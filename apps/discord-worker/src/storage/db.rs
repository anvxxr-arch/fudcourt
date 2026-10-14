//! A bounded PostgreSQL pool over `tokio-postgres`.
//!
//! `tokio-postgres` ships no pool. Rather than pull in a pool crate, this is the
//! smallest thing that is actually correct for a worker: a semaphore bounds the
//! number of in-flight sessions, an idle stack recycles them, and a session whose
//! socket died is DROPPED rather than returned, so the pool heals itself and the
//! next acquire reconnects. Startup is fail-visible: the pool is filled eagerly,
//! so a bad DSN or a down database exits the process instead of surfacing later.
//!
//! The idle stack is a `std::sync::Mutex` on purpose: it is never held across an
//! `.await` (only a `push`/`pop`), which the async `tokio::sync::Mutex` would
//! make easy to get wrong.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_postgres::{Client, Config, NoTls};

/// How long a single statement may run before Postgres cancels it. A stuck job
/// body must not pin a pooled connection indefinitely.
const STATEMENT_TIMEOUT: &str = "30s";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Pool {
    inner: Arc<Inner>,
}

struct Inner {
    cfg: Config,
    permits: Arc<Semaphore>,
    idle: Mutex<Vec<Arc<Client>>>,
}

/// A checked-out session. Returned to the pool when dropped.
pub struct Session {
    pool: Arc<Inner>,
    client: Option<Arc<Client>>,
    _permit: OwnedSemaphorePermit,
}

impl Session {
    pub fn client(&self) -> &Client {
        self.client
            .as_ref()
            .expect("session client is present until drop")
            .as_ref()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            // A closed connection is not recycled: freeing the permit lets the
            // next acquire open a fresh one, which is what makes the pool
            // self-healing after a database restart.
            if !client.is_closed() {
                if let Ok(mut idle) = self.pool.idle.lock() {
                    idle.push(client);
                }
            }
        }
    }
}

impl Pool {
    /// Open `size` sessions now. Returns an error — and the caller exits — if the
    /// database is unreachable, so the worker never starts half-alive.
    pub async fn connect(dsn: &str, size: usize) -> Result<Self, String> {
        let size = size.max(1);
        let mut cfg: Config = dsn.parse().map_err(|e| format!("DB config: {e}"))?;
        cfg.connect_timeout(CONNECT_TIMEOUT);

        let inner = Arc::new(Inner {
            cfg,
            permits: Arc::new(Semaphore::new(size)),
            idle: Mutex::new(Vec::with_capacity(size)),
        });
        let pool = Self { inner };

        let mut opened = Vec::with_capacity(size);
        for _ in 0..size {
            opened.push(pool.inner.connect_one().await?);
        }
        if let Ok(mut idle) = pool.inner.idle.lock() {
            idle.extend(opened);
        }
        Ok(pool)
    }

    /// Wait for a free slot and hand back a live session.
    pub async fn acquire(&self) -> Result<Session, String> {
        let permit = self
            .inner
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| format!("pool closed: {e}"))?;

        let recycled = self.inner.idle.lock().ok().and_then(|mut idle| idle.pop());
        let client = match recycled {
            Some(client) if !client.is_closed() => client,
            _ => self.inner.connect_one().await?,
        };
        Ok(Session {
            pool: self.inner.clone(),
            client: Some(client),
            _permit: permit,
        })
    }

    /// Pool capacity, for the startup log and `/status`-style reporting.
    pub fn size(&self) -> usize {
        self.inner.permits.available_permits()
    }
}

impl Inner {
    async fn connect_one(&self) -> Result<Arc<Client>, String> {
        let (client, connection) = self
            .cfg
            .connect(NoTls)
            .await
            .map_err(|e| format!("DB connect: {e}"))?;
        // Drive the socket on its own task; the client is useless without it.
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("postgres connection error: {e}");
            }
        });
        client
            .batch_execute(&format!("SET statement_timeout = '{STATEMENT_TIMEOUT}'"))
            .await
            .map_err(|e| format!("DB session setup: {e}"))?;
        Ok(Arc::new(client))
    }
}

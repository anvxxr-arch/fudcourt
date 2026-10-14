//! Advisory locks over Valkey (optional).
//!
//! EXPLICITLY NOT a correctness mechanism. PostgreSQL is the system of record:
//! claiming is transactional and idempotency is a unique constraint, so the
//! worker is correct with no Valkey at all. These locks only avoid redundant
//! *work* (two workers reaping at the same instant), which is why every failure
//! here is logged and stepped over rather than retried: a Valkey outage must
//! never stall the worker.

use std::sync::Arc;
use std::time::Duration;

/// The release script: delete the key only when we still own it.
///
/// A plain `DEL` would let worker A, whose TTL already expired and whose key was
/// re-taken by worker B, delete B's lock. Compare-and-delete closes that window.
const RELEASE_SCRIPT: &str = r#"
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
"#;

pub struct Lock {
    backend: Arc<Backend>,
}

enum Backend {
    /// No `VALKEY_URL`: every acquire succeeds and release is a no-op.
    Noop,
    Valkey {
        conn: tokio::sync::Mutex<redis::aio::MultiplexedConnection>,
    },
}

impl Lock {
    /// Connect when `valkey_url` is set; otherwise a no-op lock.
    pub async fn connect(valkey_url: Option<&str>) -> Result<Self, String> {
        match valkey_url {
            None | Some("") => Ok(Self {
                backend: Arc::new(Backend::Noop),
            }),
            Some(url) => {
                let client = redis::Client::open(url).map_err(|e| format!("valkey config: {e}"))?;
                let conn = client
                    .get_multiplexed_async_connection()
                    .await
                    .map_err(|e| format!("valkey connect: {e}"))?;
                Ok(Self {
                    backend: Arc::new(Backend::Valkey {
                        conn: tokio::sync::Mutex::new(conn),
                    }),
                })
            }
        }
    }

    pub fn is_enabled(&self) -> bool {
        !matches!(*self.backend, Backend::Noop)
    }

    /// Try to take `name` for `ttl`. `Ok(true)` means we hold it, `Ok(false)`
    /// means someone else does; the no-op backend always reports `true`.
    ///
    /// A Valkey error is reported as `Err` for the caller to log and ignore —
    /// never as a reason to skip real work.
    pub async fn acquire(&self, name: &str, token: &str, ttl: Duration) -> Result<bool, String> {
        match &*self.backend {
            Backend::Noop => Ok(true),
            Backend::Valkey { conn } => {
                let mut conn = conn.lock().await;
                let ttl_ms = ttl.as_millis().max(1) as u64;
                let set: Option<String> = redis::cmd("SET")
                    .arg(name)
                    .arg(token)
                    .arg("NX")
                    .arg("PX")
                    .arg(ttl_ms)
                    .query_async(&mut *conn)
                    .await
                    .map_err(|e| format!("valkey set: {e}"))?;
                Ok(set.is_some())
            }
        }
    }

    /// Release `name` if we still hold it. Idempotent.
    pub async fn release(&self, name: &str, token: &str) -> Result<(), String> {
        match &*self.backend {
            Backend::Noop => Ok(()),
            Backend::Valkey { conn } => {
                let mut conn = conn.lock().await;
                let script = redis::Script::new(RELEASE_SCRIPT);
                let _: i64 = script
                    .key(name)
                    .arg(token)
                    .invoke_async(&mut *conn)
                    .await
                    .map_err(|e| format!("valkey release: {e}"))?;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_url_is_a_working_noop() {
        let lock = Lock::connect(None).await.expect("noop");
        assert!(!lock.is_enabled());
        assert!(lock
            .acquire("n", "t", Duration::from_secs(1))
            .await
            .unwrap());
        assert!(lock.release("n", "t").await.is_ok());
    }

    #[tokio::test]
    async fn empty_url_is_also_a_noop() {
        let lock = Lock::connect(Some("")).await.expect("noop");
        assert!(!lock.is_enabled());
    }

    #[tokio::test]
    async fn a_bad_url_is_an_error_not_a_silent_noop() {
        // A typo'd VALKEY_URL must be visible at startup, not degrade to "locked
        // nothing" without a word.
        assert!(Lock::connect(Some("not-a-url")).await.is_err());
    }
}

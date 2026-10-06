//! Postgres client (DR-040).
//!
//! Postgres+TimescaleDB is the system of record; this replaces the retired Turso
//! HTTP pipeline client. Behaviour is kept byte-for-byte where it matters: a read
//! returns one JSON row per row with every cell as the text the column holds —
//! which is what the old Turso pipeline handed back (`{"type":"text","value":…}`) —
//! so the reconciler's `num()` (parses numeric strings) and `str_or()` (takes
//! strings) produce the identical `/api/reconcile` body.
//!
//! Reads go through `simple_query` (no parameters, all cells as text); writes
//! go through the extended protocol with text parameters. A write's numeric
//! columns are cast in SQL (`$3::double precision`) because the parameters are
//! declared TEXT: the values are pre-rendered Python-style strings, and Postgres
//! — unlike SQLite — will not coerce text into a `double precision` column
//! without an explicit cast.
//!
//! Resilience: the parsed `Config` is kept, a connect timeout is set, every
//! session gets `statement_timeout`, and a poisoned/closed connection is
//! re-established on demand (a Postgres restart no longer kills the service).
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_postgres::NoTls;
/// `Clone` because the HTTP service hands one per connection: it is one `Arc`.
#[derive(Clone)]
pub struct Db {
    state: Option<Arc<State>>,
}
struct State {
    cfg: tokio_postgres::Config,
    current: Mutex<Arc<Conn>>,
}
/// One live session: the client plus the death-flag the connection task raises
/// when the socket fails. A fresh `Conn` (new flag) is swapped in on reconnect,
/// so a late error from an OLD connection can never poison a NEW one.
struct Conn {
    client: Arc<tokio_postgres::Client>,
    dead: Arc<AtomicBool>,
}
pub type Row = serde_json::Map<String, Value>;
/// One pre-rendered `assets` row, exactly as the Python oracle writes it.
pub struct AssetRow<'a> {
    pub chain: &'a str,
    pub asset: &'a str,
    pub quantity: &'a str,
    pub value_usd: &'a str,
    pub share_pct: &'a str,
    pub wallet: &'a str,
}
impl Db {
    /// Connect to the system of record. `NoTls` because it binds loopback and
    /// the credential travels over a unix-local TCP hop, exactly like the web's
    /// Bun.sql client.
    pub async fn connect(dsn: &str) -> Result<Self, String> {
        let mut cfg: tokio_postgres::Config = dsn.parse().map_err(|e| format!("DB config: {e}"))?;
        cfg.connect_timeout(Duration::from_secs(10));
        let conn = Self::spawn_conn(&cfg).await?;
        Ok(Self {
            state: Some(Arc::new(State {
                cfg,
                current: Mutex::new(conn),
            })),
        })
    }
    async fn spawn_conn(cfg: &tokio_postgres::Config) -> Result<Arc<Conn>, String> {
        let (client, connection) = cfg
            .connect(NoTls)
            .await
            .map_err(|e| format!("DB connect: {e}"))?;
        client
            .execute("SET statement_timeout = '30s'", &[])
            .await
            .map_err(|e| format!("DB init: {e}"))?;
        let dead = Arc::new(AtomicBool::new(false));
        let dead2 = Arc::clone(&dead);
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("postgres connection error: {e}");
                dead2.store(true, Ordering::SeqCst);
            }
        });
        Ok(Arc::new(Conn {
            client: Arc::new(client),
            dead,
        }))
    }
    /// The live session, reconnecting first when the old one is poisoned or
    /// closed (e.g. after a Postgres restart).
    async fn client(&self) -> Result<Arc<tokio_postgres::Client>, String> {
        let Some(state) = &self.state else {
            return Err("DB: no connection (unreachable client)".to_string());
        };
        {
            let guard = state
                .current
                .lock()
                .map_err(|_| "DB: connection lock poisoned".to_string())?;
            if !guard.dead.load(Ordering::SeqCst) && !guard.client.is_closed() {
                return Ok(Arc::clone(&guard.client));
            }
        }
        let mut guard = state
            .current
            .lock()
            .map_err(|_| "DB: connection lock poisoned".to_string())?;
        // A concurrent caller may have already reconnected.
        if !guard.dead.load(Ordering::SeqCst) && !guard.client.is_closed() {
            return Ok(Arc::clone(&guard.client));
        }
        eprintln!("postgres reconnecting after connection loss");
        let conn = Self::spawn_conn(&state.cfg).await?;
        *guard = conn;
        Ok(Arc::clone(&guard.client))
    }
    /// A `Db` that can never reach a database: every query fails. The router
    /// tests use it because their subject is ROUTING, not data — a real
    /// connection would make the test depend on a running Postgres.
    pub fn unreachable() -> Self {
        Self { state: None }
    }
    /// Flatten `simple_query` messages into the one-JSON-row-per-row shape.
    fn rows_from(msgs: Vec<tokio_postgres::SimpleQueryMessage>) -> Vec<Row> {
        let mut out: Vec<Row> = Vec::new();
        for m in msgs {
            if let tokio_postgres::SimpleQueryMessage::Row(r) = m {
                let mut row = Row::new();
                for (i, col) in r.columns().iter().enumerate() {
                    let v = match r.get(i) {
                        Some(s) => Value::String(s.to_string()),
                        None => Value::Null,
                    };
                    row.insert(col.name().to_string(), v);
                }
                out.push(row);
            }
        }
        out
    }
    /// `db(sql, args)` -- raises on any transport or SQL error.
    ///
    /// FAIL-SAFE tripwire: when the oracle replay is active this returns an
    /// error WITHOUT touching the database, so an oracle run cannot write a
    /// single row (`assets` stays exactly as it was).
    pub async fn query(&self, sql: &str, args: Option<&[String]>) -> Result<Vec<Row>, String> {
        if crate::oracle::active() {
            crate::oracle::note(&format!("db|{sql}"));
            return Err(format!(
                "oracle mode: refusing to send SQL to the store ({sql})"
            ));
        }
        let client = self.client().await?;
        match args {
            // Parameterised write: text parameters, positional (`$1..$n`).
            Some(a) => {
                let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = a
                    .iter()
                    .map(|s| s as &(dyn tokio_postgres::types::ToSql + Sync))
                    .collect();
                client
                    .execute(sql, &params)
                    .await
                    .map_err(|e| format!("DB: {e}"))?;
                Ok(Vec::new())
            }
            // No parameters: a read (or a bare statement). Every cell comes back
            // as text, matching the text cells the reconciler was written on.
            None => {
                let msgs = client
                    .simple_query(sql)
                    .await
                    .map_err(|e| format!("DB: {e}"))?;
                Ok(Self::rows_from(msgs))
            }
        }
    }
    /// Run `f` on a DEDICATED connection inside one
    /// `BEGIN ISOLATION LEVEL REPEATABLE READ ... COMMIT`, so every statement
    /// inside sees the same snapshot (no mixed-generation rows across three
    /// reads on a shared client). A dedicated connection means concurrent
    /// snapshots never interleave their BEGIN/SELECT/COMMIT on one client.
    pub async fn with_snapshot<T, F, Fut>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(Arc<tokio_postgres::Client>) -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        if crate::oracle::active() {
            crate::oracle::note("db|snapshot");
            return Err("oracle mode: refusing to send SQL to the store".to_string());
        }
        let Some(state) = &self.state else {
            return Err("DB: no connection (unreachable client)".to_string());
        };
        let (client, connection) = state
            .cfg
            .connect(NoTls)
            .await
            .map_err(|e| format!("DB connect: {e}"))?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("postgres connection error: {e}");
            }
        });
        client
            .execute("SET statement_timeout = '30s'", &[])
            .await
            .map_err(|e| format!("DB init: {e}"))?;
        client
            .simple_query("BEGIN ISOLATION LEVEL REPEATABLE READ")
            .await
            .map_err(|e| format!("DB: {e}"))?;
        let shared = Arc::new(client);
        let result = f(Arc::clone(&shared)).await;
        match result {
            Ok(t) => {
                shared
                    .simple_query("COMMIT")
                    .await
                    .map_err(|e| format!("DB commit: {e}"))?;
                Ok(t)
            }
            Err(e) => {
                let _ = shared.simple_query("ROLLBACK").await;
                Err(e)
            }
        }
    }
    /// Replace the whole `assets` board in ONE transaction (the Python oracle
    /// does the same, so the board never sees a half-written table and the
    /// `assets_snapshot` trigger fires atomically). The 90-day retentions run
    /// inside the same transaction. Dedicated connection, so concurrent work
    /// never interleaves on one client.
    pub async fn replace_assets(&self, rows: &[AssetRow<'_>]) -> Result<(), String> {
        if crate::oracle::active() {
            crate::oracle::note("db|replace_assets");
            return Err("oracle mode: refusing to send SQL to the store".to_string());
        }
        let Some(state) = &self.state else {
            return Err("DB: no connection (unreachable client)".to_string());
        };
        let (mut client, connection) = state
            .cfg
            .connect(NoTls)
            .await
            .map_err(|e| format!("DB connect: {e}"))?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("postgres connection error: {e}");
            }
        });
        client
            .execute("SET statement_timeout = '30s'", &[])
            .await
            .map_err(|e| format!("DB init: {e}"))?;
        let tx = client
            .transaction()
            .await
            .map_err(|e| format!("DB tx: {e}"))?;
        // Single-flight guard: a second concurrent sync run bails loudly
        // instead of interleaving its DELETE + INSERTs with ours. Session
        // zone, so it releases when this dedicated connection drops.
        {
            let rows = tx
                .simple_query("SELECT pg_try_advisory_lock(727272) AS locked")
                .await
                .map_err(|e| format!("DB: {e}"))?;
            let locked = rows
                .iter()
                .find_map(|m| match m {
                    tokio_postgres::SimpleQueryMessage::Row(r) => r.get(0),
                    _ => None,
                })
                .map(|v| v == "t" || v == "true")
                .unwrap_or(false);
            if !locked {
                return Err(
                    "another sync run holds the advisory lock; aborting this run".to_string(),
                );
            }
        }
        tx.execute("DELETE FROM assets", &[])
            .await
            .map_err(|e| format!("DB: {e}"))?;
        for r in rows {
            tx.execute(
                "INSERT INTO assets (chain,asset,quantity,value_usd,share_pct,wallet,updated_at) \
                 VALUES ($1,$2,$3::double precision,$4::double precision,$5::double precision,$6, \
                 to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')) \
                 ON CONFLICT (wallet, chain, asset) DO UPDATE SET \
                 quantity = EXCLUDED.quantity, value_usd = EXCLUDED.value_usd, \
                 share_pct = EXCLUDED.share_pct, updated_at = EXCLUDED.updated_at",
                &[
                    &r.chain as &(dyn tokio_postgres::types::ToSql + Sync),
                    &r.asset as &(dyn tokio_postgres::types::ToSql + Sync),
                    &r.quantity as &(dyn tokio_postgres::types::ToSql + Sync),
                    &r.value_usd as &(dyn tokio_postgres::types::ToSql + Sync),
                    &r.share_pct as &(dyn tokio_postgres::types::ToSql + Sync),
                    &r.wallet as &(dyn tokio_postgres::types::ToSql + Sync),
                ],
            )
            .await
            .map_err(|e| format!("DB: {e}"))?;
        }
        // 90-day retention, the same two DELETEs the Python oracle runs.
        tx.execute(
            "DELETE FROM asset_history WHERE ts < now() - interval '90 days'",
            &[],
        )
        .await
        .map_err(|e| format!("DB: {e}"))?;
        tx.execute(
            "DELETE FROM price_history WHERE ts < now() - interval '90 days'",
            &[],
        )
        .await
        .map_err(|e| format!("DB: {e}"))?;
        tx.commit().await.map_err(|e| format!("DB commit: {e}"))?;
        Ok(())
    }
}

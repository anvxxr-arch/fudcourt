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

use serde_json::Value;
use std::sync::Arc;
use tokio_postgres::NoTls;

/// `Clone` because the HTTP service hands one per connection: it is one `Arc`.
#[derive(Clone)]
pub struct Db {
    client: Option<Arc<tokio_postgres::Client>>,
}

pub type Row = serde_json::Map<String, Value>;

impl Db {
    /// Connect to the system of record. `NoTls` because it binds loopback and
    /// the credential travels over a unix-local TCP hop, exactly like the web's
    /// Bun.sql client.
    pub async fn connect(dsn: &str) -> Result<Self, String> {
        let (client, connection) = tokio_postgres::connect(dsn, NoTls)
            .await
            .map_err(|e| format!("DB connect: {e}"))?;
        // The connection object drives the socket and must be polled for the
        // client to make progress. Detached on purpose: it lives exactly as long
        // as the client (when the client drops, the connection future ends).
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("postgres connection error: {e}");
            }
        });
        Ok(Self {
            client: Some(Arc::new(client)),
        })
    }

    /// A `Db` that can never reach a database: every query fails. The router
    /// tests use it because their subject is ROUTING, not data — a real
    /// connection would make the test depend on a running Postgres.
    pub fn unreachable() -> Self {
        Self { client: None }
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
        let Some(client) = &self.client else {
            return Err("DB: no connection (unreachable client)".to_string());
        };
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
                Ok(out)
            }
        }
    }

    /// `db('DELETE FROM assets')`
    pub async fn delete_assets(&self) -> Result<(), String> {
        self.query("DELETE FROM assets", None).await.map(|_| ())
    }

    /// `db('INSERT INTO assets (...) VALUES (...)')` -- arguments are pre-rendered
    /// Python-style text, exactly as `str(a)` would produce. The numeric columns
    /// are cast in SQL because the parameters are declared TEXT.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_asset(
        &self,
        chain: &str,
        asset: &str,
        quantity: &str,
        value_usd: &str,
        share_pct: &str,
        wallet: &str,
    ) -> Result<(), String> {
        self.query(
            "INSERT INTO assets (chain,asset,quantity,value_usd,share_pct,wallet,updated_at) \
             VALUES ($1,$2,$3::double precision,$4::double precision,$5::double precision,$6,\
             to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))",
            Some(&[
                chain.to_string(),
                asset.to_string(),
                quantity.to_string(),
                value_usd.to_string(),
                share_pct.to_string(),
                wallet.to_string(),
            ]),
        )
        .await
        .map(|_| ())
    }
}

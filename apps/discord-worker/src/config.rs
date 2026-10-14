//! Bootstrap configuration.
//!
//! Only bootstrap and secrets read the environment. Everything operational —
//! which jobs exist, their schedules, their payloads — is a Postgres row, so
//! changing it never requires a restart. `from_pairs` is separated from
//! `from_env` so the parsing rules are unit-tested without mutating the process
//! environment.

use std::collections::HashMap;
use std::time::Duration;

/// Loopback by default: the worker is never publicly reachable (DR-002).
pub const DEFAULT_HEALTH_ADDR: &str = "127.0.0.1:8110";

#[derive(Debug, Clone)]
pub struct Config {
    /// Postgres DSN. `FUDCOURT_PG_URL`, else `DATABASE_URL` (DR-040: loopback).
    pub database_url: String,
    /// `VALKEY_URL`. Unset means the advisory lock is a no-op.
    pub valkey_url: Option<String>,
    /// Identifies this worker in `jobs.locked_by` and `job_runs.worker`.
    pub worker_id: String,
    /// Pooled sessions; also the ceiling on concurrent job bodies.
    pub concurrency: usize,
    /// How long to wait before re-polling an empty queue.
    pub poll_interval: Duration,
    /// A `running` job untouched for this long is presumed dead and reclaimed.
    /// Must exceed the slowest legitimate job, or the reaper double-runs work.
    pub stale_claim_secs: i64,
    /// How often to sweep stale claims.
    pub reap_interval: Duration,
    /// How long to let in-flight jobs finish after a shutdown signal.
    pub shutdown_grace: Duration,
    /// Loopback address for `/healthz` and `/readyz`. `None` disables the
    /// listener; a bind failure is logged and non-fatal either way.
    pub health_addr: Option<String>,
    /// The single guild this bot serves. The scheduler needs an owner for the tick
    /// chain, so without it the worker still runs but the scheduler stays off —
    /// logged loudly rather than guessed.
    pub guild_id: Option<String>,
    /// How often the scheduler tick runs, in seconds. A tick schedules its own
    /// successor, so this is the whole scheduler's heartbeat.
    pub tick_interval_secs: i64,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let vars: HashMap<String, String> = std::env::vars().collect();
        Self::from_pairs(&vars)
    }

    pub fn from_pairs(vars: &HashMap<String, String>) -> Result<Self, String> {
        let get = |key: &str| vars.get(key).map(String::as_str).filter(|v| !v.is_empty());
        // The repo's convention is a `FUDCOURT_` prefix; accept the bare name too
        // so the worker is usable standalone.
        let first = |keys: &[&str]| keys.iter().find_map(|k| get(k));
        let num = |key: &str, fallback: u64| -> Result<u64, String> {
            match get(key) {
                None => Ok(fallback),
                Some(raw) => raw
                    .parse::<u64>()
                    .map_err(|e| format!("{key} is not a number: {e}")),
            }
        };

        let database_url = get("FUDCOURT_PG_URL")
            .or_else(|| get("DATABASE_URL"))
            .ok_or("FUDCOURT_PG_URL (or DATABASE_URL) is required")?
            .to_string();

        let worker_id = get("WORKER_ID")
            .map(str::to_string)
            .unwrap_or_else(default_worker_id);

        let tick_interval_secs = num("SCHEDULER_TICK_SECS", 60)? as i64;
        if tick_interval_secs < 1 {
            // A zero interval would make every tick schedule its successor at the
            // same instant it is running, which is a spin, not a schedule.
            return Err("SCHEDULER_TICK_SECS must be at least 1".to_string());
        }

        Ok(Self {
            database_url,
            valkey_url: first(&["FUDCOURT_VALKEY_URL", "VALKEY_URL"]).map(str::to_string),
            worker_id,
            concurrency: num("WORKER_CONCURRENCY", 4)? as usize,
            poll_interval: Duration::from_millis(num("WORKER_POLL_MS", 1000)?),
            stale_claim_secs: num("WORKER_STALE_CLAIM_SECS", 300)? as i64,
            reap_interval: Duration::from_secs(num("WORKER_REAP_SECS", 60)?),
            shutdown_grace: Duration::from_secs(num("WORKER_SHUTDOWN_GRACE_SECS", 25)?),
            health_addr: match get("WORKER_HEALTH_ADDR") {
                // An explicit `off` disables the listener; a blank value is
                // treated as unset so a half-filled .env keeps the default.
                Some("off") | Some("none") => None,
                Some(addr) => Some(addr.to_string()),
                None => Some(DEFAULT_HEALTH_ADDR.to_string()),
            },
            guild_id: first(&["FUDCOURT_GUILD_ID", "DISCORD_GUILD_ID"]).map(str::to_string),
            tick_interval_secs,
        })
    }
}

/// A stable-enough identity: the host, so two workers on one host are told apart
/// by an explicit WORKER_ID, and the pid, so a restart is a new identity.
fn default_worker_id() -> String {
    let host = std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "worker".to_string());
    format!("{host}-{}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn the_database_url_is_required() {
        let err = Config::from_pairs(&vars(&[])).unwrap_err();
        assert!(err.contains("FUDCOURT_PG_URL"), "got {err}");
    }

    #[test]
    fn fudcourt_pg_url_wins_over_database_url() {
        let cfg = Config::from_pairs(&vars(&[
            ("FUDCOURT_PG_URL", "host=loopback dbname=a"),
            ("DATABASE_URL", "host=elsewhere dbname=b"),
        ]))
        .unwrap();
        assert_eq!(cfg.database_url, "host=loopback dbname=a");
    }

    #[test]
    fn database_url_is_the_fallback() {
        let cfg = Config::from_pairs(&vars(&[("DATABASE_URL", "host=x")])).unwrap();
        assert_eq!(cfg.database_url, "host=x");
    }

    #[test]
    fn an_empty_value_counts_as_unset() {
        // `FUDCOURT_PG_URL=` in a partially-filled .env must not win.
        let cfg = Config::from_pairs(&vars(&[
            ("FUDCOURT_PG_URL", ""),
            ("DATABASE_URL", "host=y"),
        ]))
        .unwrap();
        assert_eq!(cfg.database_url, "host=y");
    }

    #[test]
    fn defaults_are_sane() {
        let cfg = Config::from_pairs(&vars(&[("DATABASE_URL", "host=x")])).unwrap();
        assert_eq!(cfg.concurrency, 4);
        assert_eq!(cfg.poll_interval, Duration::from_millis(1000));
        assert_eq!(cfg.stale_claim_secs, 300);
        assert_eq!(cfg.reap_interval, Duration::from_secs(60));
        assert_eq!(cfg.shutdown_grace, Duration::from_secs(25));
        assert_eq!(cfg.tick_interval_secs, 60);
        assert!(cfg.guild_id.is_none(), "the guild is never guessed");
        assert!(cfg.valkey_url.is_none());
    }

    #[test]
    fn explicit_values_override_defaults() {
        let cfg = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("WORKER_CONCURRENCY", "8"),
            ("WORKER_POLL_MS", "250"),
            ("WORKER_STALE_CLAIM_SECS", "900"),
            ("WORKER_REAP_SECS", "15"),
            ("WORKER_SHUTDOWN_GRACE_SECS", "5"),
            ("VALKEY_URL", "redis://127.0.0.1:6379"),
            ("WORKER_ID", "w1"),
        ]))
        .unwrap();
        assert_eq!(cfg.concurrency, 8);
        assert_eq!(cfg.poll_interval, Duration::from_millis(250));
        assert_eq!(cfg.stale_claim_secs, 900);
        assert_eq!(cfg.reap_interval, Duration::from_secs(15));
        assert_eq!(cfg.shutdown_grace, Duration::from_secs(5));
        assert_eq!(cfg.valkey_url.as_deref(), Some("redis://127.0.0.1:6379"));
        assert_eq!(cfg.worker_id, "w1");
    }

    #[test]
    fn a_non_numeric_knob_is_an_error_not_a_silent_default() {
        let err = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("WORKER_CONCURRENCY", "lots"),
        ]))
        .unwrap_err();
        assert!(err.contains("WORKER_CONCURRENCY"), "got {err}");
    }

    #[test]
    fn the_generated_worker_id_is_not_empty() {
        assert!(!default_worker_id().is_empty());
    }

    #[test]
    fn the_scheduler_knobs_are_read() {
        let cfg = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("FUDCOURT_GUILD_ID", "123456789"),
            ("SCHEDULER_TICK_SECS", "15"),
        ]))
        .unwrap();
        assert_eq!(cfg.guild_id.as_deref(), Some("123456789"));
        assert_eq!(cfg.tick_interval_secs, 15);
    }

    #[test]
    fn a_zero_tick_interval_is_rejected_rather_than_spinning() {
        let err = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("SCHEDULER_TICK_SECS", "0"),
        ]))
        .unwrap_err();
        assert!(err.contains("SCHEDULER_TICK_SECS"), "got {err}");
    }

    #[test]
    fn the_bare_discord_guild_id_is_accepted() {
        let cfg = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("DISCORD_GUILD_ID", "999"),
        ]))
        .unwrap();
        assert_eq!(cfg.guild_id.as_deref(), Some("999"));
    }

    #[test]
    fn health_defaults_to_loopback() {
        let cfg = Config::from_pairs(&vars(&[("DATABASE_URL", "host=x")])).unwrap();
        assert_eq!(cfg.health_addr.as_deref(), Some(DEFAULT_HEALTH_ADDR));
    }

    #[test]
    fn health_can_be_disabled_explicitly() {
        let cfg = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("WORKER_HEALTH_ADDR", "off"),
        ]))
        .unwrap();
        assert!(cfg.health_addr.is_none());
    }

    #[test]
    fn health_can_be_moved() {
        let cfg = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("WORKER_HEALTH_ADDR", "127.0.0.1:9999"),
        ]))
        .unwrap();
        assert_eq!(cfg.health_addr.as_deref(), Some("127.0.0.1:9999"));
    }

    #[test]
    fn the_repo_prefixed_valkey_url_works() {
        let cfg = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("FUDCOURT_VALKEY_URL", "redis://127.0.0.1:6379"),
        ]))
        .unwrap();
        assert_eq!(cfg.valkey_url.as_deref(), Some("redis://127.0.0.1:6379"));
    }

    #[test]
    fn the_prefixed_valkey_url_wins_over_the_bare_one() {
        let cfg = Config::from_pairs(&vars(&[
            ("DATABASE_URL", "host=x"),
            ("VALKEY_URL", "redis://bare:6379"),
            ("FUDCOURT_VALKEY_URL", "redis://prefixed:6379"),
        ]))
        .unwrap();
        assert_eq!(cfg.valkey_url.as_deref(), Some("redis://prefixed:6379"));
    }
}

//! The discord-worker binary.
//!
//! Startup is fail-visible, like every other service in this repo: a missing DSN,
//! an unreachable database, a bad `VALKEY_URL` or a queue table that is not there
//! exits non-zero BEFORE the loop starts, so a broken deploy never looks healthy.
//!
//! Shutdown is signal-driven: SIGTERM/SIGINT stop claiming, drain the in-flight
//! jobs inside the grace period, and exit 0. A job that cannot finish in time is
//! left for the reaper — which is a supported outcome, not a lost job.

use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::watch;

use fudcourt_discord_worker::config::Config;
use fudcourt_discord_worker::handlers::{Noop, Registry};
use fudcourt_discord_worker::jobs::runner::{Runner, RunnerOptions};
use fudcourt_discord_worker::jobs::Backoff;
use fudcourt_discord_worker::locks::Lock;
use fudcourt_discord_worker::logging::{self, fields};
use fudcourt_discord_worker::storage::{jobs, Pool};
use fudcourt_discord_worker::{health, logging as log};

/// Job kinds this build implements.
///
/// Phase 9 ships the runtime and two kinds that prove it end to end. The
/// scheduler (phase 10) and the feeds pipeline (phase 11) register the real kinds
/// through the same `Registry`, so nothing here has to change when they land.
const KINDS: &[&str] = &["noop", "health.ping"];

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        logging::error("fatal", fields(vec![("error", serde_json::Value::from(e))]));
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let cfg = Config::from_env()?;
    log::info_map(
        "starting discord-worker",
        fields(vec![
            ("worker", serde_json::Value::from(cfg.worker_id.clone())),
            (
                "concurrency",
                serde_json::Value::from(cfg.concurrency as u64),
            ),
            // Never the DSN itself: it carries a password.
            (
                "valkey_lock",
                serde_json::Value::from(cfg.valkey_url.is_some()),
            ),
        ]),
    );

    let pool = Pool::connect(&cfg.database_url, cfg.concurrency).await?;
    let lock = Arc::new(Lock::connect(cfg.valkey_url.as_deref()).await?);

    // Fail-visible readiness: the queue must be queryable before we accept work.
    {
        let session = pool.acquire().await?;
        let counts = jobs::counts(session.client()).await?;
        log::info_map(
            "queue ready",
            fields(vec![(
                "counts",
                serde_json::to_value(&counts).unwrap_or(serde_json::Value::Null),
            )]),
        );
    }

    let registry = Arc::new(registry());
    log::info_map(
        "handlers registered",
        fields(vec![(
            "kinds",
            serde_json::to_value(registry.kinds()).unwrap_or(serde_json::Value::Null),
        )]),
    );

    // A health-port conflict must not stop the worker from doing its job.
    if let Some(addr) = cfg.health_addr.clone() {
        match TcpListener::bind(&addr).await {
            Ok(listener) => {
                tokio::spawn(health::serve(listener, pool.clone()));
            }
            Err(e) => log::warn(
                "health listener could not bind; continuing without it",
                fields(vec![
                    ("addr", serde_json::Value::from(addr)),
                    ("error", serde_json::Value::from(e.to_string())),
                ]),
            ),
        }
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    spawn_signal_handler(shutdown_tx);

    let runner = Runner::new(
        pool,
        registry,
        lock,
        cfg.worker_id.clone(),
        RunnerOptions {
            concurrency: cfg.concurrency,
            poll_interval: cfg.poll_interval,
            stale_claim_secs: cfg.stale_claim_secs,
            reap_interval: cfg.reap_interval,
            shutdown_grace: cfg.shutdown_grace,
            backoff: Backoff::default(),
        },
    );
    runner.run(shutdown_rx).await
}

/// The `kind` -> handler table for this build.
fn registry() -> Registry {
    let mut registry = Registry::new();
    let noop: Arc<dyn fudcourt_discord_worker::handlers::JobHandler> = Arc::new(Noop);
    // `health.ping` is the same no-op body under a name that reads as what it is:
    // a job whose only observable effect is a `job_runs` row.
    for kind in KINDS {
        registry.register(*kind, noop.clone());
    }
    registry
}

/// Flip the shutdown flag on SIGTERM or SIGINT.
fn spawn_signal_handler(tx: watch::Sender<bool>) {
    tokio::spawn(async move {
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                logging::error(
                    "cannot install the SIGTERM handler",
                    fields(vec![("error", serde_json::Value::from(e.to_string()))]),
                );
                return;
            }
        };
        let mut interrupt = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                logging::error(
                    "cannot install the SIGINT handler",
                    fields(vec![("error", serde_json::Value::from(e.to_string()))]),
                );
                return;
            }
        };
        tokio::select! {
            _ = term.recv() => logging::info("SIGTERM received"),
            _ = interrupt.recv() => logging::info("SIGINT received"),
        }
        let _ = tx.send(true);
    });
}

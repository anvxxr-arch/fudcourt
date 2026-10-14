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
use fudcourt_discord_worker::scheduler::tick::{Tick, TICK_KIND};
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

    // The scheduler needs an owner for its tick chain; without a guild it stays off
    // and the reason is logged rather than guessed at.
    let tick = cfg
        .guild_id
        .is_some()
        .then(|| Tick::new(pool.clone(), cfg.tick_interval_secs));
    let registry = Arc::new(registry(
        tick.clone(),
        cfg.guild_id.clone(),
        pool.clone(),
        cfg.bot_token.clone(),
    ));

    // Bootstrap the chain. The key is the scheduled instant, so a restart collides
    // with whatever the previous chain already queued instead of forking a second
    // one; a worker that was down past that instant just claims it late.
    if let (Some(tick), Some(guild_id)) = (tick.as_ref(), cfg.guild_id.as_deref()) {
        match tick.enqueue_tick(guild_id, chrono::Utc::now()).await {
            Ok(_) => log::info_map(
                "scheduler chain ready",
                fields(vec![
                    ("guild_id", serde_json::Value::from(guild_id)),
                    (
                        "tick_secs",
                        serde_json::Value::from(cfg.tick_interval_secs as u64),
                    ),
                ]),
            ),
            Err(e) => log::warn(
                "the scheduler chain could not be started",
                fields(vec![("error", serde_json::Value::from(e))]),
            ),
        }
    }

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
///
/// The scheduler registers here like anything else: its tick is an ordinary job, so
/// it is claimed, retried, backed off and dead-lettered by the same runtime that
/// runs everything else. The feeds kinds do the same, which is why there is no
/// second scheduling mechanism anywhere in this crate.
fn registry(
    tick: Option<Arc<Tick>>,
    guild_id: Option<String>,
    pool: Pool,
    bot_token: Option<String>,
) -> Registry {
    let mut registry = Registry::new();
    let noop: Arc<dyn fudcourt_discord_worker::handlers::JobHandler> = Arc::new(Noop);
    // `health.ping` is the same no-op body under a name that reads as what it is:
    // a job whose only observable effect is a `job_runs` row.
    for kind in KINDS {
        registry.register(*kind, noop.clone());
    }
    match (tick, guild_id.clone()) {
        (Some(tick), Some(guild_id)) => {
            registry.register(
                TICK_KIND,
                fudcourt_discord_worker::scheduler::tick::handler(tick, guild_id),
            );
        }
        // No guild means no owner for the tick chain, so the kind is left
        // unregistered: a `scheduler.tick` job would then fail loudly as an unknown
        // kind instead of silently doing nothing.
        _ => logging::warn(
            "scheduler not registered",
            fields(vec![(
                "hint",
                serde_json::Value::from("set FUDCOURT_GUILD_ID to enable it"),
            )]),
        ),
    }

    // Feeds: a poll needs an owner (every job carries a guild) and a delivery needs
    // a token. Missing either leaves BOTH kinds unregistered, so a queued job fails
    // loudly as an unknown kind rather than quietly never sending.
    match (guild_id, bot_token) {
        (Some(guild_id), Some(token)) => {
            registry.register(
                fudcourt_discord_worker::feeds::POLL_KIND,
                fudcourt_discord_worker::feeds::poll::handler(Arc::new(
                    fudcourt_discord_worker::feeds::poll::Poll::new(pool.clone(), guild_id.clone()),
                )),
            );
            registry.register(
                fudcourt_discord_worker::feeds::DELIVER_KIND,
                fudcourt_discord_worker::feeds::deliver::handler(Arc::new(
                    fudcourt_discord_worker::feeds::deliver::Deliver::new(pool, token.clone()),
                )),
            );
            // A scheduled message needs the token to post and the guild to refuse a
            // job that belongs to somebody else, so it is registered in the same arm:
            // without either, the kind stays unregistered and a queued message fails
            // loudly rather than quietly never sending.
            registry.register(
                fudcourt_discord_worker::scheduler::message::MESSAGE_KIND,
                fudcourt_discord_worker::scheduler::message::handler(Arc::new(
                    fudcourt_discord_worker::scheduler::message::Message::new(token, guild_id),
                )),
            );
        }
        (guild_id, bot_token) => logging::warn(
            "feeds not registered",
            fields(vec![
                ("guild_id", serde_json::Value::from(guild_id.is_some())),
                ("bot_token", serde_json::Value::from(bot_token.is_some())),
                (
                    "hint",
                    serde_json::Value::from(
                        "set FUDCOURT_GUILD_ID and FUDCOURT_BOT_TOKEN to enable feeds",
                    ),
                ),
            ]),
        ),
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

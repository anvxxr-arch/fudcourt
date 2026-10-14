//! The worker loop.
//!
//! Shape: reap stale claims on an interval, then claim-and-dispatch while there
//! is work and a free slot, then idle for one poll interval. A shutdown signal
//! stops claiming and drains in-flight jobs before returning.
//!
//! Why a job can survive being interrupted: `attempts` is bumped at claim time
//! and the `job_runs` row is opened at claim time, so a worker killed mid-job
//! leaves a `running` row with an open history entry. The reaper then returns the
//! job to `pending` and closes the run as `crashed` — recovery is a property of
//! the data, not of a clean exit.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;

use crate::handlers::Registry;
use crate::jobs::{Backoff, ClaimedJob, Disposition};
use crate::locks::Lock;
use crate::logging::{self, fields};
use crate::storage::{jobs, Pool};

/// The recurring advisory-lock name; one sweep at a time across the fleet.
const REAP_LOCK: &str = "discord-worker:reap";

pub struct Runner {
    pool: Pool,
    registry: Arc<Registry>,
    lock: Arc<Lock>,
    worker_id: String,
    concurrency: usize,
    poll_interval: Duration,
    stale_claim_secs: i64,
    reap_interval: Duration,
    shutdown_grace: Duration,
    backoff: Backoff,
}

pub struct RunnerOptions {
    pub concurrency: usize,
    pub poll_interval: Duration,
    pub stale_claim_secs: i64,
    pub reap_interval: Duration,
    pub shutdown_grace: Duration,
    pub backoff: Backoff,
}

impl Runner {
    pub fn new(
        pool: Pool,
        registry: Arc<Registry>,
        lock: Arc<Lock>,
        worker_id: impl Into<String>,
        options: RunnerOptions,
    ) -> Self {
        Self {
            pool,
            registry,
            lock,
            worker_id: worker_id.into(),
            concurrency: options.concurrency.max(1),
            poll_interval: options.poll_interval,
            stale_claim_secs: options.stale_claim_secs,
            reap_interval: options.reap_interval,
            shutdown_grace: options.shutdown_grace,
            backoff: options.backoff,
        }
    }

    /// Run until `shutdown` flips to `true`, then drain and return.
    pub async fn run(self, mut shutdown: watch::Receiver<bool>) -> Result<(), String> {
        let inflight = Arc::new(Semaphore::new(self.concurrency));
        let mut tasks: JoinSet<()> = JoinSet::new();
        // Reap immediately on the first pass: a worker that just started is the
        // best-placed one to reclaim whatever the previous process abandoned.
        let mut last_reap: Option<Instant> = None;

        logging::info_map(
            "worker started",
            fields(vec![
                ("worker", serde_json::Value::from(self.worker_id.clone())),
                (
                    "concurrency",
                    serde_json::Value::from(self.concurrency as u64),
                ),
                ("handlers", serde_json::Value::from(self.registry.kinds())),
                (
                    "valkey_lock",
                    serde_json::Value::from(self.lock.is_enabled()),
                ),
            ]),
        );

        loop {
            if *shutdown.borrow() {
                break;
            }

            if last_reap.is_none_or(|at| at.elapsed() >= self.reap_interval) {
                self.reap_once().await;
                last_reap = Some(Instant::now());
            }

            let mut claimed = 0usize;
            while inflight.available_permits() > 0 {
                match self.claim_once().await {
                    Ok(Some(claim)) => {
                        claimed += 1;
                        let permit = inflight
                            .clone()
                            .acquire_owned()
                            .await
                            .map_err(|e| format!("semaphore closed: {e}"))?;
                        let ctx = self.context();
                        tasks.spawn(async move {
                            ctx.execute(claim).await;
                            // Release last so the drain wait below cannot finish
                            // while a job body is still running.
                            drop(permit);
                        });
                    }
                    Ok(None) => break,
                    Err(e) => {
                        logging::error(
                            "claim failed",
                            fields(vec![("error", serde_json::Value::from(e))]),
                        );
                        break;
                    }
                }
            }

            // Reap finished tasks so the JoinSet does not grow without bound.
            while tasks.try_join_next().is_some() {}

            if claimed == 0 {
                tokio::select! {
                    _ = tokio::time::sleep(self.poll_interval) => {}
                    _ = shutdown.changed() => {}
                    _ = tasks.join_next(), if !tasks.is_empty() => {}
                }
            }
        }

        self.drain(inflight, tasks).await;
        logging::info("worker stopped");
        Ok(())
    }

    fn context(&self) -> JobCtx {
        JobCtx {
            pool: self.pool.clone(),
            registry: self.registry.clone(),
            worker_id: self.worker_id.clone(),
            backoff: self.backoff,
        }
    }

    async fn claim_once(&self) -> Result<Option<jobs::Claim>, String> {
        let session = self.pool.acquire().await?;
        jobs::claim(session.client(), &self.worker_id).await
    }

    /// Return abandoned claims to the queue.
    async fn reap_once(&self) {
        // Advisory only: PostgreSQL's `SKIP LOCKED` already makes a concurrent
        // sweep safe, so an unavailable lock must not stop the sweep. The lock
        // exists to avoid three workers each doing the same redundant work.
        let token = format!("{}-{}", self.worker_id, std::process::id());
        let held = match self
            .lock
            .acquire(REAP_LOCK, &token, Duration::from_secs(30))
            .await
        {
            Ok(held) => held,
            Err(e) => {
                logging::warn(
                    "reap lock unavailable, sweeping anyway",
                    fields(vec![("error", serde_json::Value::from(e))]),
                );
                true
            }
        };
        if held {
            match self.pool.acquire().await {
                Ok(session) => match jobs::reap(session.client(), self.stale_claim_secs).await {
                    Ok(reclaimed) if !reclaimed.is_empty() => logging::info_map(
                        "reclaimed stale claims",
                        fields(vec![(
                            "jobs",
                            serde_json::to_value(&reclaimed).unwrap_or(serde_json::Value::Null),
                        )]),
                    ),
                    Ok(_) => {}
                    Err(e) => logging::error(
                        "reap failed",
                        fields(vec![("error", serde_json::Value::from(e))]),
                    ),
                },
                Err(e) => logging::error(
                    "reap has no database session",
                    fields(vec![("error", serde_json::Value::from(e))]),
                ),
            }
            let _ = self.lock.release(REAP_LOCK, &token).await;
        }
    }

    /// Stop claiming and let in-flight jobs finish, bounded by the grace period.
    ///
    /// The wait is "every concurrency permit is free again", which is exactly
    /// "no job body is running" — the permit is released after the attempt is
    /// recorded, so a drained worker has no half-finished bookkeeping.
    async fn drain(&self, inflight: Arc<Semaphore>, mut tasks: JoinSet<()>) {
        let outstanding = inflight.available_permits();
        if outstanding == self.concurrency {
            return;
        }
        logging::info_map(
            "draining in-flight jobs",
            fields(vec![(
                "in_flight",
                serde_json::Value::from((self.concurrency - outstanding) as u64),
            )]),
        );
        let wait = tokio::time::timeout(self.shutdown_grace, async {
            let _all = inflight.acquire_many(self.concurrency as u32).await;
        });
        if wait.await.is_err() {
            logging::warn(
                "drain grace expired, abandoning remaining jobs for the reaper",
                fields(vec![(
                    "grace_secs",
                    serde_json::Value::from(self.shutdown_grace.as_secs()),
                )]),
            );
        }
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }
}

/// Everything a job body needs, cloned per task.
#[derive(Clone)]
struct JobCtx {
    pool: Pool,
    registry: Arc<Registry>,
    worker_id: String,
    backoff: Backoff,
}

impl JobCtx {
    async fn execute(&self, claim: jobs::Claim) {
        let job: &ClaimedJob = &claim.job;
        let started = Instant::now();
        // A panic in here unwinds the task before `finish` runs, which leaves the
        // job `running` with an open run row: the reaper reclaims it. That is the
        // designed recovery path, not an accident.
        let disposition = self.registry.dispatch(job).await;
        let outcome = match &disposition {
            Disposition::Done => "succeeded",
            Disposition::Retryable(_) => "retryable",
            Disposition::Permanent(_) => "permanent",
        };
        logging::info_map(
            "job finished",
            fields(vec![
                ("worker", serde_json::Value::from(self.worker_id.clone())),
                ("job_id", serde_json::Value::from(job.id)),
                ("kind", serde_json::Value::from(job.kind.clone())),
                ("attempt", serde_json::Value::from(job.attempts as u64)),
                ("outcome", serde_json::Value::from(outcome)),
                (
                    "elapsed_ms",
                    serde_json::Value::from(started.elapsed().as_millis() as u64),
                ),
            ]),
        );

        match self.pool.acquire().await {
            Ok(session) => {
                if let Err(e) = jobs::finish(
                    session.client(),
                    &self.worker_id,
                    &claim,
                    &disposition,
                    &self.backoff,
                )
                .await
                {
                    logging::error(
                        "recording the attempt failed; the reaper will reclaim it",
                        fields(vec![
                            ("job_id", serde_json::Value::from(job.id)),
                            ("error", serde_json::Value::from(e)),
                        ]),
                    );
                }
            }
            Err(e) => logging::error(
                "no database session to record the attempt",
                fields(vec![
                    ("job_id", serde_json::Value::from(job.id)),
                    ("error", serde_json::Value::from(e)),
                ]),
            ),
        }
    }
}

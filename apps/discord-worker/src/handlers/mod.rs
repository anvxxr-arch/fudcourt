//! Job handlers: the code a `kind` maps to.
//!
//! A handler returns a [`Disposition`] rather than an error, so all bookkeeping
//! (retry, backoff, dead-lettering) lives in the runner and every handler stays a
//! plain "did the work, here is what happened" function.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::jobs::{ClaimedJob, Disposition};

/// A handler's future. Deliberately has NO lifetime parameter: the job is passed
/// by value, which keeps the trait object plain and lets a non-borrowing async
/// block (`Box::pin(async { .. })`) satisfy it without higher-ranked inference
/// fights. `ClaimedJob` is cheap to clone — a payload is one JSON value.
pub type HandlerFuture = Pin<Box<dyn Future<Output = Disposition> + Send>>;

pub trait JobHandler: Send + Sync + 'static {
    fn handle(&self, job: ClaimedJob) -> HandlerFuture;
}

/// Any `Fn(ClaimedJob) -> HandlerFuture` is a handler, so a test or a small
/// handler needs no newtype.
impl<F> JobHandler for F
where
    F: Fn(ClaimedJob) -> HandlerFuture + Send + Sync + 'static,
{
    fn handle(&self, job: ClaimedJob) -> HandlerFuture {
        self(job)
    }
}

/// The `kind` -> handler table.
#[derive(Default)]
pub struct Registry {
    handlers: HashMap<String, Arc<dyn JobHandler>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or replace) the handler for a job kind.
    pub fn register(&mut self, kind: impl Into<String>, handler: Arc<dyn JobHandler>) {
        self.handlers.insert(kind.into(), handler);
    }

    pub fn kinds(&self) -> Vec<String> {
        let mut kinds: Vec<String> = self.handlers.keys().cloned().collect();
        kinds.sort();
        kinds
    }

    /// Run the job's handler.
    ///
    /// An unregistered kind is a PERMANENT failure, never a retry: retrying
    /// cannot conjure a handler, and a job for a kind this worker does not
    /// implement must be parked for an operator rather than spun on forever.
    pub async fn dispatch(&self, job: &ClaimedJob) -> Disposition {
        match self.handlers.get(&job.kind) {
            Some(handler) => handler.handle(job.clone()).await,
            None => {
                Disposition::Permanent(format!("no handler registered for job kind `{}`", job.kind))
            }
        }
    }
}

/// A handler that succeeds without doing anything. Used by the phase-9 runtime
/// tests and as the honest placeholder for a kind whose work lands later.
pub struct Noop;

impl JobHandler for Noop {
    fn handle(&self, _job: ClaimedJob) -> HandlerFuture {
        Box::pin(async { Disposition::Done })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(kind: &str) -> ClaimedJob {
        ClaimedJob {
            id: 1,
            guild_id: String::new(),
            kind: kind.into(),
            dedupe_key: "k".into(),
            payload: serde_json::Value::Null,
            attempts: 1,
            max_attempts: 5,
        }
    }

    #[tokio::test]
    async fn a_registered_handler_runs() {
        let mut registry = Registry::new();
        let handler: Arc<dyn JobHandler> =
            Arc::new(|_: ClaimedJob| -> HandlerFuture { Box::pin(async { Disposition::Done }) });
        registry.register("tick", handler);
        assert!(matches!(
            registry.dispatch(&job("tick")).await,
            Disposition::Done
        ));
    }

    #[tokio::test]
    async fn an_unregistered_kind_is_permanent() {
        let registry = Registry::new();
        match registry.dispatch(&job("nope")).await {
            Disposition::Permanent(msg) => assert!(msg.contains("nope")),
            other => panic!("expected Permanent, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_noop_handler_succeeds() {
        let registry = {
            let mut r = Registry::new();
            r.register("noop", Arc::new(Noop));
            r
        };
        assert!(matches!(
            registry.dispatch(&job("noop")).await,
            Disposition::Done
        ));
    }
}

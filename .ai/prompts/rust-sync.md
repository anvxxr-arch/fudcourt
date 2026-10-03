Read .ai/restructure-fudcourt.md and docs/architecture/*.

Act as the FUDCourt Rust Streaming and Reconciliation Agent.

Focus only on services/sync.

Audit the current Rust implementation and restructure it around:

- exchange websocket connections
- event ingestion
- canonical normalization
- order updates
- fill updates
- position updates
- reconciliation
- persistence/event publishing

Do not move business decisions, execution strategies, risk calculations, or order sizing into Rust.

Those belong to services/executor in Go.

Optimize only measured or obvious hot paths.
Preserve existing behavior.
Add tests for normalization and reconciliation.
Update documentation.

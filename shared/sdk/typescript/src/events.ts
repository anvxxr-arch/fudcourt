/**
 * events.ts — canonical event contract surface.
 *
 * Re-exported FROM the generated catalog (single source:
 * shared/contracts/events/catalog.json, rendered by `bun run generate`) —
 * nothing here is hand-synced.
 */
export type {
  CatalogEventEntry,
  EventEnvelope,
  EventVersion,
  EventType,
  LegacyEventName,
} from './generated/events.js';
export { catalog, events } from './generated/events.js';

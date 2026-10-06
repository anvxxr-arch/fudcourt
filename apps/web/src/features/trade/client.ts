/**
 * client.ts — the browser-side typed surface of the trade domain (plan Phase 6).
 *
 * ONE RULE THIS FILE KEEPS: it COMPOSES the endpoints that already exist, it
 * does not invent a private aggregate. The market board reads `/api/ticker`
 * (the cross-venue board the site already serves); the account panels read
 * `/api/executor/*` (the CEX executor that already exists). A bespoke
 * `/api/trade/dashboard` would be a second source of truth for numbers the
 * other pages already serve, and the two would drift the first time one moved.
 *
 * The ticker's response is described here as a LOCAL contract — the handful of
 * fields this module actually reads — rather than imported from
 * `features/market/ticker`. Feature families are independent (DR-018): a family that
 * needs another family's data goes through its API, and the API's shape is what
 * this type records. If the ticker route changes a field, this file fails to
 * compile against the new shape, which is the point.
 */

export * from './client-fetch';
export * from './client-format';

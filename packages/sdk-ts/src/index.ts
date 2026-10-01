/**
 * @fudcourt/sdk-ts — typed client + contract types for the FUDCourt executor
 * surface. Types are generated from `packages/contracts/openapi/fudcourt.yaml`
 * (`bun run generate`); run `bun run check:contracts` to verify the contract
 * has not drifted from the frozen TS types.
 */
export * from './client.js';
export * from './events.js';
export type { components, operations, paths } from './generated/schema.js';

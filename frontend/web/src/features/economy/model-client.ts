/**
 * Economy client barrel — re-exports the split client modules so every
 * existing importer keeps working unchanged.
 *
 * Catalog (countries/indicators) lives in `./model-client-catalog`;
 * markets (central banks/liquidity/compare/calendar/regime) in
 * `./model-client-markets`. `ECONOMY_API` is single-sourced in the catalog
 * module; the markets module imports it from there.
 */
export * from './model-client-catalog';
export * from './model-client-markets';

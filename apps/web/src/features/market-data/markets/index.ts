/**
 * CoinGecko markets family (keyless, public API) -- family barrel.
 *
 * The data contract behind the tracker view (src/components/TrackerPage.tsx),
 * moved out of the former flat `frontend/web/src/features/market-data/`
 * layout into its own family directory. The contract itself lives in
 * ./markets (unchanged content); this barrel keeps the old import
 * specifier working for every importer.
 */
export * from './markets';

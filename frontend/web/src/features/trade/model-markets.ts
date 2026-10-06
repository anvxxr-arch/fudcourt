/**
 * model-markets.ts - barrel over the split markets modules.
 *
 * `model-market-types.ts` owns market types, execution strategies, order
 * types and margin modes; `model-instruments.ts` owns the instrument
 * registry and the domain entities. Re-exported by `./model-taxonomy`
 * so existing importers keep working unchanged.
 */
export * from './model-market-types';
export * from './model-instruments';

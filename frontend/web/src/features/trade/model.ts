/**
 * model.ts — barrel over the trade taxonomy and request-builder layers.
 *
 * `model-taxonomy.ts` owns types, registries and pure mappings;
 * `model-request.ts` owns the composer intent → ExecutionRequest builder.
 * Every previous importer keeps importing from `@/features/trade/model`.
 */
export * from './model-taxonomy';
export * from './model-request';

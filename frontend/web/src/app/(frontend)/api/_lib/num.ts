/**
 * The API routes' spelling of the shared unknown->number coercion. The
 * definition lives in `@/lib/num` beside its string-input twin so the feature
 * layer and the route layer cannot drift; this module is the route-local name.
 */
export { numParam as num } from '@/lib/num';

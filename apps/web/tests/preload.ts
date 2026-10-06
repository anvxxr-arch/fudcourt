/**
 * Test-runner preload: make `server-only` a no-op for the offline suites.
 *
 * The app guards its server modules with `import 'server-only'`, which throws
 * outside a React Server Component. The offline suites import those modules
 * directly to test their pure logic, so the guard must resolve to the
 * package's empty twin — the same file Next's react-server condition picks.
 *
 * This replaces the compiled-CJS `alias-resolver.cjs` shim: the suites now run
 * from TypeScript source under `bun test`, so there is no require hook to
 * install and no `@/` alias to map (Bun reads `paths` from tsconfig.json).
 * Only the one guard that cannot be expressed as a path alias is left, and it
 * is expressed as a module override rather than a resolver patch.
 */
import { plugin } from 'bun';

plugin({
  name: 'server-only-empty',
  setup(build) {
    build.module('server-only', () => ({ exports: {}, loader: 'object' }));
  },
});

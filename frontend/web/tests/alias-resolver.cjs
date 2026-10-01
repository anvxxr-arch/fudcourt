// Alias resolver for the OFFLINE test run (DR-018).
//
// The app uses exactly one import alias: `@/…` means `src/…`. TypeScript
// compiles the `@/` specifiers through verbatim (it does not rewrite paths), so
// when the compiled CommonJS suites run under plain `node --test` the alias must
// be resolved at require time. This shim does that against the compiled output,
// keeping one alias in the source and no second convention in the tests.
//
// Loaded with `node --require ./tests/alias-resolver.cjs`. It is a .cjs
// file so it works regardless of the nearest package.json `type`.
'use strict';
const path = require('node:path');
const Module = require('node:module');

// tsc runs with the repo root as rootDir (web-only suites live in
// frontend/web/tests, the executor suites in the repo-root tests/), so the
// compiled layout mirrors the repo from <.shaper-tests>/:
// `@/x` -> <.shaper-tests>/frontend/web/src/x.
const OUT = path.join(__dirname, '..', '.shaper-tests', 'frontend', 'web');
const original = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    return original.call(this, path.join(OUT, 'src', request.slice(2)), parent, isMain, options);
  }
  return original.call(this, request, parent, isMain, options);
};

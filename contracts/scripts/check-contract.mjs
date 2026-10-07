#!/usr/bin/env node
/**
 * check-contract.mjs — offline drift gate for contracts.
 *
 * Asserts (no network, no deps, node/bun runnable):
 *   (a) every enum value of ExecutionStatus / ChildOrderStatus /
 *       ExecutionEventName in contracts/openapi/fudcourt.yaml matches
 *       the literal union parsed from apps/web/src/lib/executor.ts;
 *   (b) every path documented in the OpenAPI exists as a route handler
 *       (route.ts under the Next.js app api tree) exporting every documented
 *       method, and no executor route handler is undocumented;
 *   (c) events/events.json covers every ExecutionEventName value (as a stable
 *       id, alias, or objective name), and events/events.json's
 *       event_type enum matches the catalog's stable ids;
 *   (d) every endpoint listed in the header comment of
 *       apps/web/src/features/executor/client.ts is documented in the OpenAPI
 *       (method + normalized path).
 *
 * Prints `CONTRACTS_OK` with counts, or lists failures and exits 1.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { repoRoot as discoverRepoRoot, parseOpenApiEnums } from './lib.mjs';

const repoRoot = discoverRepoRoot();

// The executor type surface moved in the frontend refactor and now lives in
// apps/web/src/lib/executor-lifecycle.ts and
// apps/web/src/lib/executor-request-defs.ts; the retired
// apps/web/src/lib/executor.ts barrel re-exports both. parseLiteralUnion does
// not follow `export *`, so read the defining slices directly and check the
// unions against their concat.
const TYPES_TS = [
  'apps/web/src/lib/executor-lifecycle.ts',
  'apps/web/src/lib/executor-request-defs.ts',
].map((p) => path.join(repoRoot, p));
const OPENAPI_YAML = path.join(repoRoot, 'contracts/openapi/fudcourt.yaml');
const CATALOG_JSON = path.join(repoRoot, 'contracts/events/events.json');
const EVENT_SCHEMA_JSON = path.join(repoRoot, 'contracts/events/events.json');
const CLIENT_TS = path.join(repoRoot, 'apps/web/src/features/executor/client.ts');
const APP_DIR = path.join(repoRoot, 'apps/web/src/app');

const CHECKED_ENUMS = ['ExecutionStatus', 'ChildOrderStatus', 'ExecutionEventName'];

const failures = [];

/** Parse `export type NAME = 'a' | 'b' | ... ;` into its string literal values. */
function parseLiteralUnion(tsSource, name) {
  const m = tsSource.match(new RegExp(`export type ${name}\\s*=\\s*([\\s\\S]*?);`));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** All documented paths → their methods. */
function parseYamlPaths(yaml) {
  const paths = new Map();
  let current = null;
  for (const line of yaml.split('\n')) {
    const p = line.match(/^  (\/api\/\S*):$/);
    if (p) {
      current = p[1];
      paths.set(current, new Set());
      continue;
    }
    const method = line.match(/^    (get|post|put|delete|patch):$/);
    if (method && current) paths.get(current).add(method[1].toUpperCase());
  }
  return paths;
}

/** Recursively find route.ts handlers under a root. */
function findRouteFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts') out.push(full);
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Load ground truth
// ---------------------------------------------------------------------------
let typesTs;
let openapiYaml;
let catalog;
let eventSchema;
let clientTs;
try {
  typesTs = TYPES_TS.map((p) => readFileSync(p, 'utf8')).join('\n');
  openapiYaml = readFileSync(OPENAPI_YAML, 'utf8');
  catalog = JSON.parse(readFileSync(CATALOG_JSON, 'utf8'));
  eventSchema = JSON.parse(readFileSync(EVENT_SCHEMA_JSON, 'utf8'));
  clientTs = readFileSync(CLIENT_TS, 'utf8');
} catch (err) {
  console.error(`CONTRACT_FAIL cannot read contract inputs: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// (a0) OpenAPI structural parseability: this gate is dependency-free (no YAML
// parser), so it hand-parses the pieces it consumes. Assert the document at
// least parses to the top-level shape every check below assumes — a malformed
// or truncated fudcourt.yaml would otherwise degrade into "0 paths, 0 enums"
// non-failures rather than a red gate.
if (!/^openapi:\s*\S+\s*$/m.test(openapiYaml)) {
  failures.push('openapi: no top-level `openapi:` version key — not a parseable OpenAPI document');
}
if (!/^paths:\s*$/m.test(openapiYaml)) {
  failures.push('openapi: no top-level `paths:` block — not a parseable OpenAPI document');
}
// (a) enums: OpenAPI components vs types.ts literal unions
// ---------------------------------------------------------------------------
const parsedOpenApiEnums = parseOpenApiEnums(openapiYaml);
let enumChecks = 0;
for (const name of CHECKED_ENUMS) {
  const tsValues = parseLiteralUnion(typesTs, name);
  const yamlValues = parsedOpenApiEnums.get(name) ?? null;
  if (!tsValues) {
    failures.push(`enum ${name}: literal union not found in types.ts`);
    continue;
  }
  if (!yamlValues) {
    failures.push(`enum ${name}: enum block not found in openapi components`);
    continue;
  }
  enumChecks += 1;
  const tsSet = new Set(tsValues);
  const yamlSet = new Set(yamlValues);
  for (const v of tsSet) if (!yamlSet.has(v)) failures.push(`enum ${name}: '${v}' missing from OpenAPI`);
  for (const v of yamlSet) if (!tsSet.has(v)) failures.push(`enum ${name}: '${v}' in OpenAPI but not in types.ts`);
  if (tsSet.size !== yamlValues.length) {
    failures.push(`enum ${name}: count mismatch (types.ts=${tsSet.size} openapi=${yamlValues.length})`);
  }
}

// ---------------------------------------------------------------------------
// (b) paths: OpenAPI vs route handlers under apps/web/src/app/**/api/**
// ---------------------------------------------------------------------------
const routeFiles = findRouteFiles(APP_DIR).filter((f) => f.includes(`${path.sep}api${path.sep}`));
const handlerMap = new Map(); // normalized path -> { file, methods }
for (const file of routeFiles) {
  const rel = file.slice(APP_DIR.length + 1).split(path.sep).join('/');
  const idx = rel.lastIndexOf('api/');
  const routeKey = rel.slice(idx + 'api/'.length).replace(/\/route\.ts$/, '');
  const source = readFileSync(file, 'utf8');
  const methods = new Set();
  for (const m of source.matchAll(/export (?:async )?function (GET|POST|PUT|DELETE|PATCH)\b/g)) methods.add(m[1]);
  for (const m of source.matchAll(/export const (GET|POST|PUT|DELETE|PATCH)\b/g)) methods.add(m[1]);
  handlerMap.set(routeKey, { file: rel, methods });
}

// The collapsed pure-passthrough surface (ADR-006) is one catch-all gateway:
// a documented path with no specific handler is valid IFF the gateway serves
// its first segment and exports the documented method. Read its routing table.
const GATEWAY_TS = path.join(APP_DIR, '(frontend)', 'api', '[...path]', 'route.ts');
let gateway = null;
try {
  const src = readFileSync(GATEWAY_TS, 'utf8');
  const names = src.match(/const DATA_FAMILY_NAMES\s*=\s*\[([^\]]*)\]/);
  const families = names ? [...names[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]) : [];
  const methods = new Set();
  for (const m of src.matchAll(/export (?:async )?function (GET|POST|PUT|DELETE|PATCH)\b/g)) methods.add(m[1]);
  gateway = {
    file: path.relative(repoRoot, GATEWAY_TS),
    segments: new Set([...families, 'reconcile', 'executor']),
    methods,
  };
} catch {
  // No gateway on disk: every documented path must then have its own handler.
}

const openapiPaths = parseYamlPaths(openapiYaml);
let pathChecks = 0;
for (const [openapiPath, methods] of openapiPaths) {
  const routeKey = openapiPath.replace(/^\/api\//, '').replace(/\{([^}]+)\}/g, '[$1]');
  pathChecks += 1;
  const handler = handlerMap.get(routeKey);
  if (!handler) {
    const firstSeg = routeKey.split('/')[0];
    if (gateway && gateway.segments.has(firstSeg)) {
      for (const method of methods) {
        if (!gateway.methods.has(method)) {
          failures.push(`path ${openapiPath}: gateway ${gateway.file} does not export ${method}`);
        }
      }
      continue;
    }
    failures.push(
      `path ${openapiPath}: no route handler at apps/web/src/app/**/api/${routeKey}/route.ts ` +
        `and no gateway segment serves '${firstSeg}'`,
    );
    continue;
  }
  for (const method of methods) {
    if (!handler.methods.has(method)) {
      failures.push(`path ${openapiPath}: handler ${handler.file} does not export ${method}`);
    }
  }
}
// The reverse direction: every executor route handler must be documented.
for (const [routeKey, handler] of handlerMap) {
  if (!routeKey.startsWith('executor/')) continue;
  const openapiPath = `/api/${routeKey.replace(/\[([^\]]+)\]/g, '{$1}')}`;
  if (!openapiPaths.has(openapiPath)) {
    failures.push(`route ${handler.file}: ${openapiPath} is not documented in the OpenAPI`);
  }
}

// ---------------------------------------------------------------------------
// (c) events catalog covers every ExecutionEventName value
// ---------------------------------------------------------------------------
const eventNames = parseLiteralUnion(typesTs, 'ExecutionEventName') ?? [];
const catalogNames = new Set();
const catalogIds = new Set();
for (const entry of catalog.events) {
  catalogIds.add(entry.id);
  catalogNames.add(entry.id);
  for (const alias of entry.aliases ?? []) catalogNames.add(alias);
  for (const name of entry.objective_names ?? []) catalogNames.add(name);
}
for (const name of eventNames) {
  if (!catalogNames.has(name)) {
    failures.push(`events catalog: ExecutionEventName '${name}' is not mapped (id, alias or objective name)`);
  }
}
const schemaEnum = eventSchema?.$defs?.Event?.allOf?.[1]?.properties?.event_type?.enum ?? [];
const schemaSet = new Set(schemaEnum);
for (const id of catalogIds) {
  if (!schemaSet.has(id)) failures.push(`event.schema.json: event_type enum missing catalog id '${id}'`);
}
for (const id of schemaSet) {
  if (!catalogIds.has(id)) failures.push(`event.schema.json: event_type '${id}' is not a catalog id`);
}
// ---------------------------------------------------------------------------
// (d) client.ts header comment: every documented endpoint is in the OpenAPI
// ---------------------------------------------------------------------------
let clientEndpointChecks = 0;
const headerEnd = clientTs.indexOf('*/');
const header = headerEnd === -1 ? clientTs : clientTs.slice(0, headerEnd);
for (const m of header.matchAll(/^\s*\*\s+(GET|POST|PUT|DELETE|PATCH)\s+(\/api\/\S+)/gm)) {
  const method = m[1];
  // `/api/executor/executions[?status=]` -> path is the part before `[`;
  // `:id` style params map to OpenAPI `{id}` style.
  const rawPath = m[2].replace(/\[.*$/, '');
  const openapiPath = rawPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  clientEndpointChecks += 1;
  const methods = openapiPaths.get(openapiPath);
  if (!methods) {
    failures.push(`client.ts header: ${method} ${rawPath} is not documented in the OpenAPI`);
  } else if (!methods.has(method)) {
    failures.push(`client.ts header: ${method} ${rawPath} is not documented (path exists without ${method})`);
  }
}
if (clientEndpointChecks === 0) {
  failures.push('client.ts header: no endpoints parsed from the header comment (parser drift?)');
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  for (const f of failures) console.error(`CONTRACT_FAIL ${f}`);
  console.error(`CONTRACT_FAIL ${failures.length} problem(s)`);
  process.exit(1);
}
console.log(
  `CONTRACTS_OK enums=${enumChecks} openapi_paths=${pathChecks} route_handlers=${handlerMap.size} events=${catalog.events.length} client_endpoints=${clientEndpointChecks}`,
);

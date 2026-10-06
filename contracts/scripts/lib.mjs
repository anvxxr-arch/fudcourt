#!/usr/bin/env node
/**
 * lib.mjs — shared helpers for the contracts/scripts gates.
 *
 * Two things every gate in this directory used to re-implement on its own:
 *   - how to find the repository root from a script in this directory;
 *   - how to hand-parse `enum:` blocks out of the OpenAPI YAML (the gates are
 *     deliberately dependency-free: no YAML parser, so each one used to grow
 *     its own slightly different copy).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the repository root (two levels up from this file:
 * contracts/scripts -> repo root).
 */
export function repoRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, '..', '..');
}

/**
 * Parse every `Name:` ... `      enum:` ... `        - VALUE` block in an
 * OpenAPI YAML document into a Map of schema name -> enum values (first
 * occurrence wins; names with an empty enum block are omitted).
 */
export function parseOpenApiEnums(yamlText) {
  const enums = new Map();
  let current = null;
  let inEnum = false;
  let values = [];
  const flush = () => {
    if (current !== null && inEnum && values.length > 0 && !enums.has(current)) {
      enums.set(current, values);
    }
    inEnum = false;
    values = [];
  };
  for (const line of yamlText.split('\n')) {
    if (inEnum) {
      const item = line.match(/^        - (\S+)\s*$/);
      if (item) {
        values.push(item[1]);
        continue;
      }
      flush();
    }
    if (line.trim() === '') continue;
    if (/^\s{0,4}\S/.test(line)) {
      const schema = line.match(/^    (\S[^:]*):$/);
      current = schema ? schema[1] : null;
      continue;
    }
    if (line === '      enum:' && current !== null) {
      inEnum = true;
      values = [];
    }
  }
  flush();
  return enums;
}

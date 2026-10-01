#!/usr/bin/env bun
/**
 * pg-load.ts — CLI wrapper over the app's Turso -> Postgres projection (DR-019).
 *
 * The projection itself lives in the app (platform/db/mirror.ts) because the
 * write path calls it in-process; this exists so a timer, a deploy step, or an
 * operator can run it without a server round trip.
 *
 * Usage: bun run scripts/tools/pg-load.ts
 */
import { loadFromMirror } from '@/platform/db/mirror';

const report = await loadFromMirror();
console.log(`pg-load: ${Object.entries(report).map(([t, n]) => `${t}=${n}`).join(' ')}`);
process.exit(0);

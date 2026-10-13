// Minimal ambient declarations so the bot typechecks with ZERO dependencies:
// no @types/node, no @types/bun. Everything the bot touches beyond the DOM lib
// (which supplies fetch/WebSocket/Response/timers/console) is declared here.
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode: number | undefined;
  exit(code?: number): never;
};

declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): { href: string };
  export function fileURLToPath(url: string): string;
}

declare module "bun:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function expect(value: any): any;
}

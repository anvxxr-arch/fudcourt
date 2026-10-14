// Stores — the registries the client reads from. Sapphire keeps a store per
// piece (commands, listeners, preconditions); these are the same idea in plain
// Maps, ordered by insertion so menus are stable.

import type { Command } from "./command.ts";
import type { Listener } from "./listener.ts";
import type { Precondition } from "./precondition.ts";

export class CommandStore {
  private readonly byKey = new Map<string, Command>();
  private readonly order: string[] = [];

  /** key namespaces a command by its KIND — a slash `/ban` and a user-context
   * "Ban" share the name but are different commands, and Discord registers them
   * separately, so the store must not let one shadow the other. */
  private static key(name: string, type = 1): string {
    return `${type}:${name}`;
  }

  add(cmd: Command): void {
    const k = CommandStore.key(cmd.name, cmd.type);
    if (!this.byKey.has(k)) this.order.push(k);
    this.byKey.set(k, cmd);
  }

  get(name: string, type = 1): Command | undefined {
    return this.byKey.get(CommandStore.key(name, type));
  }

  has(name: string, type = 1): boolean {
    return this.byKey.has(CommandStore.key(name, type));
  }

  all(): Command[] {
    return this.order.map((n) => this.byKey.get(n)!).filter(Boolean);
  }

  get size(): number {
    return this.byKey.size;
  }
}

export class ListenerStore {
  private readonly listeners: Listener[] = [];

  add(l: Listener): void {
    this.listeners.push(l);
  }

  /** forEvent returns the listeners bound to one gateway event, in load order. */
  forEvent(event: string): Listener[] {
    return this.listeners.filter((l) => l.event === event);
  }

  all(): Listener[] {
    return [...this.listeners];
  }

  get size(): number {
    return this.listeners.length;
  }
}

export class PreconditionStore {
  private readonly byName = new Map<string, Precondition>();

  add(p: Precondition): void {
    this.byName.set(p.name, p);
  }

  get(name: string): Precondition | undefined {
    return this.byName.get(name);
  }

  all(): Precondition[] {
    return [...this.byName.values()];
  }

  get size(): number {
    return this.byName.size;
  }
}

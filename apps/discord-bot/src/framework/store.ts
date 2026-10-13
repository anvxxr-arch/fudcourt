// Stores — the registries the client reads from. Sapphire keeps a store per
// piece (commands, listeners, preconditions); these are the same idea in plain
// Maps, ordered by insertion so menus are stable.

import type { Command } from "./command.ts";
import type { Listener } from "./listener.ts";
import type { Precondition } from "./precondition.ts";

export class CommandStore {
  private readonly byName = new Map<string, Command>();
  private readonly order: string[] = [];

  add(cmd: Command): void {
    if (!this.byName.has(cmd.name)) this.order.push(cmd.name);
    this.byName.set(cmd.name, cmd);
  }

  get(name: string): Command | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  all(): Command[] {
    return this.order.map((n) => this.byName.get(n)!).filter(Boolean);
  }

  get size(): number {
    return this.byName.size;
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

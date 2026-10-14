// RoleService — grants and revokes roles for the role panels and autoroles.
// Every mutation is hierarchy-checked first (the bot may only touch a role
// strictly BELOW its own highest role) and every attempt — success or refusal —
// is persisted to `role_assignments`, so a role the bot cannot grant is visible
// to an operator instead of failing silently.
//
// The check is the same shape as moderation's: a role at or above the bot's top
// position is never attempted. This is a pure decision (`canManage`) separated
// from the I/O, so it is unit-tested directly.

import type { GuildRole } from "../framework/types.ts";

/** One persisted grant/revoke attempt. */
export interface RoleAssignment {
  userId: string;
  roleId: string;
  action: "add" | "remove";
  source: string;
  status: "ok" | "failed";
  error: string;
}

export interface RoleServiceDeps {
  /** The guild's roles (for hierarchy). */
  listRoles: () => Promise<GuildRole[]>;
  /** The bot's own highest role position. */
  botTop: () => Promise<number>;
  addRole: (userId: string, roleId: string, reason?: string) => Promise<void>;
  removeRole: (userId: string, roleId: string, reason?: string) => Promise<void>;
  /** Persist one attempt (loopback to the api). */
  record: (a: RoleAssignment) => Promise<void>;
  log: (msg: string) => void;
}

export class RoleService {
  constructor(private readonly deps: RoleServiceDeps) {}

  /**
   * canManage reports whether the bot may grant/revoke `roleId`: the role must
   * exist and sit strictly below the bot's highest role. A missing role or one
   * at/above the bot is refused (with a reason for the assignment record).
   */
  canManage(roleId: string, roles: readonly GuildRole[], botTop: number): { ok: boolean; reason: string } {
    const role = roles.find((r) => r.id === roleId);
    if (!role) return { ok: false, reason: "role not found in this guild" };
    if (role.position >= botTop) {
      return { ok: false, reason: "role is at or above the bot's highest role — move the bot role up" };
    }
    return { ok: true, reason: "" };
  }

  /** grant adds a role (hierarchy-checked) and records the attempt. Returns whether it landed. */
  async grant(userId: string, roleId: string, source: string): Promise<boolean> {
    return this.mutate("add", userId, roleId, source);
  }

  /** revoke removes a role (hierarchy-checked) and records the attempt. */
  async revoke(userId: string, roleId: string, source: string): Promise<boolean> {
    return this.mutate("remove", userId, roleId, source);
  }

  /**
   * apply runs a whole selection (the add/remove set from the panel logic),
   * granting then revoking, and returns how many landed. Each role is recorded
   * independently so a partial failure is fully visible.
   */
  async apply(userId: string, add: readonly string[], remove: readonly string[], source: string): Promise<{ ok: number; failed: number }> {
    let ok = 0;
    let failed = 0;
    for (const roleId of add) (await this.mutate("add", userId, roleId, source)) ? ok++ : failed++;
    for (const roleId of remove) (await this.mutate("remove", userId, roleId, source)) ? ok++ : failed++;
    return { ok, failed };
  }

  private async mutate(action: "add" | "remove", userId: string, roleId: string, source: string): Promise<boolean> {
    let roles: GuildRole[];
    let botTop: number;
    try {
      [roles, botTop] = await Promise.all([this.deps.listRoles(), this.deps.botTop()]);
    } catch (err) {
      await this.record({ userId, roleId, action, source, status: "failed", error: `hierarchy lookup failed: ${errText(err)}` });
      return false;
    }
    const check = this.canManage(roleId, roles, botTop);
    if (!check.ok) {
      await this.record({ userId, roleId, action, source, status: "failed", error: check.reason });
      return false;
    }
    try {
      if (action === "add") await this.deps.addRole(userId, roleId, "fudzie autorole/panel");
      else await this.deps.removeRole(userId, roleId, "fudzie autorole/panel");
    } catch (err) {
      await this.record({ userId, roleId, action, source, status: "failed", error: errText(err) });
      return false;
    }
    await this.record({ userId, roleId, action, source, status: "ok", error: "" });
    return true;
  }

  private async record(a: RoleAssignment): Promise<void> {
    try {
      await this.deps.record(a);
    } catch (err) {
      this.deps.log(`role assignment record failed: ${errText(err)}`);
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

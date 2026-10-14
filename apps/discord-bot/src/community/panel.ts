// Role-panel selection logic — PURE. Given a panel's mode and the roles a member
// currently holds, it decides which roles to ADD and which to REMOVE when they
// pick an option. No client, no REST, so the tricky exclusivity rules are
// unit-tested directly instead of only through a live guild.
//
// Modes:
//   toggle    — the picked option flips: add if absent, remove if present.
//   single    — at most one option from the whole panel is held: add the pick,
//               remove every OTHER option's role.
//   multiple  — the pick is added and stays; nothing else is touched (a
//               multi-select sends its full chosen set, handled by `applySelect`).
//   exclusive — like single but scoped to the pick's `exclusiveGroup`: add the
//               pick, remove the other options in the SAME group only.

import type { RolePanel, RolePanelOption } from "./types.ts";

export interface Selection {
  /** Roles to grant (a member's current roles are the caller's input). */
  add: string[];
  /** Roles to revoke. */
  remove: string[];
}

/**
 * pickOption computes the add/remove set for ONE option being chosen, given the
 * roles the member already holds. `held` is the member's current role ids.
 */
export function pickOption(panel: RolePanel, option: RolePanelOption, held: readonly string[]): Selection {
  const has = (id: string): boolean => held.includes(id);
  switch (panel.mode) {
    case "toggle":
      return has(option.roleId) ? { add: [], remove: [option.roleId] } : { add: [option.roleId], remove: [] };
    case "single": {
      const remove = panel.options.filter((o) => o.roleId !== option.roleId && has(o.roleId)).map((o) => o.roleId);
      return { add: has(option.roleId) ? [] : [option.roleId], remove };
    }
    case "exclusive": {
      const siblings = panel.options.filter((o) => o.exclusiveGroup === option.exclusiveGroup && o.roleId !== option.roleId);
      const remove = siblings.filter((o) => has(o.roleId)).map((o) => o.roleId);
      return { add: has(option.roleId) ? [] : [option.roleId], remove };
    }
    case "multiple":
      // A single button in a multiple panel behaves as a plain add (no toggle off
      // by default; the select variant sends the whole set via applySelect).
      return has(option.roleId) ? { add: [], remove: [] } : { add: [option.roleId], remove: [] };
  }
}

/**
 * applySelect computes the add/remove set for a multi-select submission: the
 * member's chosen role ids (`chosen`) become exactly what they hold for THIS
 * panel's option set — any panel role not chosen is removed, any chosen role not
 * held is added. Roles outside the panel are never touched.
 */
export function applySelect(panel: RolePanel, chosen: readonly string[], held: readonly string[]): Selection {
  const panelRoles = new Set(panel.options.map((o) => o.roleId));
  const chosenSet = new Set(chosen.filter((r) => panelRoles.has(r)));
  const add: string[] = [];
  const remove: string[] = [];
  for (const r of chosenSet) if (!held.includes(r)) add.push(r);
  for (const o of panel.options) if (!chosenSet.has(o.roleId) && held.includes(o.roleId)) remove.push(o.roleId);
  return { add, remove };
}

/**
 * panelFromMessage finds the panel a raw interaction belongs to: button/select
 * custom_ids carry `rp:<panelId>:<roleId>`; a reaction maps message → panel via
 * the panel's stored message_id. Returns undefined when the interaction is not a
 * panel interaction, so the caller can fall through to its normal router.
 */
export function panelIdFromCustomId(customId: string): { panelId: string; roleId: string } | undefined {
  if (!customId.startsWith("rp:")) return undefined;
  const parts = customId.split(":");
  // `rp:<panelId>` — a select menu (the chosen roles arrive in `values`).
  if (parts.length === 2 && parts[1]) return { panelId: parts[1], roleId: "" };
  // `rp:<panelId>:<roleId>` — a button bound to one role.
  if (parts.length === 3 && parts[1] && parts[2]) return { panelId: parts[1], roleId: parts[2] };
  return undefined;
}

/**
 * customId builds the id a panel control carries: `rp:<panelId>:<roleId>` for a
 * button, `rp:<panelId>` for a select (the selection travels in `values`).
 */
export function customId(panelId: string, roleId?: string): string {
  return roleId ? `rp:${panelId}:${roleId}` : `rp:${panelId}`;
}

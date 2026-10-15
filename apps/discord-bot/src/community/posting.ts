// PanelPoster — posts a configured role panel as a LIVE Discord message.
//
// WHY THIS EXISTS: the panel handler existed, the panel config existed, the
// dashboard could edit both — and nothing ever posted a panel. The bot could
// read a panel, validate it and honour an interaction on it, but a button/select
// panel was unreachable (the REST layer carried no components) and a reaction
// panel needed a human to post the message and paste its id into the config.
// This closes the loop: post the message, add the reactions a reaction panel
// needs, replace the previous message, and record the new message id over
// loopback so the reactions can be matched from then on.

import { buildPanelPost, panelPostNotes, panelPostProblem, type ActionRow } from "./poster.ts";
import type { RolePanel } from "./types.ts";

export interface PanelPosterDeps {
  /** The guild's panels (read fresh; the api caches them). */
  panels: () => Promise<RolePanel[]>;
  post: (channelId: string, data: { content: string; components: ActionRow[] }) => Promise<{ id: string }>;
  react: (channelId: string, messageId: string, emoji: string) => Promise<void>;
  remove: (channelId: string, messageId: string) => Promise<void>;
  record: (r: { panelId: string; channelId: string; messageId: string }) => Promise<{ ok: boolean; detail?: string }>;
  log: (msg: string) => void;
}

export interface PostResult {
  ok: boolean;
  /** The posted message id (ok only). */
  messageId?: string;
  channelId?: string;
  /** The message id this post replaced, when one was deleted. */
  replaced?: string;
  /** What makes the posted panel behave worse than it looks — the post went out anyway. */
  notes: string[];
  /** Why nothing was posted. */
  error?: string;
  /** The panel ids that DO exist, for a typo'd id. */
  available?: string[];
}

export class PanelPoster {
  constructor(private readonly deps: PanelPosterDeps) {}

  async post(panelId: string, channelId?: string, force = false): Promise<PostResult> {
    const id = panelId.trim();
    if (id === "") return { ok: false, error: "give a panel id", notes: [] };

    let panels: RolePanel[];
    try {
      panels = await this.deps.panels();
    } catch (err) {
      return { ok: false, error: `could not load the panels: ${errText(err)}`, notes: [] };
    }
    const panel = panels.find((p) => p.id === id);
    if (!panel) return { ok: false, error: `no panel with id "${id}"`, notes: [], available: panels.map((p) => p.id) };

    const target = (channelId ?? "").trim() || panel.channelId.trim();
    if (target === "") return { ok: false, error: "this panel has no channel — name one", notes: [] };
    if (panel.messageId !== "" && !force) {
      return {
        ok: false,
        error: `this panel is already posted as message ${panel.messageId} — pass force to re-post it`,
        notes: [],
      };
    }

    const problem = panelPostProblem(panel);
    if (problem !== "") return { ok: false, error: problem, notes: [] };

    const notes = panelPostNotes(panel);
    const built = buildPanelPost(panel);

    let messageId: string;
    try {
      const msg = await this.deps.post(target, { content: built.content, components: built.components });
      messageId = msg.id;
    } catch (err) {
      return { ok: false, error: `Discord refused the message: ${errText(err)}`, notes };
    }

    // A reaction that fails to land is a role nobody can pick, so it is reported
    // rather than swallowed — the panel is live, but not as configured.
    const failed: string[] = [];
    for (const emoji of built.reactions) {
      try {
        await this.deps.react(target, messageId, emoji);
      } catch {
        failed.push(emoji);
      }
    }
    if (failed.length > 0) {
      notes.push(`${failed.length} reaction(s) could not be added (${failed.join(", ")}) — those options cannot be picked`);
    }

    // Replace only now that the new message exists: a refused post must not leave
    // the channel with no panel at all.
    let replaced: string | undefined;
    if (panel.messageId !== "" && panel.messageId !== messageId) {
      try {
        await this.deps.remove(panel.channelId.trim() || target, panel.messageId);
        replaced = panel.messageId;
      } catch {
        notes.push(`the previous message ${panel.messageId} could not be deleted — check the channel for two panels`);
      }
    }

    let recorded = true;
    let recordDetail = "";
    try {
      const res = await this.deps.record({ panelId: panel.id, channelId: target, messageId });
      recorded = res.ok;
      recordDetail = res.detail ?? "";
    } catch (err) {
      recorded = false;
      recordDetail = errText(err);
    }
    if (!recorded) {
      // The two kinds of panel lose different things here, so say which one.
      notes.push(
        panel.kind === "reaction"
          ? `the api did not record the message id (${recordDetail}) — reactions cannot be matched until it does`
          : `the api did not record the message id (${recordDetail}) — the dashboard will not show the posted message`,
      );
    }

    return { ok: true, messageId, channelId: target, ...(replaced ? { replaced } : {}), notes };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

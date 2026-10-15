import { describe, expect, test } from "bun:test";

import { PanelPoster, type PanelPosterDeps } from "../src/community/posting.ts";
import type { RolePanel, RolePanelOption } from "../src/community/types.ts";

const opt = (o: Partial<RolePanelOption> = {}): RolePanelOption => ({
  roleId: "100000000000000010",
  label: "Red",
  emoji: "",
  style: "secondary",
  position: 0,
  exclusiveGroup: "",
  ...o,
});

const panel = (o: Partial<RolePanel> = {}): RolePanel => ({
  id: "colors",
  channelId: "100000000000000001",
  messageId: "",
  title: "Colours",
  description: "Pick one",
  kind: "button",
  mode: "toggle",
  enabled: true,
  options: [opt()],
  ...o,
});

/** A recorder over the deps, so every call the poster makes is asserted. */
function harness(panels: RolePanel[], over: Partial<PanelPosterDeps> = {}) {
  const calls = { post: [] as Array<{ channelId: string; data: unknown }>, react: [] as string[], remove: [] as string[], record: [] as string[] };
  let messageId = "900000000000000001";
  const deps: PanelPosterDeps = {
    panels: async () => panels,
    post: async (channelId, data) => {
      calls.post.push({ channelId, data });
      return { id: messageId };
    },
    react: async (_c, _m, emoji) => void calls.react.push(emoji),
    remove: async (channelId, m) => void calls.remove.push(`${channelId}/${m}`),
    record: async (r) => {
      calls.record.push(`${r.panelId}/${r.channelId}/${r.messageId}`);
      return { ok: true };
    },
    log: () => {},
    ...over,
  };
  return { poster: new PanelPoster(deps), calls, setMessageId: (id: string) => void (messageId = id) };
}

describe("PanelPoster — a panel that has never been posted", () => {
  test("posts the body and the components, records the message, adds no reactions", async () => {
    const { poster, calls } = harness([panel({ options: [opt(), opt({ roleId: "100000000000000011", label: "Blue" })] })]);
    const res = await poster.post("colors");
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("900000000000000001");
    expect(res.channelId).toBe("100000000000000001"); // the panel's own channel
    expect(res.notes).toEqual([]);
    expect(calls.post).toHaveLength(1);
    const data = calls.post[0]!.data as { content: string; components: unknown[] };
    expect(data.content).toBe("Colours\nPick one");
    expect(data.components).toHaveLength(1);
    expect(calls.react).toEqual([]);
    expect(calls.record).toEqual(["colors/100000000000000001/900000000000000001"]);
  });

  test("a named channel wins over the panel's own", async () => {
    const { poster, calls } = harness([panel()]);
    const res = await poster.post("colors", "100000000000000009");
    expect(res.channelId).toBe("100000000000000009");
    expect(calls.post[0]!.channelId).toBe("100000000000000009");
    expect(calls.record).toEqual(["colors/100000000000000009/900000000000000001"]);
  });

  test("a reaction panel reacts in option order", async () => {
    const { poster, calls } = harness([
      panel({ kind: "reaction", options: [opt({ emoji: "🍎" }), opt({ roleId: "100000000000000011", emoji: "rules:42" })] }),
    ]);
    const res = await poster.post("colors");
    expect(res.ok).toBe(true);
    expect(calls.react).toEqual(["🍎", "rules:42"]);
    expect((calls.post[0]!.data as { components: unknown[] }).components).toEqual([]);
  });
});

describe("PanelPoster — refusals before anything is posted", () => {
  test("no panel with that id lists the ids that do exist", async () => {
    const { poster, calls } = harness([panel({ id: "roles" }), panel({ id: "colors" })]);
    const res = await poster.post("colour");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no panel with id "colour"/);
    expect(res.available).toEqual(["roles", "colors"]);
    expect(calls.post).toEqual([]);
  });

  test("an empty id does not even read the panels", async () => {
    let read = 0;
    const { poster } = harness([], { panels: async () => { read++; return []; } });
    const res = await poster.post("   ");
    expect(res.error).toBe("give a panel id");
    expect(read).toBe(0);
  });

  test("a panel with no channel anywhere is refused", async () => {
    const { poster } = harness([panel({ channelId: "" })]);
    const res = await poster.post("colors");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("this panel has no channel — name one");
  });

  test("an already-posted panel is refused until force", async () => {
    const { poster, calls } = harness([panel({ messageId: "800000000000000001" })]);
    const res = await poster.post("colors");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("this panel is already posted as message 800000000000000001 — pass force to re-post it");
    expect(calls.post).toEqual([]);
  });

  test("a panel the platform would reject is refused with the reason, and nothing is posted", async () => {
    const { poster, calls } = harness([panel({ options: [] })]);
    const res = await poster.post("colors");
    expect(res.error).toBe("the panel has no options");
    expect(calls.post).toEqual([]);
  });
});

describe("PanelPoster — re-posting", () => {
  test("force posts the new message and only then deletes the old one", async () => {
    const { poster, calls, setMessageId } = harness([panel({ messageId: "800000000000000001" })]);
    setMessageId("900000000000000002");
    const res = await poster.post("colors", undefined, true);
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("900000000000000002");
    expect(res.replaced).toBe("800000000000000001");
    expect(calls.remove).toEqual(["100000000000000001/800000000000000001"]);
    expect(calls.record).toEqual(["colors/100000000000000001/900000000000000002"]);
  });

  test("a refused post leaves the old message alone", async () => {
    const { calls, ...rest } = harness([panel({ messageId: "800000000000000001" })], {
      post: async () => {
        throw new Error("Discord 403 /channels/x/messages: Missing Permissions");
      },
    });
    const res = await rest.poster.post("colors", undefined, true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Discord refused the message: Discord 403/);
    expect(calls.remove).toEqual([]);
    expect(calls.record).toEqual([]);
  });
});

describe("PanelPoster — what the operator has to be told", () => {
  test("a reaction that will not land is named, and the panel is still live", async () => {
    const { poster } = harness([panel({ kind: "reaction", options: [opt({ emoji: "🍎" }), opt({ roleId: "100000000000000011", emoji: "🍏" })] })], {
      react: async (_c, _m, emoji) => {
        if (emoji === "🍏") throw new Error("Discord 400: invalid emoji");
      },
    });
    const res = await poster.post("colors");
    expect(res.ok).toBe(true);
    expect(res.notes).toEqual(["1 reaction(s) could not be added (🍏) — those options cannot be picked"]);
  });

  test("a record the api refused is reported by consequence, and differs per panel kind", async () => {
    const refused = { ok: false, detail: "404 panel_not_found" };
    const reaction = harness([panel({ kind: "reaction", options: [opt({ emoji: "🍎" })] })], { record: async () => refused });
    const a = await reaction.poster.post("colors");
    expect(a.ok).toBe(true);
    expect(a.notes).toEqual(["the api did not record the message id (404 panel_not_found) — reactions cannot be matched until it does"]);

    const button = harness([panel()], { record: async () => refused });
    const b = await button.poster.post("colors");
    expect(b.ok).toBe(true);
    expect(b.notes).toEqual(["the api did not record the message id (404 panel_not_found) — the dashboard will not show the posted message"]);
  });

  test("a record that throws is treated the same as one that is refused", async () => {
    const { poster } = harness([panel()], {
      record: async () => {
        throw new Error("fetch failed");
      },
    });
    const res = await poster.post("colors");
    expect(res.ok).toBe(true);
    expect(res.notes).toEqual(["the api did not record the message id (fetch failed) — the dashboard will not show the posted message"]);
  });

  test("an old message that will not delete leaves two panels, and says so", async () => {
    const { poster } = harness([panel({ messageId: "800000000000000001" })], {
      remove: async () => {
        throw new Error("Discord 404: Unknown Message");
      },
    });
    const res = await poster.post("colors", undefined, true);
    expect(res.ok).toBe(true);
    expect(res.replaced).toBeUndefined();
    expect(res.notes).toEqual(["the previous message 800000000000000001 could not be deleted — check the channel for two panels"]);
  });

  test("a switched-off panel and a dead option are notes, not refusals", async () => {
    const { poster, calls } = harness([
      panel({ enabled: false, kind: "reaction", options: [opt({ emoji: "" })] }),
    ]);
    const res = await poster.post("colors");
    expect(res.ok).toBe(true);
    expect(res.notes).toEqual([
      "this panel is switched off — members will be told it is no longer available",
      "1 option(s) have no emoji and can never fire: 100000000000000010",
    ]);
    expect(calls.post).toHaveLength(1);
  });

  test("panels that cannot be read are an error, not a crash", async () => {
    const { poster } = harness([], {
      panels: async () => {
        throw new Error("fetch failed");
      },
    });
    const res = await poster.post("colors");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("could not load the panels: fetch failed");
  });
});

import { describe, expect, test } from "bun:test";

import { memberVars, renderEmbed, renderTemplate } from "../src/community/templates.ts";

describe("renderTemplate", () => {
  test("substitutes known variables", () => {
    expect(renderTemplate("Welcome {user} to {server}!", { user: "<@1>", server: "Fud" })).toBe("Welcome <@1> to Fud!");
  });

  test("leaves an unknown placeholder verbatim (no silent hole)", () => {
    expect(renderTemplate("hi {oops}", { user: "<@1>" })).toBe("hi {oops}");
  });

  test("a nested/odd brace is not a token", () => {
    expect(renderTemplate("a {b{c}} d", { b: "X" })).toBe("a {b{c}} d");
  });

  test("replaces every occurrence", () => {
    expect(renderTemplate("{x}-{x}", { x: "7" })).toBe("7-7");
  });

  test("empty template is empty", () => {
    expect(renderTemplate("", { a: "1" })).toBe("");
  });

  test("a value containing braces is not re-scanned", () => {
    expect(renderTemplate("{a}", { a: "{b}", b: "no" })).toBe("{b}");
  });
});

describe("renderEmbed", () => {
  test("templates title/description/footer/fields", () => {
    const out = renderEmbed(
      { title: "Hi {username}", description: "welcome {user}", color: 1, footer: { text: "in {server}" }, fields: [{ name: "{member_count}", value: "count" }] },
      { username: "bob", user: "<@1>", server: "Fud", member_count: "42" },
    );
    expect(out?.title).toBe("Hi bob");
    expect(out?.description).toBe("welcome <@1>");
    expect(out?.color).toBe(1);
    expect(out?.footer?.text).toBe("in Fud");
    expect(out?.fields?.[0]?.name).toBe("42");
  });

  test("undefined embed stays undefined", () => {
    expect(renderEmbed(undefined, {})).toBeUndefined();
  });
});

describe("memberVars", () => {
  test("builds the standard set with a snowflake-derived created_at", () => {
    const v = memberVars({ userId: "123", username: "bob", displayName: "Bobby", guildName: "Fud", memberCount: 42, createdAt: "1750000000000" });
    expect(v.user).toBe("<@123>");
    expect(v.username).toBe("bob");
    expect(v.display_name).toBe("Bobby");
    expect(v.server).toBe("Fud");
    expect(v.member_count).toBe("42");
    expect(v.created_at).toBe("<t:1750000000:D>");
  });

  test("display_name falls back to username when no nick", () => {
    expect(memberVars({ userId: "1", username: "bob" }).display_name).toBe("bob");
  });

  test("a raw snowflake id renders as a Discord timestamp", () => {
    // 175928847299117063 → a real snowflake; expect a <t:…:D> marker.
    const v = memberVars({ userId: "1", username: "b", createdAt: "175928847299117063" });
    expect(v.created_at).toMatch(/^<t:\d+:D>$/);
  });

  test("unknown created_at renders empty, not a bogus timestamp", () => {
    expect(memberVars({ userId: "1", username: "b", createdAt: "not-a-date" }).created_at).toBe("");
  });
});

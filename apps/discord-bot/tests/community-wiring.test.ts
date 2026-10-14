import { describe, expect, test } from "bun:test";

import type { RoleAssignment } from "../src/community/roles.ts";
import { ROLE_ASSIGNMENT_PATH, recordAssignment } from "../src/community/wiring.ts";

// recordAssignment is the bot's only write into `role_assignments`, the table that
// answers "why didn't this member get the role?". It had no tests, which is how a
// source the api refuses ("panel-reaction") went on being sent while every such
// attempt silently fell on the floor: the fetch was awaited, the response was
// never looked at, and the catch only covered network errors.

const assignment: RoleAssignment = {
  userId: "111111111111111111",
  roleId: "222222222222222222",
  action: "add",
  source: "panel-reaction",
  status: "ok",
  error: "",
};

type Call = { url: string; init: RequestInit };

/** stubFetch captures the request and answers with `res` (or throws it). */
function stubFetch(res: Response | Error) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (res instanceof Error) throw res;
    return res;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function collector() {
  const logs: string[] = [];
  return { logs, log: (m: string) => logs.push(m) };
}

describe("recordAssignment", () => {
  test("posts the row and says nothing on success", async () => {
    const { calls, impl } = stubFetch(new Response("", { status: 201 }));
    const { logs, log } = collector();

    await recordAssignment("http://api.local", assignment, impl, 3000, log);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://api.local${ROLE_ASSIGNMENT_PATH}`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(assignment);
    expect(logs).toEqual([]);
  });

  test("a refused record is logged in the api's own words, unwrapped, and the caller still returns", async () => {
    const detail = "source must be autorole, panel, panel-reaction, verification or manual";
    const { impl } = stubFetch(
      new Response(JSON.stringify({ detail }), { status: 400, headers: { "content-type": "application/json" } }),
    );
    const { logs, log } = collector();

    // The await returning at all is half the assertion: a refused record must not
    // turn into a failed grant, because the grant already happened.
    await recordAssignment("http://api.local", assignment, impl, 3000, log);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("refused");
    expect(logs[0]).toContain("400");
    expect(logs[0]).toContain(detail);
    // Unwrapped, not a JSON blob: the log line should read like the dashboard's error.
    expect(logs[0]).not.toContain("{");
  });

  test("an unreachable api is logged, not thrown", async () => {
    const { impl } = stubFetch(new Error("connect ECONNREFUSED 127.0.0.1:3103"));
    const { logs, log } = collector();

    await recordAssignment("http://api.local", assignment, impl, 3000, log);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("failed");
    expect(logs[0]).toContain("ECONNREFUSED");
  });

  test("a refusal that is not the expected envelope still says something", async () => {
    const { impl } = stubFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const { logs, log } = collector();

    await recordAssignment("http://api.local", assignment, impl, 3000, log);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("502");
    expect(logs[0]).toContain("html");
  });

  test("a logger is optional: no log means no crash", async () => {
    const { impl } = stubFetch(new Response(JSON.stringify({ detail: "nope" }), { status: 400 }));
    await recordAssignment("http://api.local", assignment, impl, 3000);
  });

  test("no api url means no request at all", async () => {
    const { calls, impl } = stubFetch(new Response("", { status: 201 }));
    await recordAssignment("", assignment, impl, 3000, () => {});
    expect(calls).toHaveLength(0);
  });
});

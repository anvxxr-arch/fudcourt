// Entry point. Subcommands:
//   run       (default) — open the gateway and serve slash commands
//   doctor    — validate the token, application, guild and roles (read-only)
//   register  — publish the command set without opening the gateway
//   list      — print the loaded pieces (no network)

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, missingForGateway } from "./config.ts";
import { FudzieClient } from "./framework/client.ts";
import { Rest } from "./framework/rest.ts";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  const sub = (process.argv[2] ?? "run").toLowerCase();
  const cfg = loadConfig();

  if (sub === "list") {
    const client = new FudzieClient({ config: cfg });
    await client.loadPieces(SRC_DIR);
    console.log("commands:");
    for (const c of client.commands.all()) console.log(`  /${c.name} — ${c.description}${c.preconditions.length ? ` [${c.preconditions.join(",")}]` : ""}`);
    console.log("listeners:");
    for (const l of client.listeners.all()) console.log(`  ${l.event}${l.once ? " (once)" : ""}`);
    console.log("preconditions:");
    for (const p of client.preconditions.all()) console.log(`  ${p.name}`);
    return 0;
  }

  const missing = missingForGateway(cfg);
  if (missing.length > 0) {
    console.error(`❌ missing required env: ${missing.join(", ")}`);
    return 1;
  }

  if (sub === "doctor") {
    const rest = new Rest(cfg.token);
    const client = new FudzieClient({ config: cfg, rest });
    const counts = await client.loadPieces(SRC_DIR);
    console.log(`✅ pieces loaded — ${counts.commands} commands, ${counts.listeners} listeners, ${counts.preconditions} preconditions`);

    const me = await rest.getCurrentUser();
    console.log(`✅ token ok — bot @${me.username} (${me.id})`);
    const app = await rest.getApplication();
    console.log(`✅ application — ${app.name} (${app.id})`);
    if (app.id !== cfg.applicationId) {
      console.log(`⚠️  FUDCOURT_CLIENT_ID (${cfg.applicationId}) != application id (${app.id})`);
    }
    if (cfg.guildId) {
      const g = await rest.getGuild(cfg.guildId);
      console.log(`✅ guild — ${g.name} (${g.id})`);
      const roles = await rest.listGuildRoles(cfg.guildId);
      console.log(`   roles in guild: ${roles.length}`);
      for (const rid of [...cfg.adminRoleIds, ...cfg.teamRoleIds]) {
        const found = roles.find((r) => r.id === rid);
        console.log(`   ${found ? "✅" : "❌"} role ${rid}${found ? ` = ${found.name}` : " (not in guild)"}`);
      }
    } else {
      console.log("⚠️  no FUDCOURT_GUILD_ID — commands will register globally");
    }
    console.log(`✅ doctor OK — ${client.commands.size} commands ready`);
    return 0;
  }

  if (sub === "register") {
    const rest = new Rest(cfg.token);
    const client = new FudzieClient({ config: cfg, rest });
    await client.loadPieces(SRC_DIR);
    const n = await client.registerCommands();
    const scope = cfg.guildId ? `guild ${cfg.guildId}` : "globally";
    console.log(`✅ registered ${n} commands ${scope}`);
    return 0;
  }

  if (sub !== "run") {
    console.error(`unknown subcommand: ${sub} (use run | doctor | register | list)`);
    return 2;
  }

  const client = new FudzieClient({ config: cfg });
  await client.loadPieces(SRC_DIR);
  await client.login();
  console.log("[fudzie] gateway starting — Ctrl-C to stop");
  // The gateway owns its own reconnect loop and timers, which keep the process
  // alive; await a promise that never resolves until the runtime signals exit.
  return await new Promise<number>(() => {});
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createPresenceServer } from "../../src/helper/server.js";
import { createPresenceHandler } from "../../src/helper/index.js";
import { liveSubagentCount } from "../../src/helper/subagents.js";
import { publishPresence, retirePresence } from "../../src/extension/transport.js";

interface FakeDiscord {
  published: Record<string, any>[];
  clears: number;
}

/**
 * End-to-end over the real wire: the extension's transport posts to the helper's
 * server, the handler aggregates the live sessions, and what Discord would receive
 * is recorded here. No Discord connection and no real subagent registry are touched.
 */
async function withServer(
  tasksDir: string,
  run: (context: { config: { serverHost: string; serverPort: number }; discord: FakeDiscord }) => Promise<void>
): Promise<void> {
  const discord: FakeDiscord = { published: [], clears: 0 };
  const config = { serverHost: "127.0.0.1", serverPort: 42671 };

  const handler = createPresenceHandler(
    {
      setPresence: async (payload: Record<string, any>) => void discord.published.push(payload),
      clearPresence: async () => void (discord.clears += 1)
    } as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => liveSubagentCount(tasksDir)
  );

  const server: Server = createPresenceServer(
    handler.handlePresence,
    handler.handleClear,
    config,
    handler.handleRetire
  );

  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(config.serverPort, config.serverHost);
  });

  try {
    await run({ config, discord });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * The handler debounces rapid changes, so a second publish within the window is
 * scheduled rather than sent. This waits for the pending update to land, the way a
 * real session that just changed model does.
 */
async function settle(discord: FakeDiscord, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (discord.published.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function session(over: Record<string, unknown> & { sessionId: string }) {
  return {
    app: "pi-coding-agent",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    state: "thinking",
    startedAt: 1_700_000_000,
    privacyMode: true,
    ...over
  } as never;
}

test("two sessions over the wire share ONE presence: oldest clock, foreground model, real counts", async () => {
  const tasks = mkdtempSync(join(tmpdir(), "pi-tasks-e2e-"));
  writeFileSync(join(tasks, "worker.json"), JSON.stringify({ task: { agent: "gentle-ai-worker", status: "running" } }));
  writeFileSync(join(tasks, "done.json"), JSON.stringify({ task: { agent: "gentle-ai-verify", status: "completed" } }));

  try {
    await withServer(tasks, async ({ config, discord }) => {
      await publishPresence(session({ sessionId: "old", startedAt: 1_000, model: "gpt-5.5", state: "idle", lastPromptAtMs: 10 }), config);
      await publishPresence(session({ sessionId: "new", startedAt: 2_000, model: "glm-5.3", state: "thinking", lastPromptAtMs: 500 }), config);
      await settle(discord, 2);

      const shown = discord.published.at(-1)!;
      assert.equal(shown.agents, 2, "las dos sesiones vivas se cuentan");
      assert.equal(shown.subagents, 1, "sólo el subagente vivo cuenta");
      assert.equal(shown.startedAt, 1_000, "el tiempo es UNO: el de la sesión más antigua");
      assert.equal(shown.model, "glm-5.3", "el modelo es el de la sesión en primer plano");
      assert.equal(shown.state, "thinking");
    });
  } finally {
    rmSync(tasks, { recursive: true, force: true });
  }
});

test("retiring the oldest session over the wire moves the clock and never clears the others", async () => {
  const tasks = mkdtempSync(join(tmpdir(), "pi-tasks-e2e-"));
  writeFileSync(join(tasks, "live.json"), JSON.stringify({ task: { agent: "gentle-ai-worker", status: "running" } }));

  try {
    await withServer(tasks, async ({ config, discord }) => {
      await publishPresence(session({ sessionId: "old", startedAt: 100, model: "a", lastPromptAtMs: 1 }), config);
      await publishPresence(session({ sessionId: "second", startedAt: 200, model: "b", lastPromptAtMs: 2 }), config);
      await settle(discord, 2);

      await retirePresence("old", config);

      const shown = discord.published.at(-1)!;
      assert.equal(shown.agents, 1);
      assert.equal(shown.startedAt, 200, "el tiempo pasa a la siguiente más antigua");
      assert.equal(discord.clears, 0, "retirar una sesión no borra la presencia de las demás");

      await retirePresence("second", config);
      assert.equal(discord.clears, 1, "sin sesiones vivas, la presencia se limpia");

      await retirePresence("second", config);
      assert.equal(discord.clears, 1, "retirar una sesión que no existe no vuelve a limpiar");
    });
  } finally {
    rmSync(tasks, { recursive: true, force: true });
  }
});

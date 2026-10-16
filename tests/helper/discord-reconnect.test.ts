import test from "node:test";
import assert from "node:assert/strict";
import type { PresencePayload } from "../../src/shared/types.js";
import { buildActivity, DiscordPresenceClient, humanizeState, normalizeKey } from "../../src/helper/discord.js";

function samplePayload(overrides: Partial<PresencePayload> = {}): PresencePayload {
  return {
    app: "pi-coding-agent",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    state: "thinking",
    startedAt: 1_700_000_000,
    privacyMode: true,
    ...overrides
  };
}

class FakeRpcClient {
  handlers = new Map<string, Array<(...args: any[]) => void>>();
  loginCalls = 0;
  activities: Array<Record<string, unknown>> = [];
  failLogins = 0;
  failSetActivitys = 0;
  destroyed = false;
  emitDisconnectedOnDestroy = false;
  loginQueue: Array<() => Promise<void>> = [];

  on(event: string, listener: (...args: any[]) => void) {
    const existing = this.handlers.get(event) ?? [];
    existing.push(listener);
    this.handlers.set(event, existing);
  }

  async login(): Promise<void> {
    this.loginCalls += 1;
    const queuedLogin = this.loginQueue.shift();
    if (queuedLogin) {
      return queuedLogin();
    }
    if (this.failLogins > 0) {
      this.failLogins -= 1;
      throw new Error("login failed");
    }
    this.emit("ready");
  }

  async setActivity(activity: Record<string, unknown>): Promise<void> {
    if (this.failSetActivitys > 0) {
      this.failSetActivitys -= 1;
      throw new Error("setActivity failed");
    }
    this.activities.push(activity);
  }

  async clearActivity(): Promise<void> {}

  destroy(): void {
    this.destroyed = true;
    if (this.emitDisconnectedOnDestroy) {
      this.emit("disconnected", "destroyed");
    }
  }

  emit(event: string, ...args: any[]) {
    for (const listener of this.handlers.get(event) ?? []) {
      listener(...args);
    }
  }
}

test("Discord presence activity renders Pi identity, provider/model, and state", () => {
  const activity = buildActivity(samplePayload());

  assert.equal(activity.largeImageKey, "pi");
  assert.equal(activity.largeImageText, "Pi Coding Agent");
  assert.equal(activity.smallImageKey, "anthropic");
  assert.equal(activity.smallImageText, "anthropic");
  // details carries the live summary (agents and subagents) since the owner asked for
  // it; the Pi identity stays on the large image instead.
  assert.equal(activity.details, "1 agent");
  assert.equal(activity.state, "claude-sonnet-4-5 • Thinking");
  assert.equal(humanizeState("editing"), "Editing Files");
  assert.equal(normalizeKey("OpenAI/GPT"), "openai-gpt");
});

test("DiscordPresenceClient reconnects after disconnect and reapplies queued presence", async () => {
  const firstRpc = new FakeRpcClient();
  const secondRpc = new FakeRpcClient();
  const clients = [firstRpc, secondRpc];
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const client = new DiscordPresenceClient(
    () => clients.shift() ?? secondRpc,
    ((fn: () => void, delay?: number) => {
      scheduled.push({ delay: delay ?? 0, run: fn });
      return scheduled.length as any;
    }) as typeof setTimeout,
    (() => {}) as typeof clearTimeout
  );

  await client.connect();
  await client.setPresence(samplePayload({ state: "thinking" }));
  assert.equal(firstRpc.activities.length, 1);

  firstRpc.emit("disconnected");

  const reconnectAttempt = scheduled.find((item) => item.delay === 1000);
  assert.ok(reconnectAttempt);

  reconnectAttempt.run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstRpc.destroyed, true);
  assert.ok(secondRpc.loginCalls >= 1);
  assert.equal(secondRpc.activities.at(-1)?.state, "claude-sonnet-4-5 • Thinking");

  await client.setPresence(samplePayload({ state: "tooling" }));
  assert.equal(secondRpc.activities.at(-1)?.state, "claude-sonnet-4-5 • Running Tools");
});

test("DiscordPresenceClient retries after initial login failure until Discord returns", async () => {
  const failingRpc = new FakeRpcClient();
  failingRpc.failLogins = 1;
  const recoveredRpc = new FakeRpcClient();
  const clients = [failingRpc, recoveredRpc];
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const client = new DiscordPresenceClient(
    () => clients.shift() ?? recoveredRpc,
    ((fn: () => void, delay?: number) => {
      scheduled.push({ delay: delay ?? 0, run: fn });
      return scheduled.length as any;
    }) as typeof setTimeout,
    (() => {}) as typeof clearTimeout
  );

  await client.setPresence(samplePayload({ state: "thinking" }));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);

  scheduled[0].run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(failingRpc.destroyed, true);
  assert.ok(recoveredRpc.loginCalls >= 1);
  assert.equal(recoveredRpc.activities.at(-1)?.state, "claude-sonnet-4-5 • Thinking");
});

test("DiscordPresenceClient keepalive leaves a healthy connection alone", async () => {
  const rpc = new FakeRpcClient();
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const client = new DiscordPresenceClient(
    rpc,
    ((fn: () => void, delay?: number) => {
      scheduled.push({ delay: delay ?? 0, run: fn });
      return scheduled.length as any;
    }) as typeof setTimeout,
    (() => {}) as typeof clearTimeout,
    5
  );

  await client.setPresence(samplePayload({ state: "thinking" }));
  const initialActivityCount = rpc.activities.length;
  assert.ok(initialActivityCount >= 1);

  const keepaliveAttempt = scheduled.find((item) => item.delay === 5);
  assert.ok(keepaliveAttempt);

  keepaliveAttempt.run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rpc.destroyed, false);
  assert.equal(rpc.activities.length, initialActivityCount + 1);
  assert.equal(scheduled.some((item) => item.delay === 1000), false);
});

test("DiscordPresenceClient ignores login failures from stale in-flight RPC clients", async () => {
  const firstRpc = new FakeRpcClient();
  let rejectFirstLogin: ((error: Error) => void) | null = null;
  firstRpc.loginQueue.push(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectFirstLogin = reject;
      })
  );
  const secondRpc = new FakeRpcClient();
  const clients = [firstRpc, secondRpc];
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const client = new DiscordPresenceClient(
    () => clients.shift() ?? secondRpc,
    ((fn: () => void, delay?: number) => {
      scheduled.push({ delay: delay ?? 0, run: fn });
      return scheduled.length as any;
    }) as typeof setTimeout,
    (() => {}) as typeof clearTimeout,
    5
  );

  const firstSetPresence = client.setPresence(samplePayload({ state: "thinking" }));
  await new Promise((resolve) => setImmediate(resolve));

  firstRpc.emit("disconnected", "network lost");
  const reconnectAttempt = scheduled.find((item) => item.delay === 1000);
  assert.ok(reconnectAttempt);

  reconnectAttempt.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(secondRpc.loginCalls >= 1);

  rejectFirstLogin?.(new Error("connection closed"));
  await firstSetPresence;
  await new Promise((resolve) => setImmediate(resolve));

  await client.setPresence(samplePayload({ state: "tooling" }));
  assert.equal(secondRpc.activities.at(-1)?.state, "claude-sonnet-4-5 • Running Tools");
  assert.equal(scheduled.filter((item) => item.delay === 1000).length, 1);
});

test("DiscordPresenceClient ignores disconnect events from stale RPC clients after refresh", async () => {
  const firstRpc = new FakeRpcClient();
  firstRpc.failLogins = 1;
  firstRpc.emitDisconnectedOnDestroy = true;
  const secondRpc = new FakeRpcClient();
  const clients = [firstRpc, secondRpc];
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const client = new DiscordPresenceClient(
    () => clients.shift() ?? secondRpc,
    ((fn: () => void, delay?: number) => {
      scheduled.push({ delay: delay ?? 0, run: fn });
      return scheduled.length as any;
    }) as typeof setTimeout,
    (() => {}) as typeof clearTimeout,
    5
  );

  await client.setPresence(samplePayload({ state: "thinking" }));
  const reconnectAttempt = scheduled.find((item) => item.delay === 1000);
  assert.ok(reconnectAttempt);

  reconnectAttempt.run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstRpc.destroyed, true);
  assert.ok(secondRpc.loginCalls >= 1);
  assert.equal(secondRpc.activities.at(-1)?.state, "claude-sonnet-4-5 • Thinking");
  assert.equal(scheduled.filter((item) => item.delay === 1000).length, 1);
});

test("DiscordPresenceClient keepalive detects a silent Discord restart and reconnects", async () => {
  const firstRpc = new FakeRpcClient();
  const secondRpc = new FakeRpcClient();
  const clients = [firstRpc, secondRpc];
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const client = new DiscordPresenceClient(
    () => clients.shift() ?? secondRpc,
    ((fn: () => void, delay?: number) => {
      scheduled.push({ delay: delay ?? 0, run: fn });
      return scheduled.length as any;
    }) as typeof setTimeout,
    (() => {}) as typeof clearTimeout,
    5
  );

  await client.setPresence(samplePayload({ state: "thinking" }));
  assert.equal(firstRpc.activities.at(-1)?.state, "claude-sonnet-4-5 • Thinking");

  const keepaliveAttempt = scheduled.find((item) => item.delay === 5);
  assert.ok(keepaliveAttempt);

  firstRpc.failSetActivitys = 1;

  keepaliveAttempt.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstRpc.destroyed, false);

  const reconnectAttempt = scheduled.find((item) => item.delay === 1000);
  assert.ok(reconnectAttempt);
  reconnectAttempt.run();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstRpc.destroyed, true);
  assert.ok(secondRpc.loginCalls >= 1);
  assert.equal(secondRpc.activities.at(-1)?.state, "claude-sonnet-4-5 • Thinking");
});

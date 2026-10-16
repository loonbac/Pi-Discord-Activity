import test from "node:test";
import assert from "node:assert/strict";
import { aggregatePresence } from "../src/shared/aggregate.js";
import type { PresencePayload } from "../src/shared/types.js";

function payload(over: Partial<PresencePayload>): PresencePayload {
  return {
    app: "pi-coding-agent",
    provider: "unknown",
    model: "unknown",
    state: "idle",
    startedAt: Math.floor(Date.now() / 1000),
    privacyMode: true,
    ...over
  } as PresencePayload;
}

function entry(over: {
  sessionId: string;
  startedAt: number;
  state?: PresencePayload["state"];
  model?: string;
  provider?: string;
  lastPromptAt?: number;
  lastSeen?: number;
}) {
  return {
    sessionId: over.sessionId,
    payload: payload({
      sessionId: over.sessionId,
      startedAt: over.startedAt,
      state: over.state ?? "idle",
      model: over.model ?? "unknown",
      provider: over.provider ?? "unknown"
    }),
    lastSeen: over.lastSeen ?? 0,
    lastPromptAt: over.lastPromptAt ?? 0
  };
}

const T = 1_000_000;

test("no live session means no presence to publish", () => {
  assert.equal(aggregatePresence([], 0), null);
});

test("one live session keeps its own clock", () => {
  const result = aggregatePresence([entry({ sessionId: "s1", startedAt: T })], 3);
  assert.ok(result);
  assert.equal(result.startedAt, T);
  assert.equal(result.agents, 1);
  assert.equal(result.subagents, 3);
});

test("several sessions share ONE time: the one open the longest", () => {
  const sessions = [
    entry({ sessionId: "newest", startedAt: T + 500 }),
    entry({ sessionId: "oldest", startedAt: T }),
    entry({ sessionId: "middle", startedAt: T + 250 })
  ];
  const result = aggregatePresence(sessions, 0);
  assert.ok(result);
  assert.equal(result.startedAt, T, "el tiempo es el de la sesión más antigua");
  assert.equal(result.agents, 3);
});

test("the presence follows the session the user last prompted", () => {
  const sessions = [
    entry({ sessionId: "oldest-but-idle", startedAt: T, model: "gpt-5.5", state: "idle", lastPromptAt: 10 }),
    entry({ sessionId: "just-prompted", startedAt: T + 400, model: "glm-5.3", state: "thinking", lastPromptAt: 100 })
  ];
  const result = aggregatePresence(sessions, 0);
  assert.ok(result);
  assert.equal(result.model, "glm-5.3", "el modelo mostrado es el de la sesión en primer plano");
  assert.equal(result.state, "thinking");
  assert.equal(result.provider, "unknown");
  assert.equal(result.startedAt, T, "pero el tiempo sigue siendo el del más antiguo");
});

test("the foreground is chosen by prompt, not by activity noise", () => {
  const prompted = entry({ sessionId: "prompted", startedAt: T, model: "a", lastPromptAt: 50, lastSeen: 60 });
  const chattier = entry({ sessionId: "chattier", startedAt: T, model: "b", lastPromptAt: 20, lastSeen: 9999 });
  const result = aggregatePresence([prompted, chattier], 0);
  assert.ok(result);
  assert.equal(result.sessionId, "prompted", "una actividad más reciente sin prompt no roba el primer plano");
});

test("ties on prompt time fall back to the most recently seen session, deterministically", () => {
  const a = entry({ sessionId: "a", startedAt: T, model: "a", lastPromptAt: 50, lastSeen: 10 });
  const b = entry({ sessionId: "b", startedAt: T, model: "b", lastPromptAt: 50, lastSeen: 20 });
  assert.equal(aggregatePresence([a, b], 0)?.sessionId, "b");
  assert.equal(aggregatePresence([b, a], 0)?.sessionId, "b", "el orden de entrada no cambia el resultado");
});

test("when the oldest session retires, the single time moves to the next one", () => {
  const remaining = [
    entry({ sessionId: "second", startedAt: T + 250 }),
    entry({ sessionId: "third", startedAt: T + 500 })
  ];
  const result = aggregatePresence(remaining, 0);
  assert.ok(result);
  assert.equal(result.startedAt, T + 250);
  assert.equal(result.agents, 2);
});

test("a session with no subagents running reports zero, never an invented number", () => {
  const result = aggregatePresence([entry({ sessionId: "s1", startedAt: T })], 0);
  assert.ok(result);
  assert.equal(result.subagents, 0);
});

test("privacy mode of the foreground session survives the aggregation", () => {
  const sessions = [
    entry({ sessionId: "private", startedAt: T, model: "a", lastPromptAt: 10 }),
    entry({ sessionId: "shown", startedAt: T + 1, model: "b", lastPromptAt: 20 })
  ];
  const withPrivacy = sessions.map((session) =>
    session.sessionId === "shown"
      ? { ...session, payload: { ...session.payload, privacyMode: false, projectName: "mdm-gestor" } }
      : session
  );
  const result = aggregatePresence(withPrivacy, 0);
  assert.ok(result);
  assert.equal(result.privacyMode, false);
  assert.equal(result.projectName, "mdm-gestor");
});

import test from "node:test";
import assert from "node:assert/strict";
import type { PresencePayload } from "../../src/shared/types.js";
import { defaultConfig } from "../../src/shared/config.js";
import { createPresenceHandler } from "../../src/helper/index.js";

interface Harness {
  sent: PresencePayload[];
  clears: number;
  now: () => number;
  advance: (ms: number) => void;
  runTimers: () => void;
  handler: ReturnType<typeof createPresenceHandler>;
}

function harness(options: {
  sessionTtlMs?: number;
  subagents?: number;
  debounceMs?: number;
  presenceTimeoutMs?: number;
} = {}): Harness {
  const sent: PresencePayload[] = [];
  let clears = 0;
  let currentTime = 0;
  let timerId = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>();

  const client = {
    setPresence: async (payload: PresencePayload) => void sent.push(payload),
    clearPresence: async () => void (clears += 1)
  } as any;

  const handler = createPresenceHandler(
    client,
    options.debounceMs ?? 0,
    () => currentTime,
    ((fn: () => void, delay?: number) => {
      timerId += 1;
      timers.set(timerId, { fn, delay: delay ?? 0 });
      return timerId as any;
    }) as typeof setTimeout,
    ((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout,
    options.presenceTimeoutMs ?? 0,
    options.sessionTtlMs ?? defaultConfig.sessionTtlMs,
    () => options.subagents ?? 0
  );

  return {
    sent,
    get clears() {
      return clears;
    },
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms;
    },
    runTimers: () => {
      for (const timer of [...timers.values()]) timer.fn();
      timers.clear();
    },
    handler
  };

  function clearsAccessor() {
    return clears;
  }
}

function session(over: Partial<PresencePayload> & { sessionId: string }): PresencePayload {
  return {
    app: "pi-coding-agent",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    state: "thinking",
    startedAt: 1_700_000_000,
    privacyMode: true,
    ...over
  } as PresencePayload;
}

test("two live sessions publish ONE presence: the oldest clock and the foreground model", async () => {
  const h = harness({ subagents: 2 });
  await h.handler.handlePresence(session({ sessionId: "s-old", model: "gpt-5.5", state: "idle", startedAt: 1_000, lastPromptAtMs: 10 } as any));
  await h.handler.handlePresence(session({ sessionId: "s-new", model: "glm-5.3", state: "thinking", startedAt: 2_000, lastPromptAtMs: 500 } as any));

  assert.equal(h.sent.length, 2, "cada sesión publica su propio estado antes de agregar");
  const [first, second] = h.sent;
  assert.equal(first.model, "gpt-5.5", "con una sola sesión se muestra ella");
  assert.equal(second.model, "glm-5.3", "el primer plano es la que el usuario envió");
  assert.equal(second.startedAt, 1_000, "el tiempo es UNO: el de la sesión más antigua");
  assert.equal(second.agents, 2);
  assert.equal(second.subagents, 2);
});

test("a heartbeat that changes nothing is not re-sent", async () => {
  const h = harness();
  await h.handler.handlePresence(session({ sessionId: "s1", lastPromptAtMs: 1 } as any));
  await h.handler.handlePresence(session({ sessionId: "s1", lastPromptAtMs: 1 } as any));
  h.advance(1_000);
  await h.handler.handlePresence(session({ sessionId: "s1", model: "claude-sonnet-4-5", state: "thinking", lastPromptAtMs: 1 } as any));
  assert.equal(h.sent.length, 1, "el agregado no cambió, así que no se reenvía");
});

test("retiring the oldest session moves the single clock to the next oldest and keeps publishing", async () => {
  const h = harness();
  await h.handler.handlePresence(session({ sessionId: "oldest", startedAt: 100, model: "a", lastPromptAtMs: 1 } as any));
  await h.handler.handlePresence(session({ sessionId: "second", startedAt: 200, model: "b", lastPromptAtMs: 2 } as any));
  assert.equal(h.sent.length, 2);

  await h.handler.handleRetire("oldest");

  assert.equal(h.clears, 0, "retirar una sesión NUNCA borra la presencia de las demás");
  assert.equal(h.sent.length, 3, "el reloj cambió, así que hay un envío nuevo");
  assert.equal(h.sent[2].startedAt, 200, "el tiempo pasa a la siguiente más antigua");
  assert.equal(h.sent[2].agents, 1);
});

test("retiring one of two sessions never clears Discord, retiring the last one does", async () => {
  const h = harness();
  await h.handler.handlePresence(session({ sessionId: "a", startedAt: 10, lastPromptAtMs: 1 } as any));
  await h.handler.handlePresence(session({ sessionId: "b", startedAt: 20, lastPromptAtMs: 2 } as any));

  await h.handler.handleRetire("a");
  assert.equal(h.clears, 0);

  await h.handler.handleRetire("b");
  assert.equal(h.clears, 1, "sin sesiones vivas no hay presencia que mantener");
});

test("a session that stops reporting drops out of the count once its TTL expires", async () => {
  const h = harness({ sessionTtlMs: 5_000 });
  await h.handler.handlePresence(session({ sessionId: "live", startedAt: 100, lastPromptAtMs: 1 } as any));
  h.advance(1_000);
  await h.handler.handlePresence(session({ sessionId: "quiet", startedAt: 200, lastPromptAtMs: 2 } as any));
  assert.equal(h.sent[h.sent.length - 1].agents, 2);

  h.advance(6_000);
  await h.handler.handlePresence(session({ sessionId: "live2", startedAt: 300, lastPromptAtMs: 3 } as any));

  const last = h.sent[h.sent.length - 1];
  assert.equal(last.agents, 1, "las dos que dejaron de reportar cayeron por TTL y sólo queda la activa");
});

test("clearPresence without a session id drops every session, as old senders expect", async () => {
  const h = harness();
  await h.handler.handlePresence(session({ sessionId: "a", startedAt: 10, lastPromptAtMs: 1 } as any));
  await h.handler.handlePresence(session({ sessionId: "b", startedAt: 20, lastPromptAtMs: 2 } as any));

  await h.handler.handleClear();

  assert.equal(h.clears, 1);
  await h.handler.handlePresence(session({ sessionId: "a", startedAt: 10, model: "a", lastPromptAtMs: 3 } as any));
  assert.equal(h.sent[h.sent.length - 1].agents, 1, "tras el clear el registro empezó de cero");
});

test("a payload with no session id still counts as exactly one live session", async () => {
  const h = harness();
  await h.handler.handlePresence(session({} as any));
  const sent = h.sent[0];
  assert.equal(sent.agents, 1);
  assert.equal(sent.subagents, 0);
});

test("a foreground switch moves both the model and the activity shown", async () => {
  const h = harness();
  await h.handler.handlePresence(session({ sessionId: "one", model: "gpt-5.5", state: "idle", startedAt: 100, lastPromptAtMs: 10 } as any));
  await h.handler.handlePresence(session({ sessionId: "two", model: "glm-5.3", state: "editing", startedAt: 200, lastPromptAtMs: 20 } as any));

  const second = h.sent[h.sent.length - 1];
  assert.equal(second.model, "glm-5.3");
  assert.equal(second.state, "editing");
  assert.equal(second.startedAt, 100);

  await h.handler.handlePresence(session({ sessionId: "one", model: "gpt-5.5", state: "thinking", startedAt: 100, lastPromptAtMs: 30 } as any));
  const third = h.sent[h.sent.length - 1];
  assert.equal(third.model, "gpt-5.5", "volver a enviar en la otra sesión la trae al primer plano");
  assert.equal(third.state, "thinking");
});

import test from "node:test";
import assert from "node:assert/strict";
import extension from "../../src/extension/index.js";

type Handler = (event: any, ctx: any) => Promise<void> | void;

function createMockPi() {
  const handlers = new Map<string, Handler>();
  return {
    api: { on(event: string, handler: Handler) { handlers.set(event, handler); } },
    handlers
  };
}

function createCtx(sessionId = "session-123") {
  return {
    cwd: "/tmp/example-project",
    model: { provider: "openai", id: "gpt-5.4" },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` }
  };
}

interface Recorder {
  calls: { url: string; body: Record<string, unknown> }[];
  restore: () => void;
}

function interceptFetch(): Recorder {
  const calls: Recorder["calls"] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function presenceCalls(recorder: Recorder) {
  return recorder.calls.filter((call) => call.url.endsWith("/presence"));
}

function retireCalls(recorder: Recorder) {
  return recorder.calls.filter((call) => call.url.endsWith("/retire"));
}

test("a session that ends retires ONLY itself, never clears every other session", async () => {
  const pi = createMockPi();
  extension(pi.api as any);
  const recorder = interceptFetch();
  const previous = process.env.PI_PRESENCE_HEARTBEAT_MS;
  delete process.env.PI_PRESENCE_HEARTBEAT_MS;

  try {
    const ctx = createCtx("session-abc");
    await pi.handlers.get("session_start")!({}, ctx);
    assert.equal(presenceCalls(recorder).length, 1, "el arranque publica su estado una vez");

    await pi.handlers.get("session_shutdown")!({}, ctx);

    const retires = retireCalls(recorder);
    assert.equal(retires.length, 1, "cerrar una sesión retira esa sesión");
    assert.equal(retires[0].body.sessionId, "session-abc");
    assert.equal(
      recorder.calls.some((call) => call.url.endsWith("/clear")),
      false,
      "y NUNCA borra la presencia de las demás sesiones abiertas"
    );
  } finally {
    recorder.restore();
    if (previous === undefined) delete process.env.PI_PRESENCE_HEARTBEAT_MS; else process.env.PI_PRESENCE_HEARTBEAT_MS = previous;
  }
});

test("the payload tells the helper when the user last prompted, so the foreground is user-driven", async () => {
  const pi = createMockPi();
  extension(pi.api as any);
  const recorder = interceptFetch();

  try {
    const ctx = createCtx();
    await pi.handlers.get("session_start")!({}, ctx);
    const atStart = presenceCalls(recorder).at(-1)!.body;
    assert.equal(typeof atStart.lastPromptAtMs, "number", "el arranque de sesión ya es actividad del usuario");

    const before = atStart.lastPromptAtMs as number;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pi.handlers.get("agent_start")!({}, ctx);

    const atAgentStart = presenceCalls(recorder).at(-1)!.body;
    assert.ok((atAgentStart.lastPromptAtMs as number) >= before, "cada prompt mueve el sello de primer plano");
  } finally {
    recorder.restore();
  }
});

test("a heartbeat keeps an idle-but-open session counted", async () => {
  const pi = createMockPi();
  extension(pi.api as any);
  const recorder = interceptFetch();
  const previous = process.env.PI_PRESENCE_HEARTBEAT_MS;
  process.env.PI_PRESENCE_HEARTBEAT_MS = "1";
  const ctx = createCtx("session-beat");

  try {
    await pi.handlers.get("session_start")!({}, ctx);
    await pi.handlers.get("agent_start")!({}, ctx);
    const sentBeforeHeartbeat = presenceCalls(recorder).length;

    await new Promise((resolve) => setTimeout(resolve, 25));

    const sent = presenceCalls(recorder);
    assert.ok(sent.length > sentBeforeHeartbeat, "el latido publica aunque nada haya cambiado");
    const last = sent.at(-1)!.body;
    assert.equal(last.sessionId, "session-beat");
    assert.equal(last.model, "gpt-5.4");
  } finally {
    await pi.handlers.get("session_shutdown")!({}, ctx);
    recorder.restore();
    if (previous === undefined) delete process.env.PI_PRESENCE_HEARTBEAT_MS; else process.env.PI_PRESENCE_HEARTBEAT_MS = previous;
  }
});

test("the heartbeat stops when the session ends", async () => {
  const pi = createMockPi();
  extension(pi.api as any);
  const recorder = interceptFetch();
  const previous = process.env.PI_PRESENCE_HEARTBEAT_MS;
  process.env.PI_PRESENCE_HEARTBEAT_MS = "1";

  try {
    const ctx = createCtx("session-stop");
    await pi.handlers.get("session_start")!({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pi.handlers.get("session_shutdown")!({}, ctx);

    const presenceAfterShutdown = presenceCalls(recorder).length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(presenceCalls(recorder).length, presenceAfterShutdown, "tras cerrar, el latido dejó de publicar");
  } finally {
    recorder.restore();
    if (previous === undefined) delete process.env.PI_PRESENCE_HEARTBEAT_MS; else process.env.PI_PRESENCE_HEARTBEAT_MS = previous;
  }
});

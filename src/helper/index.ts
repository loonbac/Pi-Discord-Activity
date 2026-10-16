import { DiscordPresenceClient } from "./discord.js";
import { createPresenceServer } from "./server.js";
import type { PresencePayload } from "../shared/types.js";
import { defaultConfig } from "../shared/config.js";
import { aggregatePresence, type PresenceAggregate, type PresenceSessionEntry } from "../shared/aggregate.js";

const RECOVERABLE_DISCORD_ERROR_PATTERNS = [
  "Could not connect",
  "connection closed",
  "ECONNREFUSED",
  "EPIPE",
  "socket hang up"
];

const discord = new DiscordPresenceClient();

export function createPresenceHandler(
  client: Pick<DiscordPresenceClient, "setPresence" | "clearPresence">,
  debounceMs = defaultConfig.debounceMs,
  now: () => number = Date.now,
  schedule: typeof setTimeout = setTimeout,
  cancel: typeof clearTimeout = clearTimeout,
  presenceTimeoutMs = defaultConfig.presenceTimeoutMs,
  sessionTtlMs = defaultConfig.sessionTtlMs,
  subagentCount: () => number = () => 0
) {
  /**
   * Every live Pi session, keyed by session id.
   *
   * Sessions report to one shared helper, so the helper is the only place that can
   * see all of them at once. Without the registry the last payload received became
   * the presence, and the time shown was whichever session happened to publish last.
   */
  const live = new Map<string, PresenceSessionEntry>();
  let lastSentAt = 0;
  let lastSent: PresenceAggregate | null = null;
  let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  async function sendAggregate(aggregate: PresenceAggregate): Promise<void> {
    lastSentAt = now();
    lastSent = aggregate;
    restartTimeoutMonitor();
    await client.setPresence(payloadFor(aggregate));
  }

  /** The one presence every live session shares, or nothing when no session is live. */
  function aggregateNow(): PresenceAggregate | null {
    return aggregatePresence([...live.values()], subagentCount());
  }

  /**
   * Dedupe on the aggregate, never on the payload that arrived.
   *
   * The previous comparison read the incoming payload only, so an update whose sole
   * effect was to move the single clock — the longest-open session retiring — was
   * treated as "nothing changed" and Discord kept the stale start time.
   */
  function isEquivalent(a: PresenceAggregate | null, b: PresenceAggregate): boolean {
    return !!a
      && a.sessionId === b.sessionId
      && a.state === b.state
      && a.model === b.model
      && a.provider === b.provider
      && a.startedAt === b.startedAt
      && a.agents === b.agents
      && a.subagents === b.subagents
      && a.privacyMode === b.privacyMode
      && a.projectName === b.projectName;
  }

  function payloadFor(aggregate: PresenceAggregate): PresencePayload {
    return {
      app: "pi-coding-agent",
      provider: aggregate.provider,
      model: aggregate.model,
      state: aggregate.state,
      startedAt: aggregate.startedAt,
      sessionId: aggregate.sessionId,
      agents: aggregate.agents,
      subagents: aggregate.subagents,
      privacyMode: aggregate.privacyMode,
      ...(aggregate.projectName ? { projectName: aggregate.projectName } : {})
    };
  }

  /** A session that stopped reporting is not a session any more. */
  function prune(): void {
    if (sessionTtlMs <= 0) return;
    const cutoff = now() - sessionTtlMs;
    for (const [key, session] of live) {
      if (session.lastSeen <= cutoff) live.delete(key);
    }
  }

  async function handlePresence(payload: PresencePayload): Promise<void> {
    const at = now();
    const key = payload.sessionId?.trim() || "anonymous";
    const previous = live.get(key);
    live.set(key, {
      sessionId: key,
      payload,
      lastSeen: at,
      lastPromptAt: payload.lastPromptAtMs ?? previous?.lastPromptAt ?? at
    });
    prune();

    const aggregate = aggregateNow();
    if (!aggregate) {
      await stop();
      return;
    }

    if (isEquivalent(lastSent, aggregate)) {
      if (pendingUpdate) {
        cancel(pendingUpdate);
        pendingUpdate = null;
      }
      return;
    }

    if (lastSent && now() - lastSentAt < debounceMs) {
      if (!pendingUpdate) {
        pendingUpdate = schedule(() => {
          pendingUpdate = null;
          const next = aggregateNow();
          if (next && !isEquivalent(lastSent, next)) void sendAggregate(next);
        }, debounceMs);
      }
      return;
    }

    await sendAggregate(aggregate);
  }

  /**
   * One session ending answers with the presence of the ones that remain.
   *
   * The old `clearPresence` was global: closing one Pi wiped the activity of every
   * other open session, which is why the presence only worked with a single session.
   */
  async function handleRetire(sessionId: string): Promise<void> {
    live.delete(sessionId?.trim() || "anonymous");
    prune();

    const aggregate = aggregateNow();
    if (!aggregate) {
      await stop();
      return;
    }

    if (pendingUpdate) {
      cancel(pendingUpdate);
      pendingUpdate = null;
    }
    if (!isEquivalent(lastSent, aggregate)) await sendAggregate(aggregate);
  }

  async function handleClear(): Promise<void> {
    live.clear();
    await stop();
  }

  async function stop(): Promise<void> {
    if (pendingUpdate) {
      cancel(pendingUpdate);
      pendingUpdate = null;
    }
    if (timeoutTimer) {
      cancel(timeoutTimer);
      timeoutTimer = null;
    }
    lastSent = null;
    lastSentAt = 0;
    await client.clearPresence();
  }

  function flushPendingUpdate(): void {
    if (pendingUpdate) {
      cancel(pendingUpdate);
      pendingUpdate = null;
    }
  }

  function restartTimeoutMonitor(): void {
    if (timeoutTimer) {
      cancel(timeoutTimer);
    }
    if (presenceTimeoutMs <= 0) {
      return;
    }
    timeoutTimer = schedule(() => {
      if (defaultConfig.debugLogging) {
        console.log("[pi-discord-activity] Presence timed out; clearing Discord activity");
      }
      timeoutTimer = null;
      void stop();
    }, presenceTimeoutMs);
  }

  return { handlePresence, handleRetire, handleClear, flushPendingUpdate };
}

export async function performShutdown(
  client: Pick<DiscordPresenceClient, "clearPresence">,
  flushPendingUpdate: () => void,
  exit: (code: number) => never | void = process.exit,
  delayMs = 100,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exitCode = 0,
  reason?: string
): Promise<void> {
  if (reason && defaultConfig.debugLogging) {
    console.log(`Received ${reason}, shutting down gracefully...`);
  }

  flushPendingUpdate();
  await client.clearPresence();
  await sleep(delayMs);
  if (defaultConfig.debugLogging) {
    console.log("Shutdown complete");
  }
  exit(exitCode);
}

export function isRecoverableDiscordRuntimeError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);

    const message = current instanceof Error ? current.message : String(current);
    const code = "code" in current && typeof (current as { code?: unknown }).code === "string" ? (current as { code: string }).code : "";

    if (
      RECOVERABLE_DISCORD_ERROR_PATTERNS.some((pattern) => message.includes(pattern)) ||
      RECOVERABLE_DISCORD_ERROR_PATTERNS.some((pattern) => code.includes(pattern))
    ) {
      return true;
    }

    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }

  if (typeof error === "string") {
    return RECOVERABLE_DISCORD_ERROR_PATTERNS.some((pattern) => error.includes(pattern));
  }

  return false;
}

export async function startHelper(): Promise<void> {
  const { handlePresence, handleRetire, handleClear, flushPendingUpdate } = createPresenceHandler(discord);
  createPresenceServer(handlePresence, handleClear, defaultConfig, handleRetire);

  void discord.connect().catch((error) => {
    if (defaultConfig.debugLogging) {
      console.log("[pi-discord-activity] Discord RPC unavailable at startup; helper will retry on next presence update", error);
    }
  });

  process.on("SIGINT", () => {
    void performShutdown(discord, flushPendingUpdate, process.exit, 100, undefined, 0, "SIGINT");
  });
  process.on("SIGTERM", () => {
    void performShutdown(discord, flushPendingUpdate, process.exit, 100, undefined, 0, "SIGTERM");
  });
  process.on("uncaughtException", (error) => {
    if (isRecoverableDiscordRuntimeError(error)) {
      console.warn("[pi-discord-activity] Recoverable Discord runtime exception:", error);
      return;
    }

    console.error("[pi-discord-activity] Uncaught exception:", error);
    void performShutdown(discord, flushPendingUpdate, process.exit, 100, undefined, 1, "uncaughtException");
  });
  process.on("unhandledRejection", (reason, promise) => {
    if (isRecoverableDiscordRuntimeError(reason)) {
      console.warn("[pi-discord-activity] Recoverable Discord runtime rejection:", reason);
      return;
    }

    console.error("[pi-discord-activity] Unhandled rejection at:", promise, "reason:", reason);
    void performShutdown(discord, flushPendingUpdate, process.exit, 100, undefined, 1, "unhandledRejection");
  });
}

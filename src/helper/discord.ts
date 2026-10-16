import RPC from "discord-rpc";
import type { PresencePayload } from "../shared/types.js";
import { defaultConfig } from "../shared/config.js";

RPC.register(defaultConfig.rpcClientId);

type RpcClientLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  login(args: { clientId: string }): Promise<unknown>;
  setActivity(activity: Record<string, unknown>): Promise<unknown>;
  clearActivity(): Promise<unknown>;
  destroy?(): void | Promise<void>;
};

type RpcClientFactory = () => RpcClientLike;
type Scheduler = typeof setTimeout;
type Canceler = typeof clearTimeout;

const PRESENCE_KEEPALIVE_MS = 15_000;

export class DiscordPresenceClient {
  private client: RpcClientLike;
  private readonly createClient: RpcClientFactory;
  private readonly schedule: Scheduler;
  private readonly cancel: Canceler;
  private ready = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private pendingPresence: PresencePayload | null = null;
  private needsClientRefresh = false;
  private readonly presenceKeepaliveMs: number;

  constructor(
    clientOrFactory: RpcClientLike | RpcClientFactory = () => new RPC.Client({ transport: "ipc" }),
    schedule: Scheduler = setTimeout,
    cancel: Canceler = clearTimeout,
    presenceKeepaliveMs = PRESENCE_KEEPALIVE_MS
  ) {
    this.createClient =
      typeof clientOrFactory === "function"
        ? (clientOrFactory as RpcClientFactory)
        : () => clientOrFactory as RpcClientLike;
    this.schedule = schedule;
    this.cancel = cancel;
    this.presenceKeepaliveMs = presenceKeepaliveMs;
    this.client = this.createClient();
    this.bindListeners(this.client);
  }

  async connect(): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.needsClientRefresh) {
      this.refreshClient();
    }

    if (!this.connectPromise) {
      const activeClient = this.client;
      const connectAttempt = activeClient
        .login({ clientId: defaultConfig.rpcClientId })
        .then(() => undefined)
        .catch((error) => {
          if (activeClient === this.client) {
            this.ready = false;
            this.needsClientRefresh = true;
          } else {
            debugLog("Ignoring login failure from stale Discord RPC client", error);
          }
          throw error;
        })
        .finally(() => {
          if (this.connectPromise === connectAttempt) {
            this.connectPromise = null;
          }
        });

      this.connectPromise = connectAttempt;
    }

    await this.connectPromise;
  }

  async setPresence(payload: PresencePayload): Promise<void> {
    this.pendingPresence = payload;

    if (!this.ready) {
      try {
        await this.connect();
      } catch (error) {
        debugLog("Discord RPC not ready, queued presence update", error);
        if (!this.ready) {
          this.scheduleReconnect();
          return;
        }
      }
    }

    if (!this.ready) {
      this.scheduleReconnect();
      return;
    }

    try {
      await this.client.setActivity(buildActivity(payload));
      this.schedulePresenceKeepalive();
    } catch (error) {
      this.handleDisconnect("setActivity_failed", error);
    }
  }

  async clearPresence(): Promise<void> {
    this.pendingPresence = null;

    if (this.reconnectTimer) {
      this.cancel(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.presenceKeepaliveTimer) {
      this.cancel(this.presenceKeepaliveTimer);
      this.presenceKeepaliveTimer = null;
    }

    if (!this.ready) {
      return;
    }

    try {
      await this.client.clearActivity();
    } catch (error) {
      debugLog("Failed to clear Discord activity", error);
    }
  }

  private bindListeners(client: RpcClientLike): void {
    client.on("ready", () => {
      if (client !== this.client) {
        debugLog("Ignoring ready event from stale Discord RPC client");
        return;
      }

      this.ready = true;
      this.reconnectAttempts = 0;
      this.needsClientRefresh = false;

      if (this.reconnectTimer) {
        this.cancel(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      debugLog("Discord RPC connected");
      this.schedulePresenceKeepalive();
      void this.flushPendingPresence();
    });

    client.on("disconnected", (...args: any[]) => {
      if (client !== this.client) {
        debugLog("Ignoring disconnect from stale Discord RPC client", ...args);
        return;
      }

      this.handleDisconnect("disconnected", ...args);
    });

    client.on("error", (...args: any[]) => {
      if (client !== this.client) {
        debugLog("Ignoring error from stale Discord RPC client", ...args);
        return;
      }

      this.handleDisconnect("error", ...args);
    });
  }

  private handleDisconnect(reason: string, ...details: any[]): void {
    if (this.ready || !this.needsClientRefresh) {
      debugLog(`Discord RPC disconnected (${reason})`, ...details);
    }

    this.ready = false;
    this.needsClientRefresh = true;

    if (this.connectPromise) {
      this.connectPromise = null;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.pendingPresence === null) {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 5000);
    debugLog(`Scheduling reconnect attempt ${this.reconnectAttempts + 1} in ${delay}ms`);

    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.ready || this.pendingPresence === null) {
      return;
    }

    this.reconnectAttempts += 1;
    debugLog(`Attempting reconnect (${this.reconnectAttempts})...`);

    try {
      await this.connect();
    } catch (error) {
      debugLog("Reconnect attempt failed", error);
      if (!this.ready) {
        this.scheduleReconnect();
      }
    }
  }

  private refreshClient(): void {
    const previousClient = this.client;

    try {
      const destroyResult = previousClient.destroy?.();
      if (destroyResult && typeof (destroyResult as Promise<void>).catch === "function") {
        void (destroyResult as Promise<void>).catch((error) => {
          logDestroyFailure(error);
        });
      }
    } catch (error) {
      logDestroyFailure(error);
    }

    this.client = this.createClient();
    this.bindListeners(this.client);
    this.needsClientRefresh = false;
  }

  private schedulePresenceKeepalive(): void {
    if (this.presenceKeepaliveTimer || this.pendingPresence === null) {
      return;
    }

    this.presenceKeepaliveTimer = this.schedule(() => {
      this.presenceKeepaliveTimer = null;
      void this.runPresenceKeepalive();
    }, this.presenceKeepaliveMs);
  }

  private async runPresenceKeepalive(): Promise<void> {
    if (!this.pendingPresence) {
      return;
    }

    if (!this.ready) {
      await this.attemptReconnect();
      this.schedulePresenceKeepalive();
      return;
    }

    try {
      await this.client.setActivity(buildActivity(this.pendingPresence));
    } catch (error) {
      this.handleDisconnect("presence_keepalive_failed", error);
    }

    this.schedulePresenceKeepalive();
  }

  private async flushPendingPresence(): Promise<void> {
    if (!this.ready || !this.pendingPresence) {
      return;
    }

    try {
      await this.client.setActivity(buildActivity(this.pendingPresence));
      this.schedulePresenceKeepalive();
    } catch (error) {
      this.handleDisconnect("flushPendingPresence_failed", error);
    }
  }
}

export function buildActivity(payload: PresencePayload): Record<string, unknown> {
  const stateParts = [payload.model, humanizeState(payload.state)];
  if (!payload.privacyMode && payload.projectName && defaultConfig.includeProjectName) {
    stateParts.push(payload.projectName);
  }

  // The summary the owner asked for: every agent open and every subagent running
  // live, as one line. A payload from a single session that never carried the
  // aggregate still reads as one agent, never as a missing number.
  const agents = Math.max(1, Math.floor(payload.agents ?? 1));
  const summary = [`${agents} ${agents === 1 ? "agent" : "agents"}`];
  const subagents = Math.max(0, Math.floor(payload.subagents ?? 0));
  if (subagents > 0) {
    summary.push(`${subagents} ${subagents === 1 ? "subagent" : "subagents"}`);
  }

  return {
    details: summary.join(" · "),
    state: stateParts.join(" • "),
    startTimestamp: payload.startedAt,
    largeImageKey: "pi",
    largeImageText: defaultConfig.appName,
    smallImageKey: normalizeKey(payload.provider),
    smallImageText: payload.provider
  };
}

export function humanizeState(state: PresencePayload["state"]): string {
  return {
    starting: "Starting",
    thinking: "Thinking",
    tooling: "Running Tools",
    editing: "Editing Files",
    idle: "Idle",
    error: "Error"
  }[state];
}

export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "-");
}

function isIgnorableDestroyFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message.includes("Cannot read properties of null") && error.message.includes("write");
}

function logDestroyFailure(error: unknown): void {
  if (isIgnorableDestroyFailure(error)) {
    return;
  }

  debugLog("Ignoring Discord RPC client destroy failure", error);
}

function debugLog(message: string, ...details: unknown[]): void {
  if (!defaultConfig.debugLogging) {
    return;
  }

  console.log(`[pi-discord-activity] ${message}`, ...details);
}

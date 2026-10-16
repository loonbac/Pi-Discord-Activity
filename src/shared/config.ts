export interface PresenceConfig {
  appName: string;
  rpcClientId: string;
  serverHost: string;
  serverPort: number;
  privacyMode: boolean;
  includeProjectName: boolean;
  debounceMs: number;
  autostartHelper: boolean;
  debugLogging: boolean;
  presenceTimeoutMs: number;
  /** How long a session stays live without reporting anything, in milliseconds. */
  sessionTtlMs: number;
  /** Where the subagent task records live, when it is not the machine default. */
  subagentTasksDir?: string;
  /** How often the subagent count is re-read from the records, in milliseconds. */
  subagentRefreshMs: number;
  /** How often an open session re-publishes to stay in the live registry, in milliseconds. */
  heartbeatMs: number;
}

export const defaultConfig: PresenceConfig = {
  appName: "Pi Coding Agent",
  rpcClientId: process.env.DISCORD_RPC_CLIENT_ID ?? "1495329514417426522",
  serverHost: process.env.PI_PRESENCE_HOST ?? "127.0.0.1",
  serverPort: Number(process.env.PI_PRESENCE_PORT ?? "42666"),
  privacyMode: process.env.PI_PRESENCE_PRIVACY_MODE !== "false",
  includeProjectName: process.env.PI_PRESENCE_INCLUDE_PROJECT === "true",
  debounceMs: Number(process.env.PI_PRESENCE_DEBOUNCE_MS ?? "2000"),
  autostartHelper: process.env.PI_PRESENCE_AUTOSTART_HELPER !== "false",
  debugLogging: process.env.PI_PRESENCE_DEBUG === "true",
  presenceTimeoutMs: Number(process.env.PI_PRESENCE_TIMEOUT_MS ?? "600000"),
  sessionTtlMs: Number(process.env.PI_PRESENCE_SESSION_TTL_MS ?? "300000"),
  subagentTasksDir: process.env.PI_PRESENCE_SUBAGENT_TASKS_DIR?.trim() || undefined,
  subagentRefreshMs: Number(process.env.PI_PRESENCE_SUBAGENT_REFRESH_MS ?? "15000"),
  heartbeatMs: Number(process.env.PI_PRESENCE_HEARTBEAT_MS ?? "60000")
};

/**
 * The heartbeat interval, read when the heartbeat starts rather than at import.
 *
 * A frozen default cannot see an operator changing the environment of a running
 * session, and it would also freeze a test that sets the variable to shorten the
 * wait. It always falls back to the same default the config declares.
 */
export function resolveHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_PRESENCE_HEARTBEAT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return defaultConfig.heartbeatMs;
};

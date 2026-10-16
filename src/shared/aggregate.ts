import type { ActivityState, PresencePayload } from "./types.js";

/**
 * One live Pi session as the helper daemon sees it.
 *
 * `lastPromptAt` is the moment the user last started work in that session
 * (`agent_start`), which is the only user-driven signal a session can report.
 * `lastSeen` is any activity at all. They are kept apart because the foreground
 * session must follow the user, not the noisiest process: a background session
 * running its own tools must not steal the display from the session the user is
 * actually working in.
 */
export interface PresenceSessionEntry {
  sessionId: string;
  payload: PresencePayload;
  lastSeen: number;
  lastPromptAt: number;
}

export interface PresenceAggregate {
  /** The session the user is in: the one it prompted most recently. */
  sessionId: string;
  provider: string;
  model: string;
  state: ActivityState;
  /**
   * One elapsed clock for every session: the start of the one open the longest.
   *
   * The owner asked for a single time "por el más abierto", so the aggregate
   * never takes the time of the foreground session. When that oldest session
   * retires, the time moves to the next oldest instead of resetting to now.
   */
  startedAt: number;
  privacyMode: boolean;
  projectName?: string;
  /** Live Pi sessions behind this single presence. */
  agents: number;
  /** Live subagents launched by those sessions, from their own task records. */
  subagents: number;
}

/**
 * The one presence every live session shares, or `null` when no session is live.
 *
 * What is shown comes from the session in the foreground — the model and what it
 * is doing change with the agent the user last prompted — and the counts describe
 * the rest: how many agents are open and how many subagents they have running.
 * Nothing here invents a number: `subagents` is passed in, and it is 0 when the
 * caller has no evidence of any.
 */
export function aggregatePresence(
  sessions: readonly PresenceSessionEntry[],
  subagents: number
): PresenceAggregate | null {
  if (sessions.length === 0) return null;

  let oldest: PresenceSessionEntry | undefined;
  let foreground: PresenceSessionEntry | undefined;

  for (const session of sessions) {
    if (!oldest || session.payload.startedAt < oldest.payload.startedAt) {
      oldest = session;
    }
    if (!foreground || isMoreForeground(session, foreground)) {
      foreground = session;
    }
  }

  const shown = foreground!.payload;
  const live = parsedCount(subagents);

  return {
    sessionId: foreground!.sessionId,
    provider: shown.provider,
    model: shown.model,
    state: shown.state,
    startedAt: oldest!.payload.startedAt,
    privacyMode: shown.privacyMode,
    ...(shown.privacyMode || !shown.projectName ? {} : { projectName: shown.projectName }),
    agents: sessions.length,
    subagents: live
  };
}

/**
 * Order that decides the foreground session: the one the user prompted last,
 * then the one most recently seen, then the stable session id so the same input
 * always yields the same presence regardless of the order it arrived in.
 */
function isMoreForeground(candidate: PresenceSessionEntry, current: PresenceSessionEntry): boolean {
  if (candidate.lastPromptAt !== current.lastPromptAt) return candidate.lastPromptAt > current.lastPromptAt;
  if (candidate.lastSeen !== current.lastSeen) return candidate.lastSeen > current.lastSeen;
  return candidate.sessionId < current.sessionId;
}

/**
 * A count of subagents is a count of evidence: negative, fractional or absent
 * values never become "1" by accident.
 */
function parsedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

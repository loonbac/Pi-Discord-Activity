import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../shared/config.js";

/**
 * Statuses that mean a subagent this machine launched is still alive.
 *
 * Read from the task records the orchestrator writes, never guessed: a status that
 * is not one of these is a subagent that finished, failed, or was cancelled, and
 * counting it would report work that no longer runs. The list is local evidence
 * from `~/.pi/agent/gentle-agents/tasks`, where every launched subagent leaves a
 * record.
 */
const LIVE_SUBAGENT_STATUSES: ReadonlySet<string> = new Set(["running", "queued", "starting"]);

/** Where this machine keeps its subagent records, unless overridden. */
export function defaultSubagentTasksDirectory(home: string = homedir()): string {
  const configured = defaultConfig.subagentTasksDir;
  if (configured !== undefined) return configured;
  return join(home, ".pi", "agent", "gentle-agents", "tasks");
}

/**
 * How many subagents are running right now, or 0 when there is no evidence of any.
 *
 * Zero is the honest answer for an absent directory, an unreadable record, or a
 * malformed one: no evidence never becomes one subagent by accident. A record is
 * only read, never written, so a live launch is visible the moment its file
 * exists.
 */
export function liveSubagentCount(tasksDirectory: string = defaultSubagentTasksDirectory()): number {
  if (!existsSync(tasksDirectory)) return 0;

  let files: string[];
  try {
    files = readdirSync(tasksDirectory);
  } catch {
    return 0;
  }

  let live = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(tasksDirectory, file), "utf8")) as { task?: { status?: unknown } };
      const status = parsed?.task?.status;
      if (typeof status === "string" && LIVE_SUBAGENT_STATUSES.has(status)) live += 1;
    } catch {
      // A partially written or unreadable record is not evidence of a subagent.
    }
  }
  return live;
}

export interface SubagentCounterOptions {
  /** How often the counter re-reads the records. */
  refreshMs?: number;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
  /** Where the records live; the machine default when omitted. */
  tasksDirectory?: string;
}

export interface SubagentCounter {
  /** The number of subagents live as of the last refresh. */
  count(): number;
  /** Re-read the records now and return the new count. */
  refresh(): number;
  /** Stop refreshing. */
  close(): void;
}

/**
 * A counter that keeps the current number of live subagents, refreshed on a timer.
 *
 * Subagent launches and completions do not publish presence events, so the helper
 * cannot learn about them from the sessions alone. The records are the source;
 * this counter re-reads them and hands the number to the presence aggregate.
 */
export function createSubagentCounter(tasksDirectory?: string, options: SubagentCounterOptions = {}): SubagentCounter {
  const directory = tasksDirectory ?? defaultSubagentTasksDirectory();
  const refreshMs = options.refreshMs ?? defaultConfig.subagentRefreshMs;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;

  let current = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // The first read is scheduled rather than performed here: the counter starts empty
  // and fills on its first refresh, so a listener that asks before then sees the
  // honest "no evidence yet" answer instead of a number it did not wait for.
  scheduleRefresh();

  function scheduleRefresh(): void {
    if (closed || refreshMs <= 0) return;
    timer = schedule(() => {
      timer = null;
      refresh();
    }, refreshMs);
  }

  function refresh(): number {
    current = liveSubagentCount(directory);
    scheduleRefresh();
    return current;
  }

  return {
    count: () => current,
    refresh,
    close() {
      closed = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    }
  };
}

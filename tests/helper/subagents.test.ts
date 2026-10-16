import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentCounter, liveSubagentCount } from "../../src/helper/subagents.js";

function record(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: {
      agent: "gentle-ai-worker",
      status,
      parentSessionId: "s-parent",
      createdAt: 1_700_000_000,
      label: "do the thing",
      ...extra
    }
  };
}

function tasksDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-agents-"));
  return dir;
}

test("counts only the subagents still running", () => {
  const dir = tasksDir();
  writeFileSync(join(dir, "a.json"), JSON.stringify(record("running")));
  writeFileSync(join(dir, "b.json"), JSON.stringify(record("completed")));
  writeFileSync(join(dir, "c.json"), JSON.stringify(record("failed")));
  writeFileSync(join(dir, "d.json"), JSON.stringify(record("running", { agent: "gentle-ai-verify" })));

  assert.equal(liveSubagentCount(dir), 2);

  writeFileSync(join(dir, "a.json"), JSON.stringify(record("completed")));
  assert.equal(liveSubagentCount(dir), 1, "el contador baja cuando el subagente termina");

  rmSync(dir, { recursive: true, force: true });
});

test("no live subagents reads as zero, never as an invented number", () => {
  const dir = tasksDir();
  writeFileSync(join(dir, "a.json"), JSON.stringify(record("completed")));
  assert.equal(liveSubagentCount(dir), 0);

  rmSync(dir, { recursive: true, force: true });
});

test("a missing directory reads as zero", () => {
  assert.equal(liveSubagentCount(join(tmpdir(), "pi-does-not-exist-9931")), 0);
});

test("unreadable or malformed records are ignored instead of throwing", () => {
  const dir = tasksDir();
  writeFileSync(join(dir, "broken.json"), "{not json");
  writeFileSync(join(dir, "nested.json"), JSON.stringify({ nothing: true }));
  writeFileSync(join(dir, "good.json"), JSON.stringify(record("running")));

  assert.equal(liveSubagentCount(dir), 1, "sólo el registro válido cuenta");

  rmSync(dir, { recursive: true, force: true });
});

test("only the live-running statuses of this machine are counted", () => {
  const dir = tasksDir();
  for (const status of ["running", "queued", "starting", "cancelled", "timed_out"]) {
    writeFileSync(join(dir, `${status}.json`), JSON.stringify(record(status)));
  }
  assert.equal(liveSubagentCount(dir), 3, "running, queued y starting son subagentes vivos; los demás no");

  rmSync(dir, { recursive: true, force: true });
});

test("the counter refreshes on its own and stops when closed", async () => {
  const dir = tasksDir();
  let now = 0;
  const scheduled: { fn: () => void; delay: number }[] = [];

  const counter = createSubagentCounter(dir, {
    refreshMs: 1_000,
    now: () => now,
    schedule: ((fn: () => void, delay?: number) => {
      scheduled.push({ fn, delay: delay ?? 0 });
      return scheduled.length;
    }) as unknown as typeof setTimeout,
    cancel: (() => {}) as unknown as typeof clearTimeout
  });

  writeFileSync(join(dir, "a.json"), JSON.stringify(record("running")));
  assert.equal(counter.count(), 0, "nace vacío: todavía no ha leído");

  scheduled[0].fn();
  assert.equal(counter.count(), 1, "el refresco periódico lo ve");

  writeFileSync(join(dir, "a.json"), JSON.stringify(record("completed")));
  now = 5_000;
  scheduled[0].fn();
  assert.equal(counter.count(), 0, "un subagente que termina deja de contarse en el refresco");

  counter.close();
  const scheduledBefore = scheduled.length;
  now = 10_000;
  scheduled[scheduled.length - 1].fn();
  assert.equal(scheduled.length, scheduledBefore, "cerrado no vuelve a programar");

  rmSync(dir, { recursive: true, force: true });
});

test("the default directory is the agent directory of this machine", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-home-"));
  mkdirSync(join(home, ".pi", "agent", "gentle-agents", "tasks"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "gentle-agents", "tasks", "a.json"),
    JSON.stringify(record("running"))
  );

  const env = { HOME: home } as unknown as NodeJS.ProcessEnv;
  assert.equal(liveSubagentCount(join(home, ".pi", "agent", "gentle-agents", "tasks")), 1);

  rmSync(home, { recursive: true, force: true });
  assert.ok(env);
});

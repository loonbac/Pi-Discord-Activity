import test from "node:test";
import assert from "node:assert/strict";
import { buildActivity, humanizeState } from "../../src/helper/discord.js";
import type { PresencePayload } from "../../src/shared/types.js";
import { defaultConfig } from "../../src/shared/config.js";

function payload(over: Partial<PresencePayload> = {}): PresencePayload {
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

test("details summarize how many agents and subagents are live", () => {
  const one = buildActivity(payload({ agents: 1 }));
  const many = buildActivity(payload({ agents: 3, subagents: 2 }));
  const agentsAndSubagents = buildActivity(payload({ agents: 3, subagents: 1 }));

  assert.equal(one.details, "1 agent");
  assert.equal(many.details, "3 agents · 2 subagents");
  assert.equal(agentsAndSubagents.details, "3 agents · 1 subagent");
});

test("a single agent with no subagent shows just that, without a invented count", () => {
  const activity = buildActivity(payload({ agents: 1 }));
  assert.equal(activity.details, "1 agent");
});

test("the state line is the foreground model and what it is doing", () => {
  const activity = buildActivity(payload({ model: "glm-5.3", state: "editing" }));
  assert.equal(activity.state, "glm-5.3 • Editing Files");
});

test("the single elapsed time comes from the aggregate, not from the payload default", () => {
  const activity = buildActivity(payload({ startedAt: 999 }));
  assert.equal(activity.startTimestamp, 999);
});

test("the provider still marks the activity icon", () => {
  const activity = buildActivity(payload({ provider: "opencode-go" }));
  assert.equal(activity.smallImageText, "opencode-go");
});

test("privacy mode keeps the project name out of the state line", () => {
  const activity = buildActivity(payload({ privacyMode: true, projectName: "secret-project" }));
  assert.equal(String(activity.state).includes("secret-project"), false);
});

test("with privacy off the project joins the state line when the config allows it", () => {
  const activity = buildActivity(payload({ privacyMode: false, projectName: "mdm-gestor" }));
  assert.equal(String(activity.state).includes("mdm-gestor"), defaultConfig.includeProjectName);
});

test("humanizeState covers every activity the extension reports", () => {
  assert.equal(humanizeState("thinking"), "Thinking");
  assert.equal(humanizeState("tooling"), "Running Tools");
  assert.equal(humanizeState("editing"), "Editing Files");
  assert.equal(humanizeState("error"), "Error");
});

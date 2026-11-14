import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutor, executionConfig } from "../src/automation/executor.js";
import type {
  Automation,
  AutomationDraft,
  AutomationEvidence,
  Execution,
} from "../src/contracts/index.js";
import { type CoreDeps, DEFAULT_CONFIG, defaultDeps, openWorkspace } from "../src/core/index.js";
import { FakeAgents, FakeGit, FakeProcesses } from "./fakes.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "c60-exec-")));
  roots.push(root);
  const repository = join(root, "repo");
  await fs.mkdir(repository);
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  await fs.mkdir(join(env.XDG_CONFIG_HOME, "code60"), { recursive: true });
  const config = join(env.XDG_CONFIG_HOME, "code60", "config.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      permissions: { default: "allow" },
      agents: { fixture: { command: ["fake-provider"] } },
      mcpServers: { untrusted: { type: "stdio", command: "bad" } },
    }),
  );
  const agents = new FakeAgents((_text, session) => {
    void session
      .requestPermission({ toolCallId: "denied", title: "Execute", kind: "execute", options: [] })
      .then((answer) => {
        expect(answer).toBe("deny");
        session.endTurn("end_turn");
      });
    return "hang";
  });
  const git = new FakeGit();
  git.repoInfo = async () => ({ topLevel: repository, commonDir: join(repository, ".git") });
  git.addWorktree = async (spec) => {
    await fs.mkdir(spec.path, { recursive: true });
  };
  const deps: CoreDeps = { ...defaultDeps(), agents, git, processes: new FakeProcesses() };
  const executor = createExecutor(deps, env);
  const draft: AutomationDraft = {
    repository,
    name: "Checks",
    prompt: "Saved prompt",
    agent: "fixture",
    baseBranch: "main",
    allow: ["read"],
    turnTimeout: "1s",
    enabled: false,
    schedule: { type: "interval", everyMinutes: 1, anchor: "2026-01-01T00:00:00Z" },
  };
  const identity = await executor.validate(draft);
  const automation: Automation = {
    ...draft,
    ...identity,
    id: randomUUID(),
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextRunAt: null,
  };
  const execution: Execution = {
    id: randomUUID(),
    sequence: 1,
    automationId: automation.id,
    automationName: automation.name,
    repository: identity.repository,
    evidence: null,
    revision: 1,
    trigger: "manual",
    scheduledFor: null,
    claimedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    reason: null,
    runId: `auto-${randomUUID()}`,
    denials: 0,
    changedFiles: null,
  };
  return {
    root,
    repository,
    env,
    config,
    agents,
    git,
    deps,
    executor,
    draft,
    automation,
    execution,
  };
}
describe("isolated automation execution", () => {
  it("recognizes missing core records for claims and prelaunch refusals, not uncertain launches", async () => {
    const s = await setup();
    expect(await s.executor.inspect({ ...s.execution, status: "claimed" })).toBe("gone");
    for (const reason of ["provider_changed", "base_missing", "low_disk"] as const)
      expect(await s.executor.inspect({ ...s.execution, status: "failed", reason })).toBe("gone");
    expect(await s.executor.inspect(s.execution)).toBe("blocked");
    expect(
      await s.executor.inspect({
        ...s.execution,
        status: "failed",
        reason: "preparation_failed",
      }),
    ).toBe("blocked");
  });
  it("overrides permissive global policy, disables MCP, pins a worktree and runs exactly one turn", async () => {
    const s = await setup();
    let pin: AutomationEvidence | undefined;
    const result = await s.executor.execute(
      s.automation,
      s.execution,
      new AbortController().signal,
      async (evidence) => {
        pin = evidence;
      },
    );
    expect(result.status).toBe("finished");
    expect(result.denials).toBe(1);
    expect(s.agents.sessions[0]?.prompts).toEqual(["Saved prompt"]);
    expect(s.agents.specs[0]?.mcpServers ?? []).toEqual([]);
    expect(s.agents.specs[0]?.cwd).not.toBe(s.repository);
    expect(pin?.worktree.path).toBe(s.agents.specs[0]?.cwd);
    const workspace = await openWorkspace(s.deps, s.repository, s.env);
    expect((await workspace.store.read(s.execution.runId as string)).id).toBe(s.execution.runId);
    const config = executionConfig(
      { ...DEFAULT_CONFIG, agents: { fixture: { command: ["fake-provider"] } } },
      s.automation,
    );
    expect(config.permissions).toEqual({ default: "deny", read: "allow" });
    expect(config.mcpServers).toEqual({});
  });
  it("refuses changed providers, missing bases and replaced repositories before starting agents", async () => {
    const s = await setup();
    const pin = async () => {};
    await fs.writeFile(
      s.config,
      JSON.stringify({ agents: { fixture: { command: ["different-provider"] } } }),
    );
    await expect(
      s.executor.execute(s.automation, s.execution, new AbortController().signal, pin),
    ).rejects.toMatchObject({ reason: "provider_changed" });
    s.git.resolveCommit = async () => {
      throw new Error("missing");
    };
    await expect(
      s.executor.execute(s.automation, s.execution, new AbortController().signal, pin),
    ).rejects.toMatchObject({ reason: "base_missing" });
    await fs.rename(s.repository, `${s.repository}-old`);
    await fs.mkdir(s.repository);
    await expect(
      s.executor.execute(s.automation, s.execution, new AbortController().signal, pin),
    ).rejects.toMatchObject({ reason: "repository_replaced" });
    expect(s.agents.sessions).toHaveLength(0);
  });
  it("never falls back to a direct directory and never starts after cancelled preparation", async () => {
    const s = await setup();
    s.git.repoInfo = async () => {
      throw new Error("missing repo");
    };
    await expect(
      s.executor.execute(s.automation, s.execution, new AbortController().signal, async () => {}),
    ).rejects.toThrow();
    expect(s.agents.sessions).toHaveLength(0);
    const abort = new AbortController();
    abort.abort();
    expect(
      (await s.executor.execute(s.automation, s.execution, abort.signal, async () => {})).status,
    ).toBe("cancelled");
    expect(s.agents.sessions).toHaveLength(0);
    expect(await s.executor.inspect(s.execution)).toBe("blocked");
  });
});

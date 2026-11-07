import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentStartError } from "../src/agents/index.js";
import { diffRun, discardRun, listRuns, stopRun } from "../src/core/commands.js";
import { DEFAULT_PERMISSIONS } from "../src/core/config.js";
import { createOrchestrator, type OrchestratorOptions } from "../src/core/orchestrator.js";
import type { RunRecord } from "../src/core/types.js";
import {
  FakeAgents,
  FakeClock,
  FakeGit,
  FakeProcesses,
  flush,
  MemoryStore,
  type TurnScript,
} from "./fakes.js";

const MIN = 60_000;

async function setup(
  options: Partial<OrchestratorOptions> & {
    script?: TurnScript;
    count?: number;
    identity?: () => Promise<NonNullable<RunRecord["ownerIdentity"]> | null>;
  } = {},
) {
  const clock = new FakeClock();
  const agents = new FakeAgents(options.script);
  const git = new FakeGit();
  const store = new MemoryStore();
  const processes = Object.assign(
    new FakeProcesses(),
    options.identity ? { identity: options.identity } : {},
  );
  let n = 0;
  const count = options.count ?? 1;
  const orch = await createOrchestrator(
    { agents, git, store, clock, processes, ownerPid: 42, newRunId: () => `r${++n}` },
    {
      mode: "headless",
      prompt: "do the thing",
      agents: Array.from({ length: count }, () => ({
        name: "claude",
        config: { command: ["agent", "--acp"] },
      })),
      base: "c0ffee",
      repoDir: "/repo",
      worktreeRoot: "/repo.worktrees",
      turnTimeoutMs: 30 * MIN,
      maxParallel: 4,
      policy: DEFAULT_PERMISSIONS,
      ...options,
    },
  );
  const status = (id: string) => orch.runs().find((r) => r.id === id)?.status;
  return { clock, agents, git, store, processes, orch, status };
}

describe("a headless run", () => {
  it("records native owner identity before launching and reuses it for the batch", async () => {
    const owner = { createdAt: "12345", owner: "S-1-5-21-1" };
    const identity = vi.fn(async () => owner);
    const { orch, store } = await setup({ identity });
    expect(store.records.get("r1")).toMatchObject({ status: "queued", ownerIdentity: owner });
    orch.start();
    await orch.done;
    expect(identity).toHaveBeenCalledTimes(1);
    expect(store.records.get("r1")).toMatchObject({ status: "finished", ownerIdentity: owner });
  });

  it("refuses to prepare a batch when the native owner cannot be verified", async () => {
    await expect(setup({ identity: async () => null })).rejects.toThrow(/owner/);
    await expect(
      setup({
        identity: async () => {
          throw new Error("access denied");
        },
      }),
    ).rejects.toThrow(/access denied/);
  });

  it("creates the worktree, runs one turn, stops the agent, and finishes", async () => {
    const { orch, agents, git, store } = await setup();
    orch.start();
    await orch.done;
    expect(git.worktrees).toEqual([
      {
        repoDir: "/repo",
        path: join("/repo.worktrees", "r1"),
        branch: "code60/r1",
        base: "c0ffee",
      },
    ]);
    expect(agents.specs[0]).toMatchObject({
      name: "claude",
      command: ["agent", "--acp"],
      cwd: join("/repo.worktrees", "r1"),
    });
    expect(agents.sessions[0]?.prompts).toEqual(["do the thing"]);
    expect(agents.sessions[0]?.stops).toEqual([5_000]);
    expect(store.statuses("r1")).toEqual(["queued", "running", "finished"]);
    const record = store.records.get("r1") as RunRecord;
    expect(record).toMatchObject({
      status: "finished",
      turns: 1,
      lastStopReason: "end_turn",
      agentPid: 1000,
      ownerPid: 42,
    });
    expect(record.endedAt).toBeDefined();
    expect(store.events.filter((e) => e.type === "turnEnd")).toMatchObject([
      { runId: "r1", turn: 1, stopReason: "end_turn" },
    ]);
    expect(store.events.find((e) => e.type === "prompt")).toMatchObject({
      turn: 1,
      text: "do the thing",
    });
    expect(await orch.results()).toEqual([
      {
        id: "r1",
        agent: "claude",
        status: "finished",
        reason: null,
        branch: "code60/r1",
        worktree: join("/repo.worktrees", "r1"),
        changedFiles: 0,
      },
    ]);
  });

  it("runs directly in the directory, without a worktree, when `directory` is set", async () => {
    const { orch, agents, git, store } = await setup({ directory: "/plain", count: 2 });
    orch.start();
    await orch.done;
    expect(git.worktrees).toEqual([]);
    expect(agents.specs.map((s) => s.cwd)).toEqual(["/plain", "/plain"]);
    expect(store.records.get("r1")).toMatchObject({ base: null, branch: null, worktree: "/plain" });
    expect((await orch.results())[0]).toEqual({
      id: "r1",
      agent: "claude",
      status: "finished",
      reason: null,
      branch: null,
      worktree: "/plain",
      changedFiles: null,
    });
    await expect(
      diffRun({ git, store, clock: new FakeClock(), processes: new FakeProcesses() }, "r1"),
    ).rejects.toThrow(/without a worktree/);
    await expect(
      discardRun(
        { git, store, clock: new FakeClock(), processes: new FakeProcesses() },
        "/plain",
        "r1",
        async () => true,
      ),
    ).rejects.toThrow(/no worktree or branch to discard/);
    expect(git.removed).toEqual([]);
  });

  it.each([
    ["max_tokens", "failed"],
    ["refusal", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("maps stop reason %s to %s", async (reason, final) => {
    const { orch, status, store } = await setup({ script: () => reason });
    orch.start();
    await orch.done;
    expect(status("r1")).toBe(final);
    expect(store.events.filter((e) => e.type === "turnEnd")).toMatchObject([
      { turn: 1, stopReason: reason },
    ]);
  });

  it("fails clearly when the worktree or the agent cannot start, and others keep going", async () => {
    const a = await setup();
    a.git.addError = new Error("path exists");
    a.orch.start();
    await a.orch.done;
    expect(a.orch.runs()[0]).toMatchObject({
      status: "failed",
      reason: "could not create the worktree: path exists",
    });
    expect(a.agents.specs).toEqual([]);

    const b = await setup({ count: 2 });
    b.agents.startError = new AgentStartError(
      "agent 'claude' requires authentication; log in through claude's own CLI",
      "",
      true,
    );
    b.orch.start();
    await b.orch.done;
    expect(b.orch.runs().map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(b.orch.runs()[0]?.reason).toMatch(/log in through claude's own CLI/);
    expect((await b.orch.results())[0]?.changedFiles).toBe(0);
  });

  it("fails when the agent exits during a turn", async () => {
    const { orch, agents, status } = await setup({ script: () => "hang" });
    orch.start();
    await flush();
    agents.sessions[0]?.crash();
    await orch.done;
    expect(status("r1")).toBe("failed");
    expect(orch.runs()[0]?.reason).toBe("agent exited with code 1");
  });
});

describe("the scheduler", () => {
  it("starts runs up to the limit, and idle runs keep their slot", async () => {
    const { orch, agents, status } = await setup({ mode: "interactive", count: 3, maxParallel: 2 });
    orch.start();
    await flush();
    expect([status("r1"), status("r2"), status("r3")]).toEqual(["idle", "idle", "queued"]);
    expect(agents.specs).toHaveLength(2);
    orch.finish("r1");
    await flush(10);
    expect(status("r1")).toBe("finished");
    expect(status("r3")).toBe("idle");
    orch.finish("r2");
    orch.finish("r3");
    await orch.done;
  });

  it("without a prompt, starts each agent idle and sends the first reply as turn 1", async () => {
    const { orch, agents, store, status } = await setup({
      mode: "interactive",
      prompt: "",
      count: 2,
    });
    orch.start();
    await flush();
    expect([status("r1"), status("r2")]).toEqual(["idle", "idle"]);
    expect(orch.runs()[0]?.reason).toBe("no prompt yet");
    expect(agents.sessions[0]?.prompts).toEqual([]);
    orch.reply("r1", "first");
    await flush(10);
    expect(agents.sessions[0]?.prompts).toEqual(["first"]);
    expect(store.records.get("r1")).toMatchObject({ firstPrompt: "first", turns: 1 });
    orch.finish("r1");
    orch.finish("r2");
    await orch.done;
    expect(status("r1")).toBe("finished");
    expect(store.records.get("r2")).toMatchObject({
      status: "finished",
      reason: "no prompt was sent",
      turns: 0,
    });
  });

  it("a failed run frees its slot for the next one", async () => {
    let calls = 0;
    const { orch, status } = await setup({
      count: 2,
      maxParallel: 1,
      script: () => (++calls === 1 ? new Error("ACP failed") : "end_turn"),
    });
    orch.start();
    await orch.done;
    expect([status("r1"), status("r2")]).toEqual(["failed", "finished"]);
  });
});

describe("turn timeouts and cancellation", () => {
  it("records actual completion separately from idle time and failure cleanup", async () => {
    const { orch, agents, clock, store } = await setup({
      mode: "interactive",
      script: () => "hang",
    });
    orch.start();
    await flush();
    const start = clock.now().getTime();
    await clock.advance(12000);
    agents.sessions[0]?.endTurn("end_turn");
    await flush();
    expect(store.events.find((event) => event.type === "turnEnd")).toMatchObject({
      turn: 1,
      outcome: "finished",
      completedAt: new Date(start + 12000).toISOString(),
    });
    await clock.advance(60000);
    orch.reply("r1", "follow up");
    await flush();
    await clock.advance(7000);
    const session = agents.sessions[0];
    if (!session) throw new Error("Missing session");
    const stop = session.stop.bind(session);
    vi.spyOn(session, "stop").mockImplementation(async (grace) => {
      await clock.advance(60000);
      await stop(grace);
    });
    session.failTurn(new Error("Transport failure"));
    await orch.done;
    expect(store.events.findLast((event) => event.type === "status")).toMatchObject({
      status: "failed",
      turn: 2,
      completedAt: new Date(start + 79000).toISOString(),
      at: new Date(start + 139000).toISOString(),
    });
  });
  it("headless: a timed-out turn is cancelled and the run is timed_out", async () => {
    const { orch, agents, clock, status } = await setup({ script: () => "hang" });
    orch.start();
    await clock.advance(30 * MIN - 1);
    expect(status("r1")).toBe("running");
    await clock.advance(1);
    await orch.done;
    expect(agents.sessions[0]?.cancels).toBe(1);
    expect(orch.runs()[0]).toMatchObject({
      status: "timed_out",
      reason: "turn 1 exceeded the 30m turn timeout",
    });
  });

  it("desktop app: a timed-out turn that ends in time leaves the run idle; finishing reports timed_out", async () => {
    const { orch, clock, status, store } = await setup({
      mode: "interactive",
      script: () => "hang",
    });
    orch.start();
    await clock.advance(30 * MIN);
    expect(status("r1")).toBe("idle");
    expect(store.events.find((event) => event.type === "turnEnd")).toMatchObject({
      outcome: "timed_out",
      stopReason: "cancelled",
      completedAt: clock.now().toISOString(),
    });
    expect(orch.runs()[0]?.reason).toBe("turn 1 ended: cancelled (turn timed out)");
    await clock.advance(120 * MIN);
    expect(status("r1")).toBe("idle");
    orch.finish("r1");
    await orch.done;
    expect(status("r1")).toBe("timed_out");
  });

  it("escalates to stopping the agent when a cancelled turn does not end within 10 s", async () => {
    const { orch, agents, clock } = await setup({ mode: "interactive", script: () => "hang" });
    orch.start();
    await flush();
    const session = agents.sessions[0];
    if (session === undefined) throw new Error("no session");
    session.onCancel = "ignore";
    expect(orch.cancelTurn("r1")).toBe(true);
    await clock.advance(9_999);
    expect(session.stops).toEqual([]);
    await clock.advance(1);
    await orch.done;
    expect(session.stops[0]).toBe(5_000);
    expect(orch.runs()[0]).toMatchObject({ status: "cancelled", reason: "the turn was cancelled" });
  });

  it("times out the agent's startup", async () => {
    const { orch, agents, clock } = await setup();
    agents.startGate = new Promise(() => {});
    orch.start();
    await clock.advance(30 * MIN);
    await orch.done;
    expect(orch.runs()[0]).toMatchObject({
      status: "timed_out",
      reason: "the agent did not start within 30m",
    });
  });
});

describe("follow-up turns (desktop app)", () => {
  it("replies continue the same session, and the last turn sets the final status", async () => {
    const reasons = ["max_tokens", "end_turn"] as const;
    let i = 0;
    const { orch, agents, store, status } = await setup({
      mode: "interactive",
      script: () => reasons[i++] ?? "end_turn",
    });
    orch.start();
    await flush();
    expect(orch.runs()[0]).toMatchObject({
      status: "idle",
      lastStopReason: "max_tokens",
      reason: "turn 1 ended: max_tokens",
    });
    orch.reply("r1", "keep going");
    await flush();
    expect(agents.sessions).toHaveLength(1);
    expect(agents.sessions[0]?.prompts).toEqual(["do the thing", "keep going"]);
    expect(
      store.events.filter((e) => e.type === "prompt").map((e) => (e as { turn: number }).turn),
    ).toEqual([1, 2]);
    orch.finish("r1");
    await orch.done;
    expect(status("r1")).toBe("finished");
    expect(store.records.get("r1")?.turns).toBe(2);
    expect(store.events.filter((e) => e.type === "turnEnd")).toMatchObject([
      { turn: 1, stopReason: "max_tokens" },
      { turn: 2, stopReason: "end_turn" },
    ]);
  });

  it("the final status can be worse than earlier turns", async () => {
    const reasons = ["end_turn", "refusal"] as const;
    let i = 0;
    const { orch, status } = await setup({
      mode: "interactive",
      script: () => reasons[i++] ?? "end_turn",
    });
    orch.start();
    await flush();
    orch.reply("r1", "again");
    await flush();
    orch.finish("r1");
    await orch.done;
    expect(status("r1")).toBe("failed");
  });

  it("refuses replies while running, empty replies, and replies in headless mode", async () => {
    const tui = await setup({ mode: "interactive", script: () => "hang" });
    tui.orch.start();
    await flush();
    expect(() => tui.orch.reply("r1", "now")).toThrow(/only to an idle run/);
    expect(() => tui.orch.finish("r1")).toThrow(/only an idle run/);
    tui.agents.sessions[0]?.endTurn("end_turn");
    await flush();
    expect(() => tui.orch.reply("r1", "  ")).toThrow(/empty/);
    await tui.orch.shutdown();

    const headless = await setup({ script: () => "hang" });
    headless.orch.start();
    await flush();
    expect(() => headless.orch.reply("r1", "now")).toThrow(/only available in the desktop app/);
    await headless.orch.shutdown();
  });

  it("an agent that exits while idle fails the run", async () => {
    const { orch, agents, status } = await setup({ mode: "interactive" });
    orch.start();
    await flush();
    agents.sessions[0]?.crash();
    await orch.done;
    expect(status("r1")).toBe("failed");
    expect(orch.runs()[0]?.reason).toBe("the agent exited while idle");
  });
});

describe("permissions", () => {
  it("applies the policy and records who decided", async () => {
    const answers: string[] = [];
    const options = [{ optionId: "allow", name: "Allow once", kind: "allow_once" }];
    const { orch, store } = await setup({
      script: (_t, s) => {
        void (async () => {
          answers.push(
            await s.requestPermission({ toolCallId: "1", title: "Read", kind: "read", options }),
          );
          answers.push(
            await s.requestPermission({ toolCallId: "2", title: "Run", kind: "execute" }),
          );
          s.endTurn("end_turn");
        })();
        return "hang";
      },
    });
    orch.start();
    await orch.done;
    expect(answers).toEqual(["allow", "deny"]);
    expect(store.events.filter((e) => e.type === "permission")).toMatchObject([
      { toolCallId: "1", decision: "allowed", by: "policy", options },
      { toolCallId: "2", decision: "denied", by: "policy" },
    ]);
  });

  it("--allow overrides ask in headless mode", async () => {
    let answer = "";
    const { orch } = await setup({
      overrides: { allow: ["execute"] },
      script: (_t, s) => {
        void s.requestPermission({ toolCallId: "1", title: "Run", kind: "execute" }).then((a) => {
          answer = a;
          s.endTurn("end_turn");
        });
        return "hang";
      },
    });
    orch.start();
    await orch.done;
    expect(answer).toBe("allow");
  });

  it("desktop app: ask waits for the user while other runs keep going", async () => {
    const answers: string[] = [];
    let call = 0;
    const { orch, store, status } = await setup({
      mode: "interactive",
      count: 2,
      script: (_t, s) => {
        if (++call > 1) return "end_turn";
        void s
          .requestPermission({ toolCallId: "x", title: "rm -rf build", kind: "execute" })
          .then((a) => {
            answers.push(a);
            s.endTurn("end_turn");
          });
        return "hang";
      },
    });
    orch.start();
    await flush();
    expect(status("r1")).toBe("waiting");
    expect(status("r2")).toBe("idle");
    const pending = orch.runs()[0]?.pending ?? [];
    expect(pending).toEqual([
      { id: "r1#1", runId: "r1", toolCallId: "x", title: "rm -rf build", kind: "execute" },
    ]);
    expect(orch.answerPermission("r1#1", "allow")).toBe(true);
    expect(orch.answerPermission("r1#1", "allow")).toBe(false);
    await flush();
    expect(answers).toEqual(["allow"]);
    expect(status("r1")).toBe("idle");
    expect(store.events.filter((e) => e.type === "permission")).toMatchObject([
      { decision: "allowed", by: "user" },
    ]);
    expect(store.statuses("r1")).toContain("waiting");
    await orch.shutdown();
  });

  it("cancelling a waiting turn withdraws its permission request", async () => {
    const { orch, status } = await setup({
      mode: "interactive",
      script: (_t, s) => {
        void s.requestPermission({ toolCallId: "x", title: "t", kind: "execute" });
        return "hang";
      },
    });
    orch.start();
    await flush();
    expect(status("r1")).toBe("waiting");
    orch.cancelTurn("r1");
    await flush();
    expect(orch.runs()[0]?.pending).toEqual([]);
    expect(status("r1")).toBe("idle");
    await orch.shutdown();
  });
});

describe("shutdown", () => {
  it("cancels active turns, finishes idle runs, and cancels queued ones", async () => {
    let call = 0;
    const { orch, agents, status } = await setup({
      mode: "interactive",
      count: 3,
      maxParallel: 2,
      script: () => (++call === 1 ? "hang" : "end_turn"),
    });
    orch.start();
    await flush();
    expect([status("r1"), status("r2"), status("r3")]).toEqual(["running", "idle", "queued"]);
    await orch.shutdown();
    expect([status("r1"), status("r2"), status("r3")]).toEqual([
      "cancelled",
      "finished",
      "cancelled",
    ]);
    expect(orch.runs()[0]?.reason).toBe("cancelled during shutdown");
    expect(agents.sessions[0]?.cancels).toBe(1);
    expect(agents.sessions).toHaveLength(2);
  });

  it("a forced shutdown skips the grace periods", async () => {
    const { orch, agents, status } = await setup({ script: () => "hang" });
    orch.start();
    await flush();
    const session = agents.sessions[0];
    if (session === undefined) throw new Error("no session");
    session.onCancel = "ignore";
    void orch.shutdown();
    await flush();
    expect(status("r1")).toBe("running");
    await orch.shutdown(true);
    expect(session.stops[0]).toBe(0);
    expect(status("r1")).toBe("cancelled");
  });

  it("cancels a run whose agent is still starting", async () => {
    const { orch, agents, status } = await setup();
    agents.startGate = new Promise(() => {});
    orch.start();
    await flush();
    await orch.shutdown();
    expect(status("r1")).toBe("cancelled");
  });
});

describe("leftover commands", () => {
  const base = (over: Partial<RunRecord>): RunRecord => ({
    id: "r1",
    agent: "claude",
    status: "finished",
    firstPrompt: "p",
    turns: 1,
    base: "c0ffee",
    branch: "code60/r1",
    worktree: "/w/r1",
    ownerPid: 7,
    agentPid: 900,
    agentCommandLine: "node agent --acp",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  async function deps(record: RunRecord) {
    const store = new MemoryStore();
    await store.save(record);
    return { store, git: new FakeGit(), clock: new FakeClock(), processes: new FakeProcesses() };
  }

  it("marks a run interrupted only when its owner is gone, and reports a live agent", async () => {
    const d = await deps(base({ status: "running" }));
    d.processes.alive.add(7);
    expect((await listRuns(d))[0]?.record.status).toBe("running");

    d.processes.alive.clear();
    d.processes.groups.add(900);
    d.processes.commandLines.set(900, "node agent --acp");
    const [listed] = await listRuns(d);
    expect(listed).toMatchObject({ agentAlive: true, agentCommandLine: "node agent --acp" });
    expect(listed?.record).toMatchObject({
      status: "interrupted",
      reason: "the owning process (PID 7) is gone",
    });
    expect(d.store.records.get("r1")?.status).toBe("interrupted");
    expect(d.store.statuses("r1")).toEqual(["interrupted"]);
  });

  it("never marks a final run interrupted", async () => {
    const d = await deps(base({ status: "failed" }));
    expect((await listRuns(d))[0]?.record.status).toBe("failed");
  });

  it("discard refuses active runs and live agents, asks, then removes only that run", async () => {
    const active = await deps(base({ status: "idle" }));
    active.processes.alive.add(7);
    await expect(discardRun(active, "/repo", "r1", async () => true)).rejects.toThrow(/is idle/);

    const live = await deps(base({ status: "interrupted" }));
    live.processes.groups.add(900);
    await expect(discardRun(live, "/repo", "r1", async () => true)).rejects.toThrow(
      /may still be running/,
    );

    const d = await deps(base({}));
    d.git.files = [{ path: "a.txt", status: "modified" }];
    const declined = await discardRun(d, "/repo", "r1", async () => false);
    expect(declined.discarded).toBe(false);
    expect(d.git.removed).toEqual([]);
    const shown: string[] = [];
    const done = await discardRun(d, "/repo", "r1", async (files) => {
      shown.push(...files.map((f) => f.path));
      return true;
    });
    expect(shown).toEqual(["a.txt"]);
    expect(done.discarded).toBe(true);
    expect(d.git.removed).toEqual([{ path: "/w/r1", branch: "code60/r1" }]);
    expect(d.store.records.get("r1")?.discardedAt).toBeDefined();
    await expect(diffRun(d, "r1")).rejects.toThrow(/discarded/);
  });

  it("stop refuses when the command line does not match", async () => {
    const d = await deps(base({ status: "interrupted" }));
    d.processes.groups.add(900);
    d.processes.commandLines.set(900, "vim notes.txt");
    await expect(stopRun(d, "r1")).rejects.toThrow(/cannot confirm that process 900/);
    expect(d.processes.signals).toEqual([]);
  });

  it("stop kills a matching agent, escalating to SIGKILL", async () => {
    const d = await deps(base({ status: "interrupted" }));
    d.processes.groups.add(900);
    d.processes.commandLines.set(900, "node agent --acp");
    d.processes.ignores.add("SIGTERM");
    const result = stopRun(d, "r1");
    await d.clock.advance(5_000);
    expect(await result).toMatchObject({ stopped: true, pid: 900 });
    expect(d.processes.signals).toEqual([
      { pgid: 900, signal: "SIGTERM" },
      { pgid: 900, signal: "SIGKILL" },
    ]);
  });

  it("stop refuses a run owned by a live process and reports nothing to stop", async () => {
    const owned = await deps(base({ status: "running" }));
    owned.processes.alive.add(7);
    await expect(stopRun(owned, "r1")).rejects.toThrow(/owned by a live process/);
    const gone = await deps(base({}));
    expect(await stopRun(gone, "r1")).toMatchObject({ stopped: false });
  });
});

import { describe, expect, it, vi } from "vitest";
import type {
  Automation,
  AutomationDraft,
  AutomationState,
  Execution,
} from "../contracts/index.js";
import type { Executor } from "./executor.js";
import { Scheduler } from "./scheduler.js";
import { emptyState, type StateWriter } from "./store.js";

const draft: AutomationDraft = {
  name: "Checks",
  prompt: "Check",
  agent: "droid",
  repository: "/repo",
  baseBranch: "main",
  allow: ["read"],
  turnTimeout: "1m",
  enabled: true,
  schedule: { type: "interval", everyMinutes: 1, anchor: "2026-01-01T00:00:00Z" },
};
const identity = {
  repository: { path: "/repo", dev: "1", ino: "2" },
  providerHash: "a".repeat(64),
};
function setup(initial = emptyState()) {
  let now = new Date("2026-01-01T00:00:00Z");
  const store: StateWriter = {
    state: structuredClone(initial),
    save: vi.fn(async (state: AutomationState) => {
      Object.assign(store, { state: structuredClone(state) });
    }),
  };
  let release!: () => void;
  let snapshot: Automation | undefined;
  let launch: Execution | undefined;
  const execute = vi.fn(
    async (automation: Automation, execution: Execution, signal: AbortSignal) => {
      snapshot = automation;
      launch = execution;
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (signal.aborted) resolve();
      });
      return {
        status: signal.aborted ? ("cancelled" as const) : ("finished" as const),
        reason: null,
        denials: 1,
        changedFiles: 2,
      };
    },
  );
  const executor: Executor = {
    validate: vi.fn(async () => identity),
    execute,
    inspect: vi.fn(async () => "gone" as const),
  };
  const scheduler = new Scheduler(store, executor, () => now);
  const advance = async (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      now = new Date(+now + 1000);
      await scheduler.tick();
    }
  };
  return {
    store,
    executor,
    scheduler,
    advance,
    setNow: (value: string) => {
      now = new Date(value);
    },
    release: () => release(),
    snapshot: () => snapshot,
    launch: () => launch,
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("durable automation scheduler", () => {
  it("fences a claim still being saved when shutdown begins", async () => {
    const s = setup();
    const automation = (await s.scheduler.request({ action: "create", draft })) as Automation;
    let saved!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      saved = resolve;
    });
    vi.mocked(s.store.save).mockImplementationOnce(async (state) => {
      entered();
      await gate;
      Object.assign(s.store, { state: structuredClone(state) });
    });
    const claim = s.scheduler.request({ action: "runNow", id: automation.id });
    await saving;
    const stopped = s.scheduler.stop();
    saved();
    await claim;
    await stopped;
    const revision = s.store.state.revision;
    await flush();
    expect(s.executor.execute).not.toHaveBeenCalled();
    expect(s.store.state.revision).toBe(revision);
    expect(s.store.state.executions[0]).toMatchObject({
      status: "cancelled",
      reason: "service_stopped",
    });
  });
  it("does not replay claimed occurrences after clock rollback, resume or restart", async () => {
    const s = setup();
    await s.scheduler.request({ action: "create", draft });
    await s.advance(60);
    await flush();
    s.release();
    await flush();
    s.setNow("2026-01-01T00:00:59Z");
    await s.scheduler.tick();
    await s.advance(1);
    expect(s.executor.execute).toHaveBeenCalledTimes(1);
    await s.scheduler.request({ action: "pauseAll", cancelActive: false });
    s.setNow("2026-01-01T00:00:59Z");
    await s.scheduler.request({ action: "resumeAll" });
    await s.advance(1);
    expect(s.executor.execute).toHaveBeenCalledTimes(1);
    await s.scheduler.stop();
    const restarted = setup(s.store.state);
    await restarted.scheduler.initialize();
    await restarted.advance(60);
    expect(restarted.executor.execute).not.toHaveBeenCalled();
    expect(restarted.store.state.automations[0]?.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    await restarted.scheduler.stop();
  });
  it("records a turn interrupted by service shutdown as stopped, not failed", async () => {
    const s = setup();
    vi.mocked(s.executor.execute).mockImplementationOnce(
      (_automation, _execution, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("agent exited on signal"))),
        ),
    );
    const automation = (await s.scheduler.request({ action: "create", draft })) as Automation;
    const claim = (await s.scheduler.request({ action: "runNow", id: automation.id })) as Execution;
    await flush();
    await s.scheduler.stop();
    expect(s.scheduler.execution(claim.id)).toMatchObject({
      status: "cancelled",
      reason: "service_stopped",
    });
  });
  it("persists claims and recurrence before launch, freezes edits, skips occupied occurrences", async () => {
    const s = setup();
    await s.scheduler.initialize();
    const automation = (await s.scheduler.request({ action: "create", draft })) as Automation;
    await s.advance(60);
    await flush();
    expect(s.executor.execute).toHaveBeenCalledTimes(1);
    expect(s.store.state.executions[0]?.runId).toBe(s.launch()?.runId);
    expect(s.store.state.automations[0]?.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
    await s.scheduler.request({
      action: "update",
      id: automation.id,
      revision: 1,
      draft: { ...draft, prompt: "Different" },
    });
    expect(s.snapshot()?.prompt).toBe("Check");
    await s.advance(60);
    expect(s.store.state.executions[1]?.reason).toBe("busy");
    await expect(
      s.scheduler.request({ action: "delete", id: automation.id, revision: 2 }),
    ).rejects.toThrow("Cancel");
    await s.scheduler.request({ action: "cancel", id: automation.id });
    await s.scheduler.stop();
    expect(s.store.state.executions[0]?.status).toBe("cancelled");
  });
  it("skips missed occurrences after sleep, and advances at restart without catch-up", async () => {
    const s = setup();
    await s.scheduler.request({ action: "create", draft });
    s.setNow("2026-01-01T00:01:10Z");
    await s.scheduler.tick();
    expect(s.executor.execute).not.toHaveBeenCalled();
    expect(s.store.state.executions[0]?.reason).toBe("missed");
    const restarted = setup(s.store.state);
    restarted.setNow("2026-01-02T00:00:01Z");
    await restarted.scheduler.initialize();
    expect(restarted.store.state.automations[0]?.nextRunAt).toBe("2026-01-02T00:01:00.000Z");
    await restarted.scheduler.stop();
  });
  it("checks revisions and pauses future dispatch without rewriting active work", async () => {
    const s = setup();
    const automation = (await s.scheduler.request({ action: "create", draft })) as Automation;
    await s.scheduler.request({ action: "runNow", id: automation.id });
    await flush();
    await s.scheduler.request({ action: "pauseAll", cancelActive: false });
    await s.advance(120);
    expect(s.executor.execute).toHaveBeenCalledTimes(1);
    await expect(
      s.scheduler.request({
        action: "setEnabled",
        id: automation.id,
        revision: 99,
        enabled: false,
      }),
    ).rejects.toThrow("changed");
    await s.scheduler.request({ action: "pauseAll", cancelActive: true });
    await s.scheduler.stop();
    expect(s.store.state.executions[0]?.status).toBe("cancelled");
    expect(await s.scheduler.request({ action: "history", limit: 1 })).toHaveLength(1);
  });
  it("never starts an agent after claim persistence fails", async () => {
    const s = setup();
    const automation = (await s.scheduler.request({ action: "create", draft })) as Automation;
    vi.mocked(s.store.save).mockRejectedValueOnce(new Error("disk full"));
    await expect(s.scheduler.request({ action: "runNow", id: automation.id })).rejects.toThrow(
      "persistence",
    );
    expect(s.executor.execute).not.toHaveBeenCalled();
    expect(s.scheduler.status().block?.reason).toBe("persistence_failed");
  });
  it("blocks restart on uncertain leftover ownership and never replays a claim", async () => {
    const s = setup();
    const automation = (await s.scheduler.request({ action: "create", draft })) as Automation;
    await s.scheduler.request({ action: "runNow", id: automation.id });
    await flush();
    const saved = structuredClone(s.store.state);
    await s.scheduler.stop();
    const restarted = setup(saved);
    vi.mocked(restarted.executor.inspect).mockResolvedValue("blocked");
    await restarted.scheduler.initialize();
    expect(restarted.scheduler.status().block?.reason).toBe("leftover_agent");
    await restarted.advance(60);
    expect(restarted.executor.execute).not.toHaveBeenCalled();
    await expect(restarted.scheduler.request({ action: "resolveBlock" })).rejects.toThrow(
      "leftover",
    );
    vi.mocked(restarted.executor.inspect).mockResolvedValue("gone");
    await restarted.scheduler.request({ action: "resolveBlock" });
    expect(restarted.store.state.executions[0]?.status).toBe("interrupted");
    await restarted.scheduler.stop();
  });
  it("records failed turns without retries and preserves evidence after deletion", async () => {
    const s = setup();
    vi.mocked(s.executor.execute).mockRejectedValue(new Error("agent error"));
    const automation = (await s.scheduler.request({ action: "create", draft })) as Automation;
    const claim = (await s.scheduler.request({ action: "runNow", id: automation.id })) as Execution;
    await flush();
    await s.scheduler.stop();
    expect(s.scheduler.execution(claim.id).status).toBe("failed");
    await s.scheduler.request({ action: "delete", id: automation.id, revision: 1 });
    expect(s.scheduler.execution(claim.id).repository).toEqual(identity.repository);
    expect(s.executor.execute).toHaveBeenCalledTimes(1);
  });
});

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROMPT_TEMPLATES,
  type PollSettingsPatch,
  type PromptTemplates,
  type RunConfiguration,
} from "../src/bridge/index.js";
import type { CoreDeps } from "../src/core/index.js";
import { DesktopController } from "../src/desktop/controller.js";
import type { DesktopPreferences } from "../src/desktop/preferences.js";
import type { ProjectDatabase } from "../src/desktop/projects.js";
import { FakeAgents, FakeGit, FakeProcesses } from "./fakes.js";

let directory: string;
let controller: DesktopController;
let agents: FakeAgents;
let git: FakeGit;
let confirm: ReturnType<typeof vi.fn<(title: string, detail: string) => Promise<boolean>>>;
const request = { agents: ["claude"], allow: [], allowAll: false };
let tick = 0;
let stored: string | undefined;
let preferencesFail = false;
let orchestrationProvider: string | null = null;
let listGate: (() => Promise<void>) | undefined;
const databases = new Map<
  string,
  {
    entries: Map<string, string>;
    configurations: RunConfiguration[];
    prompts: Partial<PromptTemplates>;
    failWrites: boolean;
  }
>();
const openDatabase = vi.fn((path: string, create: boolean): ProjectDatabase => {
  let data = databases.get(path);
  if (data === undefined) {
    if (!create) throw new Error(`Database not found: ${path}`);
    data = { entries: new Map(), configurations: [], prompts: {}, failWrites: false };
    databases.set(path, data);
  }
  const shared = data;
  let open = true;
  return {
    path,
    list: () => {
      if (!open) throw new Error("closed");
      return [...shared.entries]
        .map(([project, openedAt]) => ({ path: project, openedAt }))
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    },
    record: (project, openedAt) => {
      if (!open) throw new Error("closed");
      if (shared.failWrites) throw new Error("disk is full");
      shared.entries.set(project, openedAt);
    },
    remove: (project) => {
      shared.entries.delete(project);
    },
    clear: () => {
      shared.entries.clear();
    },
    configurations: () => structuredClone(shared.configurations),
    saveConfiguration: (entry) => {
      if (shared.failWrites) throw new Error("disk is full");
      if (
        shared.configurations.some(
          (item) => item.id !== entry.id && item.name.toLowerCase() === entry.name.toLowerCase(),
        )
      )
        throw new Error("A run configuration with that name already exists");
      shared.configurations = [
        ...shared.configurations.filter((item) => item.id !== entry.id),
        structuredClone(entry),
      ];
    },
    deleteConfiguration: (id) => {
      shared.configurations = shared.configurations.filter((item) => item.id !== id);
    },
    useConfiguration: (id, at) => {
      if (shared.failWrites) throw new Error("disk is full");
      const entry = shared.configurations.find((item) => item.id === id);
      if (entry) {
        entry.uses++;
        entry.lastUsed = at;
      }
    },
    promptTemplates: () => ({ templates: { ...shared.prompts }, skipped: [] }),
    savePromptTemplate: (id, template) => {
      if (shared.failWrites) throw new Error("disk is full");
      shared.prompts[id] = template;
    },
    deletePromptTemplate: (id) => {
      delete shared.prompts[id];
    },
    close: () => {
      open = false;
    },
  };
});
const preferences: DesktopPreferences = {
  orchestrationProvider: async () => orchestrationProvider,
  setOrchestrationProvider: async (provider) => {
    if (preferencesFail) throw new Error("read-only");
    orchestrationProvider = provider;
  },
  read: async () => stored,
  write: async (path) => {
    if (preferencesFail) throw new Error("read-only");
    stored = path;
  },
};
const realOf = (path: string) => fs.realpath(path).catch(() => path);
const controllerDeps = (): CoreDeps => {
  const processes = new FakeProcesses();
  processes.alive.add(process.pid);
  return {
    agents,
    git,
    fs: {
      ...(fs as unknown as CoreDeps["fs"]),
      readdir: async (path) => {
        const ids = await fs.readdir(path);
        await listGate?.();
        return ids;
      },
    },
    ownerPid: process.pid,
    clock: {
      now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
    },
    processes,
  };
};

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "code60-desktop-"));
  agents = new FakeAgents();
  git = new FakeGit();
  git.repoInfo = async () => ({ topLevel: directory, commonDir: join(directory, ".git") });
  confirm = vi.fn(async () => true);
  databases.clear();
  stored = undefined;
  preferencesFail = false;
  orchestrationProvider = null;
  listGate = undefined;
  controller = new DesktopController(
    controllerDeps(),
    {
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
    },
    { confirm },
    { openDatabase, preferences },
  );
  await controller.connect(join(directory, "first.sqlite"), true);
});
afterEach(async () => {
  await controller.shutdown(true);
  await fs.rm(directory, { recursive: true, force: true });
});

async function start(prompt?: string) {
  await controller.open(directory);
  await controller.start({ ...request, ...(prompt === undefined ? {} : { prompt }) });
  await vi.waitFor(() => expect(controller.snapshot().runs[0]?.view?.status).toBe("idle"));
  return controller.snapshot().runs[0]?.record.id as string;
}

describe("desktop orchestration", () => {
  it("saves an orchestration provider with fixed allow-all and probes ACP without creating a run", async () => {
    await expect(controller.testOrchestrationProvider()).rejects.toThrow("Select an available");
    await expect(controller.setOrchestrationProvider("missing")).rejects.toThrow(
      "Unavailable provider",
    );
    await controller.setOrchestrationProvider("claude");
    expect(orchestrationProvider).toBe("claude");
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    const probe = agents.specs.length;
    await controller.testOrchestrationProvider();
    expect(controller.snapshot().orchestration).toEqual({
      provider: "claude",
      allowAll: true,
      connection: "connected",
      error: null,
    });
    expect(agents.sessions[probe]?.prompts).toEqual([]);
    expect(agents.sessions[probe]?.stops).toEqual([1000]);
    expect(controller.snapshot().runs).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    await controller.setOrchestrationProvider(null);
    expect(controller.snapshot().orchestration.provider).toBeNull();
  });

  it("retains settings on save failure and exposes failed connection tests", async () => {
    await controller.setOrchestrationProvider("claude");
    preferencesFail = true;
    await expect(controller.setOrchestrationProvider("codex")).rejects.toThrow("read-only");
    expect(controller.snapshot().orchestration.provider).toBe("claude");
    agents.startError = new Error("ACP authentication required");
    await controller.testOrchestrationProvider();
    expect(controller.snapshot().orchestration).toMatchObject({
      connection: "failed",
      error: "ACP authentication required",
    });
  });

  it("deduplicates tests, keeps the action queue responsive, and cancels on database changes", async () => {
    await controller.setOrchestrationProvider("claude");
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    agents.startGate = new Promise(() => {});
    const first = controller.testOrchestrationProvider();
    await vi.waitFor(() => expect(controller.snapshot().orchestration.connection).toBe("testing"));
    const second = controller.testOrchestrationProvider();
    await controller.poll(["config"]);
    expect(agents.specs).toHaveLength(2);
    await controller.connect(join(directory, "second.sqlite"), true);
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(agents.specs).toHaveLength(3));
    expect(controller.snapshot().orchestration).toMatchObject({
      provider: "claude",
      connection: "idle",
      error: null,
    });
  });

  it("restores an unavailable saved provider without silently replacing it", async () => {
    orchestrationProvider = "removed";
    await controller.restore();
    expect(controller.snapshot().orchestration).toMatchObject({
      provider: "removed",
      allowAll: true,
    });
    await expect(controller.testOrchestrationProvider()).rejects.toThrow("Select an available");
  });

  it("stops connection probes on shutdown", async () => {
    await controller.setOrchestrationProvider("claude");
    agents.startGate = new Promise(() => {});
    const test = controller.testOrchestrationProvider();
    await vi.waitFor(() => expect(controller.snapshot().orchestration.connection).toBe("testing"));
    await controller.shutdown();
    await test;
    expect(controller.snapshot().orchestration.connection).toBe("idle");
  });
  it("scopes file reads to the project and listed worktrees, refreshes, and clears on project switches", async () => {
    await controller.open(directory);
    const project = controller.snapshot().directory as string;
    await fs.writeFile(join(project, "preview.txt"), "before");
    const context = { project, root: project, directories: [""], preview: "preview.txt" };
    await controller.setFileContext(context);
    expect(controller.snapshot().files?.preview?.text).toBe("before");
    await fs.writeFile(join(project, "preview.txt"), "after");
    await controller.poll(["files"]);
    expect(controller.snapshot().files?.preview?.text).toBe("after");
    await expect(controller.setFileContext({ ...context, root: "/" })).rejects.toThrow(/root/);
    await expect(controller.setFileContext({ ...context, project: "/other" })).rejects.toThrow(
      /changed/,
    );
    const worktree = join(project, "worker");
    await fs.mkdir(worktree);
    await fs.writeFile(join(worktree, "preview.txt"), "worker");
    vi.spyOn(git, "listWorktrees").mockResolvedValue([
      { path: worktree, branch: "worker", createdAt: null, sizeBytes: null },
    ]);
    await controller.poll(["worktrees"]);
    await controller.setFileContext({ ...context, root: worktree });
    expect(controller.snapshot().files?.preview?.text).toBe("worker");
    await controller.open(worktree);
    expect(controller.snapshot().files).toBeNull();
    await expect(controller.setFileContext(context)).rejects.toThrow(/changed/);
  });

  it("lists the open repository's worktrees and propagates inventory errors", async () => {
    await expect(controller.poll(["worktrees"])).rejects.toThrow(/not available/);
    await controller.open(directory);
    const worktrees = [
      { path: directory, branch: "main", createdAt: null, sizeBytes: 42 },
      { path: "/external/worktree", branch: null, createdAt: null, sizeBytes: null },
    ];
    const list = vi.spyOn(git, "listWorktrees").mockResolvedValue(worktrees);
    await controller.poll(["worktrees"]);
    expect(controller.snapshot().worktrees).toEqual({
      repository: basename(directory),
      worktrees,
    });
    expect(list).toHaveBeenCalledWith(directory);
    list.mockRejectedValueOnce(new Error("Cannot list worktrees"));
    await expect(controller.poll(["worktrees"])).rejects.toThrow("Cannot list worktrees");
    // A failed poll keeps the last successful listing and records the error.
    expect(controller.snapshot().worktrees?.worktrees).toEqual(worktrees);
    const state = controller.snapshot().polling.sources.find((s) => s.key === "worktrees");
    expect(state).toMatchObject({ failures: 1, lastError: "Cannot list worktrees" });
    expect(state?.history.map((result) => result.ok)).toEqual([true, false]);
    await controller.open(directory);
    expect(controller.snapshot().worktrees).toBeNull();
  });

  it("persists only polling overrides and restores them on launch", async () => {
    let saved: PollSettingsPatch = {};
    preferences.setPolling = async (settings) => {
      saved = settings;
    };
    preferences.polling = async () => saved;
    try {
      const history = { intervalMs: 10000, idleIntervalMs: 60000 };
      await controller.setPollSettings({ history });
      expect(saved).toEqual({ history });
      const source = () => controller.snapshot().polling.sources.find((s) => s.key === "history");
      expect(source()?.setting).toEqual(history);
      await controller.setPollSettings({ history: null });
      expect(saved).toEqual({});
      expect(source()?.setting).toEqual({ intervalMs: 5000, idleIntervalMs: 30000 });
      saved = { history };
      await controller.restore();
      expect(source()?.setting).toEqual(history);
      controller.setPollingPaused(true);
      expect(controller.snapshot().polling.paused).toBe(true);
    } finally {
      delete preferences.setPolling;
      delete preferences.polling;
    }
  });

  it("returns an empty inventory for a non-Git project without scanning", async () => {
    git.repoInfo = async () => {
      throw new Error("no repo");
    };
    await controller.open(directory);
    const list = vi.spyOn(git, "listWorktrees");
    await controller.poll(["worktrees"]);
    expect(controller.snapshot().worktrees).toEqual({ repository: null, worktrees: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it("manages configurations across projects but not databases, without storing prompts", async () => {
    await controller.saveConfiguration({
      name: " Team ",
      settings: { ...request, agents: ["claude", "codex"] },
    });
    const entry = controller.snapshot().configurations[0] as RunConfiguration;
    expect(entry).toMatchObject({
      name: "Team",
      uses: 0,
      lastUsed: null,
      settings: { parallel: "4", turnTimeout: "30m" },
    });
    await controller.open(directory);
    const ids = await controller.start({
      ...entry.settings,
      configurationId: entry.id,
      prompt: "private task",
      parallel: "1",
    });
    expect(ids).toHaveLength(2);
    expect(controller.snapshot().configurations[0]).toMatchObject({
      uses: 1,
      lastUsed: expect.any(String),
    });
    await controller.saveConfiguration({ name: "New settings", launchId: ids[0] as string });
    expect(controller.snapshot().configurations[1]).toMatchObject({
      uses: 1,
      settings: { parallel: "1" },
    });
    expect(JSON.stringify(controller.snapshot().configurations)).not.toContain("private task");
    expect(agents.sessions.length).toBeLessThanOrEqual(1);
    await expect(
      controller.saveConfiguration({ name: "Again", launchId: ids[0] as string }),
    ).rejects.toThrow(/already saved/);
    await expect(controller.saveConfiguration({ name: "TEAM", settings: request })).rejects.toThrow(
      /already exists/,
    );
    await controller.saveConfiguration({ id: entry.id, name: "Renamed", settings: request });
    expect(controller.snapshot().configurations[1]?.uses).toBe(1);
    await controller.stopAll();
    const other = join(directory, "other-config-project");
    await fs.mkdir(other);
    await controller.open(other);
    expect(controller.snapshot().configurations).toHaveLength(2);
    confirm.mockResolvedValueOnce(false);
    expect(await controller.deleteConfiguration(entry.id)).toBe(false);
    expect(await controller.deleteConfiguration(entry.id)).toBe(true);
    expect(controller.snapshot().configurations).toHaveLength(1);
    await controller.connect(join(directory, "second.sqlite"), true);
    expect(controller.snapshot().configurations).toEqual([]);
    await expect(controller.start({ ...request, configurationId: entry.id })).rejects.toThrow();
  });

  it("does not count declined or invalid launches and keeps saved defaults usable without Git", async () => {
    git.repoInfo = async () => {
      throw new Error("no repo");
    };
    await controller.open(directory);
    const [first] = await controller.start(request);
    await controller.saveConfiguration({ name: "No Git", launchId: first as string });
    const entry = controller.snapshot().configurations[0] as RunConfiguration;
    expect(entry.settings.base).toBeUndefined();
    confirm.mockResolvedValueOnce(false);
    expect(await controller.start({ ...entry.settings, configurationId: entry.id })).toEqual([]);
    await expect(
      controller.start({ ...request, agents: ["missing"], configurationId: entry.id }),
    ).rejects.toThrow(/unknown agent/);
    expect(controller.snapshot().configurations[0]?.uses).toBe(1);
    await controller.start({ ...entry.settings, configurationId: entry.id });
    expect(controller.snapshot().configurations[0]?.uses).toBe(2);
  });

  it("keeps accepted launches running when usage or saving fails and permits save retry", async () => {
    await controller.saveConfiguration({ name: "Team", settings: request });
    const entry = controller.snapshot().configurations[0] as RunConfiguration;
    await controller.open(directory);
    const data = databases.get(join(directory, "first.sqlite"));
    if (data) data.failWrites = true;
    const [id] = await controller.start({ ...request, configurationId: entry.id });
    expect(id).toBeTruthy();
    expect(controller.snapshot().warnings.join(" ")).toContain("Agents started");
    await expect(
      controller.saveConfiguration({ name: "Saved", launchId: id as string }),
    ).rejects.toThrow(/disk is full/);
    if (data) data.failWrites = false;
    await controller.saveConfiguration({ name: "Saved", launchId: id as string });
    expect(controller.snapshot().configurations).toHaveLength(2);
    await vi.waitFor(() => expect(agents.sessions).toHaveLength(1));
    await expect(
      controller.saveConfiguration({ name: "Bad", settings: { ...request, agents: ["missing"] } }),
    ).rejects.toThrow(/Unavailable provider/);
    await expect(controller.start({ ...request, configurationId: "unknown" })).rejects.toThrow(
      /Unknown run configuration/,
    );
    expect(controller.snapshot().runs).toHaveLength(1);
  });
  it("starts without a prompt, streams follow-ups, finishes, and loads recorded history", async () => {
    const id = await start();
    agents.script = (_text, session) => {
      session.update({ type: "message", text: "hello" });
      return "end_turn";
    };
    // Sessions retain their script; send events explicitly to simulate streaming.
    agents.sessions[0]?.update({ type: "message", text: "hello" });
    await controller.action({ type: "reply", id, text: "first task" });
    await vi.waitFor(() => expect(agents.sessions[0]?.prompts).toEqual(["first task"]));
    await vi.waitFor(() => expect(controller.snapshot().runs[0]?.view?.status).toBe("idle"));
    expect(controller.snapshot().events.some((entry) => entry.event.type === "message")).toBe(true);
    await controller.action({ type: "finish", id });
    await vi.waitFor(() => expect(controller.active).toBe(false));
    const events = await controller.action({ type: "events", id });
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "prompt", text: "first task" })]),
    );
    expect(await controller.action({ type: "diff", id })).toMatch(/diff --git/);
    await controller.open(directory);
    expect(controller.snapshot().runs[0]?.record.status).toBe("finished");
  });

  it("starts independent overlapping batches and refuses switches until both end", async () => {
    const first = await start("earlier task");
    agents.sessions[0]?.update({ type: "message", text: "earlier transcript" });
    const events = controller.snapshot().events;
    const [second] = await controller.start(request);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(agents.sessions).toHaveLength(2));
    await vi.waitFor(() =>
      expect(controller.snapshot().runs.find((run) => run.record.id === second)?.view?.status).toBe(
        "idle",
      ),
    );
    expect(agents.sessions[1]?.prompts).toEqual([]);
    expect(git.worktrees[1]?.base).toBe(git.worktrees[0]?.base);
    expect(git.worktrees[1]?.path).not.toBe(git.worktrees[0]?.path);
    expect(controller.snapshot().events).toEqual(expect.arrayContaining(events));
    await controller.action({ type: "reply", id: second as string, text: "new task" });
    await vi.waitFor(() => expect(agents.sessions[1]?.prompts).toEqual(["new task"]));
    expect(agents.sessions[0]?.prompts).toEqual(["earlier task"]);
    await controller.action({ type: "finish", id: first });
    await vi.waitFor(() => expect(agents.sessions[0]?.stops.length).toBeGreaterThan(0));
    await vi.waitFor(async () => {
      await controller.poll(["history", "config", "configurations"]);
      expect(controller.snapshot().runs.find((run) => run.record.id === first)?.record.status).toBe(
        "finished",
      );
    });
    expect(controller.active).toBe(true);
    await expect(controller.open(join(directory, "other"))).rejects.toThrow(/switching folders/);
    await expect(controller.connect(join(directory, "second.sqlite"), true)).rejects.toThrow(
      /switching databases/,
    );
    await vi.waitFor(() =>
      expect(controller.snapshot().runs.find((run) => run.record.id === second)?.view?.status).toBe(
        "idle",
      ),
    );
    await controller.action({ type: "finish", id: second as string });
    await vi.waitFor(() => expect(controller.active).toBe(false));
    await controller.poll(["history", "config", "configurations"]);
    expect(controller.snapshot().runs.every((run) => run.record.status === "finished")).toBe(true);
    expect(controller.snapshot().events).toEqual(expect.arrayContaining(events));
  });

  it("keeps parallel limits per batch, including queued sessions", async () => {
    await controller.open(directory);
    const first = await controller.start({
      ...request,
      agents: ["claude", "claude"],
      parallel: "1",
    });
    const second = await controller.start({
      ...request,
      agents: ["claude", "claude"],
      parallel: "1",
    });
    await vi.waitFor(() => expect(agents.sessions).toHaveLength(2));
    const status = (id: string) =>
      controller.snapshot().runs.find((run) => run.record.id === id)?.view?.status;
    await vi.waitFor(() => expect(first.map(status)).toEqual(["idle", "queued"]));
    await vi.waitFor(() => expect(second.map(status)).toEqual(["idle", "queued"]));
    await controller.action({ type: "finish", id: first[0] as string });
    await vi.waitFor(() => expect(status(first[1] as string)).toBe("idle"));
    expect(status(second[1] as string)).toBe("queued");
    await controller.stopAll();
    expect(controller.active).toBe(false);
    expect(agents.sessions.every((session) => session.stops.length > 0)).toBe(true);
    expect(agents.sessions).toHaveLength(3);
  });

  it("serializes delayed completion reads with new starts and refreshes", async () => {
    const first = await start();
    const [second] = await controller.start(request);
    await vi.waitFor(() => expect(agents.sessions).toHaveLength(2));
    let release!: () => void;
    let reading = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    listGate = async () => {
      listGate = undefined;
      reading = true;
      await gate;
    };
    await controller.action({ type: "finish", id: first });
    await vi.waitFor(() => expect(reading).toBe(true));
    const thirdStart = controller.start(request);
    const refresh = controller.poll(["history", "config", "configurations"]);
    expect(controller.active).toBe(true);
    expect(agents.sessions).toHaveLength(2);
    release();
    const [third] = await thirdStart;
    await refresh;
    expect(controller.snapshot().runs.map((run) => run.record.id)).toEqual(
      expect.arrayContaining([first, second, third]),
    );
    expect(controller.snapshot().liveIds).toEqual([second, third]);
    expect(controller.active).toBe(true);
    await controller.stopAll();
    await controller.open(directory);
    expect(controller.snapshot().liveIds).toEqual([]);
    expect(controller.snapshot().runs).toHaveLength(3);
    expect(controller.active).toBe(false);
  });

  it("keeps earlier sessions usable when a later batch fails independently", async () => {
    const first = await start();
    agents.startError = new Error("cannot start second agent");
    const [second] = await controller.start(request);
    await vi.waitFor(() =>
      expect(
        controller.snapshot().runs.find((run) => run.record.id === second)?.record.status,
      ).toBe("failed"),
    );
    await controller.poll(["history", "config", "configurations"]);
    expect(controller.active).toBe(true);
    expect(controller.snapshot().liveIds).toEqual([first]);
    await controller.action({ type: "reply", id: first, text: "unaffected" });
    await vi.waitFor(() => expect(agents.sessions[0]?.prompts).toEqual(["unaffected"]));
  });

  it("routes approvals and cancellation across running and waiting batches", async () => {
    agents.script = () => "hang";
    const first = await start();
    await controller.action({ type: "reply", id: first, text: "first" });
    const permission = { toolCallId: "x", title: "command", kind: "execute" } as const;
    const firstAnswer = agents.sessions[0]?.requestPermission(permission);
    await vi.waitFor(() => expect(controller.snapshot().runs[0]?.view?.status).toBe("waiting"));
    const [second] = await controller.start({ ...request, prompt: "second" });
    await vi.waitFor(() => expect(agents.sessions[1]?.turnActive).toBe(true));
    const secondAnswer = agents.sessions[1]?.requestPermission(permission);
    await vi.waitFor(() =>
      expect(
        controller.snapshot().runs.filter((run) => run.view?.pending.length === 1),
      ).toHaveLength(2),
    );
    for (const [id, answer] of [
      [second, "deny"],
      [first, "allow"],
    ] as const) {
      const pending = controller.snapshot().runs.find((run) => run.record.id === id)?.view
        ?.pending[0];
      await controller.action({ type: "permission", id: pending?.id as string, answer });
      await expect(
        controller.action({ type: "permission", id: pending?.id as string, answer }),
      ).rejects.toThrow(/no longer pending/);
    }
    expect(await firstAnswer).toBe("allow");
    expect(await secondAnswer).toBe("deny");
    await controller.action({ type: "cancel", id: first });
    await vi.waitFor(() => expect(agents.sessions[0]?.cancels).toBe(1));
    expect(agents.sessions[1]?.cancels).toBe(0);
    expect(agents.sessions[1]?.turnActive).toBe(true);
    await controller.stopAll();
    expect(controller.active).toBe(false);
    expect(agents.sessions.every((session) => session.stops.length > 0)).toBe(true);
  });

  it("rejects invalid starts without changing live sessions or transcripts", async () => {
    const id = await start();
    agents.sessions[0]?.update({ type: "message", text: "keep me" });
    const events = controller.snapshot().events;
    await expect(controller.start({ ...request, agents: ["unknown"] })).rejects.toThrow(
      /unknown agent/,
    );
    expect(controller.snapshot().liveIds).toEqual([id]);
    expect(controller.snapshot().events).toEqual(events);
    await controller.action({ type: "reply", id, text: "still usable" });
    await vi.waitFor(() => expect(agents.sessions[0]?.prompts).toEqual(["still usable"]));
    expect(agents.sessions).toHaveLength(1);
  });

  it.each([false, true])("shuts down every batch (force=%s)", async (force) => {
    await start();
    await controller.start(request);
    await vi.waitFor(() => expect(agents.sessions).toHaveLength(2));
    await controller.shutdown(force);
    expect(controller.active).toBe(false);
    expect(agents.sessions.every((session) => session.stops.length > 0)).toBe(true);
    if (force) expect(agents.sessions.every((session) => session.stops.includes(0))).toBe(true);
  });

  it("escalates a pending graceful shutdown for every batch", async () => {
    await start();
    await controller.start(request);
    await vi.waitFor(() => expect(agents.sessions).toHaveLength(2));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const session of agents.sessions) {
      const stop = session.stop.bind(session);
      vi.spyOn(session, "stop").mockImplementation(async (grace) => {
        if (grace !== 0) await gate;
        else release();
        await stop(grace);
      });
    }
    const graceful = controller.shutdown();
    await vi.waitFor(() =>
      expect(
        agents.sessions.every((session) => vi.mocked(session.stop).mock.calls.length > 0),
      ).toBe(true),
    );
    await controller.shutdown(true);
    await graceful;
    expect(agents.sessions.every((session) => session.stops.includes(0))).toBe(true);
  });

  it("warns about existing shared-directory sessions and leaves them untouched on decline", async () => {
    git.repoInfo = async () => {
      throw new Error("no repo");
    };
    const first = await start();
    agents.sessions[0]?.update({ type: "message", text: "original" });
    const events = controller.snapshot().events;
    confirm.mockResolvedValueOnce(false);
    expect(await controller.start(request)).toEqual([]);
    expect(confirm).toHaveBeenLastCalledWith(
      "Run without worktrees?",
      expect.stringContaining("existing live sessions"),
    );
    expect(controller.snapshot().events).toEqual(events);
    expect(controller.snapshot().liveIds).toEqual([first]);
    expect(controller.active).toBe(true);
    expect(agents.sessions[0]?.stops).toEqual([]);
    expect(agents.sessions).toHaveLength(1);
    const [second] = await controller.start(request);
    expect(second).toBeTruthy();
    await vi.waitFor(() => expect(agents.sessions).toHaveLength(2));
    await controller.action({ type: "reply", id: first, text: "still here" });
    await vi.waitFor(() => expect(agents.sessions[0]?.prompts).toEqual(["still here"]));
  });

  it("answers only pending permissions and rejects stale approval clicks", async () => {
    agents.script = () => "hang";
    const id = await start();
    await controller.action({ type: "reply", id, text: "go" });
    const answer = agents.sessions[0]?.requestPermission({
      toolCallId: "x",
      title: "command",
      kind: "execute",
    });
    await vi.waitFor(() => expect(controller.snapshot().runs[0]?.view?.pending).toHaveLength(1));
    const permissionId = controller.snapshot().runs[0]?.view?.pending[0]?.id as string;
    await controller.action({ type: "permission", id: permissionId, answer: "allow" });
    expect(await answer).toBe("allow");
    await expect(
      controller.action({ type: "permission", id: permissionId, answer: "allow" }),
    ).rejects.toThrow(/no longer pending/);
    expect(id).toBeTruthy();
  });

  it("requires confirmation before unisolated runs and never starts on denial", async () => {
    git.repoInfo = async () => {
      throw new Error("no repo");
    };
    confirm.mockResolvedValue(false);
    await controller.open(directory);
    await controller.start({ ...request, parallel: "2" });
    expect(confirm).toHaveBeenCalledWith(
      "Run without worktrees?",
      expect.stringContaining("overwrite"),
    );
    expect(agents.sessions).toHaveLength(0);
    expect(controller.active).toBe(false);
  });

  it("confirms changed files before discard and keeps the worktree on denial", async () => {
    const id = await start("go");
    await controller.action({ type: "finish", id });
    await vi.waitFor(() => expect(controller.active).toBe(false));
    git.files = [{ path: "hello.txt", status: "untracked" }];
    confirm.mockResolvedValue(false);
    await controller.action({ type: "discard", id });
    expect(confirm).toHaveBeenCalledWith(
      "Discard this worktree?",
      expect.stringContaining("hello.txt"),
    );
    expect(git.removed).toEqual([]);
    confirm.mockResolvedValue(true);
    await controller.action({ type: "discard", id });
    expect(git.removed).toHaveLength(1);
    expect(controller.snapshot().runs[0]?.record.discardedAt).toBeDefined();
  });

  it("rejects actions on a run from another workspace", async () => {
    const id = await start();
    await controller.stopAll();
    git.repoInfo = async () => ({
      topLevel: join(directory, "other"),
      commonDir: join(directory, "other", ".git"),
    });
    await fs.mkdir(join(directory, "other"));
    await controller.open(join(directory, "other"));
    await expect(controller.action({ type: "diff", id })).rejects.toThrow(/Unknown run/);
  });

  it("sends batched updates and stops idle agents on shutdown", async () => {
    const updates: number[] = [];
    controller.subscribe((snapshot) => updates.push(snapshot.revision));
    await start();
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
    await controller.shutdown();
    expect(agents.sessions[0]?.stops.length).toBeGreaterThan(0);
    expect(controller.active).toBe(false);
    await expect(controller.start(request)).rejects.toThrow(/stopping/);
  });
});

describe("prompt templates", () => {
  const state = (id: string) => controller.snapshot().prompts.find((entry) => entry.id === id);

  it("keeps skipped-template warnings when switching databases", async () => {
    const open = openDatabase.getMockImplementation();
    if (!open) throw new Error("Missing database fixture");
    openDatabase.mockImplementationOnce((path, create) => ({
      ...open(path, create),
      promptTemplates: () => ({
        templates: {},
        skipped: ["Ignored a saved prompt template with an unknown ID"],
      }),
    }));
    await controller.connect(join(directory, "invalid.sqlite"), true);
    expect(controller.snapshot().warnings).toContain(
      "Ignored a saved prompt template with an unknown ID",
    );
  });

  it("layers database edits over config.json over built-in templates", async () => {
    expect(state("handoffTurn")).toMatchObject({ source: "built-in", fallbackSource: "built-in" });
    await fs.mkdir(join(directory, "config", "code60"), { recursive: true });
    await fs.writeFile(
      join(directory, "config", "code60", "config.json"),
      JSON.stringify({ prompts: { handoffTurn: "Config {{message}}" } }),
    );
    await controller.poll(["config"]);
    expect(state("handoffTurn")).toMatchObject({
      template: "Config {{message}}",
      source: "config",
      fallbackSource: "config",
    });

    await controller.savePromptTemplate({ id: "handoffTurn", template: "Edit {{message}}" });
    expect(state("handoffTurn")).toMatchObject({
      template: "Edit {{message}}",
      source: "database",
      fallback: "Config {{message}}",
    });
    expect(state("handoffSummary")?.source).toBe("built-in");

    confirm.mockResolvedValueOnce(false);
    await expect(controller.resetPromptTemplate("handoffTurn")).resolves.toBe(false);
    expect(state("handoffTurn")?.source).toBe("database");
    await expect(controller.resetPromptTemplate("handoffTurn")).resolves.toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(
      "Reset prompt template?",
      expect.stringContaining("the template from config.json"),
    );
    expect(state("handoffTurn")).toMatchObject({
      template: "Config {{message}}",
      source: "config",
    });
  });

  it("validates edits and keeps them with their database", async () => {
    await expect(
      controller.savePromptTemplate({ id: "handoffTurn", template: "{{summary}}" }),
    ).rejects.toThrow(/must include/);
    await expect(
      controller.savePromptTemplate({ id: "nope", template: "x" } as never),
    ).rejects.toThrow(/Unknown prompt template/);
    await controller.savePromptTemplate({ id: "handoffSummary", template: "S {{status}}" });
    await controller.connect(join(directory, "second.sqlite"), true);
    expect(state("handoffSummary")?.source).toBe("built-in");
    await controller.connect(join(directory, "first.sqlite"), false);
    expect(state("handoffSummary")).toMatchObject({ template: "S {{status}}", source: "database" });
  });
});

describe("project database", () => {
  it("requires a database before opening a project", async () => {
    const fresh = new DesktopController(
      controllerDeps(),
      { XDG_STATE_HOME: join(directory, "state") },
      { confirm },
      { openDatabase, preferences },
    );
    await expect(fresh.open(directory)).rejects.toThrow(/Connect to a database/);
    await fresh.shutdown(true);
  });

  it("records canonical paths once, newest first, and reopens recorded projects", async () => {
    const other = join(directory, "other");
    await fs.mkdir(other);
    await controller.open(directory);
    await controller.open(other);
    await controller.open(`${directory}/./`);
    const real = await fs.realpath(directory);
    expect(controller.snapshot().projects.map((project) => project.path)).toEqual([
      real,
      await fs.realpath(other),
    ]);
    await controller.openProject(await fs.realpath(other));
    expect(controller.snapshot().directory).toBe(await fs.realpath(other));
    await expect(controller.openProject("/not/recorded")).rejects.toThrow(/not in the database/);
  });

  it("removes one project or, after confirmation, the whole history", async () => {
    const other = join(directory, "other");
    await fs.mkdir(other);
    await controller.open(directory);
    await controller.open(other);
    const real = await fs.realpath(directory);
    await controller.removeProject(await fs.realpath(other));
    expect(controller.snapshot().projects.map((project) => project.path)).toEqual([real]);
    expect(controller.snapshot().directory).toBe(await fs.realpath(other));
    await expect(controller.removeProject("/not/recorded")).rejects.toThrow(/not in the database/);
    confirm.mockResolvedValueOnce(false);
    expect(await controller.clearProjects()).toBe(false);
    expect(controller.snapshot().projects).toHaveLength(1);
    expect(await controller.clearProjects()).toBe(true);
    expect(confirm).toHaveBeenLastCalledWith(
      "Clear project history?",
      expect.stringContaining("not affected"),
    );
    expect(controller.snapshot().projects).toEqual([]);
    await expect(fs.stat(real)).resolves.toBeDefined();
  });

  it("keeps history for a missing folder and reports it", async () => {
    const gone = join(directory, "gone");
    await fs.mkdir(gone);
    await controller.open(gone);
    const real = await fs.realpath(gone);
    await fs.rm(gone, { recursive: true });
    await expect(controller.openProject(real)).rejects.toThrow(/not available/);
    expect(controller.snapshot().projects).toHaveLength(1);
  });

  it("keeps each database's history separate and clears the workspace on switch", async () => {
    await controller.open(directory);
    await controller.connect(join(directory, "second.sqlite"), true);
    expect(controller.snapshot()).toMatchObject({
      database: join(directory, "second.sqlite"),
      directory: null,
      projects: [],
      runs: [],
    });
    expect(stored).toBe(join(directory, "second.sqlite"));
    await controller.connect(join(directory, "first.sqlite"), false);
    expect(controller.snapshot().projects).toHaveLength(1);
  });

  it("keeps the current connection when another database cannot be used", async () => {
    await controller.open(directory);
    await expect(controller.connect(join(directory, "missing.sqlite"), false)).rejects.toThrow(
      /not found/,
    );
    preferencesFail = true;
    await expect(controller.connect(join(directory, "new.sqlite"), true)).rejects.toThrow(
      /remember/,
    );
    expect(controller.snapshot()).toMatchObject({
      database: join(directory, "first.sqlite"),
      directory: await realOf(directory),
    });
    expect(stored).toBe(join(directory, "first.sqlite"));
  });

  it("refuses to switch databases while runs are active", async () => {
    await start();
    await expect(controller.connect(join(directory, "second.sqlite"), true)).rejects.toThrow(
      /switching databases/,
    );
  });

  it("opens the project even when its history cannot be saved", async () => {
    const data = databases.get(join(directory, "first.sqlite"));
    if (data) data.failWrites = true;
    await controller.open(directory);
    expect(controller.snapshot().directory).toBe(await realOf(directory));
    expect(controller.snapshot().warnings[0]).toMatch(/disk is full/);
  });

  it("reconnects on launch and reports a saved database that is gone", async () => {
    await controller.open(directory);
    const restart = () =>
      new DesktopController(controllerDeps(), {}, { confirm }, { openDatabase, preferences });
    const again = restart();
    await again.restore();
    expect(again.snapshot()).toMatchObject({
      database: join(directory, "first.sqlite"),
      databaseError: null,
      projects: [{ path: await realOf(directory) }],
    });
    await again.shutdown(true);
    databases.clear();
    const missing = restart();
    await missing.restore();
    expect(missing.snapshot().database).toBeNull();
    expect(missing.snapshot().databaseError).toMatch(/not found/);
    expect(databases.size).toBe(0);
    await missing.shutdown(true);
  });
});

describe("app-wide orchestration chat", () => {
  async function ready() {
    await controller.setOrchestrationProvider("claude");
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    return controller.snapshot().chat.run?.id as string;
  }

  function tableCaller(index = 0) {
    const server = agents.specs[index]?.mcpServers?.[0];
    if (!server) throw new Error("Expected an orchestration MCP server");
    const environment = Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]));
    const url = environment.CODE60_MCP_GATEWAY_URL as string;
    return async (name: string, args: unknown = {}) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${environment.CODE60_MCP_GATEWAY_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name, arguments: args }),
      });
      return { status: response.status, body: await response.json() };
    };
  }

  it("injects the latest saved contract without changing recorded user prompts", async () => {
    const id = await ready();
    const send = async (text: string) => {
      await controller.orchestrationChatAction({ type: "send", id, text });
      await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    };
    await send("first");
    expect(agents.sessions[0]?.prompts[0]).toBe(
      `${DEFAULT_PROMPT_TEMPLATES.operatingContract}\n\n--- User request ---\nfirst`,
    );
    await controller.savePromptTemplate({
      id: "operatingContract",
      template: "Edited Code60 role.",
    });
    await send("second");
    expect(agents.sessions[0]?.prompts[1]).toBe(
      "Edited Code60 role.\n\n--- User request ---\nsecond",
    );
    await controller.resetPromptTemplate("operatingContract");
    await send("third");
    expect(agents.sessions[0]?.prompts[2]).toContain(DEFAULT_PROMPT_TEMPLATES.operatingContract);
    expect(
      controller
        .snapshot()
        .chat.events.map(({ event }) => event)
        .filter((event) => event.type === "prompt")
        .map((event) => event.text),
    ).toEqual(["first", "second", "third"]);
    expect(agents.specs).toHaveLength(1);
  });

  it("provides read/search for every UI table, with current-project scope and no mutation tools", async () => {
    await ready();
    const call = tableCaller();
    expect(agents.specs[0]?.mcpServers?.[0]?.command).toBe(process.execPath);
    expect((await call("code60_read_sessions")).body.result.rows).toEqual([]);
    await controller.open(directory);
    await controller.saveConfiguration({ name: "Team Alpha", settings: request });
    git.listedWorktrees = [{ path: directory, branch: "main", createdAt: null, sizeBytes: 42 }];
    await controller.poll(["worktrees"]);
    const [runId] = await controller.start({ ...request, prompt: "Project hello" });
    await vi.waitFor(() => expect(controller.snapshot().runs[0]?.view?.status).toBe("idle"));
    expect(agents.specs[1]?.mcpServers).toBeUndefined();
    agents.sessions[1]?.update({ type: "message", text: "Streamed " });
    agents.sessions[1]?.update({ type: "message", text: "reply" });
    const sessions = await call("code60_search_sessions", { query: runId });
    expect(sessions.body.result.rows).toEqual([
      expect.objectContaining({ id: runId, agent: "claude", turns: 1 }),
    ]);
    const messages = await call("code60_search_messages", { query: "STREAMED REPLY" });
    expect(messages.body.result.rows).toEqual([
      expect.objectContaining({ kind: "Message", text: "Streamed reply" }),
    ]);
    const events = await call("code60_search_events", { query: "Streamed " });
    expect(events.body.result.rows).toEqual([
      expect.objectContaining({
        session: runId,
        agent: "claude",
        type: "message",
        details: JSON.stringify({ text: "Streamed " }),
      }),
    ]);
    const statusEvents = await call("code60_search_events", { query: "running" });
    expect(statusEvents.body.result.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "status", status: "running" })]),
    );
    const configurations = await call("code60_search_configurations", { query: "alpha" });
    expect(configurations.body.result.rows).toEqual([
      expect.objectContaining({ name: "Team Alpha", agents: 1, uses: 0 }),
    ]);
    const worktrees = await call("code60_read_worktrees");
    expect(worktrees.body.result.rows).toEqual([
      expect.objectContaining({ path: directory, branch: "main", sizeBytes: 42 }),
    ]);
    const polling = await call("code60_search_polling", { query: "Worktrees" });
    expect(polling.body.result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowType: "source", source: "Worktrees" }),
        expect.objectContaining({ rowType: "result", source: "Worktrees", trigger: "manual" }),
      ]),
    );
    expect((await call("code60_delete_sessions")).status).toBe(400);
    expect((await call("code60_read_sessions", { path: "/another-project" })).status).toBe(400);

    await controller.action({ type: "finish", id: runId as string });
    await vi.waitFor(() => expect(controller.active).toBe(false));
    await controller.poll(["history"]);
    const historical = await call("code60_search_messages", { query: "Streamed reply" });
    expect(historical.body.result.total).toBe(1);
    expect((await call("code60_search_events", { query: "Streamed " })).body.result.rows).toEqual(
      events.body.result.rows,
    );
    const next = join(directory, "another");
    await fs.mkdir(next);
    git.repoInfo = async () => ({ topLevel: next, commonDir: join(next, ".git") });
    await controller.open(next);
    expect((await call("code60_read_sessions")).body.result.rows).toEqual([]);
    expect((await call("code60_read_messages")).body.result.rows).toEqual([]);
    expect((await call("code60_read_events")).body.result.rows).toEqual([]);
    expect((await call("code60_read_configurations")).body.result.total).toBe(1);
    expect((await call("code60_read_worktrees")).status).toBe(400);

    await controller.setOrchestrationProvider(null);
    await expect(call("code60_read_sessions")).rejects.toThrow();
  });

  it("creates private chat folders, routes background turns, and retains independent transcripts", async () => {
    agents.script = () => "hang";
    const firstId = await ready();
    const first = controller.snapshot().chat;
    const root = join(directory, ".code60_workspace");
    expect(first.directory).not.toBe(root);
    expect(first.directory?.startsWith(`${root}${sep}`)).toBe(true);
    await fs.writeFile(join(first.directory as string, "notes.txt"), "first chat");
    await controller.orchestrationChatAction({ type: "send", id: firstId, text: "first" });
    await controller.orchestrationChatAction({ type: "new" });
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    const second = controller.snapshot().chat;
    const secondId = second.run?.id as string;
    expect(secondId).not.toBe(firstId);
    expect(second.directory).not.toBe(first.directory);
    if (process.platform !== "win32")
      expect((await fs.stat(second.directory as string)).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(join(first.directory as string, "notes.txt"), "utf8")).toBe(
      "first chat",
    );
    expect(await fs.readdir(second.directory as string)).not.toContain("notes.txt");
    expect(agents.sessions[0]?.stops).toEqual([]);
    expect(controller.hasActiveWork).toBe(true);
    expect(controller.snapshot().chats).toHaveLength(2);

    agents.sessions[0]?.update({ type: "message", text: "background reply" });
    agents.sessions[0]?.endTurn("end_turn");
    await vi.waitFor(() => expect(controller.snapshot().chats[0]?.run?.status).toBe("idle"));
    expect(controller.snapshot().chat.events.some(({ event }) => event.type === "message")).toBe(
      false,
    );
    await controller.orchestrationChatAction({ type: "send", id: secondId, text: "second" });
    // Requests target the specified chat even if another chat is selected.
    await controller.orchestrationChatAction({
      type: "send",
      id: firstId,
      text: "first follow-up",
    });
    await controller.orchestrationChatAction({ type: "select", id: firstId });
    expect(controller.snapshot().chat.run?.id).toBe(firstId);
    expect(controller.snapshot().chat.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ text: "background reply" }) }),
      ]),
    );
    expect(agents.sessions[0]?.prompts.at(-1)).toContain("first follow-up");
    expect(agents.sessions[1]?.prompts.at(-1)).toContain("second");
    await controller.stopAll();
    expect(controller.snapshot().chats.every((chat) => chat.run?.status === "cancelled")).toBe(
      true,
    );
    expect(agents.sessions.map((session) => session.stops.length)).toEqual([1, 1]);
    for (const chat of controller.snapshot().chats) {
      const record = JSON.parse(
        await fs.readFile(
          join(chat.directory as string, ".code60", "runs", chat.run?.id as string, "run.json"),
          "utf8",
        ),
      );
      expect(record.worktree).toBe(chat.directory);
    }
  });

  it.each([false, true])("shuts down all orchestrator chats (force=%s)", async (force) => {
    await ready();
    await controller.orchestrationChatAction({ type: "new" });
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    await controller.shutdown(force);
    expect(agents.sessions.every((session) => session.stops.length >= 1)).toBe(true);
    expect(controller.snapshot().chats.every((chat) => chat.run?.status === "finished")).toBe(true);
  });

  it("replaces all chats on provider changes but retries only the selected chat", async () => {
    const firstId = await ready();
    await controller.orchestrationChatAction({ type: "new" });
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    const secondId = controller.snapshot().chat.run?.id as string;
    await controller.orchestrationChatAction({ type: "restart", id: secondId });
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    expect(controller.snapshot().chats[0]?.run?.id).toBe(firstId);
    expect(agents.sessions[0]?.stops).toEqual([]);
    await expect(
      controller.orchestrationChatAction({ type: "select", id: secondId }),
    ).rejects.toThrow("no longer current");
    await controller.setOrchestrationProvider("codex");
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    expect(controller.snapshot().chats).toHaveLength(1);
    expect(agents.sessions.slice(0, 3).map((session) => session.stops.length)).toEqual([1, 1, 1]);
  });

  it("starts fresh at restore and streams replies with allow-all, independently of project changes", async () => {
    orchestrationProvider = "claude";
    agents.script = (text, session) => {
      session.update({
        type: "message",
        text: `reply: ${text.split("--- User request ---\n").at(-1)}`,
      });
      return "end_turn";
    };
    await controller.restore();
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    const id = controller.snapshot().chat.run?.id as string;
    expect(agents.specs[0]?.cwd).toBe(controller.snapshot().chat.directory);
    expect(agents.sessions[0]?.prompts).toEqual([]);
    expect(controller.snapshot().runs).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(
      await agents.sessions[0]?.requestPermission({
        toolCallId: "edit",
        title: "Edit",
        kind: "edit",
      }),
    ).toBe("allow");
    await controller.orchestrationChatAction({ type: "send", id, text: "hello" });
    await vi.waitFor(() =>
      expect(controller.snapshot().chat.run).toMatchObject({ status: "idle", turns: 1 }),
    );
    expect(controller.snapshot().chat.events.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "prompt", text: "hello" }),
        expect.objectContaining({ type: "message", text: "reply: hello" }),
        expect.objectContaining({ type: "permission", decision: "allowed", by: "policy" }),
      ]),
    );
    const second = join(directory, "project-two");
    await fs.mkdir(second);
    await controller.open(directory);
    await controller.open(second);
    expect(controller.snapshot().chat.run?.id).toBe(id);
    expect(agents.specs).toHaveLength(1);
    expect(controller.snapshot().chat.events.some((entry) => entry.event.type === "message")).toBe(
      true,
    );
    await controller.orchestrationChatAction({ type: "send", id, text: "after project switch" });
    await vi.waitFor(() =>
      expect(
        controller
          .snapshot()
          .chat.events.some(
            (entry) =>
              entry.event.type === "message" && entry.event.text === "reply: after project switch",
          ),
      ).toBe(true),
    );
  });

  it("replaces sessions on provider/database changes and refuses stale actions", async () => {
    const id = await ready();
    await controller.setOrchestrationProvider("codex");
    await vi.waitFor(() =>
      expect(controller.snapshot().chat.run).toMatchObject({ status: "idle", agent: "codex" }),
    );
    expect(agents.sessions[0]?.stops).toHaveLength(1);
    await expect(
      controller.orchestrationChatAction({ type: "send", id, text: "stale" }),
    ).rejects.toThrow("no longer current");
    const providerId = controller.snapshot().chat.run?.id;
    await controller.connect(join(directory, "second.sqlite"), true);
    expect(controller.snapshot().chat.run?.id).not.toBe(providerId);
    expect(controller.snapshot().chat.events.some((entry) => entry.event.type === "prompt")).toBe(
      false,
    );
    await controller.setOrchestrationProvider(null);
    expect(controller.snapshot().chat.run).toBeNull();
    expect(controller.snapshot().chat.events).toEqual([]);
  });

  it("cancels a turn, accepts another reply and includes chat in Stop all", async () => {
    agents.script = () => "hang";
    const id = await ready();
    expect(controller.hasActiveWork).toBe(false);
    await controller.orchestrationChatAction({ type: "send", id, text: "working" });
    expect(controller.hasActiveWork).toBe(true);
    await controller.orchestrationChatAction({ type: "cancel", id });
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    expect(agents.sessions[0]?.cancels).toBe(1);
    agents.script = () => "end_turn";
    // The existing fake session retains its original hanging turn script.
    await controller.orchestrationChatAction({ type: "send", id, text: "again" });
    expect(agents.sessions[0]?.prompts).toEqual([
      `${DEFAULT_PROMPT_TEMPLATES.operatingContract}\n\n--- User request ---\nworking`,
      `${DEFAULT_PROMPT_TEMPLATES.operatingContract}\n\n--- User request ---\nagain`,
    ]);
    await controller.stopAll();
    expect(controller.snapshot().chat.run?.status).toBe("cancelled");
    expect(agents.sessions[0]?.stops).toHaveLength(1);
    await controller.poll(["config"]);
    expect(controller.snapshot().chat.run?.id).toBe(id);
    expect(agents.specs).toHaveLength(1);
  });

  it("surfaces startup failures and retries with a new ACP session", async () => {
    agents.startError = new Error("ACP authentication required");
    await controller.setOrchestrationProvider("claude");
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("failed"));
    const id = controller.snapshot().chat.run?.id as string;
    expect(controller.snapshot().chat.run?.reason).toContain("authentication");
    agents.startError = undefined;
    await controller.orchestrationChatAction({ type: "restart", id });
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    expect(controller.snapshot().chat.run?.id).not.toBe(id);
  });

  it("aborts ACP startup during shutdown", async () => {
    agents.startGate = new Promise(() => {});
    await controller.setOrchestrationProvider("claude");
    await vi.waitFor(() => expect(agents.specs).toHaveLength(1));
    expect(controller.hasActiveWork).toBe(true);
    await controller.shutdown(true);
    expect(controller.snapshot().chat.run?.status).toBe("cancelled");
    expect(agents.sessions).toEqual([]);
  });

  it("reports worktree-directory conflicts without overwriting existing files", async () => {
    const folder = join(directory, ".code60_workspace");
    await fs.writeFile(folder, "preserve me");
    await controller.setOrchestrationProvider("claude");
    expect(controller.snapshot().chat.error).toBeTruthy();
    expect(await fs.readFile(folder, "utf8")).toBe("preserve me");
    expect(controller.connected).toBe(true);
    await fs.rm(folder);
    await controller.orchestrationChatAction({ type: "restart", id: null });
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    if (process.platform !== "win32") expect((await fs.stat(folder)).mode & 0o777).toBe(0o700);
  });
});

it("includes the orchestration session when warning about a shared non-Git folder", async () => {
  await controller.setOrchestrationProvider("claude");
  await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
  git.repoInfo = async () => {
    throw new Error("not a repository");
  };
  await controller.open(controller.snapshot().chat.directory as string);
  await controller.start({ ...request });
  expect(confirm).toHaveBeenCalledWith(
    "Run without worktrees?",
    expect.stringContaining("existing live sessions"),
  );
});

describe("orchestrated workers over ACP", () => {
  type Call = (
    name: string,
    args?: unknown,
  ) => Promise<{
    status: number;
    body: {
      error: string;
      result: {
        scope: string;
        runId: string;
        workers: unknown[];
        entries: unknown[];
        [key: string]: unknown;
      };
    };
  }>;
  function caller(index = 0): Call {
    const server = agents.specs[index]?.mcpServers?.[0];
    if (!server) throw new Error("Expected an orchestration MCP server");
    const environment = Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]));
    return async (name, args = {}) => {
      const response = await fetch(environment.CODE60_MCP_GATEWAY_URL as string, {
        method: "POST",
        headers: {
          authorization: `Bearer ${environment.CODE60_MCP_GATEWAY_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name, arguments: args }),
      });
      return { status: response.status, body: await response.json() };
    };
  }
  const session = (runId: string) =>
    agents.sessions[agents.specs.findIndex((spec) => spec.cwd.endsWith(runId))];
  const chatPrompts = () => agents.sessions[0]?.prompts ?? [];
  const chatStatus = () => controller.snapshot().chat.run?.status;

  async function setup(maxParallel = 4) {
    agents.script = (text, current) => {
      if (text.includes("HANG")) return "hang";
      if (!text.includes("--- ")) current.update({ type: "message", text: `done: ${text}` });
      return "end_turn";
    };
    await controller.setOrchestrationProvider("claude");
    await vi.waitFor(() => expect(chatStatus()).toBe("idle"));
    await controller.open(directory);
    const call = caller();
    const context = await call("code60_get_context");
    expect(context.body.result).toMatchObject({
      project: await realOf(directory),
      gitRepository: true,
      defaultProvider: "claude",
      maxParallel,
      liveWorkers: 0,
    });
    return { call, scope: context.body.result.scope as string };
  }

  async function dispatch(call: Call, scope: string, prompt: string, requestId = prompt) {
    const result = await call("code60_dispatch_agent", { scope, requestId, prompt });
    expect(result.status).toBe(200);
    return result.body.result.runId as string;
  }

  it("isolates gateways, ownership, request IDs, capacity and updates across chats", async () => {
    await fs.mkdir(join(directory, "config", "code60"), { recursive: true });
    await fs.writeFile(
      join(directory, "config", "code60", "config.json"),
      JSON.stringify({ maxParallel: 1 }),
    );
    await controller.poll(["config"]);
    const { call: firstCall, scope: firstScope } = await setup(1);
    const firstId = controller.snapshot().chat.run?.id as string;
    await controller.orchestrationChatAction({ type: "new" });
    await vi.waitFor(() => expect(chatStatus()).toBe("idle"));
    const secondCall = caller(1);
    const secondScope = (await secondCall("code60_get_context")).body.result.scope;
    expect(secondScope).not.toBe(firstScope);
    const firstWorker = await dispatch(firstCall, firstScope, "HANG first", "shared-id");
    const secondWorker = await dispatch(secondCall, secondScope, "HANG second", "shared-id");
    expect(firstWorker).not.toBe(secondWorker);
    expect(controller.snapshot().chats.find((chat) => chat.run?.id === firstId)?.workers).toEqual([
      firstWorker,
    ]);
    expect(controller.snapshot().chat.workers).toEqual([secondWorker]);
    expect((await firstCall("code60_get_context")).body.result.liveWorkers).toBe(1);
    expect((await secondCall("code60_get_context")).body.result.liveWorkers).toBe(1);
    expect((await firstCall("code60_list_agents")).body.result.workers).toEqual([
      expect.objectContaining({ runId: firstWorker }),
    ]);
    expect((await secondCall("code60_list_agents")).body.result.workers).toEqual([
      expect.objectContaining({ runId: secondWorker }),
    ]);
    expect((await secondCall("code60_read_agent", { runId: firstWorker })).status).toBe(400);
    expect(
      (
        await secondCall("code60_stop_agent", {
          scope: firstScope,
          runId: firstWorker,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await secondCall("code60_stop_agent", {
          scope: secondScope,
          runId: firstWorker,
        })
      ).status,
    ).toBe(400);

    await vi.waitFor(() => expect(session(firstWorker)?.turnActive).toBe(true));
    session(firstWorker)?.update({ type: "message", text: "first worker reply" });
    session(firstWorker)?.endTurn("end_turn");
    await vi.waitFor(() => expect(agents.sessions[0]?.prompts).toHaveLength(1));
    expect(agents.sessions[0]?.prompts[0]).toContain("first worker reply");
    expect(agents.sessions[1]?.prompts).toEqual([]);
    await vi.waitFor(() => expect(session(secondWorker)?.turnActive).toBe(true));
    session(secondWorker)?.endTurn("end_turn");
    await vi.waitFor(() => expect(agents.sessions[1]?.prompts).toHaveLength(1));
    expect(agents.sessions[1]?.prompts[0]).toContain(secondWorker);
    expect(agents.sessions[1]?.prompts[0]).not.toContain(firstWorker);

    await controller.orchestrationChatAction({ type: "select", id: firstId });
    expect((await secondCall("code60_list_agents")).status).toBe(200);
    await controller.orchestrationChatAction({ type: "restart", id: firstId });
    await expect(firstCall("code60_get_context")).rejects.toThrow();
    expect((await secondCall("code60_list_agents")).status).toBe(200);
  });

  it("dispatches allow-all workers, wakes the chat once per worker turn, and labels it automatic", async () => {
    const { call, scope } = await setup();
    const runId = await dispatch(call, scope, "Fix the bug");
    await vi.waitFor(() => expect(session(runId)?.prompts).toEqual(["Fix the bug"]));
    const spec = agents.specs.find((entry) => entry.cwd.endsWith(runId));
    expect(spec?.mcpServers).toBeUndefined();
    expect(controller.snapshot().workers).toEqual([runId]);

    await vi.waitFor(() => expect(chatPrompts()).toHaveLength(1));
    const update = chatPrompts()[0] as string;
    expect(update).toContain("--- Automatic Code60 update (not written by the user) ---");
    expect(update).toContain(`Worker ${runId} (claude): idle after turn 1 (end_turn)`);
    expect(update).toContain("done: Fix the bug");
    await vi.waitFor(() => expect(chatStatus()).toBe("idle"));
    const prompts = controller
      .snapshot()
      .chat.events.map(({ event }) => event)
      .filter((event) => event.type === "prompt");
    expect(prompts).toEqual([expect.objectContaining({ origin: "automatic" })]);

    expect(
      await session(runId)?.requestPermission({ toolCallId: "t", title: "rm", kind: "execute" }),
    ).toBe("allow");
    const listed = await call("code60_list_agents");
    expect(listed.body.result.workers).toEqual([
      expect.objectContaining({
        runId,
        status: "idle",
        turns: 1,
        actions: ["send", "finish", "stop"],
      }),
    ]);
    const read = await call("code60_read_agent", { runId });
    expect(read.body.result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "prompt", text: "Fix the bug" }),
        expect.objectContaining({ type: "message", text: "done: Fix the bug" }),
        expect.objectContaining({ type: "permission", decision: "allowed", by: "policy" }),
      ]),
    );

    expect(
      (await call("code60_send_agent", { scope, runId, prompt: "Also add tests" })).status,
    ).toBe(200);
    await vi.waitFor(() => expect(chatPrompts()).toHaveLength(2));
    expect(chatPrompts()[1]).toContain("idle after turn 2");
    await vi.waitFor(() => expect(chatStatus()).toBe("idle"));

    expect((await call("code60_finish_agent", { scope, runId })).status).toBe(200);
    await vi.waitFor(() => expect(controller.active).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(chatPrompts()).toHaveLength(2);
  });

  it("rejects stale scopes, unknown arguments, manual sessions, and the chat itself", async () => {
    const { call, scope } = await setup();
    const [manual] = await controller.start({ ...request, prompt: "manual" });
    const chatId = controller.snapshot().chat.run?.id;
    for (const runId of [manual, chatId, "20260101-000000-abcdef"]) {
      const result = await call("code60_send_agent", { scope, runId, prompt: "x" });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("No worker with this ID");
    }
    expect(
      (await call("code60_dispatch_agent", { scope: "old", requestId: "a", prompt: "x" })).body
        .error,
    ).toContain("stale");
    expect(
      (await call("code60_dispatch_agent", { scope, requestId: "a", prompt: "x", command: "sh" }))
        .body.error,
    ).toBe("Unknown tool argument");
    expect(
      (
        await call("code60_dispatch_agent", {
          scope,
          requestId: "a",
          prompt: "x",
          provider: "nope",
        })
      ).body.error,
    ).toContain("Unknown provider");
    expect(
      (await call("code60_dispatch_agent", { scope, requestId: "a", prompt: " " })).status,
    ).toBe(400);
    await vi.waitFor(() =>
      expect(controller.snapshot().runs.find((run) => run.record.id === manual)?.view?.status).toBe(
        "idle",
      ),
    );
    await controller.action({ type: "finish", id: manual as string });
    await vi.waitFor(() => expect(controller.active).toBe(false));
    const other = join(directory, "other");
    await fs.mkdir(other);
    await controller.open(other);
    expect(
      (await call("code60_dispatch_agent", { scope, requestId: "b", prompt: "x" })).body.error,
    ).toContain("stale");
  });

  it("deduplicates request IDs and enforces the parallel limit until a worker is finished", async () => {
    await fs.mkdir(join(directory, "config", "code60"), { recursive: true });
    await fs.writeFile(
      join(directory, "config", "code60", "config.json"),
      JSON.stringify({ maxParallel: 1 }),
    );
    await controller.poll(["config"]);
    const { call, scope } = await setup(1);
    const first = await call("code60_dispatch_agent", { scope, requestId: "r1", prompt: "HANG" });
    const again = await call("code60_dispatch_agent", { scope, requestId: "r1", prompt: "HANG" });
    expect(again.body.result.runId).toBe(first.body.result.runId);
    expect(
      (await call("code60_dispatch_agent", { scope, requestId: "r1", prompt: "other" })).body.error,
    ).toContain("already used");
    const full = await call("code60_dispatch_agent", { scope, requestId: "r2", prompt: "two" });
    expect(full.body.error).toContain("All 1 worker slots are in use");
    const runId = first.body.result.runId as string;
    await vi.waitFor(() => expect(session(runId)?.turnActive).toBe(true));
    expect((await call("code60_finish_agent", { scope, runId })).body.error).toContain(
      "only an idle run",
    );
    expect((await call("code60_cancel_agent", { scope, runId })).status).toBe(200);
    await vi.waitFor(() => expect(controller.snapshot().runs[0]?.view?.status).toBe("idle"));
    expect((await call("code60_finish_agent", { scope, runId })).status).toBe(200);
    await vi.waitFor(() => expect(controller.active).toBe(false));
    expect(
      (await call("code60_dispatch_agent", { scope, requestId: "r2", prompt: "two" })).status,
    ).toBe(200);
    await vi.waitFor(() => expect(agents.sessions).toHaveLength(3));
  });

  it("wakes the chat when a worker fails before its first turn", async () => {
    const { call, scope } = await setup();
    agents.startError = new Error("Worker authentication required");
    const runId = await dispatch(call, scope, "start work");
    await vi.waitFor(() => expect(chatPrompts()).toHaveLength(1));
    expect(chatPrompts()[0]).toContain(`Worker ${runId} (claude): failed after turn 0`);
    expect(chatPrompts()[0]).toContain("Worker authentication required");
  });

  it("coalesces updates while the chat is busy and pauses them after Stop", async () => {
    const { call, scope } = await setup();
    const chatId = controller.snapshot().chat.run?.id as string;
    await controller.orchestrationChatAction({ type: "send", id: chatId, text: "HANG please" });
    const one = await dispatch(call, scope, "one");
    const two = await dispatch(call, scope, "two");
    await vi.waitFor(() =>
      expect(controller.snapshot().chat.updates).toEqual({ paused: false, pending: 2 }),
    );
    agents.sessions[0]?.endTurn("end_turn");
    await vi.waitFor(() => expect(chatPrompts()).toHaveLength(2));
    expect(chatPrompts()[1]).toContain(`Worker ${one}`);
    expect(chatPrompts()[1]).toContain(`Worker ${two}`);
    await vi.waitFor(() => expect(chatStatus()).toBe("idle"));

    await controller.orchestrationChatAction({ type: "send", id: chatId, text: "HANG again" });
    await call("code60_send_agent", { scope, runId: one, prompt: "more" });
    await vi.waitFor(() => expect(controller.snapshot().chat.updates.pending).toBe(1));
    await controller.orchestrationChatAction({ type: "cancel", id: chatId });
    await vi.waitFor(() => expect(chatStatus()).toBe("idle"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(controller.snapshot().chat.updates).toEqual({ paused: true, pending: 1 });
    expect(chatPrompts()).toHaveLength(3);
    await controller.orchestrationChatAction({ type: "resume-updates", id: chatId });
    await vi.waitFor(() => expect(chatPrompts()).toHaveLength(4));
    expect(chatPrompts()[3]).toContain(`Worker ${one} (claude): idle after turn 2`);
  });

  it("stops and resumes owned workers with allow-all, and revokes tools when the chat is replaced", async () => {
    const { call, scope } = await setup();
    const runId = await dispatch(call, scope, "HANG work");
    await vi.waitFor(() => expect(session(runId)?.turnActive).toBe(true));
    expect((await call("code60_stop_agent", { scope, runId })).status).toBe(200);
    await vi.waitFor(() => expect(controller.active).toBe(false));
    await controller.poll(["history"]);
    await vi.waitFor(() => expect(chatPrompts().at(-1)).toContain("cancelled after turn 1"));
    const listed = await call("code60_list_agents");
    expect(listed.body.result.workers[0]).toMatchObject({
      status: "cancelled",
      actions: ["resume"],
    });
    const resumed = await call("code60_resume_agent", { scope, runId, prompt: "continue" });
    expect(resumed.body.result).toMatchObject({ recovery: "restored" });
    expect(agents.restores.at(-1)?.sessionId).toBe(session(runId)?.sessionId);
    const restored = agents.sessions.at(-1);
    await vi.waitFor(() => expect(restored?.prompts).toEqual(["continue"]));
    expect(
      await restored?.requestPermission({ toolCallId: "t", title: "x", kind: "execute" }),
    ).toBe("allow");

    await controller.setOrchestrationProvider("codex");
    await vi.waitFor(() => expect(chatStatus()).toBe("idle"));
    await expect(call("code60_list_agents")).rejects.toThrow();
    const next = caller(agents.specs.findLastIndex((spec) => spec.mcpServers !== undefined));
    const context = await next("code60_get_context");
    expect(context.body.result.scope).not.toBe(scope);
    expect(
      (await next("code60_finish_agent", { scope: context.body.result.scope, runId })).body.error,
    ).toContain("No worker with this ID");
    expect(controller.snapshot().workers).toContain(runId);
    expect(controller.snapshot().chat.workers).toEqual([]);
  });
});

describe("episodic memory controller", () => {
  async function prepare() {
    const id = await start("Use npm for the project.");
    await controller.action({ type: "finish", id });
    await vi.waitFor(() => expect(controller.snapshot().active).toBe(false));
    await controller.setOrchestrationProvider("claude");
    await vi.waitFor(() => expect(controller.snapshot().chat.run?.status).toBe("idle"));
    const events = await controller.action({ type: "events", id });
    if (!Array.isArray(events)) throw new Error("Missing fixture events");
    return {
      requestId: crypto.randomUUID(),
      directory: await realOf(directory),
      prompt: "Remember decisions",
      runs: [{ id, count: events.length }],
    };
  }

  it("uses the selected event snapshot and a temporary directory, leaving chat and runs unchanged", async () => {
    const request = await prepare();
    expect(request.runs[0]?.count).toBeGreaterThan(2);
    request.runs = request.runs.map((run) => ({ ...run, count: 2 }));
    const before = controller.snapshot();
    agents.script = (_, session) => {
      session.update({ type: "message", text: '{"statements":["The project uses npm."]}' });
      return "end_turn";
    };
    const result = await controller.extractMemory(request);
    expect(result).toEqual({
      eventCount: request.runs[0]?.count,
      statements: ["The project uses npm."],
    });
    expect(controller.snapshot().runs.map((run) => run.record.id)).toEqual(
      before.runs.map((run) => run.record.id),
    );
    expect(controller.snapshot().chat.run?.id).toBe(before.chat.run?.id);
    const excerpt = agents.sessions
      .at(-1)
      ?.prompts[0]?.split("--- Recorded events ---\n\n")[1]
      ?.split("\n\n--- End recorded events ---")[0];
    expect(
      excerpt
        ?.trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toHaveLength(2);
    const spec = agents.specs.at(-1);
    expect(spec?.cwd).toContain("code60-memory-");
    expect(spec?.mcpServers).toBeUndefined();
    await expect(fs.stat(spec?.cwd ?? "")).rejects.toThrow();
  });

  it("rejects stale projects, foreign sessions, and unavailable event counts", async () => {
    const request = await prepare();
    const starts = agents.sessions.length;
    await expect(controller.extractMemory({ ...request, directory: "/other" })).rejects.toThrow(
      "project changed",
    );
    await expect(
      controller.extractMemory({ ...request, runs: [{ id: "foreign", count: 1 }] }),
    ).rejects.toThrow("open project");
    await expect(
      controller.extractMemory({
        ...request,
        runs: [{ id: request.runs[0]?.id as string, count: 9999 }],
      }),
    ).rejects.toThrow("Events changed");
    expect(agents.sessions).toHaveLength(starts);
  });

  it.each(["cancel", "provider", "project", "stop all", "shutdown"])(
    "cancels and cleans up extraction on %s",
    async (action) => {
      const request = await prepare();
      agents.script = () => "hang";
      const starts = agents.sessions.length;
      const pending = controller.extractMemory(request);
      const rejected = expect(pending).rejects.toThrow("cancelled");
      await vi.waitFor(() => expect(agents.sessions.length).toBe(starts + 1));
      await expect(
        controller.extractMemory({ ...request, requestId: crypto.randomUUID() }),
      ).rejects.toThrow("already running");
      await controller.cancelMemoryExtraction(crypto.randomUUID());
      expect(agents.sessions.at(-1)?.stops).toEqual([]);
      if (action === "cancel") await controller.cancelMemoryExtraction(request.requestId);
      else if (action === "provider") await controller.setOrchestrationProvider(null);
      else if (action === "project") {
        await controller.open(directory);
      } else if (action === "stop all") await controller.stopAll();
      else await controller.shutdown();
      await rejected;
      expect(agents.sessions.at(-1)?.stops).toContain(1000);
      await expect(fs.stat(agents.specs.at(-1)?.cwd ?? "")).rejects.toThrow();
    },
  );
});

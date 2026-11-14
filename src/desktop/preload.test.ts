import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

describe("sandboxed diagnostic preload", () => {
  it("exposes only fixed log methods and cleans up its batched notice listener", async () => {
    const invoke = vi.fn(async () => "result");
    const on = vi.fn();
    const removeListener = vi.fn();
    let api: Record<string, (...args: unknown[]) => unknown> = {};
    const require = createRequire(import.meta.url);
    const electron = require.resolve("electron");
    const previous = require.cache[electron];
    require.cache[electron] = {
      exports: {
        contextBridge: {
          exposeInMainWorld: (key: string, value: typeof api) => {
            expect(key).toBe("desktop");
            api = value;
          },
        },
        ipcRenderer: { invoke, on, removeListener },
      },
    } as NodeModule;
    const preload = "./preload.cts";
    try {
      await import(preload);
    } finally {
      if (previous) require.cache[electron] = previous;
      else delete require.cache[electron];
    }
    for (const [method, channel, request] of [
      ["queryLogs", "desktop:logs-query", { limit: 10 }],
      ["logDetail", "desktop:logs-detail", { id: crypto.randomUUID() }],
      ["clearLogs", "desktop:logs-clear", { confirm: true }],
    ] as const) {
      expect(await api[method]?.(request)).toBe("result");
      expect(invoke).toHaveBeenLastCalledWith(channel, request);
    }
    const listener = vi.fn();
    const unsubscribe = api.onLogsChanged?.(listener) as () => void;
    const [channel, handler] = on.mock.calls[0] as [string, () => void];
    expect(channel).toBe("desktop:logs-changed");
    handler();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(channel, handler);
    const memoryListener = vi.fn();
    const offMemory = api.onMemoryChanged?.(memoryListener) as () => void;
    const memoryHandler = on.mock.lastCall?.[1] as () => void;
    expect(on).toHaveBeenLastCalledWith("desktop:memory-changed", memoryHandler);
    memoryHandler();
    expect(memoryListener).toHaveBeenCalledOnce();
    offMemory();
    expect(removeListener).toHaveBeenLastCalledWith("desktop:memory-changed", memoryHandler);
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("readFile");
    expect(await api.appSummary?.()).toBe("result");
    expect(invoke).toHaveBeenLastCalledWith("desktop:snapshot-summary");
    // Verify the existing fixed forwarding surface, not just newly added methods.
    const requests = {
      automation: "automation",
      browseMemories: "memory-browse",
      memoryDetail: "memory-detail",
      memoryAction: "memory-action",
      rebuildRag: "rag-rebuild",
      retrieveRag: "rag-retrieve",
      cancelRag: "rag-cancel",
      clearRag: "rag-clear",
      openWebLink: "web-link",
      checkGit: "git-check",
      beginGitSetup: "git-begin",
      previewGitSetupFile: "git-file",
      initializeGit: "git-initialize",
      commitGitSetup: "git-commit",
      cancelGitSetup: "git-cancel",
      readPlan: "plan-read",
      subscribeDetails: "detail-subscribe",
      readDetails: "detail-read",
      setRelayFileContext: "relay-files",
      unsubscribeDetails: "detail-unsubscribe",
      readRelayMessage: "relay-message",
      relayReview: "relay-review",
      planAction: "plan-action",
      readReview: "review-read",
      taskAction: "task-action",
      reviewAction: "review-action",
      captureReview: "review-capture",
      readReviewFile: "review-file",
      readDiff: "diff-read",
      cancelDiff: "diff-cancel",
      beginAgentSetup: "setup-begin",
      attemptAgentSetup: "setup-attempt",
      cancelAgentSetup: "setup-cancel",
      finishAgentSetup: "setup-finish",
      abandonAgentSetup: "setup-abandon",
      update: "app-update",
      summarizeSearch: "search-summary",
      cancelSearchSummary: "search-summary-cancel",
      extractMemory: "memory-extract",
      cancelMemoryExtraction: "memory-cancel",
      orchestrationChatAction: "orchestration-chat",
      setWindowTheme: "window-theme",
      setTransparent: "transparent",
      setBackgroundHitTest: "background-hit-test",
      projectAction: "project-action",
      setFileContext: "files",
      setPollSettings: "poll-settings",
      setPollingPaused: "poll-paused",
      setVisibility: "visibility",
      setOrchestrationProvider: "orchestration-provider",
      start: "start",
      action: "action",
    };
    const request = { opaque: "request" };
    const automationListener = vi.fn();
    const offAutomation = api.onAutomationChanged?.(automationListener) as () => void;
    const automationHandler = on.mock.lastCall?.[1] as () => void;
    expect(on).toHaveBeenLastCalledWith("desktop:automation-changed", automationHandler);
    automationHandler();
    expect(automationListener).toHaveBeenCalledOnce();
    offAutomation();
    expect(removeListener).toHaveBeenLastCalledWith(
      "desktop:automation-changed",
      automationHandler,
    );
    const detailListener = vi.fn();
    const offDetails = api.onDetails?.(detailListener) as () => void;
    const [detailChannel, detailHandler] = on.mock.calls.at(-1) as [
      string,
      (event: unknown, frame: unknown) => void,
    ];
    expect(detailChannel).toBe("desktop:detail");
    detailHandler(null, { revision: 5 });
    expect(detailListener).toHaveBeenCalledWith({ revision: 5 });
    offDetails();
    expect(removeListener).toHaveBeenLastCalledWith(detailChannel, detailHandler);
    const projectId = crypto.randomUUID();
    for (const identity of [{ projectId, databaseEpoch: 7 }, undefined]) {
      expect(await api.poll?.(["history"], identity)).toBe("result");
      expect(invoke).toHaveBeenLastCalledWith("desktop:poll", {
        keys: ["history"],
        projectId: identity?.projectId,
        databaseEpoch: identity?.databaseEpoch,
      });
    }
    for (const [method, channel] of Object.entries(requests)) {
      expect(await api[method]?.(request)).toBe("result");
      expect(invoke).toHaveBeenLastCalledWith(`desktop:${channel}`, request);
    }
    for (const [method, channel] of Object.entries({
      connectDatabase: "database",
      openProject: "project",
      removeProject: "project-remove",
      saveConfiguration: "configuration-save",
      deleteConfiguration: "configuration-delete",
      savePromptTemplate: "prompt-save",
      saveCommand: "command-save",
      deleteCommand: "command-delete",
      resetPromptTemplate: "prompt-reset",
    })) {
      expect(await api[method]?.(request, 7)).toBe("result");
      expect(invoke).toHaveBeenLastCalledWith(`desktop:${channel}`, { request, databaseEpoch: 7 });
      await api[method]?.(request);
      expect(invoke).toHaveBeenLastCalledWith(`desktop:${channel}`, {
        request,
        databaseEpoch: undefined,
      });
    }
    for (const [method, channel] of Object.entries({
      chooseFolder: "folder",
      clearProjects: "project-clear",
    })) {
      for (const databaseEpoch of [7, undefined]) {
        expect(await api[method]?.(databaseEpoch)).toBe("result");
        expect(invoke).toHaveBeenLastCalledWith(`desktop:${channel}`, {
          request: undefined,
          databaseEpoch,
        });
      }
    }
    for (const [method, channel] of Object.entries({
      snapshot: "snapshot",
      memorySnapshot: "memory-snapshot",
      ragStatus: "rag-status",
      windowAppearance: "window-appearance",
      testOrchestrationProvider: "orchestration-test",
      cancelOrchestrationTest: "orchestration-test-cancel",
      stopAll: "stop-all",
    })) {
      await api[method]?.();
      expect(invoke).toHaveBeenLastCalledWith(`desktop:${channel}`);
    }
    for (const [method, channel] of [
      ["subscribe", "desktop:update"],
      ["onUpdate", "desktop:app-update-state"],
      ["onRagStatus", "desktop:rag-status"],
      ["onMenu", "desktop:menu"],
    ]) {
      const callback = vi.fn();
      const dispose = api[method as string]?.(callback) as () => void;
      const handler = on.mock.lastCall?.[1] as (event: unknown, value: unknown) => void;
      expect(on).toHaveBeenLastCalledWith(channel, handler);
      handler({}, "database");
      expect(callback).toHaveBeenLastCalledWith("database");
      handler({}, "open-project");
      handler({}, "untrusted-command");
      expect(callback).toHaveBeenCalledTimes(method === "onMenu" ? 2 : 3);
      dispose();
      expect(removeListener).toHaveBeenLastCalledWith(channel, handler);
    }
  });
});

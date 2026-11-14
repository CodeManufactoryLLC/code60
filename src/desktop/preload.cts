const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

// Keep this sandboxed preload self-contained; do not expose ipcRenderer or raw channels.
contextBridge.exposeInMainWorld("desktop", {
  automation: (request: unknown) => ipcRenderer.invoke("desktop:automation", request),
  onAutomationChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("desktop:automation-changed", handler);
    return () => ipcRenderer.removeListener("desktop:automation-changed", handler);
  },
  memorySnapshot: () => ipcRenderer.invoke("desktop:memory-snapshot"),
  browseMemories: (request: unknown) => ipcRenderer.invoke("desktop:memory-browse", request),
  memoryDetail: (request: unknown) => ipcRenderer.invoke("desktop:memory-detail", request),
  memoryAction: (request: unknown) => ipcRenderer.invoke("desktop:memory-action", request),
  onMemoryChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("desktop:memory-changed", handler);
    return () => ipcRenderer.removeListener("desktop:memory-changed", handler);
  },
  ragStatus: () => ipcRenderer.invoke("desktop:rag-status"),
  rebuildRag: (request: unknown) => ipcRenderer.invoke("desktop:rag-rebuild", request),
  retrieveRag: (request: unknown) => ipcRenderer.invoke("desktop:rag-retrieve", request),
  cancelRag: (requestId: unknown) => ipcRenderer.invoke("desktop:rag-cancel", requestId),
  clearRag: (request: unknown) => ipcRenderer.invoke("desktop:rag-clear", request),
  onRagStatus: (listener: (value: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("desktop:rag-status", handler);
    return () => ipcRenderer.removeListener("desktop:rag-status", handler);
  },
  openWebLink: (request: unknown) => ipcRenderer.invoke("desktop:web-link", request),
  queryLogs: (request: unknown) => ipcRenderer.invoke("desktop:logs-query", request),
  logDetail: (request: unknown) => ipcRenderer.invoke("desktop:logs-detail", request),
  clearLogs: (request: unknown) => ipcRenderer.invoke("desktop:logs-clear", request),
  onLogsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("desktop:logs-changed", handler);
    return () => ipcRenderer.removeListener("desktop:logs-changed", handler);
  },
  checkGit: (request: unknown) => ipcRenderer.invoke("desktop:git-check", request),
  beginGitSetup: (request: unknown) => ipcRenderer.invoke("desktop:git-begin", request),
  previewGitSetupFile: (request: unknown) => ipcRenderer.invoke("desktop:git-file", request),
  initializeGit: (request: unknown) => ipcRenderer.invoke("desktop:git-initialize", request),
  commitGitSetup: (request: unknown) => ipcRenderer.invoke("desktop:git-commit", request),
  cancelGitSetup: (request: unknown) => ipcRenderer.invoke("desktop:git-cancel", request),
  readPlan: (request: unknown) => ipcRenderer.invoke("desktop:plan-read", request),
  readRelayMessage: (request: unknown) => ipcRenderer.invoke("desktop:relay-message", request),
  relayReview: (request: unknown) => ipcRenderer.invoke("desktop:relay-review", request),
  planAction: (request: unknown) => ipcRenderer.invoke("desktop:plan-action", request),
  readReview: (request: unknown) => ipcRenderer.invoke("desktop:review-read", request),
  taskAction: (request: unknown) => ipcRenderer.invoke("desktop:task-action", request),
  reviewAction: (request: unknown) => ipcRenderer.invoke("desktop:review-action", request),
  captureReview: (request: unknown) => ipcRenderer.invoke("desktop:review-capture", request),
  readReviewFile: (request: unknown) => ipcRenderer.invoke("desktop:review-file", request),
  readDiff: (request: unknown) => ipcRenderer.invoke("desktop:diff-read", request),
  cancelDiff: (request: unknown) => ipcRenderer.invoke("desktop:diff-cancel", request),
  beginAgentSetup: (request: unknown) => ipcRenderer.invoke("desktop:setup-begin", request),
  attemptAgentSetup: (request: unknown) => ipcRenderer.invoke("desktop:setup-attempt", request),
  cancelAgentSetup: (request: unknown) => ipcRenderer.invoke("desktop:setup-cancel", request),
  finishAgentSetup: (request: unknown) => ipcRenderer.invoke("desktop:setup-finish", request),
  abandonAgentSetup: (request: unknown) => ipcRenderer.invoke("desktop:setup-abandon", request),
  update: (action: unknown) => ipcRenderer.invoke("desktop:app-update", action),
  onUpdate: (listener: (value: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("desktop:app-update-state", handler);
    return () => ipcRenderer.removeListener("desktop:app-update-state", handler);
  },
  summarizeSearch: (request: unknown) => ipcRenderer.invoke("desktop:search-summary", request),
  cancelSearchSummary: (requestId: unknown) =>
    ipcRenderer.invoke("desktop:search-summary-cancel", requestId),
  extractMemory: (request: unknown) => ipcRenderer.invoke("desktop:memory-extract", request),
  cancelMemoryExtraction: (requestId: unknown) =>
    ipcRenderer.invoke("desktop:memory-cancel", requestId),
  orchestrationChatAction: (request: unknown) =>
    ipcRenderer.invoke("desktop:orchestration-chat", request),
  windowAppearance: () => ipcRenderer.invoke("desktop:window-appearance"),
  setWindowTheme: (dark: unknown) => ipcRenderer.invoke("desktop:window-theme", dark),
  setTransparent: (enabled: unknown) => ipcRenderer.invoke("desktop:transparent", enabled),
  setBackgroundHitTest: (ignore: unknown) =>
    ipcRenderer.invoke("desktop:background-hit-test", ignore),
  snapshot: () => ipcRenderer.invoke("desktop:snapshot"),
  appSummary: () => ipcRenderer.invoke("desktop:snapshot-summary"),
  subscribeDetails: (request: unknown) => ipcRenderer.invoke("desktop:detail-subscribe", request),
  readDetails: (request: unknown) => ipcRenderer.invoke("desktop:detail-read", request),
  setRelayFileContext: (request: unknown) => ipcRenderer.invoke("desktop:relay-files", request),
  unsubscribeDetails: (request: unknown) =>
    ipcRenderer.invoke("desktop:detail-unsubscribe", request),
  onDetails: (listener: (frame: unknown) => void) => {
    const handler = (_event: unknown, frame: unknown) => listener(frame);
    ipcRenderer.on("desktop:detail", handler);
    return () => ipcRenderer.removeListener("desktop:detail", handler);
  },
  connectDatabase: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:database", { request, databaseEpoch }),
  chooseFolder: (databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:folder", { request: undefined, databaseEpoch }),
  openProject: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:project", { request, databaseEpoch }),
  projectAction: (request: unknown) => ipcRenderer.invoke("desktop:project-action", request),
  removeProject: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:project-remove", { request, databaseEpoch }),
  clearProjects: (databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:project-clear", { request: undefined, databaseEpoch }),
  setFileContext: (context: unknown) => ipcRenderer.invoke("desktop:files", context),
  poll: (keys: unknown, identity?: { projectId?: string; databaseEpoch?: number }) =>
    ipcRenderer.invoke("desktop:poll", {
      keys,
      projectId: identity?.projectId,
      databaseEpoch: identity?.databaseEpoch,
    }),
  setPollSettings: (settings: unknown) => ipcRenderer.invoke("desktop:poll-settings", settings),
  setPollingPaused: (paused: unknown) => ipcRenderer.invoke("desktop:poll-paused", paused),
  setVisibility: (visibility: unknown) => ipcRenderer.invoke("desktop:visibility", visibility),
  setOrchestrationProvider: (provider: unknown) =>
    ipcRenderer.invoke("desktop:orchestration-provider", provider),
  testOrchestrationProvider: () => ipcRenderer.invoke("desktop:orchestration-test"),
  cancelOrchestrationTest: () => ipcRenderer.invoke("desktop:orchestration-test-cancel"),
  start: (request: unknown) => ipcRenderer.invoke("desktop:start", request),
  saveConfiguration: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:configuration-save", { request, databaseEpoch }),
  deleteConfiguration: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:configuration-delete", { request, databaseEpoch }),
  savePromptTemplate: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:prompt-save", { request, databaseEpoch }),
  saveCommand: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:command-save", { request, databaseEpoch }),
  deleteCommand: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:command-delete", { request, databaseEpoch }),
  resetPromptTemplate: (request: unknown, databaseEpoch?: number) =>
    ipcRenderer.invoke("desktop:prompt-reset", { request, databaseEpoch }),
  action: (action: unknown) => ipcRenderer.invoke("desktop:action", action),
  stopAll: () => ipcRenderer.invoke("desktop:stop-all"),
  subscribe: (listener: (value: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("desktop:update", handler);
    return () => ipcRenderer.removeListener("desktop:update", handler);
  },
  onMenu: (listener: (command: "open-project" | "database") => void) => {
    const handler = (_event: unknown, value: unknown) => {
      if (value === "open-project" || value === "database") listener(value);
    };
    ipcRenderer.on("desktop:menu", handler);
    return () => ipcRenderer.removeListener("desktop:menu", handler);
  },
});

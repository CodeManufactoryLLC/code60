import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  shell,
} from "electron";
import updaterPackage from "electron-updater";
import {
  automationClient,
  prepareSchedulerUpdate,
  restoreSchedulerUpdate,
} from "../automation/index.js";
import {
  CODE60_COPYRIGHT,
  type MenuCommand,
  parseAction,
  parseBoolean,
  parseConfigurationId,
  parseDatabaseMode,
  parseDatabaseWrite,
  parseDeleteCommand,
  parseDetailIdentity,
  parseDetailRequest,
  parseDiffIdentity,
  parseDiffRequest,
  parseFileContext,
  parseGitProject,
  parseGitSetupCommit,
  parseGitSetupFile,
  parseGitSetupIdentity,
  parseLogClear,
  parseLogDetail,
  parseLogQuery,
  parseMemoryAction,
  parseMemoryBrowse,
  parseMemoryDetail,
  parseMemoryExtraction,
  parseMemoryRequestId,
  parseOrchestrationChatAction,
  parseOrchestrationProvider,
  parsePlanAction,
  parsePlanRead,
  parsePollRequest,
  parsePollSettings,
  parsePollVisibility,
  parseProjectAction,
  parseProjectPath,
  parsePromptTemplateId,
  parseRagCancel,
  parseRagIdentity,
  parseRagQuery,
  parseReviewAction,
  parseReviewFileRead,
  parseReviewRead,
  parseSaveCommand,
  parseSaveConfiguration,
  parseSavePromptTemplate,
  parseSearchSummary,
  parseSearchSummaryRequestId,
  parseSetupAttempt,
  parseSetupBegin,
  parseSetupSession,
  parseStart,
  parseTaskAction,
  parseUpdateAction,
} from "../bridge/index.js";
import { defaultDeps, stateHome } from "../core/index.js";
import { diagnosticMessage, setEnvironmentPath } from "../platform/index.js";
import { installAppImage } from "./appimage-update.js";
import { DesktopAutomations } from "./automations.js";
import { DesktopController } from "./controller.js";
import { installDeb } from "./deb-update.js";
import { desktopPath } from "./environment.js";
import { DesktopLogStore, logProjectId } from "./log-store.js";
import { filePreferences } from "./preferences.js";
import { openProjectDatabase } from "./projects.js";
import { DesktopUpdates } from "./updates.js";
import { WebLinks } from "./web-links.js";

const here = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(join(here, "../renderer/index.html")).href;
let window: BrowserWindow | undefined;
let exiting = false;
let quitPending = false;
const startup = new AbortController();
let updates: DesktopUpdates | undefined;
const webLinks = new WebLinks({
  async confirm(url) {
    const result = await dialog.showMessageBox({
      type: "question",
      title: "Open web link?",
      message: "Open this address in your default browser?",
      detail: url,
      buttons: ["Cancel", "Open link"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1 && !exiting && !!window && !window.isDestroyed();
  },
  open: (url) => shell.openExternal(url),
});
const databaseFilters = [{ name: "SQLite database", extensions: ["sqlite", "sqlite3", "db"] }];
const preferences = filePreferences(join(stateHome(process.env), "code60", "desktop.json"));
const logs = new DesktopLogStore(join(stateHome(process.env), "code60", "logs"));
const launchOperation = randomUUID();
logs.sink({ event: "app.start", operationId: launchOperation, outcome: "started" });
logs.subscribe(() => {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send("desktop:logs-changed");
});
const windowControlColors = (dark: boolean) => ({
  color: dark ? "#0f172a" : "#ffffff",
  symbolColor: dark ? "#ffffff" : "#000000",
});
const controller = new DesktopController(
  defaultDeps(logs.sink),
  process.env,
  {
    async confirm(title, detail) {
      const result = await dialog.showMessageBox({
        type: "warning",
        title,
        message: title,
        detail,
        buttons: ["Cancel", "Confirm"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
  },
  {
    openDatabase: openProjectDatabase,
    relay: true,
    memory: true,
    ragModelRoot: app.isPackaged
      ? join(process.resourcesPath, "models")
      : fileURLToPath(new URL("../../models/", import.meta.url)),
    preferences,
    refreshPath: async (signal) => {
      setEnvironmentPath(process.env, await desktopPath({ signal }));
    },
  },
);
controller.rag.subscribe((status) => {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send("desktop:rag-status", status);
});
controller.memory.subscribe(() => {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send("desktop:memory-changed");
});
const automations = new DesktopAutomations(
  process.env,
  {
    async pick() {
      const selected = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose automation repository",
      });
      return selected.canceled ? null : (selected.filePaths[0] ?? null);
    },
    async confirm(title, detail) {
      const result = await dialog.showMessageBox({
        type: "warning",
        message: title,
        detail,
        buttons: ["Cancel", "Confirm"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1 && !exiting;
    },
  },
  () => {
    if (window && !window.isDestroyed()) window.webContents.send("desktop:automation-changed");
  },
  () => controller.snapshot(false, true).agents,
);
let shutdownTask: Promise<void> | undefined;
function shutdownDesktop(force = false): Promise<void> {
  automations.reset();
  if (shutdownTask) {
    if (force) void controller.shutdown(true).catch(() => {});
    return shutdownTask;
  }
  logs.sink({ event: "app.stop", operationId: launchOperation, outcome: "started" });
  shutdownTask = controller
    .shutdown(force)
    .then(async () => {
      logs.sink({ event: "app.stopped", operationId: launchOperation, outcome: "succeeded" });
      await logs.close();
    })
    .catch((error: unknown) => {
      shutdownTask = undefined;
      logs.sink({
        event: "app.stopped",
        operationId: launchOperation,
        outcome: "failed",
        errorCategory: "process",
      });
      throw error;
    });
  return shutdownTask;
}

async function quit(confirm: boolean): Promise<void> {
  if (quitPending) return;
  quitPending = true;
  try {
    const background = confirm
      ? await automationClient(process.env)({ action: "status" }).catch(() => null)
      : null;
    if (confirm && (controller.hasActiveWork || background)) {
      const result = await dialog.showMessageBox({
        type: "warning",
        message: "Quit Code60?",
        detail:
          "Desktop-owned turns will be cancelled and idle sessions finished. Background automations keep running while Code60 is quit. Worktrees are kept. Use Automations to pause or cancel background work.",
        buttons: ["Keep working", "Quit"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return;
    }
    startup.abort();
    updates?.close();
    await shutdownDesktop();
    exiting = true;
    app.quit();
  } catch {
    await dialog.showMessageBox({
      type: "error",
      message: "Could not stop all agents. Try quitting again.",
    });
  } finally {
    quitPending = false;
  }
}

function trusted(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== page
  )
    throw new Error("Untrusted desktop request");
}

function handle(channel: string, action: (value: unknown) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    trusted(event);
    if (args.length > 1) throw new Error("Invalid request");
    if (channel !== "desktop:app-update" && updates?.snapshot().status === "installing")
      throw new Error("An update is being installed");
    try {
      return await action(args[0]);
    } catch (error) {
      throw new Error(diagnosticMessage(error));
    }
  });
}

function menu(command: MenuCommand): void {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.webContents.send("desktop:menu", command);
}

function applicationMenu(): Menu {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    // macOS shows the running bundle's name as the bold menu title; unpackaged, that is "Electron".
    mac
      ? { id: "app", label: "Code60", role: "appMenu" }
      : {
          id: "app",
          label: "Code60",
          submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
        },
    {
      label: "File",
      submenu: [
        {
          id: "open-project",
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          enabled: false,
          click: () => menu("open-project"),
        },
        ...(mac ? [{ type: "separator" as const }, { role: "close" as const }] : []),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(mac ? [{ role: "pasteAndMatchStyle" as const }] : []),
        { role: "delete" },
        { role: "selectAll" },
        { type: "separator" },
        { id: "database", label: "Database Connection…", click: () => menu("database") },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

app.setName("Code60");
app.setAboutPanelOptions({
  applicationName: "Code60",
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
  copyright: CODE60_COPYRIGHT,
});
app.on("before-quit", (event) => {
  if (exiting) return;
  event.preventDefault();
  void quit(true);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (quitPending) void shutdownDesktop(true).catch(() => {});
    else void quit(false);
  });
}

// Avoid top-level await here: Electron automation attaches only after the main module finishes loading.
async function ready(): Promise<void> {
  // Some AppImage launchers fall back to --no-sandbox when user namespaces fail.
  // Never let a distribution wrapper weaken the renderer's security contract.
  if (app.commandLine.hasSwitch("no-sandbox")) {
    process.stderr.write(
      "Code60 requires the Chromium sandbox. Enable user namespaces or install the DEB package; do not use --no-sandbox.\n",
    );
    app.exit(1);
    return;
  }
  setEnvironmentPath(process.env, await desktopPath({ signal: startup.signal }));
  if (startup.signal.aborted) return;
  await restoreSchedulerUpdate(process.env).catch(async () => {
    await dialog.showMessageBox({
      type: "error",
      message: "Background automations could not restart after the update.",
      detail:
        "Open Automations to repair the background service. Your schedules and run evidence are kept.",
      buttons: ["Continue"],
    });
  });
  const transparent = await preferences.transparent();
  let enabled = transparent;
  const clickThrough = transparent && process.platform === "darwin";
  Menu.setApplicationMenu(applicationMenu());
  const supported =
    (process.platform === "darwin" && process.arch === "arm64") ||
    ((process.platform === "linux" || process.platform === "win32") && process.arch === "x64");
  updates = new DesktopUpdates(
    app.isPackaged && supported ? updaterPackage.autoUpdater : null,
    (state) => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("desktop:app-update-state", state);
    },
    async () => {
      if (quitPending) return false;
      quitPending = true;
      try {
        const result = await dialog.showMessageBox({
          type: "warning",
          message: "Install update and restart Code60?",
          detail:
            "Active turns will be cancelled and all agents stopped. Worktrees, settings and databases are kept. Linux DEB updates may ask for administrator authorization.",
          buttons: ["Keep working", "Install and restart"],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) return false;
        return true;
      } finally {
        quitPending = false;
      }
    },
    async (file) => {
      quitPending = true;
      try {
        await prepareSchedulerUpdate(process.env);
        startup.abort();
        await shutdownDesktop();
        exiting = true;
        if (process.platform === "linux") {
          if (file.endsWith(".deb")) await installDeb(file);
          else if (file.endsWith(".AppImage") && process.env.APPIMAGE)
            await installAppImage(file, process.env.APPIMAGE);
          else throw new Error("Unsupported Linux installer");
          app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : {});
          app.quit();
        } else updaterPackage.autoUpdater.quitAndInstall(false, true);
      } catch {
        await dialog.showMessageBox({
          type: "error",
          message: "The update could not be installed.",
          detail:
            "Restart Code60 and try again. Check installation permissions (DEB updates need a working PolicyKit authorization agent). Your data is kept.",
          buttons: ["Close Code60"],
        });
        // Shutdown may have only partly succeeded; never leave agents behind.
        await shutdownDesktop(true);
        exiting = true;
        app.quit();
      } finally {
        quitPending = false;
      }
    },
    {
      autoCheck: await preferences.updateCheck(),
      saveAutoCheck: (enabled) => preferences.setUpdateCheck(enabled),
    },
  );
  if (app.isPackaged && supported)
    updaterPackage.autoUpdater.on("error", () => {
      if (!exiting) return;
      void dialog
        .showMessageBox({
          type: "error",
          message: "The update could not be installed.",
          detail: "Code60 will close. Restart it and try updating again. Your data is kept.",
        })
        .finally(() => app.quit());
    });
  handle("desktop:app-update", (value) => updates?.action(parseUpdateAction(value)));
  handle("desktop:automation", (value) => automations.request(value));
  handle("desktop:window-appearance", (value) => {
    if (value !== undefined) throw new Error("Invalid request");
    return { transparent, enabled, clickThrough };
  });
  handle("desktop:window-theme", (value) => {
    const dark = parseBoolean(value);
    if (process.platform === "win32" && window && !window.isDestroyed())
      window.setTitleBarOverlay({ height: 28, ...windowControlColors(dark) });
  });
  handle("desktop:transparent", async (value) => {
    const next = parseBoolean(value);
    await preferences.setTransparent(next);
    enabled = next;
  });
  handle("desktop:background-hit-test", (value) => {
    const ignore = parseBoolean(value);
    if (clickThrough) window?.setIgnoreMouseEvents(ignore, { forward: true });
  });
  handle("desktop:logs-query", (value) => {
    const query = parseLogQuery(value);
    const directory = controller.snapshot().directory;
    return logs.query(
      query.scope === "current"
        ? {
            ...query,
            projectId: directory ? logProjectId(directory) : "0000000000000000",
          }
        : query,
    );
  });
  handle("desktop:logs-detail", (value) => logs.detail(parseLogDetail(value).id));
  handle("desktop:logs-clear", async (value) => {
    parseLogClear(value);
    const confirmation = await dialog.showMessageBox({
      type: "warning",
      title: "Clear logs?",
      message: "Clear all retained diagnostic logs?",
      detail:
        "This affects local diagnostic logs only, across all projects and app launches. Events, transcripts, run records and databases are kept.",
      buttons: ["Cancel", "Clear logs"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return false;
    await logs.clear();
    return true;
  });
  handle("desktop:snapshot", () => controller.snapshot());
  handle("desktop:snapshot-summary", () => controller.snapshot(true, true));
  handle("desktop:detail-subscribe", (value) => {
    controller.subscribeDetails(parseDetailRequest(value), (frame) => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("desktop:detail", frame);
    });
  });
  handle("desktop:detail-read", (value) => controller.readDetails(parseDetailRequest(value)));
  handle("desktop:relay-files", (value) => controller.setRelayFileContext(value));
  handle("desktop:detail-unsubscribe", (value) =>
    controller.unsubscribeDetails(parseDetailIdentity(value)),
  );
  handle("desktop:web-link", (value) => webLinks.open(value));
  handle("desktop:database", async (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    const mode = parseDatabaseMode(request);
    const epoch = controller.assertDatabaseRequest(databaseEpoch);
    const path =
      mode === "create"
        ? (
            await dialog.showSaveDialog({
              title: "Create database",
              defaultPath: "code60.sqlite",
              filters: databaseFilters,
              properties: ["createDirectory", "showOverwriteConfirmation"],
            })
          ).filePath
        : (
            await dialog.showOpenDialog({
              title: "Open database",
              properties: ["openFile"],
              filters: databaseFilters,
            })
          ).filePaths[0];
    controller.assertDatabaseRequest(epoch);
    if (!path) return false;
    await controller.connect(path, mode === "create", epoch);
    return true;
  });
  handle("desktop:folder", async (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    if (request !== undefined) throw new Error("Invalid request");
    const epoch = controller.assertDatabaseRequest(databaseEpoch);
    if (!controller.connected) throw new Error("Connect to a database first");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Open project",
    });
    controller.assertDatabaseRequest(epoch);
    if (result.canceled || !result.filePaths[0]) return false;
    if (!window || window.isDestroyed()) return false;
    const confirmation = await dialog.showMessageBox(window, {
      type: "question",
      title: "Open project?",
      message: "Open this project?",
      detail: result.filePaths[0],
      buttons: ["Cancel", "Open project"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    controller.assertDatabaseRequest(epoch);
    if (confirmation.response !== 1) return false;
    await controller.open(result.filePaths[0], epoch);
    return true;
  });
  handle("desktop:project", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    return controller.openProject(parseProjectPath(request), databaseEpoch);
  });
  handle("desktop:project-action", (value) => controller.projectAction(parseProjectAction(value)));
  handle("desktop:project-remove", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    return controller.removeProject(parseProjectPath(request), databaseEpoch);
  });
  handle("desktop:project-clear", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    if (request !== undefined) throw new Error("Invalid request");
    return controller.clearProjects(databaseEpoch);
  });
  handle("desktop:files", (value) => controller.setFileContext(parseFileContext(value)));
  handle("desktop:poll", (value) => {
    const { keys, ...identity } = parsePollRequest(value);
    return controller.poll(keys, identity);
  });
  handle("desktop:poll-settings", (value) => controller.setPollSettings(parsePollSettings(value)));
  handle("desktop:poll-paused", (value) => controller.setPollingPaused(parseBoolean(value)));
  handle("desktop:visibility", (value) => controller.setVisibility(parsePollVisibility(value)));
  handle("desktop:orchestration-chat", (value) =>
    controller.orchestrationChatAction(parseOrchestrationChatAction(value)),
  );
  handle("desktop:setup-begin", (value) => controller.beginAgentSetup(parseSetupBegin(value)));
  handle("desktop:setup-attempt", (value) =>
    controller.attemptAgentSetup(parseSetupAttempt(value)),
  );
  handle("desktop:setup-cancel", (value) => controller.cancelAgentSetup(parseSetupSession(value)));
  handle("desktop:setup-finish", (value) => controller.finishAgentSetup(parseSetupSession(value)));
  handle("desktop:setup-abandon", (value) =>
    controller.abandonAgentSetup(parseSetupSession(value)),
  );
  handle("desktop:orchestration-provider", (value) =>
    controller.setOrchestrationProvider(parseOrchestrationProvider(value)),
  );
  handle("desktop:orchestration-test", (value) => {
    if (value !== undefined) throw new Error("Invalid request");
    return controller.testOrchestrationProvider();
  });
  handle("desktop:orchestration-test-cancel", (value) => {
    if (value !== undefined) throw new Error("Invalid request");
    return controller.cancelOrchestrationTest();
  });
  handle("desktop:memory-extract", (value) =>
    controller.extractMemory(parseMemoryExtraction(value)),
  );
  handle("desktop:rag-status", (value) => {
    if (value !== undefined) throw new Error("Invalid request");
    return controller.rag.status();
  });
  handle("desktop:memory-snapshot", (value) => {
    if (value !== undefined) throw new Error("Invalid request");
    return controller.memory.snapshot();
  });
  handle("desktop:memory-browse", (value) => controller.memory.browse(parseMemoryBrowse(value)));
  handle("desktop:memory-detail", (value) => controller.memory.detail(parseMemoryDetail(value).id));
  handle("desktop:memory-action", (value) =>
    controller.memory.action(parseMemoryAction(value), async (title, detail) => {
      const result = await dialog.showMessageBox({
        type: "warning",
        title,
        message: title,
        detail,
        buttons: ["Cancel", "Confirm"],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    }),
  );
  handle("desktop:rag-rebuild", (value) => controller.rebuildRag(parseRagIdentity(value)));
  handle("desktop:rag-retrieve", (value) => controller.retrieveRag(parseRagQuery(value)));
  handle("desktop:rag-cancel", (value) => controller.cancelRag(parseRagCancel(value)));
  handle("desktop:rag-clear", (value) => controller.clearRag(parseRagIdentity(value)));
  handle("desktop:search-summary", (value) =>
    controller.summarizeSearch(parseSearchSummary(value)),
  );
  handle("desktop:search-summary-cancel", (value) =>
    controller.cancelSearchSummary(parseSearchSummaryRequestId(value)),
  );
  handle("desktop:memory-cancel", (value) =>
    controller.cancelMemoryExtraction(parseMemoryRequestId(value)),
  );
  handle("desktop:start", (value) => controller.start(parseStart(value)));
  handle("desktop:configuration-save", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    return controller.saveConfiguration(parseSaveConfiguration(request), databaseEpoch);
  });
  handle("desktop:configuration-delete", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    return controller.deleteConfiguration(parseConfigurationId(request), databaseEpoch);
  });
  handle("desktop:prompt-save", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    return controller.savePromptTemplate(parseSavePromptTemplate(request), databaseEpoch);
  });
  handle("desktop:command-save", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    return controller.saveCommand(parseSaveCommand(request), databaseEpoch);
  });
  handle("desktop:command-delete", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    return controller.deleteCommand(parseDeleteCommand(request), databaseEpoch);
  });
  handle("desktop:prompt-reset", (value) => {
    const { request, databaseEpoch } = parseDatabaseWrite(value);
    return controller.resetPromptTemplate(parsePromptTemplateId(request), databaseEpoch);
  });
  handle("desktop:git-check", (value) => controller.checkGit(parseGitProject(value)));
  handle("desktop:git-begin", (value) => controller.beginGitSetup(parseGitProject(value)));
  handle("desktop:git-file", (value) => controller.previewGitSetupFile(parseGitSetupFile(value)));
  handle("desktop:git-initialize", (value) =>
    controller.initializeGit(parseGitSetupIdentity(value)),
  );
  handle("desktop:git-commit", (value) => controller.commitGitSetup(parseGitSetupCommit(value)));
  handle("desktop:git-cancel", (value) => controller.cancelGitSetup(parseGitProject(value)));
  handle("desktop:diff-read", (value) => controller.readDiff(parseDiffRequest(value)));
  handle("desktop:plan-read", (value) => controller.readPlan(parsePlanRead(value)));
  handle("desktop:relay-message", (value) => controller.readRelayMessage(value));
  handle("desktop:relay-review", (value) => controller.relayReview(value));
  handle("desktop:plan-action", (value) => controller.planAction(parsePlanAction(value)));
  handle("desktop:task-action", (value) => controller.taskAction(parseTaskAction(value)));
  handle("desktop:review-action", (value) => controller.reviewAction(parseReviewAction(value)));
  handle("desktop:review-read", (value) => controller.readReview(parseReviewRead(value)));
  handle("desktop:review-capture", (value) => controller.captureReview(parseReviewRead(value)));
  handle("desktop:review-file", (value) => controller.readReviewFile(parseReviewFileRead(value)));
  handle("desktop:diff-cancel", (value) => controller.cancelDiff(parseDiffIdentity(value)));
  handle("desktop:action", (value) => controller.action(parseAction(value)));
  handle("desktop:stop-all", async () => {
    const result = await dialog.showMessageBox({
      type: "warning",
      message: "Stop all runs?",
      detail: "Active turns will be cancelled and idle sessions finished. Worktrees are kept.",
      buttons: ["Keep working", "Stop all"],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) await controller.stopAll();
  });
  void controller.restore();
  controller.subscribe((snapshot) => {
    // Mirrors the renderer's rule for opening projects: a database is connected and no batch is active.
    const openProject = Menu.getApplicationMenu()?.getMenuItemById("open-project");
    if (openProject) openProject.enabled = snapshot.database !== null;
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send("desktop:update", snapshot);
  }, true);

  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    title: `Code60 - ${app.getVersion()}`,
    transparent,
    backgroundColor: transparent ? "#00000000" : "#0f172a",
    hasShadow: !transparent,
    // The window controls sit over the renderer's dedicated drag strip.
    titleBarStyle: "hidden",
    titleBarOverlay: {
      height: 28,
      ...(process.platform === "win32" ? windowControlColors(nativeTheme.shouldUseDarkColors) : {}),
    },
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 7 } } : {}),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Keep the versioned title instead of the page's <title>.
  window.on("page-title-updated", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== page) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", () => void quit(false));
  window.webContents.on("did-start-loading", () => {
    automations.reset();
    controller.clearDetailSubscriptions();
    void controller.cancelRag().catch(() => {});
    void controller.cancelDiffReads().catch(() => {});
    void controller.cancelGitSetup().catch(() => {});
    void controller.cancelAgentSetup().catch(() => {});
    void controller.cancelSearchSummary().catch(() => {});
    window?.setIgnoreMouseEvents(false);
    controller.setVisibility({ visible: false, worktrees: false });
  });
  window.on("close", (event) => {
    if (exiting) return;
    event.preventDefault();
    void quit(true);
  });
  if (process.platform === "win32") {
    window.on("query-session-end", () => {
      startup.abort();
      // Do not veto sign-out. The owned jobs also close if Windows terminates us
      // before these best-effort final record writes finish.
      void shutdownDesktop(true).catch(() => {});
    });
    window.on("session-end", () => {
      startup.abort();
      void shutdownDesktop(true).catch(() => {});
    });
  }
  logs.sink({ event: "app.ready", operationId: launchOperation, outcome: "succeeded" });
  window.loadURL(page).catch(() => void quit(false));
}

app
  .whenReady()
  .then(ready)
  .catch(async () => {
    logs.sink({
      event: "app.ready",
      operationId: launchOperation,
      outcome: "failed",
      errorCategory: "unknown",
    });
    await shutdownDesktop(true).catch(() => {});
    app.exit(1);
  });

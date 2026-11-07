import type { Rectangle } from "@glideapps/glide-data-grid";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  Action,
  DatabaseMode,
  DesktopApi,
  DesktopRun,
  MenuCommand,
  ProjectEntry,
  RunConfiguration,
  Snapshot,
  StartRequest,
} from "../bridge/index.js";
import { CODE60_COPYRIGHT, type Versions } from "../bridge/index.js";
import { ChatDock, type OpenChat } from "./chat-dock.js";
import { ChatPage } from "./chat-page.js";
import { newestMessage } from "./chat-presentation.js";
import { agentCount, ConfigurationsTable, providers } from "./configurations.js";
import { EpisodicMemoryPage } from "./episodic-memory.js";
import { EventsPage } from "./events.js";
import { prepareFileNavigation } from "./file-navigation.js";
import { FileInspector, FilesPage, useFiles } from "./files.js";
import { Icon, type IconName } from "./icons.js";
import { MessagesPage } from "./messages.js";
import { OrchestrationSettings } from "./orchestration-settings.js";
import {
  type Command,
  CommandPalette,
  maxToasts,
  type ToastMessage,
  Toasts,
  type ToastTone,
  Tooltips,
} from "./overlays.js";
import { PageTabBar } from "./page-tabs.js";
import { pathLabel } from "./path-label.js";
import { PollingControls, PollingPage, PollingWidget, labels as pollLabels } from "./polling.js";
import { PromptEditorPage } from "./prompt-editor.js";
import { continueBlocker } from "./recovery.js";
import { SearchPage } from "./search-page.js";
import { SessionsTable } from "./sessions.js";
import {
  applyUpdate,
  type DesktopState,
  defaultTextStyles,
  fontSizes,
  fontWeights,
  hasOrchestrationProvider,
  migrateAppearance,
  migrateTypography,
  parseFitColumns,
  parseRowDensity,
  parseTableLines,
  parseTextStyles,
  parseTheme,
  parseTypeface,
  type RowDensity,
  resolveText,
  rowDensities,
  sessionRows,
  type TableLines,
  type TextStyle,
  type TextStyles,
  type Theme,
  textRoles,
  textStyleProperties,
  typefaces,
} from "./state.js";
import { initialTabs, updateTabs } from "./tabs.js";
import { parseChartTick } from "./ticker.js";
import { useTranscripts } from "./transcripts.js";
import { WorktreesPage } from "./worktrees.js";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-serif/400.css";
import "@fontsource/ibm-plex-serif/500.css";
import "@fontsource/ibm-plex-serif/600.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/600.css";
import "./fonts.css";
import "./style.css";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

migrateAppearance(localStorage);
migrateTypography(localStorage);
const api = window.desktop;
const kinds = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
];
const activeStatuses = new Set(["queued", "running", "waiting", "idle"]);
const statusOf = (run: DesktopRun) => run.view?.status ?? run.record.status;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const folderName = pathLabel;
const hasWorktree = (run: DesktopRun) => run.record.base !== null && !run.record.discardedAt;

function App() {
  const [state, setState] = useState<DesktopState>();
  const [error, setError] = useState("");
  const [transparent, setTransparent] = useState<boolean>();
  const [savingAppearance, setSavingAppearance] = useState(false);
  useEffect(() => {
    let mounted = true;
    let cleanup = () => {};
    void api
      .windowAppearance()
      .then((appearance) => {
        if (!mounted) return;
        setTransparent(appearance.enabled);
        document.documentElement.dataset.transparent = String(appearance.transparent);
        if (!appearance.clickThrough) return;
        let ignored = false;
        const hitTest = (event: MouseEvent) => {
          // Native traffic lights must remain clickable.
          const nativeControls = event.clientY < 28 && event.clientX < 80;
          const element = document.elementFromPoint(event.clientX, event.clientY);
          const content = element?.closest(
            ".app-footer, .sidebar, .chat-sidebar, .file-inspector, .page-panel, .page-tab, .splash, dialog[open], .actions-menu, .app-toast, .command-palette",
          );
          const next = !nativeControls && !content && !document.querySelector("dialog[open]");
          if (ignored === next) return;
          ignored = next;
          void api.setBackgroundHitTest(next).catch((cause) => setError(message(cause)));
        };
        // Electron forwards mousemove (not pointermove) while the window ignores mouse events.
        window.addEventListener("mousemove", hitTest);
        cleanup = () => {
          window.removeEventListener("mousemove", hitTest);
          void api.setBackgroundHitTest(false).catch(() => {});
        };
      })
      .catch((cause) => {
        if (mounted) setError(message(cause));
      });
    return () => {
      mounted = false;
      cleanup();
    };
  }, []);
  const saveTransparent = async (enabled: boolean) => {
    const previous = transparent;
    setTransparent(enabled);
    setSavingAppearance(true);
    try {
      await api.setTransparent(enabled);
    } catch (cause) {
      setTransparent(previous);
      setError(message(cause));
    } finally {
      setSavingAppearance(false);
    }
  };
  const [palette, setPalette] = useState(false);
  const [notifications, setNotifications] = useState<ToastMessage[]>([]);
  const notificationId = useRef(0);
  const notify = (text: string, tone: ToastTone = "success", action?: ToastMessage["action"]) =>
    setNotifications((current) => [
      ...current.slice(-(maxToasts - 1)),
      { id: ++notificationId.current, text, tone, action },
    ]);
  const dismissNotification = useCallback(
    (id: number) => setNotifications((current) => current.filter((item) => item.id !== id)),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [setup, setSetup] = useState(false);
  const [configurationEditor, setConfigurationEditor] = useState<RunConfiguration | "new">();
  const [selectedConfiguration, setSelectedConfiguration] = useState<string>();
  const [configurationMenu, setConfigurationMenu] = useState<{ id: string; bounds: Rectangle }>();
  const [worktreeMenu, setWorktreeMenu] = useState<{
    id: string;
    bounds: Rectangle;
    workspace: string;
  }>();
  const [pollMenu, setPollMenu] = useState<{ id: string; bounds: Rectangle }>();
  const [confirmation, setConfirmation] = useState<{ launchId: string; count: number }>();
  const [chatRequest, setChatRequest] = useState<OpenChat>();
  const openChat = (id: string, compose = false, eventIndex?: number) =>
    setChatRequest((current) => ({
      id,
      serial: (current?.serial ?? 0) + 1,
      compose,
      ...(eventIndex === undefined ? {} : { eventIndex }),
    }));
  const [changes, setChanges] = useState<string>();
  const [menu, setMenu] = useState<{
    id: string;
    bounds: Rectangle;
    contextual?: boolean | undefined;
  }>();
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => parseTheme(localStorage.getItem("code60.theme")));
  const [textStyles, setTextStyles] = useState<TextStyles>(() =>
    parseTextStyles(localStorage.getItem("code60.textStyles")),
  );
  const [focusHighlight, setFocusHighlight] = useState(
    () => localStorage.getItem("code60.focusHighlight") === "on",
  );
  const [signals, setSignals] = useState(() => localStorage.getItem("code60.signals") === "on");
  const [charts, setCharts] = useState(() => localStorage.getItem("code60.gridCharts") !== "off");
  const [lines, setLines] = useState<TableLines>(() =>
    parseTableLines(localStorage.getItem("code60.tableLines")),
  );
  const [fit, setFit] = useState(() => parseFitColumns(localStorage.getItem("code60.fitColumns")));
  const [density, setDensity] = useState<RowDensity>(() =>
    parseRowDensity(localStorage.getItem("code60.rowDensity")),
  );
  const [tabs, setTabs] = useState(initialTabs);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [chartTickMs, setChartTickMs] = useState(() =>
    parseChartTick(localStorage.getItem("code60.chartTickMs")),
  );
  useEffect(() => {
    localStorage.setItem("code60.chartTickMs", String(chartTickMs));
  }, [chartTickMs]);
  // Reloads can skip the splash only after the saved provider has been checked.
  const [splash, setSplash] = useState(true);
  const startupChecked = useRef(false);
  const [splashReady, setSplashReady] = useState(false);
  useEffect(() => {
    if (!splash) return;
    let cancelled = false;
    // Wait for the face so the wordmark never flashes in a fallback font.
    void document.fonts
      .load('400 64px "D-DIN"')
      .catch(() => [])
      .then(() => {
        if (!cancelled) setSplashReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [splash]);
  const [picker, setPicker] = useState<"database" | "project">();
  const snapshot = state?.snapshot;
  const orchestratorConfigured = hasOrchestrationProvider(snapshot);
  useEffect(() => {
    if (!snapshot || startupChecked.current) return;
    startupChecked.current = true;
    if (orchestratorConfigured && sessionStorage.getItem("code60.splashShown")) setSplash(false);
  }, [snapshot, orchestratorConfigured]);
  const database = snapshot?.database ?? null;
  const directory = snapshot?.directory;
  const workspace = `${database}:${directory}`;
  const fileBrowser = useFiles(api, snapshot, !splash && tabs.active === "chat" && explorerOpen);
  const transcripts = useTranscripts(
    api,
    workspace,
    !!directory && !splash,
    snapshot?.runs,
    snapshot?.liveIds,
    state?.events,
  );
  useEffect(() => {
    const visibility = () => {
      void api
        .setVisibility({
          visible: !document.hidden && !splash,
          worktrees: tabs.active === "worktrees",
          files: tabs.active === "chat" && explorerOpen,
        })
        .catch((cause) => setError(message(cause)));
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [tabs.active, splash, explorerOpen]);
  const loaded = snapshot !== undefined || error !== "";
  // With a connected database and no open project, the splash offers the most recent project.
  const lastProject = database && !directory ? snapshot?.projects[0] : undefined;
  useEffect(() => {
    if (splash && directory && orchestratorConfigured) {
      sessionStorage.setItem("code60.splashShown", "1");
      setSplash(false);
    }
  }, [splash, directory, orchestratorConfigured]);
  const run = snapshot?.runs.find((item) => item.record.id === selected);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("code60.theme", theme);
  }, [theme]);

  useEffect(() => {
    for (const [key, value] of Object.entries(textStyleProperties(textStyles))) {
      if (value === undefined) document.documentElement.style.removeProperty(key);
      else document.documentElement.style.setProperty(key, value);
    }
    localStorage.setItem("code60.textStyles", JSON.stringify(textStyles));
  }, [textStyles]);

  useEffect(() => {
    document.documentElement.dataset.focusHighlight = focusHighlight ? "on" : "off";
    localStorage.setItem("code60.focusHighlight", focusHighlight ? "on" : "off");
  }, [focusHighlight]);

  useEffect(() => {
    document.documentElement.dataset.signals = signals ? "on" : "off";
    localStorage.setItem("code60.signals", signals ? "on" : "off");
  }, [signals]);

  useEffect(() => {
    localStorage.setItem("code60.gridCharts", charts ? "on" : "off");
  }, [charts]);

  useEffect(() => {
    localStorage.setItem("code60.tableLines", JSON.stringify(lines));
  }, [lines]);

  useEffect(() => {
    localStorage.setItem("code60.rowDensity", density);
  }, [density]);

  useEffect(() => {
    localStorage.setItem("code60.fitColumns", String(fit));
  }, [fit]);

  useEffect(
    () =>
      api.onMenu((command: MenuCommand) => {
        setError("");
        setPicker(command === "database" ? "database" : "project");
      }),
    [],
  );

  useLayoutEffect(() => {
    // Finish navigation focus before another interaction can focus a control or open a modal.
    if (!splash) document.getElementById(`tab-${tabs.active}`)?.focus();
  }, [tabs.active, splash]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Dialogs keep their own state, so the shortcut waits until none is open.
      if (splash || document.querySelector("dialog[open]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMenu(undefined);
        setWorktreeMenu(undefined);
        setPalette(true);
      } else if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setMenu(undefined);
        setWorktreeMenu(undefined);
        setTabs((current) => updateTabs(current, { type: "open", id: "settings" }));
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [splash]);

  useEffect(() => {
    let mounted = true;
    let initialized = false;
    const buffered: Snapshot[] = [];
    const off = api.subscribe((update) => {
      if (!initialized) buffered.push(update);
      else if (mounted) setState((current) => applyUpdate(current, update));
    });
    void api
      .snapshot()
      .then((initial) => {
        if (!mounted) return;
        let next = applyUpdate(undefined, initial);
        for (const update of buffered) next = applyUpdate(next, update);
        initialized = true;
        setState(next);
      })
      .catch((cause) => {
        if (mounted) setError(message(cause));
      });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    if (!snapshot.runs.some((item) => item.record.id === selected)) {
      const live = snapshot.liveIds[0];
      setSelected(live ?? snapshot.runs.at(-1)?.record.id);
    }
  }, [snapshot, selected]);

  useEffect(() => {
    let cancelled = false;
    setDiff("");
    if (!changes || !directory) return;
    setDiffLoading(true);
    void api
      .action({ type: "diff", id: changes })
      .then((result) => {
        if (!cancelled && typeof result === "string") setDiff(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, changes]);
  async function attempt(operation: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await operation();
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const browseFiles = async () => {
    if (!snapshot) return;
    setBusy(true);
    try {
      const latest = await prepareFileNavigation(api, snapshot);
      if (!latest) return;
      setState((current) => applyUpdate(current, latest));
      fileBrowser.selectRoot();
      setExplorerOpen(true);
      setTabs((current) => updateTabs(current, { type: "select", id: "chat" }));
    } catch (cause) {
      notify(message(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const act = (action: Action) => attempt(() => api.action(action));
  // Sending a message from the chat resumes the run, so Resume only opens it ready to type.
  const resume = (id: string) => {
    setSelected(id);
    openChat(id, true);
  };
  const showPicker = (kind: "database" | "project") => {
    setError("");
    setPicker(kind);
  };
  const connectDatabase = (mode: DatabaseMode) =>
    void attempt(async () => {
      if (await api.connectDatabase(mode))
        setPicker((current) => (current === "database" ? undefined : current));
    });
  const projectOpened = async () => {
    const latest = await api.snapshot();
    setState((current) => applyUpdate(current, latest));
    setPicker(undefined);
    if (latest.directory) notify(`Opened ${folderName(latest.directory)}.`);
  };
  const rows = useMemo(() => sessionRows(snapshot?.runs ?? []), [snapshot?.runs]);
  const changesRun = snapshot?.runs.find((item) => item.record.id === changes);
  const menuRun = snapshot?.runs.find((item) => item.record.id === menu?.id);
  const menuConfiguration = snapshot?.configurations.find(
    (entry) => entry.id === configurationMenu?.id,
  );
  const menuWorktree =
    worktreeMenu?.workspace === workspace
      ? snapshot?.worktrees?.worktrees.find((entry) => entry.path === worktreeMenu.id)
      : undefined;
  const menuSource = snapshot?.polling.sources.find((source) => source.key === pollMenu?.id);
  const unless = (blocked: boolean, reason: string) => (blocked ? reason : undefined);
  const sessionCommands = (target: DesktopRun): Command[] => {
    const status = statusOf(target);
    const view = target.view;
    const waitBusy = "Wait for the current action to finish";
    const reasons = {
      browse: busy ? waitBusy : unless(!directory, "Open a project to browse files"),
      review: busy
        ? waitBusy
        : unless(!hasWorktree(target), "This run has no worktree, so there is no diff"),
      cancel: busy
        ? waitBusy
        : unless(
            !view || !["running", "waiting"].includes(status) || view.stopping,
            "Available while the agent is working on a turn",
          ),
      finish: busy
        ? waitBusy
        : unless(
            !view || status !== "idle" || view.stopping,
            "Available when the agent is ready for a prompt",
          ),
      resume: busy ? waitBusy : continueBlocker(target),
      stop: busy ? waitBusy : unless(!target.agentAlive, "No leftover agent process is running"),
      discard: busy
        ? waitBusy
        : !hasWorktree(target)
          ? "This run has no worktree to delete"
          : unless(
              activeStatuses.has(status) || target.agentAlive,
              "Available after the run ends and its agent stops",
            ),
    };
    const entry = (
      id: keyof typeof reasons | "chat",
      label: string,
      icon: IconName,
      run: () => void,
    ): Command => {
      const reason = id === "chat" ? undefined : reasons[id];
      return {
        id,
        label,
        icon,
        group: "Session",
        disabled: reason !== undefined,
        ...(reason ? { reason } : {}),
        ...(id === "discard" || id === "stop" ? { danger: true } : {}),
        run,
      };
    };
    return [
      entry("chat", "Open chat", "chat", () => {
        setSelected(target.record.id);
        openChat(target.record.id);
      }),
      entry("review", "Review changes", "compare", () => setChanges(target.record.id)),
      entry("browse", "Browse project files", "document", () => void browseFiles()),
      entry(
        "cancel",
        "Cancel turn",
        "stop",
        () => void act({ type: "cancel", id: target.record.id }),
      ),
      entry(
        "finish",
        "Finish run",
        "checkmark--outline",
        () => void act({ type: "finish", id: target.record.id }),
      ),
      entry("resume", "Resume", "renew", () => resume(target.record.id)),
      entry(
        "stop",
        "Stop leftover agent",
        "close",
        () => void act({ type: "stop", id: target.record.id }),
      ),
      entry(
        "discard",
        "Delete worktree",
        "trash-can",
        () => void act({ type: "discard", id: target.record.id }),
      ),
    ];
  };
  const page = (
    id:
      | "episodic-memory"
      | "chat"
      | "files"
      | "sessions"
      | "configurations"
      | "messages"
      | "events"
      | "worktrees"
      | "polling"
      | "search"
      | "prompts",
    label: string,
  ): Command => ({
    id,
    label,
    group: "Pages",
    icon: "document",
    checked: tabs.active === id,
    run: () => {
      if (id === "files") {
        fileBrowser.selectRoot();
        setExplorerOpen(true);
      }
      setTabs((current) => updateTabs(current, { type: "select", id }));
    },
  });
  const commands: Command[] = [
    page("chat", "Chat"),
    page("episodic-memory", "Episodic Memory"),
    page("files", "File Explorer"),
    page("sessions", "Sessions"),
    page("configurations", "Configurations"),
    page("messages", "Messages"),
    page("events", "Events"),
    page("search", "Search"),
    page("worktrees", "Worktrees"),
    page("polling", "Polling"),
    page("prompts", "Prompt Editor"),
    {
      id: "settings",
      label: "Settings",
      group: "Pages",
      icon: "settings",
      keys: settingsShortcut,
      checked: tabs.active === "settings",
      run: () => setTabs((current) => updateTabs(current, { type: "open", id: "settings" })),
    },
    {
      id: "new",
      label: "New agent session",
      group: "Project",
      icon: "add",
      disabled: busy || !directory,
      run: () => setSetup(true),
    },
    {
      id: "project",
      label: "Open project",
      group: "Project",
      icon: "document",
      disabled: busy || !database || Boolean(snapshot?.active),
      run: () => showPicker("project"),
    },
    {
      id: "database",
      label: "Connect to database",
      group: "Project",
      icon: "document",
      disabled: busy || Boolean(snapshot?.active),
      run: () => showPicker("database"),
    },
    {
      id: "refresh",
      label: "Poll project data",
      group: "Project",
      icon: "renew",
      disabled: busy || !directory,
      run: () =>
        void attempt(async () => {
          await api.poll(["history", "config", "configurations"]);
          notify("Project data polled.", "info");
        }),
    },
    {
      id: "stop-all",
      label: "Stop all runs",
      group: "Project",
      icon: "stop",
      danger: true,
      disabled: busy || !snapshot?.active,
      run: () => void attempt(() => api.stopAll()),
    },
    ...(
      [
        ["light", "Light"],
        ["dark", "Dark"],
        ["system", "System"],
      ] as const
    ).map(
      ([id, label]): Command => ({
        id: `theme-${id}`,
        label: `Theme: ${label}`,
        group: "Appearance",
        icon: "light",
        checked: theme === id,
        run: () => setTheme(id),
      }),
    ),
    {
      id: "focus-highlight",
      label: "Focus highlight border",
      group: "Appearance",
      icon: "view",
      checked: focusHighlight,
      run: () => setFocusHighlight((value) => !value),
    },
    {
      id: "signals",
      label: "Signal colors",
      group: "Appearance",
      icon: "light",
      checked: signals,
      run: () => setSignals((value) => !value),
    },
    {
      id: "charts",
      label: "Inline charts in the sessions table",
      group: "Appearance",
      icon: "view",
      checked: charts,
      run: () => setCharts((value) => !value),
    },
    ...(run
      ? sessionCommands(run).map((command) => ({
          ...command,
          id: `session-${command.id}`,
          hint: `${run.record.agent} / ${run.record.id.slice(-6)}`,
        }))
      : []),
  ];
  return (
    <div className="app">
      <Tooltips />
      <Toasts messages={notifications} onDismiss={dismissNotification} />
      {/* Menus render outside page panels, which clip their contents. */}
      {configurationMenu && menuConfiguration && (
        <ActionsMenu
          bounds={configurationMenu.bounds}
          label={`Actions for ${menuConfiguration.name}`}
          groups={[
            [
              {
                label: "Edit",
                icon: "document",
                disabled: busy,
                reason: "Wait for the current action to finish",
                run: () => {
                  setError("");
                  setConfigurationEditor(menuConfiguration);
                },
              },
            ],
            [
              {
                label: "Delete",
                icon: "trash-can",
                disabled: busy,
                reason: "Wait for the current action to finish",
                danger: true,
                run: () => void attempt(() => api.deleteConfiguration(menuConfiguration.id)),
              },
            ],
          ]}
          onClose={() => setConfigurationMenu(undefined)}
        />
      )}
      {worktreeMenu && menuWorktree && (
        <ActionsMenu
          bounds={worktreeMenu.bounds}
          label={`Actions for ${menuWorktree.path}`}
          groups={[
            [
              {
                label: "Browse project files",
                icon: "document",
                disabled: busy,
                reason: "Wait for the current action to finish",
                run: () => void browseFiles(),
              },
            ],
          ]}
          onClose={() => setWorktreeMenu(undefined)}
        />
      )}
      {pollMenu && menuSource && (
        <ActionsMenu
          bounds={pollMenu.bounds}
          label={`Actions for ${pollLabels[menuSource.key]}`}
          groups={[
            [
              {
                label: "Poll now",
                icon: "renew",
                disabled: busy || menuSource.status === "unavailable",
                reason: busy
                  ? "Wait for the current action to finish"
                  : "Open a project to poll this source",
                run: () => void attempt(() => api.poll([menuSource.key])),
              },
            ],
            [
              {
                label: "Polling settings",
                icon: "settings",
                disabled: false,
                run: () =>
                  setTabs((current) => updateTabs(current, { type: "open", id: "settings" })),
              },
            ],
          ]}
          onClose={() => setPollMenu(undefined)}
        />
      )}
      {menu && menuRun && (
        <ActionsMenu
          bounds={menu.bounds}
          label={`Actions for ${menuRun.record.agent} / ${menuRun.record.id.slice(-6)}`}
          groups={(() => {
            const items = sessionCommands(menuRun).map((command) => ({
              label: command.label,
              icon: command.icon ?? "document",
              disabled: command.disabled ?? false,
              reason: command.reason,
              danger: command.danger,
              run: command.run,
              id: command.id,
            }));
            const pick = (ids: string[]) => items.filter((item) => ids.includes(item.id));
            return [
              pick(["chat", "review", "browse"]),
              pick(["cancel", "finish", "resume", "stop"]),
              pick(["discard"]),
            ];
          })()}
          onClose={() => setMenu(undefined)}
        />
      )}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {splash && (
        <Splash
          ready={splashReady && loaded}
          snapshot={snapshot}
          api={api}
          project={lastProject}
          onAnswer={(open) => {
            if (!orchestratorConfigured) return;
            sessionStorage.setItem("code60.splashShown", "1");
            setSplash(false);
            if (open && lastProject) void attempt(() => api.openProject(lastProject.path));
          }}
        />
      )}
      {!splash && <div className="window-drag-strip" aria-hidden="true" />}
      <div
        className="app-workspace"
        data-chat={!splash && tabs.active === "chat"}
        data-inspector={
          !splash && tabs.active === "chat" && explorerOpen && fileBrowser.preview !== null
        }
      >
        {!splash && (
          <PageTabBar
            tabs={tabs}
            api={api}
            chats={snapshot?.chats ?? []}
            selectedId={snapshot?.chat.run?.id}
            database={database}
            version={snapshot?.versions.code60}
            directory={directory ?? undefined}
            onOpenProject={() => showPicker("project")}
            projectDisabled={busy || !snapshot || Boolean(snapshot.active)}
            onSelect={(id) => {
              setMenu(undefined);
              setConfigurationMenu(undefined);
              setPollMenu(undefined);
              setWorktreeMenu(undefined);
              setTabs((current) => updateTabs(current, { type: "select", id }));
            }}
          />
        )}
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-chat"
          aria-labelledby="tab-chat"
          hidden={tabs.active !== "chat"}
        >
          {explorerOpen && (
            <FilesPage browser={fileBrowser} onOpenProject={() => showPicker("project")} />
          )}
          <div className="chat-conversations">
            {(snapshot?.chats.length ? snapshot.chats : [snapshot?.chat]).map((chat) => (
              <ChatPage
                key={chat?.run?.id ?? chat?.directory ?? "disconnected"}
                api={api}
                chat={chat}
                hidden={chat?.directory !== snapshot?.chat.directory}
                events={state?.chatEventsByRun[chat?.run?.id ?? ""] ?? []}
                database={database}
                runs={snapshot?.runs ?? []}
                explorerOpen={explorerOpen}
                onExplorer={() => {
                  if (!explorerOpen) fileBrowser.selectRoot();
                  setExplorerOpen((value) => !value);
                }}
                active={
                  !splash && tabs.active === "chat" && chat?.directory === snapshot?.chat.directory
                }
                onDatabase={() => showPicker("database")}
              />
            ))}
          </div>
        </div>
        {tabs.open.includes("settings") && (
          <div
            className="page-panel"
            role="tabpanel"
            id="panel-settings"
            aria-labelledby="tab-settings"
            hidden={tabs.active !== "settings"}
          >
            <SettingsPage
              versions={snapshot?.versions}
              orchestration={snapshot && <OrchestrationSettings snapshot={snapshot} api={api} />}
              pollingControls={
                snapshot && (
                  <>
                    <PollingControls
                      polling={snapshot.polling}
                      api={api}
                      chartTickMs={chartTickMs}
                      onChartTick={setChartTickMs}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setTabs((current) => updateTabs(current, { type: "select", id: "polling" }))
                      }
                    >
                      Open polling monitor
                    </button>
                  </>
                )
              }
              transparent={transparent}
              savingAppearance={savingAppearance}
              onTransparent={(enabled) => void saveTransparent(enabled)}
              theme={theme}
              onTheme={setTheme}
              textStyles={textStyles}
              onTextStyles={setTextStyles}
              lines={lines}
              onLines={setLines}
              density={density}
              onDensity={setDensity}
              fit={fit}
              onFit={setFit}
              focusHighlight={focusHighlight}
              onFocusHighlight={setFocusHighlight}
              signals={signals}
              onSignals={setSignals}
              charts={charts}
              onCharts={setCharts}
            />
          </div>
        )}
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-configurations"
          aria-labelledby="tab-configurations"
          hidden={tabs.active !== "configurations"}
        >
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {database && snapshot ? (
            <main
              className="sessions"
              aria-label="Configurations"
              data-heading-lines={lines.heading}
            >
              {snapshot.configurations.length === 0 && (
                <p className="muted configuration-empty">
                  No run configurations yet. Create one here or save settings after starting agents.
                </p>
              )}
              <ConfigurationsTable
                tableId="configurations"
                workspace={`${database}:${directory}`}
                onAdd={() => {
                  setError("");
                  setConfigurationEditor("new");
                }}
                addDisabled={busy}
                configurations={snapshot.configurations}
                selected={selectedConfiguration}
                onSelect={setSelectedConfiguration}
                onActions={(id, bounds) => {
                  setSelectedConfiguration(id);
                  setConfigurationMenu({ id, bounds });
                }}
                lines={lines}
                density={density}
                fit={fit}
                textStyles={textStyles}
              />
            </main>
          ) : (
            <section className="welcome">
              <p>Connect to a database to manage run configurations.</p>
              <button
                type="button"
                className="primary"
                disabled={busy || !snapshot}
                onClick={() => showPicker("database")}
              >
                Connect to database
              </button>
            </section>
          )}
        </div>
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-prompts"
          aria-labelledby="tab-prompts"
          hidden={tabs.active !== "prompts"}
        >
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {database && snapshot ? (
            <PromptEditorPage
              key={database}
              prompts={snapshot.prompts}
              busy={busy}
              onSave={async (id, template) => {
                const saved = await attempt(() => api.savePromptTemplate({ id, template }));
                if (saved) notify("Prompt template saved.");
                return saved;
              }}
              onReset={async (id) => {
                let reset = false;
                const ok = await attempt(async () => {
                  reset = await api.resetPromptTemplate(id);
                });
                if (ok && reset) notify("Prompt template reset.");
                return ok && reset;
              }}
            />
          ) : (
            <section className="welcome">
              <p>Connect to a database to edit prompt templates.</p>
              <button
                type="button"
                className="primary"
                disabled={busy || !snapshot}
                onClick={() => showPicker("database")}
              >
                Connect to database
              </button>
            </section>
          )}
        </div>
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-polling"
          aria-labelledby="tab-polling"
          hidden={tabs.active !== "polling"}
        >
          {snapshot && (
            <PollingPage
              workspace={database ?? "none"}
              polling={snapshot.polling}
              chartTickMs={chartTickMs}
              visible={tabs.active === "polling"}
              lines={lines}
              density={density}
              fit={fit}
              textStyles={textStyles}
              onActions={(id, bounds) => {
                setPollMenu({ id, bounds });
              }}
            />
          )}
        </div>
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-worktrees"
          aria-labelledby="tab-worktrees"
          hidden={tabs.active !== "worktrees"}
        >
          {
            <WorktreesPage
              workspace={workspace}
              onActions={(id, bounds) => setWorktreeMenu({ id, bounds, workspace })}
              listing={snapshot?.worktrees ?? null}
              pollState={snapshot?.polling.sources.find((source) => source.key === "worktrees")}
              directory={directory ?? null}
              lines={lines}
              density={density}
              fit={fit}
              textStyles={textStyles}
            />
          }
        </div>
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-messages"
          aria-labelledby="tab-messages"
          hidden={tabs.active !== "messages"}
        >
          <MessagesPage
            key={`${database}:${directory}`}
            data={transcripts}
            workspace={workspace}
            runs={snapshot?.runs ?? []}
            directory={directory ?? null}
            lines={lines}
            density={density}
            fit={fit}
            textStyles={textStyles}
          />
        </div>
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-episodic-memory"
          aria-labelledby="tab-episodic-memory"
          hidden={tabs.active !== "episodic-memory"}
        >
          <EpisodicMemoryPage
            key={workspace}
            api={api}
            directory={directory ?? null}
            runs={snapshot?.runs ?? []}
            data={transcripts}
            provider={orchestratorConfigured ? (snapshot?.orchestration.provider ?? null) : null}
          />
        </div>
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-events"
          aria-labelledby="tab-events"
          hidden={tabs.active !== "events"}
        >
          <EventsPage
            key={workspace}
            data={transcripts}
            workspace={workspace}
            runs={snapshot?.runs ?? []}
            directory={directory ?? null}
            lines={lines}
            density={density}
            fit={fit}
            textStyles={textStyles}
            onOpen={(id, eventIndex) => {
              setSelected(id);
              openChat(id, false, eventIndex);
            }}
          />
        </div>
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-search"
          aria-labelledby="tab-search"
          hidden={tabs.active !== "search"}
        >
          <SearchPage
            key={workspace}
            directory={directory ?? null}
            runs={snapshot?.runs ?? []}
            data={transcripts}
            onOpen={(result) => {
              setTabs((current) => updateTabs(current, { type: "select", id: "sessions" }));
              if (result.runId) {
                setSelected(result.runId);
                openChat(result.runId, false, result.eventIndex);
              }
            }}
          />
        </div>
        <div
          className="page-panel"
          role="tabpanel"
          id="panel-sessions"
          aria-labelledby="tab-sessions"
          hidden={tabs.active !== "sessions"}
        >
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          )}
          {snapshot?.databaseError && (
            <div className="warning-banner" role="status">
              {snapshot.databaseError}
            </div>
          )}
          {snapshot?.warnings.map((warning) => (
            <div className="warning-banner" key={warning}>
              {warning}
            </div>
          ))}
          {database ? (
            <main className="sessions" aria-label="Sessions" data-heading-lines={lines.heading}>
              <SessionsTable
                actions={
                  <>
                    {run?.agentAlive && (
                      <button
                        type="button"
                        className="danger-text"
                        disabled={busy}
                        onClick={() => void act({ type: "stop", id: run.record.id })}
                      >
                        Stop leftover agent
                      </button>
                    )}
                    {!!snapshot?.active && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void attempt(() => api.stopAll())}
                      >
                        Stop all runs
                      </button>
                    )}
                  </>
                }
                tableId="sessions"
                workspace={`${database}:${directory}`}
                onAdd={() => {
                  setError("");
                  setSetup(true);
                }}
                addDisabled={!directory || busy}
                rows={rows}
                events={state?.events ?? {}}
                charts={charts}
                chartTickMs={chartTickMs}
                visible={tabs.active === "sessions"}
                selected={selected}
                onSelect={(id) => {
                  setSelected(id);
                  openChat(id);
                  setError("");
                }}
                onActions={(id, bounds, contextual) => {
                  setSelected(id);
                  setMenu({ id, bounds, contextual });
                }}
                lines={lines}
                density={density}
                fit={fit}
                textStyles={textStyles}
              />
            </main>
          ) : (
            <section className="welcome">
              <button
                type="button"
                className="primary"
                disabled={busy || !snapshot}
                onClick={() => showPicker("database")}
              >
                Connect to database
              </button>
            </section>
          )}
          {changes && changesRun && (
            <Modal title="Changes" busy={false} wide onClose={() => setChanges(undefined)}>
              <div className="run-context">
                <span>
                  <b>BRANCH</b> {changesRun.record.branch ?? "No isolated worktree"}
                </span>
                <span title={changesRun.record.worktree}>
                  <b>DIRECTORY</b> {changesRun.record.worktree}
                </span>
              </div>
              <button
                type="button"
                disabled={busy || diffLoading}
                onClick={() =>
                  void attempt(async () => {
                    const result = await api.action({ type: "diff", id: changesRun.record.id });
                    if (typeof result === "string") setDiff(result);
                  })
                }
              >
                <Icon name="renew" /> Refresh diff
              </button>
              {diffLoading ? (
                <p className="muted">Loading…</p>
              ) : (
                <pre className="diff">{diff || "No changes."}</pre>
              )}
            </Modal>
          )}
        </div>
        {!splash && tabs.active === "chat" && explorerOpen && (
          <FileInspector
            browser={fileBrowser}
            onReveal={() => {
              fileBrowser.reveal();
              setTabs((current) => updateTabs(current, { type: "select", id: "chat" }));
            }}
          />
        )}
      </div>
      {!splash && (
        <footer className="app-footer">
          {snapshot && (
            <PollingWidget
              key={database ?? "none"}
              polling={snapshot.polling}
              api={api}
              messageScope={
                tabs.active === "chat"
                  ? "selected orchestration conversation"
                  : "current project sessions"
              }
              messageAt={
                tabs.active === "chat"
                  ? newestMessage(state?.chatEvents ?? [])
                  : transcripts.pending || Object.keys(transcripts.errors).length
                    ? null
                    : newestMessage(
                        snapshot.runs.flatMap(({ record }) => [
                          ...(transcripts.events[record.id] ?? []),
                        ]),
                      )
              }
            />
          )}
          {directory && snapshot && state && (
            <ChatDock
              key={`${database}:${directory}`}
              api={api}
              snapshot={snapshot}
              events={state.events}
              request={chatRequest}
              active
              onSelect={setSelected}
            />
          )}
        </footer>
      )}
      {picker === "database" && (
        <DatabaseDialog
          database={database}
          busy={busy}
          error={error}
          onClose={() => setPicker(undefined)}
          onChoose={connectDatabase}
        />
      )}
      {picker === "project" && snapshot && (
        <ProjectDialog
          projects={snapshot.projects}
          database={database}
          onConnect={(mode) => void attempt(() => api.connectDatabase(mode))}
          busy={busy}
          error={error}
          onClose={() => setPicker(undefined)}
          onOpen={(path) =>
            void attempt(async () => {
              await api.openProject(path);
              await projectOpened();
            })
          }
          onCreate={() =>
            void attempt(async () => {
              if (await api.chooseFolder()) await projectOpened();
            })
          }
          onRemove={(path) => void attempt(() => api.removeProject(path))}
          onClear={() => void attempt(() => api.clearProjects())}
        />
      )}
      {setup && snapshot && (
        <NewSession
          snapshot={snapshot}
          busy={busy}
          error={error}
          onClose={() => setSetup(false)}
          onStart={async (request) => {
            await attempt(async () => {
              const ids = await api.start(request);
              const first = ids[0];
              if (!first) return;
              setSelected(first);
              setSetup(false);
              setConfirmation({ launchId: first, count: ids.length });
            });
          }}
        />
      )}
      {configurationEditor && snapshot && (
        <NewRun
          snapshot={snapshot}
          busy={busy}
          error={error}
          configurationName={configurationEditor === "new" ? "" : configurationEditor.name}
          initial={configurationEditor === "new" ? undefined : configurationEditor.settings}
          onClose={() => setConfigurationEditor(undefined)}
          onStart={async (request, name) => {
            const { prompt: _prompt, configurationId: _id, ...settings } = request;
            if (
              await attempt(() =>
                api.saveConfiguration({
                  name: name ?? "",
                  settings,
                  ...(configurationEditor === "new" ? {} : { id: configurationEditor.id }),
                }),
              )
            ) {
              setConfigurationEditor(undefined);
              notify("Run configuration saved.");
            }
          }}
        />
      )}
      {confirmation && (
        <LaunchConfirmation
          count={confirmation.count}
          busy={busy}
          error={error}
          onClose={() => {
            setConfirmation(undefined);
            setError("");
          }}
          onSave={async (name) => {
            const saved = await attempt(() =>
              api.saveConfiguration({ name, launchId: confirmation.launchId }),
            );
            if (saved) notify("Run configuration saved.");
            return saved;
          }}
        />
      )}
    </div>
  );
}

const settingsShortcut = navigator.platform.startsWith("Mac") ? "⌘," : "Ctrl+,";

type MenuItem = {
  label: string;
  icon: IconName;
  disabled: boolean;
  /** Why the item is unavailable, shown as its tooltip. */
  reason?: string | undefined;
  keys?: string | undefined;
  danger?: boolean | undefined;
  run(): void;
};

function ActionsMenu({
  bounds,
  label,
  groups,
  onClose,
}: {
  bounds: Rectangle;
  label: string;
  groups: MenuItem[][];
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: bounds.x, top: bounds.y + bounds.height });
  const close = useRef(onClose);
  close.current = onClose;
  const items = () => [
    ...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
  ];
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let restore = true;
    const rect = menu.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        left: Math.max(8, Math.min(bounds.x, innerWidth - rect.width - 8)),
        top: Math.max(8, Math.min(bounds.y + bounds.height, innerHeight - rect.height - 8)),
      });
    // The grid refocuses its canvas after a click, so focus the menu once that has happened.
    const timer = setTimeout(() =>
      menu.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')
        ?.focus(),
    );
    // Outside clicks, resizing, and window blur dismiss without forcing focus back.
    const dismiss = () => {
      restore = false;
      close.current();
    };
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) dismiss();
    };
    const escapeKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escapeKey, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escapeKey, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      if (restore) previous?.focus();
    };
  }, [bounds.x, bounds.y, bounds.height]);
  const focusAt = (index: number) => {
    const list = items();
    list.at(index % list.length)?.focus();
  };
  return (
    <div
      ref={menu}
      className="actions-menu"
      role="menu"
      aria-label={label}
      style={position}
      onKeyDown={(event) => {
        const list = items();
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Tab") {
          event.preventDefault();
          onClose();
        } else if (
          (event.key === "Enter" || event.key === " ") &&
          event.target instanceof HTMLButtonElement
        ) {
          // The grid cancels Enter's default action, so a focused item is activated here.
          event.preventDefault();
          event.target.click();
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          focusAt(event.key === "Home" ? 0 : list.length - 1);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          focusAt(index + (event.key === "ArrowDown" ? 1 : list.length - 1));
        } else if (/^\p{L}$/u.test(event.key) && !event.metaKey && !event.ctrlKey) {
          // Typing a letter jumps to the next item that starts with it.
          const letter = event.key.toLocaleLowerCase();
          const next = [...list.slice(index + 1), ...list.slice(0, index + 1)].find((item) =>
            item.textContent?.trim().toLocaleLowerCase().startsWith(letter),
          );
          if (next) {
            event.preventDefault();
            next.focus();
          }
        }
      }}
    >
      {groups
        .filter((group) => group.length)
        .map((group) => (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form semantics and its own frame to a row of buttons.
          <div className="menu-group" role="group" key={group.map((item) => item.label).join()}>
            {group.map((item) => (
              <button
                type="button"
                role="menuitem"
                key={item.label}
                tabIndex={-1}
                className={item.danger ? "danger-text" : undefined}
                aria-disabled={item.disabled || undefined}
                data-tooltip={item.disabled ? item.reason : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  onClose();
                  item.run();
                }}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                <span className="menu-key">{item.keys}</span>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

function SettingsPage({
  versions,
  orchestration,
  pollingControls,
  transparent,
  savingAppearance,
  onTransparent,
  theme,
  onTheme,
  textStyles,
  onTextStyles,
  lines,
  onLines,
  density,
  onDensity,
  fit,
  onFit,
  focusHighlight,
  onFocusHighlight,
  signals,
  onSignals,
  charts,
  onCharts,
}: {
  versions: Versions | undefined;
  orchestration: ReactNode;
  pollingControls: ReactNode;
  focusHighlight: boolean;
  onFocusHighlight(on: boolean): void;
  signals: boolean;
  onSignals(on: boolean): void;
  charts: boolean;
  onCharts(on: boolean): void;
  transparent: boolean | undefined;
  savingAppearance: boolean;
  onTransparent(enabled: boolean): void;
  theme: Theme;
  onTheme(theme: Theme): void;
  textStyles: TextStyles;
  onTextStyles(styles: TextStyles): void;
  lines: TableLines;
  onLines(lines: TableLines): void;
  density: RowDensity;
  onDensity(density: RowDensity): void;
  fit: boolean;
  onFit(fit: boolean): void;
}) {
  const id = useId();
  return (
    <main className="settings-page" aria-labelledby={id}>
      <div className="settings-page-heading">
        <h1 id={id}>Settings</h1>
      </div>
      {orchestration}
      <section className="settings-section" aria-labelledby={`${id}-appearance`}>
        <h2 id={`${id}-appearance`}>Appearance</h2>
        <label className="settings-row">
          Theme
          <select
            aria-label="Theme"
            value={theme}
            onChange={(event) => onTheme(parseTheme(event.target.value))}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </label>
        <label className="settings-row">
          Transparent background
          <input
            type="checkbox"
            role="switch"
            checked={transparent ?? false}
            aria-checked={transparent ?? false}
            aria-describedby={`${id}-transparent`}
            disabled={transparent === undefined || savingAppearance}
            onChange={(event) => onTransparent(event.target.checked)}
          />
        </label>
        <p id={`${id}-transparent`}>
          Applies after restart. Makes the area outside the content frame and tabs fully
          transparent. On macOS, clicks in that area pass through to the desktop; on Linux, the
          window stays clickable.
        </p>
        <label className="settings-row">
          Focus highlight border
          <input
            type="checkbox"
            role="switch"
            checked={focusHighlight}
            aria-checked={focusHighlight}
            onChange={(event) => onFocusHighlight(event.target.checked)}
          />
        </label>
        <label className="settings-row">
          Signal colors
          <input
            type="checkbox"
            role="switch"
            checked={signals}
            aria-checked={signals}
            aria-describedby={`${id}-signals`}
            onChange={(event) => onSignals(event.target.checked)}
          />
        </label>
        <p id={`${id}-signals`}>
          Adds color to status labels, banners, and toasts. Every state keeps its icon and written
          label, so nothing depends on color alone.
        </p>
      </section>
      <section className="settings-section" aria-labelledby={`${id}-table`}>
        <h2 id={`${id}-table`}>Table defaults</h2>
        <p>
          Defaults for tables without local overrides. Use each table’s Settings to customize it.
        </p>
        {(
          [
            ["horizontal", "Row lines"],
            ["vertical", "Column lines"],
            ["heading", "Heading lines"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="settings-row">
            {label}
            <input
              type="checkbox"
              role="switch"
              aria-checked={lines[key]}
              checked={lines[key]}
              onChange={(event) => onLines({ ...lines, [key]: event.target.checked })}
            />
          </label>
        ))}
        <label className="settings-row">
          Inline charts
          <input
            type="checkbox"
            role="switch"
            aria-checked={charts}
            checked={charts}
            aria-describedby={`${id}-charts`}
            onChange={(event) => onCharts(event.target.checked)}
          />
        </label>
        <p id={`${id}-charts`}>
          Shows turn time, event activity, and the last two minutes of state for each session.
        </p>
        <label className="settings-row">
          Fit columns to width
          <input
            type="checkbox"
            role="switch"
            aria-checked={fit}
            checked={fit}
            onChange={(event) => onFit(event.target.checked)}
          />
        </label>
        <div className="settings-row" role="radiogroup" aria-labelledby={`${id}-density`}>
          <span id={`${id}-density`}>Row density</span>
          <span className="settings-options">
            {rowDensities.map((entry) => (
              <label key={entry.id} className="check-label">
                <input
                  type="radio"
                  name="row-density"
                  value={entry.id}
                  checked={density === entry.id}
                  onChange={() => onDensity(entry.id)}
                />
                {entry.label}
              </label>
            ))}
          </span>
        </div>
      </section>
      <section className="settings-section" aria-labelledby={`${id}-text`}>
        <div className="text-section-heading">
          <h2 id={`${id}-text`}>Text</h2>
          <button type="button" onClick={() => onTextStyles(structuredClone(defaultTextStyles))}>
            Reset text
          </button>
        </div>
        {textRoles.map((role) => {
          const style = textStyles[role.id];
          const resolved = resolveText(textStyles, role.id);
          const update = (patch: TextStyle) =>
            onTextStyles({ ...textStyles, [role.id]: { ...style, ...patch } });
          return (
            <fieldset className="text-style" key={role.id}>
              <legend>{role.label}</legend>
              <div className="text-style-controls">
                <label>
                  Typeface
                  <select
                    value={style.typeface ?? ""}
                    onChange={(event) =>
                      update({
                        typeface: event.target.value
                          ? parseTypeface(event.target.value)
                          : undefined,
                      })
                    }
                  >
                    <option value="">Default (D-DIN)</option>
                    {typefaces.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Font size
                  <input
                    type="number"
                    min={fontSizes.min}
                    max={fontSizes.max}
                    step="1"
                    value={style.size ?? ""}
                    placeholder={String(resolved.size)}
                    onChange={(event) => {
                      const value = event.target.valueAsNumber;
                      if (!event.target.value) update({ size: undefined });
                      else if (
                        Number.isInteger(value) &&
                        value >= fontSizes.min &&
                        value <= fontSizes.max
                      )
                        update({ size: value });
                    }}
                  />
                </label>
                <label>
                  Font weight
                  <select
                    value={style.weight ?? ""}
                    onChange={(event) =>
                      update({
                        weight: fontWeights.find(
                          (entry) => String(entry.value) === event.target.value,
                        )?.value,
                      })
                    }
                  >
                    <option value="">Default</option>
                    {fontWeights.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                {(["upper", "lower"] as const).map((textCase) => (
                  <label className="check-label" key={textCase}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={resolved.case === textCase}
                      aria-checked={resolved.case === textCase}
                      onChange={(event) =>
                        update({ case: event.target.checked ? textCase : "none" })
                      }
                    />
                    {textCase === "upper" ? "Uppercase" : "Lowercase"}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </section>
      {pollingControls}
      <AboutSection versions={versions} />
    </main>
  );
}

function AboutSection({ versions }: { versions: Versions | undefined }) {
  const id = useId();
  const [copyStatus, setCopyStatus] = useState("");
  const rows = versions
    ? ([
        ["Code60", versions.code60],
        ["Database schema", versions.databaseSchema],
        ["Run record format", versions.runRecordFormat],
        ["ACP protocol", versions.acpProtocol],
        ["MCP protocol", versions.mcpProtocol],
        ["Electron", versions.electron ?? "Unavailable"],
        ["Chromium", versions.chromium ?? "Unavailable"],
        ["Node.js", versions.node],
      ] as const)
    : [];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        [...rows.map(([label, value]) => `${label}: ${value}`), CODE60_COPYRIGHT].join("\n"),
      );
      setCopyStatus("Version info copied.");
    } catch {
      setCopyStatus("Could not copy version info.");
    }
  };
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h2 id={id}>About</h2>
      {rows.map(([label, value]) => (
        <div className="settings-row" key={label}>
          <span>{label}</span>
          <span>{value}</span>
        </div>
      ))}
      <p>{CODE60_COPYRIGHT}</p>
      <button type="button" disabled={!versions} onClick={() => void copy()}>
        Copy version info
      </button>
      <p role="status">{copyStatus}</p>
    </section>
  );
}

function Splash({
  ready,
  snapshot,
  api,
  project,
  onAnswer,
}: {
  ready: boolean;
  snapshot: Snapshot | undefined;
  api: DesktopApi;
  project: ProjectEntry | undefined;
  onAnswer(open: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const id = useId();
  const configured = hasOrchestrationProvider(snapshot);
  const providerLoaded = snapshot !== undefined;
  const [setup, setSetup] = useState(false);
  const [saving, setSaving] = useState(false);
  const testing = snapshot?.orchestration.connection === "testing";
  // A modal dialog keeps the app behind it out of reach until the splash is gone.
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (ready) yes.current?.focus();
  }, [ready]);
  useEffect(() => {
    if (ready && !configured && providerLoaded) setSetup(true);
  }, [ready, configured, providerLoaded]);
  const answer = (open: boolean) => {
    if (!ready) return;
    if (!configured) setSetup(true);
    else onAnswer(open);
  };
  return (
    <>
      <dialog
        ref={dialog}
        className="splash"
        data-ready={ready}
        aria-labelledby={`${id}-title`}
        onCancel={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          if (configured) answer(false);
        }}
      >
        <span id={`${id}-title`} className="wordmark splash-title">
          Code<b>60</b>
        </span>
        {ready && (
          <div className="splash-prompt">
            {configured && project && (
              <h2 id={`${id}-question`}>Continue {folderName(project.path)}?</h2>
            )}
            <div className="splash-actions">
              {configured && project && (
                <button type="button" onClick={() => answer(false)}>
                  No
                </button>
              )}
              <button type="button" className="primary" ref={yes} onClick={() => answer(true)}>
                {!configured ? "Set orchestration provider" : project ? "Yes" : "Start"}
              </button>
            </div>
          </div>
        )}
      </dialog>
      {setup && snapshot && (
        <Modal
          title="Set orchestration provider"
          busy={saving || testing}
          onClose={() => setSetup(false)}
        >
          <OrchestrationSettings
            snapshot={snapshot}
            api={api}
            heading={false}
            onSavingChange={setSaving}
          />
          <div className="modal-footer">
            <button type="button" disabled={saving || testing} onClick={() => setSetup(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!configured || saving || testing}
              onClick={() => setSetup(false)}
            >
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Modal({
  title,
  busy,
  wide = false,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  wide?: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`setup-dialog ${wide ? "changes-dialog" : "picker-dialog"}`}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={`Close ${title}`}
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function DatabaseDialog({
  database,
  busy,
  error,
  onClose,
  onChoose,
}: {
  database: string | null;
  busy: boolean;
  error: string;
  onClose(): void;
  onChoose(mode: DatabaseMode): void;
}) {
  return (
    <Modal title="Select database" busy={busy} onClose={onClose}>
      {database && (
        <p className="muted">
          Connected to <span className="connected-path">{database}</span>
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="modal-footer">
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add form semantics and its own frame to a row of buttons. */}
        <div className="button-group" role="group" aria-label="Database">
          <button type="button" disabled={busy} onClick={() => onChoose("open")}>
            Open existing database…
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onChoose("create")}
          >
            Create database…
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProjectDialog({
  projects,
  database,
  onConnect,
  busy,
  error,
  onClose,
  onOpen,
  onCreate,
  onRemove,
  onClear,
}: {
  projects: ProjectEntry[];
  database: string | null;
  onConnect(mode: DatabaseMode): void;
  busy: boolean;
  error: string;
  onClose(): void;
  onOpen(path: string): void;
  onCreate(): void;
  onRemove(path: string): void;
  onClear(): void;
}) {
  return (
    <Modal title="Open Project" busy={busy} onClose={onClose}>
      {!database ? (
        <>
          <p className="muted">No database connected.</p>
          {/* biome-ignore lint/a11y/useSemanticElements: This group contains actions, not form inputs. */}
          <div className="button-group" role="group" aria-label="Database connection">
            <button type="button" disabled={busy} onClick={() => onConnect("open")}>
              Open existing database…
            </button>
            <button type="button" disabled={busy} onClick={() => onConnect("create")}>
              Create database…
            </button>
          </div>
        </>
      ) : projects.length > 0 ? (
        <ul className="project-list" aria-label="Recent projects">
          {projects.map((project) => (
            <li key={project.path} className="project-row">
              <button
                type="button"
                className="project-item"
                disabled={busy}
                onClick={() => onOpen(project.path)}
              >
                <strong>{folderName(project.path)}</strong>
                <span className="path">{project.path}</span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${folderName(project.path)} from history`}
                title={`Remove ${project.path} from history`}
                disabled={busy}
                onClick={() => onRemove(project.path)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No recent projects.</p>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="modal-footer">
        {projects.length > 0 && (
          <button
            type="button"
            className="danger-text footer-start"
            disabled={busy}
            onClick={onClear}
          >
            Clear history
          </button>
        )}
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={busy || !database} onClick={onCreate}>
          Create new project…
        </button>
      </div>
    </Modal>
  );
}

function NewSession(props: {
  snapshot: Snapshot;
  busy: boolean;
  error: string;
  onClose(): void;
  onStart(request: StartRequest): Promise<void>;
}) {
  const [choosing, setChoosing] = useState(true);
  const [configurationId, setConfigurationId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, StartRequest>>({});
  const configuration = props.snapshot.configurations.find((entry) => entry.id === configurationId);
  const key = configurationId ?? "adhoc";
  if (!choosing)
    return (
      <NewRun
        {...props}
        initial={drafts[key] ?? configuration?.settings}
        onBack={(draft) => {
          setDrafts((current) => ({ ...current, [key]: draft }));
          setChoosing(true);
        }}
        onStart={(request) =>
          props.onStart({ ...request, ...(configurationId ? { configurationId } : {}) })
        }
      />
    );
  return (
    <Modal title="Select run configuration" busy={props.busy} onClose={props.onClose}>
      <p className="muted">Choose saved settings or configure this batch without a preset.</p>
      {props.snapshot.configurations.length === 0 && <p>No saved run configurations.</p>}
      <ul className="project-list" aria-label="Available run configurations">
        {props.snapshot.configurations.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="project-item"
              disabled={props.busy}
              onClick={() => {
                setConfigurationId(entry.id);
                setChoosing(false);
              }}
            >
              <strong>{entry.name}</strong>
              <span>
                {providers(entry)} / {agentCount(entry)} agents
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="modal-footer">
        <button type="button" disabled={props.busy} onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={props.busy}
          onClick={() => {
            setConfigurationId(undefined);
            setChoosing(false);
          }}
        >
          Do not use a run configuration
        </button>
      </div>
    </Modal>
  );
}

function LaunchConfirmation({
  count,
  busy,
  error,
  onClose,
  onSave,
}: {
  count: number;
  busy: boolean;
  error: string;
  onClose(): void;
  onSave(name: string): Promise<boolean>;
}) {
  const [save, setSave] = useState(false);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <Modal title="Agent sessions started" busy={busy} onClose={onClose}>
      <p role="status">
        {count} agent {count === 1 ? "session" : "sessions"} started. Check the sessions table and
        chats for progress or startup errors.
      </p>
      {saved ? (
        <p role="status">Run configuration saved.</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(name).then((success) => {
              if (success) setSaved(true);
            });
          }}
        >
          <label className="check-label">
            <input
              type="checkbox"
              checked={save}
              disabled={busy}
              onChange={(event) => setSave(event.target.checked)}
            />
            Save Run Configuration
          </label>
          {save && (
            <label className="space-top">
              Configuration name
              <input
                required
                maxLength={128}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {save && (
            <div className="modal-footer">
              <button type="submit" className="primary" disabled={busy || !name.trim()}>
                {busy ? "Saving…" : "Save configuration"}
              </button>
            </div>
          )}
        </form>
      )}
      <div className="modal-footer">
        <button type="button" disabled={busy} onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function NewRun({
  snapshot,
  busy,
  error,
  onClose,
  onStart,
  initial,
  configurationName,
  onBack,
}: {
  snapshot: Snapshot;
  busy: boolean;
  error: string;
  onClose(): void;
  initial?: StartRequest | undefined;
  configurationName?: string;
  onBack?(request: StartRequest): void;
  onStart(request: StartRequest, name?: string): Promise<void>;
}) {
  const editing = configurationName !== undefined;
  const [name, setName] = useState(configurationName ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agents, setAgents] = useState(
    (initial?.agents ?? [snapshot.defaultAgent]).map((name, id) => ({ id, name })),
  );
  const nextAgentId = useRef(agents.length);
  const [parallel, setParallel] = useState(initial?.parallel ?? "");
  const [base, setBase] = useState(initial?.base ?? "");
  const [timeout, setTimeoutValue] = useState(initial?.turnTimeout ?? "");
  const [allow, setAllow] = useState<string[]>(initial?.allow ?? []);
  const [allowAll, setAllowAll] = useState(initial?.allowAll ?? false);
  const request = (): StartRequest => ({
    agents: agents.map((agent) => agent.name),
    allow,
    allowAll,
    ...(!editing && prompt.trim() ? { prompt } : {}),
    ...(parallel ? { parallel } : {}),
    ...(base ? { base } : {}),
    ...(timeout ? { turnTimeout: timeout } : {}),
  });
  const unavailable = agents.filter((agent) => !snapshot.agents.includes(agent.name));
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="setup-dialog"
      aria-label={editing ? "Run configuration" : "New agent sessions"}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onStart(request(), name);
        }}
      >
        <div className="modal-heading">
          <div>
            <h2>{editing ? "Run configuration" : "Put your agents to work"}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close new run"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <p className="muted">
          {editing
            ? "Reusable settings shared across projects in this database. Task prompts are never saved."
            : "Each agent gets a separate worktree when Git is available."}
        </p>
        {unavailable.length > 0 && (
          <p role="alert" className="error-banner">
            Unavailable providers: {[...new Set(unavailable.map((agent) => agent.name))].join(", ")}
            . Choose available providers before continuing.
          </p>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <fieldset disabled={busy}>
          {editing && (
            <label>
              Configuration name
              <input
                autoFocus
                required
                maxLength={128}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {!editing && (
            <>
              <label>
                Task prompt <span className="muted">(optional)</span>
                <textarea
                  autoFocus
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="What would you like your agents to do?"
                  rows={5}
                />
              </label>
              <p className="field-hint">
                Leave blank to start sessions and send each agent its own prompt later.
              </p>
            </>
          )}
          <p className="field-label">Agents</p>
          {agents.map((agent, index) => (
            <div className="agent-row" key={agent.id}>
              <select
                aria-label={`Agent ${index + 1}`}
                value={agent.name}
                onChange={(event) =>
                  setAgents((current) =>
                    current.map((item) =>
                      item.id === agent.id ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
              >
                {!snapshot.agents.includes(agent.name) && (
                  <option value={agent.name}>{agent.name} (unavailable)</option>
                )}
                {snapshot.agents.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
              {agents.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove agent ${index + 1}`}
                  onClick={() =>
                    setAgents((current) => current.filter((item) => item.id !== agent.id))
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            disabled={agents.length >= 32}
            onClick={() => {
              const entry = { id: nextAgentId.current++, name: snapshot.defaultAgent };
              setAgents((current) => [...current, entry]);
            }}
          >
            <Icon name="add" /> Add agent
          </button>
          <label className="space-top">
            {agents.length === 1 ? "Parallel copies" : "Maximum active runs"}
            <input
              type="number"
              min="1"
              max={agents.length === 1 ? 32 : undefined}
              value={parallel}
              placeholder={agents.length === 1 ? "1" : String(snapshot.maxParallel)}
              onChange={(event) => setParallel(event.target.value)}
            />
          </label>
          <details>
            <summary>Advanced options</summary>
            <div className="form-grid">
              <label>
                Base revision
                <input
                  value={base}
                  placeholder="HEAD"
                  onChange={(event) => setBase(event.target.value)}
                />
              </label>
              <label>
                Turn timeout
                <input
                  value={timeout}
                  placeholder={snapshot.turnTimeout}
                  onChange={(event) => setTimeoutValue(event.target.value)}
                />
              </label>
            </div>
            <p className="field-hint">
              Permission overrides apply only to this batch. Agent configuration remains read-only.
            </p>
            <div className="permission-grid">
              {kinds.map((kind) => (
                <label key={kind} className="check-label">
                  <input
                    type="checkbox"
                    checked={allow.includes(kind)}
                    onChange={(event) =>
                      setAllow((current) =>
                        event.target.checked
                          ? [...current, kind]
                          : current.filter((item) => item !== kind),
                      )
                    }
                  />
                  Allow {kind}
                </label>
              ))}
            </div>
            <label className="check-label danger-text">
              <input
                type="checkbox"
                checked={allowAll}
                onChange={(event) => setAllowAll(event.target.checked)}
              />
              Allow all actions without asking
            </label>
          </details>
        </fieldset>
        <div className="modal-footer">
          {onBack && (
            <button type="button" disabled={busy} onClick={() => onBack(request())}>
              Back
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !agents[0] || unavailable.length > 0 || (editing && !name.trim())}
          >
            {editing
              ? busy
                ? "Saving…"
                : "Save configuration"
              : busy
                ? "Starting…"
                : "Start agents"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

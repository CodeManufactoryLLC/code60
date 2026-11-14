import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  DesktopApi,
  DesktopRun,
  OpenProject,
  OrchestrationChat,
  OrchestrationChatAction,
  ProjectAction,
} from "../bridge/index.js";
import type { RunEvent } from "../core/index.js";
import { ChatSidebar } from "./chat-sidebar.js";
import { conversationId } from "./chats.js";
import { Icon } from "./icons.js";
import {
  groups,
  isSettingsSection,
  pageAvailable,
  pageDefinitions,
  pageGroup,
  pagesInGroup,
  settingsIcons,
  settingsLabels,
} from "./navigation.js";
import { NavigationIcon } from "./navigation-icons.js";
import { ProjectChatSidebar } from "./project-chat-sidebar.js";
import { type PageId, type PageTabs, type SettingsSectionId, settingsSectionIds } from "./tabs.js";

export function PageTabBar({
  tabs,
  settingsSection,
  onSelect,
  onSettingsSectionSelect,
  onChatArchived,
  onOpenProject,
  onConnectDatabase,
  projectDisabled,
  api,
  chats,
  runs,
  onWorkerSelect,
  selectedId,
  navigationSerial,
  database,
  eventsByRun,
  openProjects,
  selectedProjectId,
}: {
  tabs: PageTabs;
  settingsSection: SettingsSectionId;
  onSelect(id: PageId): void;
  onSettingsSectionSelect(id: SettingsSectionId): void;
  onChatArchived?: (() => void) | undefined;
  onOpenProject(): void;
  onConnectDatabase?(): void;
  projectDisabled: boolean;
  api: DesktopApi;
  chats: readonly OrchestrationChat[];
  runs: readonly DesktopRun[];
  onWorkerSelect(id: string | undefined, projectId?: string | null): void;
  selectedId: string | undefined;
  navigationSerial: number | undefined;
  database: string | null;
  eventsByRun: Readonly<Record<string, readonly RunEvent[]>>;
  openProjects?: readonly OpenProject[] | undefined;
  selectedProjectId?: string | null | undefined;
}) {
  const sidebar = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem("code60.sidebarWidth"));
    return Number.isFinite(saved) && saved >= 180 && saved <= 480 ? saved : 220;
  });
  useLayoutEffect(() => {
    sidebar.current
      ?.closest<HTMLElement>(".app")
      ?.style.setProperty("--sidebar-width", `${width}px`);
    localStorage.setItem("code60.sidebarWidth", String(width));
  }, [width]);
  const resize = (value: number) => {
    const available = sidebar.current?.parentElement?.clientWidth ?? 840;
    setWidth(Math.max(180, Math.min(480, available - 360, value)));
  };
  return (
    <nav ref={sidebar} className="sidebar" aria-label="Sidebar">
      <button
        type="button"
        className="sidebar-resize"
        aria-label="Resize navigation sidebar"
        title="Resize navigation sidebar (Left/Right arrows)"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          resize(
            (sidebar.current?.getBoundingClientRect().width ?? width) +
              (event.key === "ArrowRight" ? 20 : -20),
          );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId) && sidebar.current)
            resize(event.clientX - sidebar.current.getBoundingClientRect().left);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          if (sidebar.current) resize(event.clientX - sidebar.current.getBoundingClientRect().left);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
      <div className="sidebar-toolbar">
        <button
          type="button"
          id="tab-search"
          className="icon-button sidebar-search"
          aria-label="Search"
          title="Search"
          aria-controls="panel-search"
          aria-pressed={tabs.active === "search"}
          disabled={!pageAvailable("search", database)}
          onClick={() => onSelect("search")}
        >
          <Icon name="search" />
        </button>
      </div>
      <div id="navigation-sidebar-content" className="sidebar-content">
        <PageTabList
          onOpenProject={database ? onOpenProject : (onConnectDatabase ?? onOpenProject)}
          projectDisabled={projectDisabled}
          onChatArchived={onChatArchived}
          tabs={tabs}
          settingsSection={settingsSection}
          onSelect={onSelect}
          onSettingsSectionSelect={onSettingsSectionSelect}
          api={api}
          chats={chats}
          runs={runs}
          onWorkerSelect={onWorkerSelect}
          selectedId={selectedId}
          navigationSerial={navigationSerial}
          database={database}
          eventsByRun={eventsByRun}
          openProjects={openProjects}
          selectedProjectId={selectedProjectId}
        />
      </div>
    </nav>
  );
}

const appPages = pagesInGroup("apps");
const tablePages = pagesInGroup("tables");
const experimentPages = pagesInGroup("experiments");

function PageTabList({
  onOpenProject,
  projectDisabled,
  tabs,
  settingsSection,
  onSelect,
  onSettingsSectionSelect,
  onChatArchived,
  api,
  chats,
  runs,
  onWorkerSelect,
  selectedId,
  navigationSerial,
  database,
  eventsByRun,
  openProjects,
  selectedProjectId,
}: {
  onOpenProject(): void;
  projectDisabled: boolean;
  tabs: PageTabs;
  settingsSection: SettingsSectionId;
  onSelect(id: PageId): void;
  onSettingsSectionSelect(id: SettingsSectionId): void;
  onChatArchived?: (() => void) | undefined;
  api: DesktopApi;
  chats: readonly OrchestrationChat[];
  runs: readonly DesktopRun[];
  onWorkerSelect(id: string | undefined, projectId?: string | null): void;
  selectedId: string | undefined;
  navigationSerial: number | undefined;
  database: string | null;
  eventsByRun: Readonly<Record<string, readonly RunEvent[]>>;
  openProjects?: readonly OpenProject[] | undefined;
  selectedProjectId?: string | null | undefined;
}) {
  const [chatPending, setChatPending] = useState(false);
  const [chatError, setChatError] = useState("");
  const chatInFlight = useRef(false);
  const archivedDestination = useRef<string | undefined>(undefined);
  const relay = chats.find((chat) => chat.kind === "relay");
  const relayId = relay && conversationId(relay);
  const relaySelected = relayId !== undefined && relayId === selectedId;
  useLayoutEffect(() => {
    if (!chatPending && archivedDestination.current === selectedId && selectedId) {
      document.getElementById(`conversation-${selectedId}`)?.focus();
      archivedDestination.current = undefined;
    }
  }, [chatPending, selectedId]);
  async function projectAction(request: ProjectAction) {
    if (chatInFlight.current) return false;
    chatInFlight.current = true;
    setChatPending(true);
    setChatError("");
    try {
      await api.projectAction(request);
      return true;
    } catch (cause) {
      setChatError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      chatInFlight.current = false;
      setChatPending(false);
    }
  }
  async function chatAction(request: OrchestrationChatAction) {
    if (
      (!database &&
        !chats.some(
          (chat) =>
            chat.kind === "relay" &&
            (chat.run?.id === ("id" in request ? request.id : undefined) ||
              chat.conversationId === ("id" in request ? request.id : undefined)),
        )) ||
      chatInFlight.current
    )
      return false;
    chatInFlight.current = true;
    setChatPending(true);
    setChatError("");
    const navigate = request.type === "new" || request.type === "select";
    const archiveCurrent =
      request.type === "archive" && request.id === selectedId && tabs.active === "chat";
    if (navigate) onSelect("chat");
    try {
      await api.orchestrationChatAction(request);
      if (archiveCurrent) {
        onChatArchived?.();
        if (relayId) {
          await api.orchestrationChatAction({ type: "select", id: relayId });
          archivedDestination.current = relayId;
          onWorkerSelect(undefined, null);
          onSelect("chat");
        }
      }
      if (navigate)
        onWorkerSelect(
          undefined,
          openProjects
            ? ((request.type === "new"
                ? request.projectId
                : chats.find(
                    (chat) => conversationId(chat) === ("id" in request ? request.id : undefined),
                  )?.projectId) ?? null)
            : undefined,
        );
      return true;
    } catch (cause) {
      setChatError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      chatInFlight.current = false;
      setChatPending(false);
    }
  }
  const [chatExpanded, setChatExpanded] = useState(
    () => localStorage.getItem("code60.chatExpanded") !== "false",
  );
  useEffect(() => {
    localStorage.setItem("code60.chatExpanded", String(chatExpanded));
  }, [chatExpanded]);
  useLayoutEffect(() => {
    if (chatExpanded && selectedId && !relaySelected)
      document.querySelector("#chat-pages [aria-current='true']")?.scrollIntoView({
        block: "nearest",
      });
  }, [chatExpanded, selectedId, relaySelected]);
  const previousNavigation = useRef({ tabs, selectedId });
  useLayoutEffect(() => {
    const previous = previousNavigation.current;
    if (
      tabs.active === "chat" &&
      !relaySelected &&
      (previous.tabs !== tabs ||
        (previous.selectedId !== undefined && previous.selectedId !== selectedId))
    )
      setChatExpanded(true);
    previousNavigation.current = { tabs, selectedId };
  }, [tabs, selectedId, relaySelected]);
  const [settingsExpanded, setSettingsExpanded] = useState(
    () => localStorage.getItem("code60.settingsExpanded") === "true",
  );
  const [advancedExpanded, setAdvancedExpanded] = useState(
    () =>
      (localStorage.getItem("code60.advancedExpanded") ??
        localStorage.getItem("code60.experimentsExpanded")) === "true",
  );
  const [experimentsExpanded, setExperimentsExpanded] = useState(
    () => localStorage.getItem("code60.experimentsExpanded") === "true",
  );
  const [appsExpanded, setAppsExpanded] = useState(
    () => localStorage.getItem("code60.toolsExpanded") !== "false",
  );
  const [expanded, setExpanded] = useState(
    () => localStorage.getItem("code60.tablesExpanded") === "true",
  );
  const navigationFrame = useRef<number | undefined>(undefined);
  const previousActivePage = useRef<PageId | undefined>(undefined);
  const experimentActive = experimentPages.includes(tabs.active);
  const advancedActive = experimentActive || tabs.active === "contributor-tools";
  const tableActive = tablePages.includes(tabs.active);
  const appActive = appPages.includes(tabs.active) || tableActive;
  useLayoutEffect(() => {
    const activeChanged = previousActivePage.current !== tabs.active;
    previousActivePage.current = tabs.active;
    if (tabs.active === "settings" || (activeChanged && pageGroup(tabs.active) === "advanced")) {
      setSettingsExpanded(true);
    }
    if (appPages.includes(tabs.active)) setAppsExpanded(true);
    else if (tablePages.includes(tabs.active)) {
      setAppsExpanded(true);
      setExpanded(true);
    } else if (pageGroup(tabs.active) === "advanced") {
      setAdvancedExpanded(true);
      if (experimentPages.includes(tabs.active)) setExperimentsExpanded(true);
    } else return;
    // Expansion and modal focus restoration must finish before focusing the revealed page.
    navigationFrame.current = requestAnimationFrame(() => {
      navigationFrame.current = undefined;
      // Do not steal focus if the user has already entered the newly opened page.
      if (document.getElementById(`panel-${tabs.active}`)?.contains(document.activeElement)) return;
      document.getElementById(`tab-${tabs.active}`)?.focus();
    });
    return () => {
      if (navigationFrame.current !== undefined) cancelAnimationFrame(navigationFrame.current);
    };
  }, [tabs]);
  useEffect(() => {
    localStorage.setItem("code60.tablesExpanded", String(expanded));
  }, [expanded]);
  useEffect(() => {
    localStorage.setItem("code60.settingsExpanded", String(settingsExpanded));
  }, [settingsExpanded]);
  useEffect(() => {
    localStorage.setItem("code60.advancedExpanded", String(advancedExpanded));
  }, [advancedExpanded]);
  useEffect(() => {
    localStorage.setItem("code60.experimentsExpanded", String(experimentsExpanded));
  }, [experimentsExpanded]);
  const openPages = (group: Parameters<typeof pagesInGroup>[0]) =>
    pagesInGroup(group).filter((id) => tabs.open.includes(id));
  useEffect(() => {
    localStorage.setItem("code60.toolsExpanded", String(appsExpanded));
  }, [appsExpanded]);
  const appDestinations = openPages("apps");
  const experiments = openPages("experiments");
  const tables = openPages("tables");
  const destinations: (
    | PageId
    | SettingsSectionId
    | "relay"
    | "tables"
    | "advanced"
    | "experiments"
  )[] = [
    "home",
    ...(relay && !chatPending ? (["relay"] as const) : []),
    "chat",
    "automations",
    "apps",
    ...(appsExpanded
      ? [
          ...appDestinations.slice(0, 1),
          "tables" as const,
          ...(expanded ? tables : []),
          ...appDestinations.slice(1),
        ]
      : []),
    "settings",
    ...(settingsExpanded
      ? ([
          ...settingsSectionIds,
          "advanced",
          ...(advancedExpanded
            ? [
                "experiments" as const,
                ...(experimentsExpanded ? experiments : []),
                "contributor-tools" as const,
              ]
            : []),
        ] as const)
      : []),
  ];
  const visible = destinations.filter(
    (id) =>
      database ||
      id === "relay" ||
      id === "tables" ||
      id === "advanced" ||
      isSettingsSection(id) ||
      (id !== "experiments" && pageAvailable(id, database)),
  );
  const afterChat = visible[visible.indexOf("chat") + 1];
  const relayButtons = () =>
    [...document.querySelectorAll<HTMLButtonElement>(".relay-sidebar button:enabled")].filter(
      (button) => !button.closest("[hidden]"),
    );
  const chatButtons = () =>
    [...document.querySelectorAll<HTMLButtonElement>("#chat-pages button:enabled")].filter(
      (button) => !button.closest("[hidden]"),
    );
  const selectConversation = (id: string) => {
    if (chats.some((chat) => conversationId(chat) === id)) void chatAction({ type: "select", id });
    else {
      onWorkerSelect(id);
      onSelect("chat");
    }
  };
  function moveTo(target: (typeof visible)[number] | undefined) {
    if (target === "relay") {
      relayButtons()[0]?.focus();
    } else if (target === "tables" || target === "advanced" || target === "experiments") {
      document.getElementById(`${target}-toggle`)?.focus();
    } else if (target && isSettingsSection(target)) {
      onSelect("settings");
      onSettingsSectionSelect(target);
      document.getElementById(`tab-settings-${target}`)?.focus();
    } else if (target) {
      onSelect(target);
      document.getElementById(`tab-${target}`)?.focus();
    }
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, id: (typeof visible)[number]) {
    // A delayed reveal must not undo a subsequent keyboard navigation.
    if (navigationFrame.current !== undefined) {
      cancelAnimationFrame(navigationFrame.current);
      navigationFrame.current = undefined;
    }
    if (id === "chat" && event.key === "ArrowUp") {
      const lastRelayButton = relayButtons().at(-1);
      if (lastRelayButton) {
        event.preventDefault();
        lastRelayButton.focus();
        return;
      }
    }
    if (id === afterChat && event.key === "ArrowUp" && chatExpanded) {
      const lastChild = chatButtons().at(-1);
      if (lastChild) {
        event.preventDefault();
        lastChild.focus();
        return;
      }
    }
    if (id === "chat" && event.key === "ArrowDown" && chatExpanded) {
      const child = chatButtons()[0];
      if (child) {
        event.preventDefault();
        child.focus();
        return;
      }
    }
    if (id === "chat" && event.key === "ArrowLeft") {
      event.preventDefault();
      setChatExpanded(false);
      return;
    }
    if (id === "chat" && event.key === "ArrowRight") {
      event.preventDefault();
      if (chatExpanded) document.querySelector<HTMLButtonElement>("#chat-pages button")?.focus();
      else setChatExpanded(true);
      return;
    }
    if (id === "settings" && event.key === "ArrowLeft") {
      event.preventDefault();
      setSettingsExpanded(false);
      return;
    }
    if (id === "settings" && event.key === "ArrowRight") {
      event.preventDefault();
      if (settingsExpanded) moveTo(settingsSectionIds[0]);
      else setSettingsExpanded(true);
      return;
    }
    if (isSettingsSection(id) && event.key === "ArrowLeft") {
      event.preventDefault();
      setSettingsExpanded(false);
      document.getElementById("tab-settings")?.focus();
      return;
    }
    if (
      event.key === "ArrowLeft" &&
      (id === "experiments" || experimentPages.some((pageId) => pageId === id))
    ) {
      event.preventDefault();
      if (id === "experiments" && !experimentsExpanded) moveTo("advanced");
      else {
        setExperimentsExpanded(false);
        moveTo("experiments");
      }
      return;
    }
    if (event.key === "ArrowRight" && id === "experiments") {
      event.preventDefault();
      if (experimentsExpanded && experiments[0]) moveTo(experiments[0]);
      else setExperimentsExpanded(true);
      return;
    }
    if (event.key === "ArrowLeft" && (id === "advanced" || id === "contributor-tools")) {
      event.preventDefault();
      if (id === "advanced" && !advancedExpanded) {
        document.getElementById("tab-settings")?.focus();
      } else {
        setAdvancedExpanded(false);
        moveTo("advanced");
      }
      return;
    }
    if (event.key === "ArrowRight" && id === "advanced") {
      event.preventDefault();
      if (advancedExpanded) moveTo(database ? "experiments" : "contributor-tools");
      else setAdvancedExpanded(true);
      return;
    }
    if (event.key === "ArrowLeft" && (id === "apps" || appPages.some((pageId) => pageId === id))) {
      event.preventDefault();
      setAppsExpanded(false);
      document.getElementById("tab-apps")?.focus();
      return;
    }
    if (event.key === "ArrowRight" && id === "apps") {
      event.preventDefault();
      if (appsExpanded) moveTo(database ? appDestinations[0] : "tables");
      else setAppsExpanded(true);
      return;
    }
    if (
      event.key === "ArrowLeft" &&
      (id === "tables" || tablePages.some((pageId) => pageId === id))
    ) {
      event.preventDefault();
      if (id === "tables" && !expanded) document.getElementById("tab-apps")?.focus();
      else {
        setExpanded(false);
        document.getElementById("tables-toggle")?.focus();
      }
      return;
    }
    if (event.key === "ArrowRight" && id === "tables") {
      event.preventDefault();
      if (expanded) moveTo(tables.find((id) => pageAvailable(id, database)));
      else setExpanded(true);
      return;
    }
    const index = visible.indexOf(id);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % visible.length
        : event.key === "ArrowUp"
          ? (index - 1 + visible.length) % visible.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? visible.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    moveTo(visible[next]);
  }
  function page(id: PageId, first: boolean) {
    const icon = pageDefinitions[id].icon;
    return (
      <div
        className="page-tab"
        role="presentation"
        key={id}
        data-nav-active={
          (id !== "settings" && tabs.active === id) || (id === "apps" && appActive && !appsExpanded)
        }
      >
        <button
          type="button"
          role="tab"
          id={`tab-${id}`}
          className={id === "apps" ? "page-group-toggle" : undefined}
          aria-controls={
            id === "settings"
              ? "panel-settings settings-pages"
              : id === "apps"
                ? "panel-apps app-pages"
                : `panel-${id}`
          }
          aria-expanded={
            id === "settings" ? settingsExpanded : id === "apps" ? appsExpanded : undefined
          }
          aria-selected={tabs.active === id && (id !== "settings" || !settingsExpanded)}
          data-active={
            id === "apps" ? tabs.active === id || (appActive && !appsExpanded) : undefined
          }
          title={pageDefinitions[id].label}
          disabled={!pageAvailable(id, database)}
          tabIndex={
            tabs.active === id || (first && pageGroup(tabs.active) !== pageGroup(id)) ? 0 : -1
          }
          onClick={() => {
            if (id === "settings" && tabs.active === "settings") {
              setSettingsExpanded((value) => !value);
              return;
            }
            if (id === "apps") {
              // Collapsing keeps the current page; only opening the group shows the Apps home page.
              setAppsExpanded(!appsExpanded);
              if (appsExpanded) return;
            }
            onSelect(id);
          }}
          onKeyDown={(event) => navigate(event, id)}
        >
          {icon && <NavigationIcon name={icon} />}
          <span className="page-tab-label">{pageDefinitions[id].label}</span>
        </button>
      </div>
    );
  }
  function settingsPage(id: SettingsSectionId) {
    const selected = tabs.active === "settings" && settingsSection === id;
    return (
      <div className="page-tab" role="presentation" key={id} data-nav-active={selected}>
        <button
          type="button"
          role="tab"
          id={`tab-settings-${id}`}
          aria-controls={`panel-settings-${id}`}
          aria-selected={selected}
          title={settingsLabels[id]}
          tabIndex={selected ? 0 : -1}
          onClick={() => {
            onSettingsSectionSelect(id);
            onSelect("settings");
          }}
          onKeyDown={(event) => navigate(event, id)}
        >
          <NavigationIcon name={settingsIcons[id]} />
          <span className="page-tab-label">{settingsLabels[id]}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="page-tabs">
      <div role="tablist" aria-label="Home page" aria-orientation="vertical">
        {page("home", true)}
      </div>
      {relay && (
        <ChatSidebar
          relayNavigation
          chats={[relay]}
          runs={runs.filter((run) => run.relay)}
          selectedId={selectedId}
          navigationSerial={navigationSerial}
          database={database}
          eventsByRun={eventsByRun}
          open={tabs.active === "chat"}
          pending={chatPending}
          onSelect={selectConversation}
          onKeyDown={(event) => {
            if (event.defaultPrevented) return;
            const buttons = relayButtons();
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const next = buttons[index + (event.key === "ArrowDown" ? 1 : -1)];
              if (next) next.focus();
              else moveTo(event.key === "ArrowDown" ? "chat" : "home");
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              moveTo(event.key === "Home" ? visible[0] : visible.at(-1));
            }
          }}
        />
      )}
      <div className="chat-page-heading" data-nav-active={tabs.active === "chat" && !selectedId}>
        <div
          className="page-tab"
          role="tablist"
          aria-label="Projects page"
          aria-orientation="vertical"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tabs.active === "chat"}
            title="Projects"
            id="tab-chat"
            className="page-group-toggle"
            aria-expanded={chatExpanded}
            aria-controls="panel-chat chat-pages"
            data-active={tabs.active === "chat" && !selectedId}
            onClick={() => {
              if (tabs.active !== "chat") onSelect("chat");
              else setChatExpanded((value) => !value);
            }}
            onKeyDown={(event) => navigate(event, "chat")}
          >
            {pageDefinitions.chat.icon && <NavigationIcon name={pageDefinitions.chat.icon} />}
            <span className="page-tab-label">{pageDefinitions.chat.label}</span>
          </button>
        </div>
        <button
          type="button"
          className="icon-button project-sidebar-open"
          aria-label={database ? "Open Project" : "Connect to database"}
          title={database ? "Open Project" : "Connect to database"}
          aria-haspopup="dialog"
          disabled={projectDisabled}
          onClick={onOpenProject}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              document.getElementById("tab-chat")?.focus();
            } else if (["ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              navigate(event, "chat");
          }}
        >
          <Icon name="add" />
        </button>
      </div>
      {chatError && (
        <p className="error-banner" role="alert">
          {chatError}
        </p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: navigation disclosure, not a form fieldset. */}
      <div
        id="chat-pages"
        role="group"
        aria-label="Chat conversations"
        className="page-group-pages"
        hidden={!chatExpanded}
        inert={!chatExpanded}
        aria-hidden={!chatExpanded}
        onKeyDown={(event) => {
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          ].filter((button) => !button.closest("[hidden]"));
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          if (event.key === "ArrowLeft" || (event.key === "ArrowUp" && index === 0)) {
            event.preventDefault();
            if (event.key === "ArrowLeft") setChatExpanded(false);
            document.getElementById("tab-chat")?.focus();
          } else if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            event.preventDefault();
            if (event.key === "Home") {
              moveTo(visible[0]);
              return;
            }
            if (event.key === "End") {
              moveTo(visible.at(-1));
              return;
            }
            const next = index + (event.key === "ArrowDown" ? 1 : -1);
            if (next >= buttons.length) moveTo(afterChat);
            else buttons[next]?.focus();
          }
        }}
      >
        {openProjects ? (
          <ProjectChatSidebar
            projects={openProjects}
            selectedProjectId={selectedProjectId}
            onProjectAction={projectAction}
            onAction={chatAction}
            chats={chats}
            runs={runs}
            selectedId={selectedId}
            navigationSerial={navigationSerial}
            database={database}
            eventsByRun={eventsByRun}
            open={tabs.active === "chat"}
            pending={chatPending}
            onSelect={selectConversation}
          />
        ) : (
          <ChatSidebar
            onAction={chatAction}
            chats={chats.filter((chat) => chat.kind !== "relay")}
            runs={runs.filter((run) => !run.relay)}
            selectedId={selectedId}
            navigationSerial={navigationSerial}
            database={database}
            eventsByRun={eventsByRun}
            open={tabs.active === "chat"}
            pending={chatPending}
            onSelect={selectConversation}
          />
        )}
      </div>
      <div role="tablist" aria-label="Automations page" aria-orientation="vertical">
        {page("automations", true)}
      </div>
      <div role="tablist" aria-label="Apps page" aria-orientation="vertical">
        {page("apps", true)}
      </div>
      <div
        id="app-pages"
        className="page-tab-list page-group-pages"
        hidden={!appsExpanded}
        inert={!appsExpanded}
        aria-hidden={!appsExpanded}
      >
        <div role="tablist" aria-label="Apps" aria-orientation="vertical">
          {appDestinations.slice(0, 1).map((id) => page(id, true))}
        </div>
        <div className="page-tab" data-nav-active={tableActive && !expanded}>
          <button
            type="button"
            id="tables-toggle"
            title="Data Viewer"
            className="page-group-toggle"
            aria-expanded={expanded}
            aria-controls="table-pages"
            data-active={tableActive && !expanded}
            onClick={() => {
              setExpanded((value) => !value);
            }}
            onKeyDown={(event) => navigate(event, "tables")}
          >
            <NavigationIcon name={groups.tables.icon} />
            <span className="page-tab-label">{groups.tables.label}</span>
          </button>
        </div>
        <div
          id="table-pages"
          className="page-tab-list page-group-pages"
          role="tablist"
          aria-label="Data Viewer"
          aria-orientation="vertical"
          hidden={!expanded}
          inert={!expanded}
          aria-hidden={!expanded}
        >
          {tables.map((id, index) => page(id, index === 0))}
        </div>
        <div role="tablist" aria-label="Apps" aria-orientation="vertical">
          {appDestinations.slice(1).map((id) => page(id, false))}
        </div>
      </div>
      <div className="page-tab-list sidebar-settings">
        <div
          className="sidebar-settings-heading"
          data-active={(tabs.active === "settings" || advancedActive) && !settingsExpanded}
          data-nav-active={(tabs.active === "settings" || advancedActive) && !settingsExpanded}
        >
          <div
            className="page-tab-list"
            role="tablist"
            aria-label="Settings page"
            aria-orientation="vertical"
          >
            {page("settings", true)}
          </div>
        </div>
        <div
          id="settings-pages"
          className="page-tab-list page-group-pages"
          hidden={!settingsExpanded}
          inert={!settingsExpanded}
          aria-hidden={!settingsExpanded}
        >
          <div
            className="page-tab-list"
            role="tablist"
            aria-label="Settings pages"
            aria-orientation="vertical"
          >
            {settingsSectionIds.map(settingsPage)}
          </div>
          <div className="page-tab" data-nav-active={advancedActive && !advancedExpanded}>
            <button
              type="button"
              id="advanced-toggle"
              className="page-group-toggle"
              aria-expanded={advancedExpanded}
              aria-controls="advanced-pages"
              data-active={advancedActive && !advancedExpanded}
              onClick={() => setAdvancedExpanded((value) => !value)}
              onKeyDown={(event) => navigate(event, "advanced")}
            >
              <NavigationIcon name={groups.advanced.icon} />
              <span className="page-tab-label">{groups.advanced.label}</span>
            </button>
          </div>
          <div
            id="advanced-pages"
            className="page-tab-list page-group-pages"
            hidden={!advancedExpanded}
            inert={!advancedExpanded}
            aria-hidden={!advancedExpanded}
          >
            <div className="page-tab" data-nav-active={experimentActive && !experimentsExpanded}>
              <button
                type="button"
                id="experiments-toggle"
                disabled={!database}
                className="page-group-toggle"
                aria-expanded={experimentsExpanded}
                aria-controls="experiment-pages"
                data-active={experimentActive && !experimentsExpanded}
                onClick={() => setExperimentsExpanded((value) => !value)}
                onKeyDown={(event) => navigate(event, "experiments")}
              >
                <NavigationIcon name={groups.experiments.icon} />
                <span className="page-tab-label">{groups.experiments.label}</span>
              </button>
            </div>
            <div
              id="experiment-pages"
              role="tablist"
              aria-label="Experiments"
              aria-orientation="vertical"
              className="page-tab-list page-group-pages"
              hidden={!experimentsExpanded}
              inert={!experimentsExpanded}
              aria-hidden={!experimentsExpanded}
            >
              {experiments.map((id, index) => page(id, index === 0))}
            </div>
            <div role="tablist" aria-label="Contributor pages" aria-orientation="vertical">
              {page("contributor-tools", true)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import { useMemo } from "react";
import type { AppPagesProps } from "./app-page-props.js";
import { AppsPage } from "./apps-page.js";
import { AutomationsPage } from "./automations.js";
import { ChatWorkspace } from "./chat-workspace.js";
import { CommandsPage } from "./commands-page.js";
import { ConfigurationsTable } from "./configurations.js";
import { EpisodicMemoryPage } from "./episodic-memory.js";
import { EventsPage } from "./events.js";
import { HomePage } from "./home-page.js";
import { Icon } from "./icons.js";
import { LogsPage } from "./logs.js";
import { MemoriesPage } from "./memories.js";
import { MemoryPage } from "./memory.js";
import { MessagesPage } from "./messages.js";
import { type RenderedPageId, renderedPages } from "./navigation.js";
import { OrchestrationSettings } from "./orchestration-settings.js";
import { PollingControls, PollingPage } from "./polling.js";
import { PromptEditorPage } from "./prompt-editor.js";
import { RagPage } from "./rag.js";
import { SearchPage } from "./search-page.js";
import { sessionRows } from "./session-presentation.js";
import { SessionsTable } from "./sessions.js";
import { SettingsPage } from "./settings-page.js";
import { updateTabs } from "./tabs.js";
import { UpdatesSection } from "./updates.js";
import { WorktreesPage } from "./worktrees.js";

export function AppPages(props: AppPagesProps) {
  const { updates } = props;
  const { setExplorerOpen } = props.project;
  const {
    api,
    state,
    project,
    preferences,
    appearance,
    tabs,
    settingsSection,
    splash,
    busy,
    error,
    fileBrowser,
    transcripts,
    orchestratorConfigured,
    setTabs,
    setError,
    showPicker,
    attempt,
    notify,
    openChat,
    act,
    fileAction,
    accept,
  } = props;
  const snapshot = state?.snapshot;
  const projectRuns = useMemo(
    () => snapshot?.runs.filter((run) => !run.relay) ?? [],
    [snapshot?.runs],
  );
  const {
    scope,
    selected,
    setSelected,
    selectedConfiguration,
    setSelectedConfiguration,
    setConfigurationEditor,
    setConfigurationMenu,
    setPollMenu,
    setWorktreeMenu,
    setSetup,
    setMenu,
  } = project;
  const database = scope.database;
  const directory = scope.project;
  const workspace = scope.workspace;
  const databaseKey = JSON.stringify([database, state?.databaseGeneration ?? 0]);
  const { transparent, savingAppearance, saveTransparent } = appearance;
  const {
    theme,
    setTheme,
    textStyles,
    setTextStyles,
    lines,
    setLines,
    density,
    setDensity,
    fit,
    setFit,
    focusHighlight,
    setFocusHighlight,
    signals,
    setSignals,
    charts,
    setCharts,
    chartTickMs,
    setChartTickMs,
  } = preferences;
  const run = snapshot?.runs.find((item) => item.record.id === selected);
  const rows = useMemo(() => sessionRows(snapshot?.runs ?? []), [snapshot?.runs]);
  const views = {
    automations: (
      <AutomationsPage
        api={api}
        active={!splash && tabs.active === "automations"}
        agents={snapshot?.agents ?? []}
        lines={lines}
        density={density}
        fit={fit}
        textStyles={textStyles}
      />
    ),
    memories: (
      <MemoriesPage
        api={api}
        active={!splash && tabs.active === "memories"}
        lines={lines}
        density={density}
        fit={fit}
        textStyles={textStyles}
      />
    ),
    apps: (
      <AppsPage
        database={database}
        onOpen={(id) => setTabs((current) => updateTabs(current, { type: "select", id }))}
      />
    ),
    home: (
      <HomePage
        database={database}
        relayAvailable={Boolean(snapshot?.chats.some((chat) => chat.kind === "relay"))}
        onOpenRelay={props.openRelay}
        onOpenTool={(id) => setTabs((current) => updateTabs(current, { type: "select", id }))}
      />
    ),
    chat: <ChatWorkspace {...props} />,
    rag: (
      <RagPage
        key={databaseKey}
        api={api}
        database={database}
        databaseEpoch={snapshot?.databaseEpoch}
      />
    ),
    settings: (
      <>
        <SettingsPage
          section={settingsSection}
          memory={<MemoryPage api={api} />}
          updates={<UpdatesSection updates={updates} />}
          versions={snapshot?.versions}
          orchestration={
            snapshot && (
              <OrchestrationSettings
                snapshot={snapshot}
                api={api}
                active={!splash && tabs.active === "settings" && settingsSection === "agents"}
              />
            )
          }
          pollingControls={
            snapshot && (
              <fieldset disabled={!database} className="database-dependent-controls">
                <legend className="sr-only">Project polling</legend>
                <PollingControls
                  polling={snapshot.polling}
                  api={api}
                  chartTickMs={chartTickMs}
                  onChartTick={setChartTickMs}
                  onOpenMonitor={() =>
                    setTabs((current) => updateTabs(current, { type: "select", id: "polling" }))
                  }
                />
              </fieldset>
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
      </>
    ),
    configurations: (
      <>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {database && snapshot ? (
          <main className="sessions" aria-label="Configurations" data-heading-lines={lines.heading}>
            <ConfigurationsTable
              key={scope.viewKey}
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
      </>
    ),
    prompts: (
      <>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {database && snapshot ? (
          <PromptEditorPage
            key={databaseKey}
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
      </>
    ),
    commands: (
      <>
        {database && snapshot && (
          <CommandsPage
            key={databaseKey}
            commands={snapshot.commands}
            api={api}
            onSnapshot={(next) => accept(next)}
          />
        )}
      </>
    ),
    logs: (
      <>
        <LogsPage
          api={api}
          active={tabs.active === "logs"}
          project={directory ?? null}
          lines={lines}
          density={density}
          fit={fit}
          textStyles={textStyles}
        />
      </>
    ),
    polling: (
      <>
        {snapshot && (
          <PollingPage
            key={scope.viewKey}
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
      </>
    ),
    worktrees: (
      <>
        {
          <WorktreesPage
            key={scope.viewKey}
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
      </>
    ),
    messages: (
      <>
        <MessagesPage
          key={scope.viewKey}
          data={transcripts}
          workspace={workspace}
          runs={snapshot?.runs ?? []}
          directory={directory ?? null}
          lines={lines}
          density={density}
          fit={fit}
          textStyles={textStyles}
        />
      </>
    ),
    "contributor-tools": (
      <>
        <main className="contributor-tools">
          <h1>Contributor Tools</h1>
          <p>No contributor tools yet.</p>
        </main>
      </>
    ),
    "episodic-memory": (
      <>
        <EpisodicMemoryPage
          key={scope.viewKey}
          api={api}
          directory={directory ?? null}
          runs={projectRuns}
          data={transcripts}
          provider={orchestratorConfigured ? (snapshot?.orchestration.provider ?? null) : null}
        />
      </>
    ),
    events: (
      <>
        <EventsPage
          key={scope.viewKey}
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
      </>
    ),
    search: (
      <>
        <SearchPage
          key={scope.viewKey}
          api={api}
          provider={snapshot?.orchestration.provider ?? null}
          directory={directory ?? null}
          runs={projectRuns}
          data={transcripts}
          onOpen={(result) => {
            if (result.kind === "file" && result.path) {
              fileAction({ type: "file", path: result.path });
              fileBrowser.selectFile(result.path);
              setExplorerOpen(true);
              setTabs((current) => updateTabs(current, { type: "select", id: "chat" }));
              return;
            }
            setTabs((current) => updateTabs(current, { type: "select", id: "sessions" }));
            if (result.runId) {
              setSelected(result.runId);
              openChat(result.runId, false, result.eventIndex);
            }
          }}
        />
      </>
    ),
    sessions: (
      <>
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
              key={scope.viewKey}
              actions={
                <>
                  {run?.agentAlive && (
                    <button
                      type="button"
                      className="icon-button danger-text"
                      aria-label="Stop leftover agent"
                      disabled={busy}
                      onClick={() => void act({ type: "stop", id: run.record.id })}
                    >
                      <Icon name="stop" />
                    </button>
                  )}
                  {!!snapshot?.active && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Stop all runs"
                      disabled={busy}
                      onClick={() => void attempt(() => api.stopAll())}
                    >
                      <Icon name="stop" />
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
      </>
    ),
  } satisfies Record<RenderedPageId, ReactNode>;
  return (
    <>
      {renderedPages.map(({ id }) => (
        <div
          key={id}
          className="page-panel"
          role="tabpanel"
          id={`panel-${id}`}
          aria-labelledby={`tab-${id}`}
          hidden={tabs.active !== id}
        >
          {views[id]}
        </div>
      ))}
    </>
  );
}

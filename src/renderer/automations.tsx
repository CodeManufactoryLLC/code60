import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AutomationEditor,
  type AutomationHistoryEntry,
  type AutomationSummary,
  type AutomationUiRequest,
  type DesktopApi,
  type RendererAutomationDraft,
  type ServiceStatus,
  TOOL_KINDS,
} from "../bridge/index.js";
import { DataTable, type TableOptions } from "./data-table.js";
import { Icon } from "./icons.js";
import { Modal } from "./modal.js";

const automationColumns = [
  { key: "name", title: "Name", width: 180, filter: "text" },
  { key: "agent", title: "Agent", width: 110, filter: "category" },
  { key: "enabled", title: "Enabled", width: 90, filter: "category" },
  { key: "nextRunAt", title: "Next occurrence", width: 210, filter: "date" },
] satisfies {
  key: keyof AutomationSummary;
  title: string;
  width: number;
  filter: "text" | "date" | "category";
}[];
const historyColumns = [
  { key: "automationName", title: "Automation", width: 160, filter: "text" },
  { key: "status", title: "Turn outcome", width: 120, filter: "category" },
  { key: "reason", title: "Reason", width: 180, filter: "category" },
  { key: "scheduledFor", title: "Scheduled", width: 190, filter: "date" },
  { key: "startedAt", title: "Started", width: 190, filter: "date" },
  { key: "endedAt", title: "Ended", width: 190, filter: "date" },
  { key: "denials", title: "Denied requests", width: 120, filter: "number" },
] satisfies {
  key: keyof AutomationHistoryEntry;
  title: string;
  width: number;
  filter: "text" | "date" | "category" | "number";
}[];
const freshDraft = (agent: string): RendererAutomationDraft => ({
  name: "",
  prompt: "",
  agent,
  baseBranch: "main",
  allow: [],
  turnTimeout: "30m",
  enabled: false,
  schedule: {
    type: "daily",
    time: "09:00",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
});

export function AutomationsPage({
  api,
  active,
  agents,
  ...table
}: {
  api: DesktopApi;
  active: boolean;
  agents: string[];
} & Pick<TableOptions, "lines" | "density" | "fit" | "textStyles">) {
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [history, setHistory] = useState<AutomationHistoryEntry[]>([]);
  const [status, setStatus] = useState<ServiceStatus>();
  const [selected, setSelected] = useState<string>();
  const [selectedExecution, setSelectedExecution] = useState<string>();
  const [before, setBefore] = useState<number>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<AutomationEditor>();
  const [evidence, setEvidence] = useState("");
  const generation = useRef(0);
  const dirty = useRef(false);
  const flight = useRef(false);
  const refreshLatest = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(async () => {
    dirty.current = true;
    if (!active || flight.current) return;
    flight.current = true;
    const owner = generation.current;
    try {
      do {
        dirty.current = false;
        const [nextStatus, list, page] = await Promise.all([
          api.automation({ action: "status" }),
          api.automation({ action: "list" }),
          api.automation({
            action: "history",
            ...(selected ? { id: selected } : {}),
            ...(before ? { before } : {}),
          }),
        ]);
        if (owner !== generation.current) return;
        setStatus(nextStatus as ServiceStatus);
        setAutomations(list as AutomationSummary[]);
        setHistory(page as AutomationHistoryEntry[]);
        setError("");
      } while (dirty.current && owner === generation.current);
    } catch {
      if (owner === generation.current) {
        setStatus(undefined);
        setError(
          "Scheduler unavailable. Install or start the background service, then refresh. Existing schedules and evidence are kept.",
        );
      }
    } finally {
      flight.current = false;
      if (dirty.current) void refreshLatest.current();
    }
  }, [active, api, before, selected]);
  refreshLatest.current = refresh;
  useEffect(() => {
    generation.current++;
    const off = api.onAutomationChanged(() => {
      void refresh();
    });
    void refresh();
    return () => {
      generation.current++;
      off();
    };
  }, [api, refresh]);
  const act = async (request: AutomationUiRequest) => {
    if (busy) return;
    const owner = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await api.automation(request);
      if (owner !== generation.current) return;
      if (request.action === "get") setEditor(result as AutomationEditor);
      if (request.action === "transcript" || request.action === "diff")
        setEvidence(JSON.stringify(result, null, 2));
      await refresh();
    } catch (error) {
      if (owner === generation.current) setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const chosen = automations.find((value) => value.id === selected);
  const execution = history.find((value) => value.id === selectedExecution);
  return (
    <section className="automations-page">
      <header className="automation-page-heading">
        <div>
          <h1 className="table-title">Automations</h1>
          <p>
            Runs continue after you quit Code60. Keep this computer awake and logged in. Missed runs
            are skipped.
          </p>
        </div>
        <div className="automation-page-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh automations"
            title="Refresh automations"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <Icon name="renew" />
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              setEditor({
                id: "",
                revision: 0,
                repositoryLabel: "",
                draft: freshDraft(agents[0] ?? ""),
              })
            }
          >
            <Icon name="add" />
            New automation
          </button>
        </div>
      </header>

      <section className="automation-service" aria-labelledby="automation-service-title">
        <div className="automation-service-summary">
          <div className="automation-service-copy">
            <h2 id="automation-service-title">Background service</h2>
            <p className="automation-service-state" role="status">
              <span
                className={`automation-health-dot${status ? " is-connected" : ""}`}
                aria-hidden="true"
              />
              {status
                ? status.pausedAll
                  ? "Installed, all automations paused"
                  : "Installed and running"
                : "Service unavailable"}
              {status?.activeExecutionId && !status.pausedAll ? " · A run is active" : ""}
            </p>
          </div>
          <div className="automation-service-actions">
            {status ? (
              status.pausedAll ? (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void act({ action: "resumeAll" })}
                >
                  Resume all
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ action: "pauseAll", cancelActive: true })}
                >
                  Pause all and cancel active work
                </button>
              )
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void act({ action: "scheduler", control: "install" })}
              >
                Install service
              </button>
            )}
          </div>
        </div>
        {status?.block && (
          <div className="automation-block" role="alert">
            <span>
              {status.block.reason === "leftover_agent"
                ? "An unfinished agent process needs recovery."
                : "The service could not save its private state."}
            </span>
            <button
              type="button"
              className="small"
              disabled={busy}
              onClick={() => void act({ action: "resolveBlock" })}
            >
              Recheck
            </button>
          </div>
        )}
        <details className="automation-service-options">
          <summary>Service options</summary>
          <div className="automation-service-tools">
            {(["install", "repair", "start", "stop", "uninstall"] as const).map((control) => (
              <button
                type="button"
                className={`small${control === "uninstall" ? " danger-text" : ""}`}
                key={control}
                disabled={busy}
                onClick={() => void act({ action: "scheduler", control })}
              >
                {control.charAt(0).toUpperCase() + control.slice(1)}
              </button>
            ))}
          </div>
        </details>
      </section>

      {error && <p role="alert">{error}</p>}
      <div className="automation-grid automation-schedules-grid">
        <DataTable
          {...table}
          tableId="automations"
          workspace="application"
          rows={automations}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            setBefore(undefined);
          }}
          columns={automationColumns}
          initialSort="name"
          display={(row, key) => String(row[key] ?? "Paused")}
        />
      </div>
      {chosen && (
        <section className="automation-selection-actions" aria-label="Selected automation actions">
          <div className="automation-selection-label">
            <span>Selected schedule</span>
            <strong>{chosen.name}</strong>
          </div>
          <div className="automation-action-group">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void act({ action: "runNow", id: chosen.id })}
            >
              <Icon name="play--filled" />
              Run now
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act({ action: "get", id: chosen.id })}
            >
              <Icon name="settings" />
              Edit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act({
                  action: "setEnabled",
                  id: chosen.id,
                  revision: chosen.revision,
                  enabled: !chosen.enabled,
                })
              }
            >
              {chosen.enabled ? "Pause" : "Enable"}
            </button>
            <details className="automation-more-actions">
              <summary>More actions</summary>
              <div>
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  onClick={() => void act({ action: "cancel", id: chosen.id })}
                >
                  Cancel active run
                </button>
                <button
                  type="button"
                  className="small danger-text"
                  disabled={busy}
                  onClick={() =>
                    void act({ action: "delete", id: chosen.id, revision: chosen.revision })
                  }
                >
                  Delete automation
                </button>
              </div>
            </details>
          </div>
        </section>
      )}

      <div className="automation-grid automation-history-grid">
        <DataTable
          {...table}
          tableId="automation-history"
          workspace="application"
          rows={history}
          selected={selectedExecution}
          onSelect={setSelectedExecution}
          columns={historyColumns}
          initialSort="startedAt"
          initialDescending
          display={(row, key) => String(row[key] ?? "Not started")}
        />
      </div>
      <div className="automation-history-footer">
        <p>
          A finished run means the agent turn ended, not that the task was independently verified.
        </p>
        <div className="automation-action-group">
          {selected && (
            <button
              type="button"
              className="small"
              onClick={() => {
                setSelected(undefined);
                setBefore(undefined);
              }}
            >
              Show all schedules
            </button>
          )}
          {before !== undefined && (
            <button type="button" className="small" onClick={() => setBefore(undefined)}>
              Latest
            </button>
          )}
          {history.length >= 50 && (
            <button
              type="button"
              className="small"
              onClick={() => setBefore(history.at(-1)?.sequence)}
            >
              Older
            </button>
          )}
        </div>
      </div>
      {execution?.runId && (
        <section className="automation-evidence-actions" aria-label="Selected run evidence">
          <span>
            Selected run: {execution.automationName} · {execution.status}
          </span>
          <div className="automation-action-group">
            <button
              type="button"
              className="small"
              disabled={busy}
              onClick={() => void act({ action: "transcript", executionId: execution.id })}
            >
              Transcript
            </button>
            <button
              type="button"
              className="small"
              disabled={busy}
              onClick={() => void act({ action: "diff", executionId: execution.id })}
            >
              Changes
            </button>
          </div>
        </section>
      )}
      {editor && (
        <AutomationForm
          api={api}
          editor={editor}
          agents={agents}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            void refresh();
          }}
        />
      )}
      {evidence && (
        <Modal
          title="Read-only execution evidence"
          busy={false}
          wide
          onClose={() => setEvidence("")}
        >
          <pre className="automation-evidence">{evidence}</pre>
        </Modal>
      )}
    </section>
  );
}

function AutomationForm({
  api,
  editor,
  agents,
  onClose,
  onSaved,
}: {
  api: DesktopApi;
  editor: AutomationEditor;
  agents: string[];
  onClose(): void;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState(editor.draft);
  const [repository, setRepository] = useState(editor.repositoryLabel);
  const [preview, setPreview] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    let current = true;
    setPreview([]);
    void api
      .automation({ action: "preview", schedule: draft.schedule })
      .then((result) => {
        if (current) setPreview(result as string[]);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, draft.schedule]);
  const set = <K extends keyof RendererAutomationDraft>(
    key: K,
    value: RendererAutomationDraft[K],
  ) => setDraft((previous) => ({ ...previous, [key]: value }));
  const schedule = draft.schedule;
  const pick = async () => {
    setBusy(true);
    setError("");
    try {
      const result = (await api.automation({ action: "pickRepository" })) as {
        token: string;
        label: string;
      } | null;
      if (alive.current && result) {
        set("repositoryToken", result.token);
        setRepository(result.label);
      }
    } catch (error) {
      if (alive.current) setError((error as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.automation(
        editor.id
          ? { action: "update", id: editor.id, revision: editor.revision, draft }
          : { action: "create", draft },
      );
      if (alive.current) onSaved();
    } catch (error) {
      if (alive.current) setError((error as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal
      title={editor.id ? "Edit automation" : "New automation"}
      busy={busy}
      wide
      onClose={onClose}
    >
      <form
        className="automation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="automation-form-basics">
          <label>
            Name
            <input
              required
              maxLength={80}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </label>
          <label>
            Agent
            <select
              required
              value={draft.agent}
              onChange={(event) => set("agent", event.target.value)}
            >
              <option value="">Choose a provider</option>
              {agents.map((agent) => (
                <option key={agent}>{agent}</option>
              ))}
            </select>
          </label>
          <div className="automation-form-field">
            <span className="automation-form-label">Repository</span>
            <div className="automation-repository-choice">
              <button type="button" disabled={busy} onClick={() => void pick()}>
                Choose repository
              </button>
              <span>{repository || "No repository chosen"}</span>
            </div>
          </div>
          <label>
            Local base branch
            <input
              required
              value={draft.baseBranch}
              onChange={(event) => set("baseBranch", event.target.value)}
            />
          </label>
          <label>
            Turn timeout
            <input
              required
              value={draft.turnTimeout}
              onChange={(event) => set("turnTimeout", event.target.value)}
            />
          </label>
        </div>
        <label className="automation-form-prompt">
          Saved prompt
          <textarea
            required
            maxLength={32000}
            value={draft.prompt}
            onChange={(event) => set("prompt", event.target.value)}
          />
        </label>
        <fieldset>
          <legend>Cadence</legend>
          <label>
            Schedule
            <select
              value={schedule.type}
              onChange={(event) => {
                const type = event.target.value;
                set(
                  "schedule",
                  type === "interval"
                    ? { type, everyMinutes: 60, anchor: new Date().toISOString() }
                    : type === "weekly"
                      ? {
                          type,
                          days: [1],
                          time: "09:00",
                          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                        }
                      : {
                          type: "daily",
                          time: "09:00",
                          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                        },
                );
              }}
            >
              <option value="interval">Interval</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          {schedule.type === "interval" ? (
            <label>
              Every minutes
              <input
                type="number"
                required
                min={1}
                max={10080}
                value={schedule.everyMinutes}
                onChange={(event) =>
                  set("schedule", { ...schedule, everyMinutes: Number(event.target.value) })
                }
              />
            </label>
          ) : (
            <>
              <label>
                Time
                <input
                  type="time"
                  required
                  value={schedule.time}
                  onChange={(event) => set("schedule", { ...schedule, time: event.target.value })}
                />
              </label>
              <label>
                IANA time zone
                <input
                  required
                  value={schedule.timeZone}
                  onChange={(event) =>
                    set("schedule", { ...schedule, timeZone: event.target.value })
                  }
                />
              </label>
            </>
          )}
          {schedule.type === "weekly" && (
            <div className="automation-actions">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={schedule.days.includes(index)}
                    onChange={(event) =>
                      set("schedule", {
                        ...schedule,
                        days: event.target.checked
                          ? [...schedule.days, index]
                          : schedule.days.filter((value) => value !== index),
                      })
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
          )}
          <p>
            Next occurrences (UTC):{" "}
            {preview.length ? preview.join(", ") : "Enter a valid schedule to preview."}
          </p>
        </fieldset>
        <fieldset>
          <legend>Allowed tool kinds</legend>
          <p>
            Everything else is denied, without waiting for approval. Allowing execute can grant
            broad user-account and network access. A worktree is not a sandbox.
          </p>
          <div className="automation-actions">
            {TOOL_KINDS.map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={draft.allow.includes(kind)}
                  onChange={(event) =>
                    set(
                      "allow",
                      event.target.checked
                        ? [...draft.allow, kind]
                        : draft.allow.filter((value) => value !== kind),
                    )
                  }
                />
                {kind}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="automation-form-enabled">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => set("enabled", event.target.checked)}
          />
          Enabled
        </label>
        <p className="automation-form-note">
          Save disabled, then use Run now to test. Each run gets one fresh turn, with no retries or
          automatic changes applied.
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="automation-actions automation-form-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !repository || preview.length === 0}>
            Save automation
          </button>
        </div>
      </form>
    </Modal>
  );
}

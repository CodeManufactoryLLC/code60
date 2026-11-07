import type { Rectangle } from "@glideapps/glide-data-grid";
import { useMemo, useState } from "react";
import {
  type DesktopApi,
  type Polling,
  type PollKey,
  type PollResult,
  type PollState,
  pollKeys,
  pollRanges,
} from "../bridge/index.js";
import { DataTable, type TableOptions } from "./data-table.js";
import { drawIcon, Icon } from "./icons.js";
import { MessageAge } from "./message-controls.js";
import { useTicker } from "./ticker.js";

export const labels: Record<PollKey, string> = {
  history: "Run history",
  config: "Agent config",
  configurations: "Run configurations",
  worktrees: "Worktrees",
  files: "Files",
};
const time = (at: number | null) => (at === null ? "Never" : new Date(at).toLocaleTimeString());
export const intervalText = (ms: number | null) => (ms === null ? "Off" : `${ms / 1000}s`);
const triggerLabels: Record<PollResult["trigger"], string> = {
  manual: "Manual",
  timer: "Timer",
  change: "Change",
};

type PollApi = Pick<DesktopApi, "poll" | "setPollSettings" | "setPollingPaused">;
export interface PollingProps {
  polling: Polling;
  api: PollApi;
  chartTickMs: number;
  onChartTick(ms: number): void;
}

export function PollingWidget({
  polling,
  api,
  messageAt,
  messageScope,
}: Pick<PollingProps, "polling" | "api"> & {
  messageAt: number | null | undefined;
  messageScope: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const available = polling.sources.filter((source) => source.status !== "unavailable");
  const attempt = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="footer-polling" aria-label="Polling controls">
      <p className="poll-timestamp">
        <Icon name="view" />
        <MessageAge at={messageAt} scope={messageScope} />
      </p>
      <div className="button-group">
        <button
          type="button"
          aria-label={polling.paused ? "Start polling" : "Pause polling"}
          disabled={busy}
          onClick={() => void attempt(() => api.setPollingPaused(!polling.paused))}
        >
          <Icon name={polling.paused ? "play--filled" : "pause"} />
          {polling.paused ? "Start" : "Pause"}
        </button>
        <button
          type="button"
          aria-label="Refresh project data"
          disabled={
            busy || !available.length || available.some((source) => source.status === "polling")
          }
          onClick={() => void attempt(() => api.poll(available.map((source) => source.key)))}
        >
          <Icon name="renew" />
          Refresh
        </button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function IntervalForm({
  source,
  busy,
  onSave,
}: {
  source: PollState;
  busy: boolean;
  onSave(intervalMs: number | null, idleIntervalMs: number | null): void;
}) {
  const [active, setActive] = useState(
    source.setting.intervalMs === null ? "" : String(source.setting.intervalMs / 1000),
  );
  const [idle, setIdle] = useState(
    source.setting.idleIntervalMs === null ? "" : String(source.setting.idleIntervalMs / 1000),
  );
  const [min, max] = pollRanges[source.key];
  return (
    <form
      className="poll-interval-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(
          active === "" ? null : Number(active) * 1000,
          idle === "" ? null : Number(idle) * 1000,
        );
      }}
    >
      {(["active", "idle"] as const).map((mode) => (
        <label key={mode}>
          {mode === "active"
            ? source.key === "worktrees" || source.key === "files"
              ? "Visible tab seconds"
              : "Active seconds"
            : "Idle seconds"}
          <input
            type="number"
            min={min / 1000}
            max={max / 1000}
            step="1"
            required={source.key === "history"}
            disabled={
              busy || ((source.key === "worktrees" || source.key === "files") && mode === "idle")
            }
            placeholder="Off"
            value={mode === "active" ? active : idle}
            onChange={(event) => (mode === "active" ? setActive : setIdle)(event.target.value)}
          />
        </label>
      ))}
      <button type="submit" disabled={busy}>
        Apply
      </button>
    </form>
  );
}

export function PollingControls({ polling, api, chartTickMs, onChartTick }: PollingProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section polling-settings" aria-label="Polling settings">
      <h2>Polling</h2>
      <p className="muted">
        Desktop only. Empty intervals turn automatic polling off. Worktrees scan only while their
        tab is visible. Manual polls still work while paused.
      </p>
      <div className="poll-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void attempt(() =>
              api.setPollSettings(Object.fromEntries(pollKeys.map((key) => [key, null]))),
            )
          }
        >
          Reset polling defaults
        </button>
      </div>
      {polling.sources.map((source) => (
        <fieldset key={source.key}>
          <legend>{labels[source.key]}</legend>
          <IntervalForm
            key={`${source.key}:${source.setting.intervalMs}:${source.setting.idleIntervalMs}`}
            source={source}
            busy={busy}
            onSave={(intervalMs, idleIntervalMs) =>
              void attempt(() =>
                api.setPollSettings({
                  [source.key]: {
                    intervalMs,
                    idleIntervalMs:
                      source.key === "worktrees" || source.key === "files"
                        ? intervalMs
                        : idleIntervalMs,
                  },
                }),
              )
            }
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void attempt(() => api.setPollSettings({ [source.key]: null }))}
          >
            Reset {labels[source.key].toLowerCase()}
          </button>
        </fieldset>
      ))}
      <label className="settings-row">
        Chart ticker seconds (local clock, no data reads)
        <input
          type="number"
          min="1"
          max="60"
          step="1"
          value={chartTickMs / 1000}
          onChange={(event) => {
            const seconds = Number(event.target.value);
            if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 60)
              onChartTick(seconds * 1000);
          }}
        />
      </label>
      <button type="button" onClick={() => onChartTick(5000)}>
        Reset chart ticker
      </button>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** A source row, or one of its results nested below it. */
interface PollRow {
  id: string;
  parent: PollKey | undefined;
  source: PollState;
  result: PollResult | undefined;
  name: string;
  status: string;
  effectiveIntervalMs: number;
  settings: string;
  polledAt: number;
  succeededAt: number;
  nextAt: number;
  failures: number;
  lastResult: string;
  recent: number;
}
type PollColumn =
  | "name"
  | "status"
  | "effectiveIntervalMs"
  | "settings"
  | "polledAt"
  | "succeededAt"
  | "nextAt"
  | "failures"
  | "lastResult"
  | "recent";
const pollColumns: {
  key: PollColumn;
  title: string;
  width: number;
  filter?: "date" | "category" | "number";
}[] = [
  { key: "name", title: "Source", width: 180 },
  { key: "status", title: "Status", width: 120, filter: "category" },
  { key: "effectiveIntervalMs", title: "Interval", width: 75, filter: "number" },
  { key: "settings", title: "Active and idle", width: 125 },
  { key: "polledAt", title: "Last attempt", width: 110, filter: "date" },
  { key: "succeededAt", title: "Last success", width: 110, filter: "date" },
  { key: "nextAt", title: "Next poll", width: 115, filter: "date" },
  { key: "failures", title: "Failures in a row", width: 130, filter: "number" },
  { key: "lastResult", title: "Last result", width: 240 },
  { key: "recent", title: "Recent durations", width: 170, filter: "number" },
];
export const statusText = (status: PollState["status"]) =>
  status.charAt(0).toUpperCase() + status.slice(1);
const nextText = (nextAt: number | null, now: number) =>
  nextAt === null ? "Not scheduled" : `In ${Math.max(0, Math.ceil((nextAt - now) / 1000))}s`;
export const lastResultText = (result: PollResult | undefined) =>
  result
    ? `${result.ok ? "Success" : "Failed"}, ${triggerLabels[result.trigger].toLowerCase()}, ${result.durationMs} ms`
    : "None yet";
/** A result row already shows its trigger and outcome, so this adds the duration and any error. */
const resultText = (result: PollResult) =>
  result.error ? `${result.durationMs} ms: ${result.error}` : `${result.durationMs} ms`;
const parentOf = (row: PollRow) => row.parent;
const actionable = (row: PollRow) => !row.parent;

/** Source rows followed, when expanded, by their results, newest first. */
export function pollRows(sources: PollState[], expanded: ReadonlySet<string>): PollRow[] {
  return sources.flatMap((source) => {
    const row: PollRow = {
      id: source.key,
      parent: undefined,
      source,
      result: undefined,
      name: labels[source.key],
      status: source.status,
      effectiveIntervalMs: source.effectiveIntervalMs ?? -1,
      settings: `${intervalText(source.setting.intervalMs)} and ${intervalText(source.setting.idleIntervalMs)}`,
      polledAt: source.polledAt ?? -1,
      succeededAt: source.succeededAt ?? -1,
      nextAt: source.nextAt ?? Number.MAX_SAFE_INTEGER,
      failures: source.failures,
      lastResult: lastResultText(source.history.at(-1)),
      recent: source.history.at(-1)?.durationMs ?? -1,
    };
    if (!expanded.has(source.key)) return [row];
    return [
      row,
      ...source.history.toReversed().map(
        (result): PollRow => ({
          ...row,
          id: `${source.key}:${result.id}`,
          parent: source.key,
          result,
          name: triggerLabels[result.trigger],
          status: result.ok ? "success" : "failed",
          polledAt: result.at,
          lastResult: resultText(result),
          recent: result.durationMs,
        }),
      ),
    ];
  });
}

export function PollingPage({
  polling,
  visible,
  chartTickMs,
  onActions,
  ...options
}: Pick<PollingProps, "polling" | "chartTickMs"> &
  Pick<TableOptions, "workspace" | "lines" | "density" | "fit" | "textStyles"> & {
    visible: boolean;
    onActions(id: string, bounds: Rectangle, contextual?: boolean): void;
  }) {
  const [selected, setSelected] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const now = useTicker(visible, chartTickMs);
  const rows = useMemo(() => pollRows(polling.sources, expanded), [polling.sources, expanded]);
  // Choosing a source row shows or hides its results, by mouse or by Enter.
  const choose = (id: string) => {
    setSelected(id);
    if (!pollKeys.includes(id as PollKey)) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const display = (row: PollRow, key: PollColumn): string => {
    const { source, result } = row;
    if (result) {
      switch (key) {
        case "name":
          return `${triggerLabels[result.trigger]} poll of ${labels[source.key]}`;
        case "status":
          return result.ok ? "Success" : "Failed";
        case "polledAt":
          return time(result.at);
        case "lastResult":
          return row.lastResult;
        case "recent":
          return `${result.durationMs} ms`;
        default:
          return "";
      }
    }
    switch (key) {
      case "name":
        return `${row.name}, ${source.history.length} results, ${expanded.has(source.key) ? "expanded" : "collapsed"}`;
      case "status":
        return statusText(source.status);
      case "effectiveIntervalMs":
        return intervalText(source.effectiveIntervalMs);
      case "polledAt":
        return time(source.polledAt);
      case "succeededAt":
        return time(source.succeededAt);
      case "nextAt":
        return nextText(source.nextAt, now);
      case "failures":
        return String(source.failures);
      case "recent":
        return source.history.length
          ? `${source.history.length} samples, maximum ${Math.max(...source.history.map((item) => item.durationMs))} ms`
          : "No samples";
      default:
        return String(row[key]);
    }
  };
  const paint: Parameters<typeof DataTable<PollRow, PollColumn>>[0]["paint"] = (
    { ctx, rect, theme },
    row,
    key,
  ) => {
    const style = getComputedStyle(document.documentElement);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const middle = rect.y + rect.height / 2;
    const { source, result } = row;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    if (key === "name") {
      ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
      if (result) {
        // A guide line ties each result to its source above.
        ctx.fillStyle = color("--border");
        ctx.fillRect(rect.x + 13, rect.y, 1, rect.height);
        ctx.fillStyle = color("--muted");
        ctx.fillText(row.name, rect.x + 28, middle, rect.width - 36);
        return true;
      }
      ctx.fillStyle = theme.textDark;
      drawIcon(
        ctx,
        expanded.has(source.key) ? "chevron--down" : "chevron--right",
        rect.x + 6,
        middle - 8,
      );
      ctx.fillText(row.name, rect.x + 28, middle, rect.width - 64);
      const count = String(source.history.length);
      ctx.fillStyle = color("--muted");
      ctx.textAlign = "right";
      ctx.fillText(count, rect.x + rect.width - 8, middle);
      return true;
    }
    if (key === "status") {
      const failed = row.status === "failed";
      const strong = row.status === "healthy" || row.status === "success";
      ctx.fillStyle = failed ? color("--danger") : strong ? color("--text") : color("--muted");
      if (failed)
        ctx.fillRect(
          rect.x + 6,
          middle - Math.min(10, rect.height / 2 - 2),
          3,
          Math.min(20, rect.height - 4),
        );
      const icon = failed
        ? "warning--alt--filled"
        : row.status === "polling"
          ? "renew"
          : row.status === "paused"
            ? "pause"
            : strong
              ? "checkmark"
              : "time";
      drawIcon(ctx, icon, rect.x + 14, middle - 8);
      ctx.font = `400 12px ${theme.fontFamily}`;
      ctx.fillText(display(row, "status"), rect.x + 36, middle, rect.width - 44);
      return true;
    }
    if (key !== "recent" || !source.history.length) return false;
    const max = Math.max(1, ...source.history.map((item) => item.durationMs));
    const height = Math.max(4, rect.height - 8);
    ctx.lineWidth = 1;
    const bar = (x: number, width: number, value: PollResult, barHeight: number, y: number) => {
      if (value.ok) {
        ctx.fillStyle = color("--human-text");
        ctx.fillRect(x, y, width, barHeight);
      } else {
        ctx.strokeStyle = color("--accent");
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, barHeight - 1));
      }
    };
    if (result) {
      // One horizontal bar on the source's scale, so results compare down the column.
      const width = Math.max(1, (result.durationMs / max) * (rect.width - 72));
      bar(rect.x + 8, width, result, 8, middle - 4);
      ctx.fillStyle = color("--muted");
      ctx.font = `12px ${theme.fontFamily}`;
      ctx.textAlign = "right";
      ctx.fillText(`${result.durationMs} ms`, rect.x + rect.width - 8, middle);
      return true;
    }
    const slot = (rect.width - 16) / 50;
    source.history.forEach((item, index) => {
      const barHeight = Math.max(1, (item.durationMs / max) * height);
      bar(
        rect.x + 8 + index * slot,
        Math.max(1, slot - 1),
        item,
        barHeight,
        rect.y + rect.height - 4 - barHeight,
      );
    });
    return true;
  };
  return (
    <main
      className="sessions polling-page"
      aria-label="Polling monitor"
      data-heading-lines={options.lines.heading}
    >
      <DataTable
        {...options}
        tableId="polling"
        rows={rows}
        columns={pollColumns}
        display={display}
        initialSort="name"
        selected={selected}
        onSelect={choose}
        onActions={onActions}
        parent={parentOf}
        hasActions={actionable}
        align={(key) => (key === "failures" ? "right" : "left")}
        paint={paint}
      />
    </main>
  );
}

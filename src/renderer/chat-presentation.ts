import type { DesktopRun } from "../bridge/index.js";
import type { RunEvent, RunStatus, RunView } from "../core/index.js";
import { statusSpec } from "./state.js";

export function sessionStatus(run: Pick<RunView, "status" | "turns" | "stopping" | "pending">) {
  if (run.stopping) return { ...statusSpec.cancelled, label: "Stopping" };
  if (run.pending.length > 0 || run.status === "waiting")
    return { ...statusSpec.waiting, label: "Approval needed" };
  if (run.status === "running" && run.turns === 0)
    return { ...statusSpec.queued, label: "Connecting" };
  if (run.status === "idle") return { ...statusSpec.idle, label: "Awaiting input" };
  return statusSpec[run.status];
}

export function delegatedActivity(ids: readonly string[], runs: readonly DesktopRun[]): string {
  const active = runs.flatMap(({ record, view }) =>
    ids.includes(record.id) &&
    view &&
    (view.stopping || ["queued", "running", "waiting"].includes(view.status))
      ? [view]
      : [],
  );
  if (!active.length) return "";
  const label = active.some((run) => run.pending.length || run.status === "waiting")
    ? "Waiting for approval"
    : active.every((run) => run.stopping)
      ? "Stopping"
      : active.every((run) => run.status === "queued" || run.turns === 0)
        ? "Connecting"
        : "Working";
  return `${active.length} subagent${active.length === 1 ? "" : "s"}: ${label.toLowerCase()}`;
}

export function durationText(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours
    ? `${hours}h ${minutes}m ${seconds % 60}s`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`;
}

export function newestMessage(events: readonly RunEvent[]): number | null | undefined {
  let newest: number | undefined;
  let invalid = false;
  for (const event of events) {
    if (event.type !== "message" || !event.text.length) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) invalid = true;
    else newest = Math.max(newest ?? -Infinity, at);
  }
  return invalid ? null : newest;
}

export interface TurnTiming {
  key: string;
  turn: number;
  start: number;
  end?: number;
  outcome?: string;
  active: boolean;
}
/** Each prompt starts its own group. Missing crash completion never runs a timer forever. */
export function turnTimings(
  events: readonly RunEvent[],
  status: RunStatus,
): Map<string, TurnTiming> {
  const groups = new Map<string, TurnTiming>();
  let current: TurnTiming | undefined;
  for (const [index, event] of events.entries()) {
    if (event.type === "prompt") {
      current = {
        key: String(index),
        turn: event.turn,
        start: Date.parse(event.at),
        active: false,
      };
      groups.set(current.key, current);
    } else if (current && event.type === "turnEnd" && event.turn === current.turn) {
      current.end = Date.parse(event.completedAt ?? event.at);
      current.outcome =
        event.outcome ??
        (event.stopReason === "end_turn"
          ? "finished"
          : event.stopReason === "cancelled"
            ? "cancelled"
            : "failed");
    } else if (
      current &&
      event.type === "status" &&
      event.status === "idle" &&
      event.reason === `turn ${current.turn} ended: cancelled (turn timed out)`
    ) {
      current.outcome = "timed_out";
    } else if (
      current &&
      event.type === "status" &&
      event.status === "timed_out" &&
      current.outcome === "cancelled"
    ) {
      // Legacy headless timeouts recorded only "cancelled" on turnEnd.
      current.outcome = "timed_out";
    } else if (
      current &&
      event.type === "status" &&
      !["queued", "running", "waiting", "idle"].includes(event.status) &&
      current.end === undefined
    ) {
      current.outcome = event.status;
      // Old terminal records include process cleanup, not an exact turn completion.
      if (event.turn === current.turn && event.completedAt)
        current.end = Date.parse(event.completedAt);
    }
  }
  if (
    current &&
    current.end === undefined &&
    !current.outcome &&
    ["running", "waiting"].includes(status)
  )
    current.active = true;
  return groups;
}

export function timingText(timing: TurnTiming, now: number): string {
  const end = timing.active ? now : timing.end;
  const outcome = timing.outcome ? ` (${timing.outcome.replaceAll("_", " ")})` : "";
  if (
    !Number.isFinite(timing.start) ||
    end === undefined ||
    !Number.isFinite(end) ||
    end < timing.start
  )
    return `Timing unavailable${timing.active ? "" : " / incomplete"}${outcome}`;
  return `${timing.active ? "Working" : "Worked"} for ${durationText(end - timing.start)}${outcome}`;
}

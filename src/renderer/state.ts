import type { DesktopRun, Snapshot } from "../bridge/index.js";
import type { RunEvent, RunStatus } from "../core/index.js";
import type { IconName } from "./icons.js";

export interface DesktopState {
  snapshot: Snapshot;
  events: Record<string, RunEvent[]>;
  chatEvents: RunEvent[];
  chatEventsByRun: Record<string, RunEvent[]>;
}

export function hasOrchestrationProvider(
  snapshot: Pick<Snapshot, "agents" | "orchestration"> | undefined,
): boolean {
  const provider = snapshot?.orchestration.provider;
  return provider != null && snapshot?.agents.includes(provider) === true;
}

/** Snapshot revisions and event revisions avoid duplicates across initial load and reload. */
export function applyUpdate(state: DesktopState | undefined, update: Snapshot): DesktopState {
  if (state && update.revision <= state.snapshot.revision) return state;
  const sameWorkspace =
    state?.snapshot.directory === update.directory && state?.snapshot.database === update.database;
  const events = sameWorkspace ? { ...state.events } : {};
  const after = sameWorkspace ? state.snapshot.revision : -1;
  for (const entry of update.events) {
    if (entry.revision <= after) continue;
    const id = entry.event.runId;
    events[id] = [...(events[id] ?? []), entry.event];
  }
  const previousChats = state?.snapshot.database === update.database ? state.chatEventsByRun : {};
  const chatEventsByRun: Record<string, RunEvent[]> = {};
  for (const chat of update.chats.length ? update.chats : [update.chat]) {
    const id = chat.run?.id;
    if (!id) continue;
    const previous = previousChats?.[id];
    const merged = [...(previous ?? [])];
    const after = previous ? (state?.snapshot.revision ?? -1) : -1;
    for (const entry of chat.events) {
      if (entry.revision > after && entry.event.runId === id) merged.push(entry.event);
    }
    chatEventsByRun[id] = merged;
  }
  const chatEvents = chatEventsByRun[update.chat.run?.id ?? ""] ?? [];
  return {
    snapshot: {
      ...update,
      events: [],
      chat: { ...update.chat, events: [] },
      chats: update.chats.map((chat) => ({ ...chat, events: [] })),
    },
    events,
    chatEvents,
    chatEventsByRun,
  };
}

export interface Block {
  type: RunEvent["type"];
  text: string;
  key: string;
  /** Expandable detail, such as the summary a handoff note refers to. */
  detail?: string;
  /** Set on prompts Code60 generated instead of the user. */
  automatic?: boolean;
}

/** Chat blocks: the text of each event, without speaker, turn, or status labels. */
export function transcript(events: readonly RunEvent[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, Block>();
  let open: Block | undefined;
  for (const [index, event] of events.entries()) {
    // Raw protocol records must not split the corresponding streamed text message.
    if (event.type === "acp") continue;
    if (event.type === "message" || event.type === "thought") {
      if (open?.type === event.type) open.text += event.text;
      else {
        open = { key: String(index), type: event.type, text: event.text };
        blocks.push(open);
      }
      continue;
    }
    open = undefined;
    let text: string;
    switch (event.type) {
      case "status":
      case "turnEnd":
        continue;
      case "prompt":
        if (event.origin === "automatic") {
          blocks.push({ key: String(index), type: event.type, text: event.text, automatic: true });
          continue;
        }
        text = event.text;
        break;
      case "stderr":
        text = event.text;
        break;
      case "toolCall": {
        const existing = tools.get(event.toolCallId);
        text = `${event.title}\n${event.kind} / ${event.status}`;
        if (existing) {
          existing.text = text;
          continue;
        }
        const block: Block = { key: String(index), type: event.type, text };
        tools.set(event.toolCallId, block);
        blocks.push(block);
        continue;
      }
      case "permission":
        text = `${event.decision} by ${event.by} / ${event.title}`;
        break;
      case "note":
        blocks.push({
          key: String(index),
          type: event.type,
          text: event.text,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        });
        continue;
    }
    blocks.push({ key: String(index), type: event.type, text });
  }
  return blocks;
}
export interface SessionRow {
  id: string;
  shortId: string;
  agent: string;
  status: RunStatus;
  statusLabel: string;
  turns: number;
  approvals: number;
  branch: string | null;
  pid: number | null;
  startedAt: string;
}

/** Table rows for the sessions grid, newest first; live run views take priority over records. */
export function sessionRows(runs: readonly DesktopRun[]): SessionRow[] {
  return runs
    .map((run) => {
      const status = run.view?.status ?? run.record.status;
      return {
        id: run.record.id,
        shortId: run.record.id.slice(-6),
        agent: run.record.agent,
        status,
        statusLabel: `${statusSpec[status].label}${run.record.discardedAt ? " / discarded" : ""}`,
        turns: run.view?.turns ?? run.record.turns,
        approvals: run.view?.pending.length ?? 0,
        branch: run.record.branch,
        pid: run.record.agentPid ?? null,
        startedAt: run.record.startedAt,
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export type Theme = "light" | "dark" | "system";
export function parseTheme(value: string | null): Theme {
  if (value === "paper") return "light";
  return value === "light" || value === "dark" ? value : "system";
}
/**
 * How each run state is written in the interface. Every state has a label and an icon; routine
 * states stay quiet, approval is inverted, and abnormal stops carry a warning and a left rule.
 */
export const statusSpec: Record<
  RunStatus,
  { label: string; icon: IconName; emphasis: "quiet" | "active" | "decision" | "abnormal" }
> = {
  queued: { label: "Queued", icon: "time", emphasis: "quiet" },
  running: { label: "Working", icon: "play--filled", emphasis: "active" },
  waiting: { label: "Needs approval", icon: "pause", emphasis: "decision" },
  idle: { label: "Ready", icon: "chat", emphasis: "active" },
  finished: { label: "Finished", icon: "checkmark", emphasis: "quiet" },
  failed: { label: "Failed", icon: "warning--alt--filled", emphasis: "abnormal" },
  cancelled: { label: "Cancelled", icon: "stop", emphasis: "quiet" },
  timed_out: { label: "Timed out", icon: "warning--alt--filled", emphasis: "abnormal" },
  interrupted: { label: "Interrupted", icon: "warning--alt--filled", emphasis: "abnormal" },
};
const appearanceKeys = [
  "textStyles",
  "typeface",
  "theme",
  "tableLines",
  "rowDensity",
  "fitColumns",
  "signals",
  "gridCharts",
];
/** Reset every appearance setting once for the current theme, leaving other data intact. */
export function migrateAppearance(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): void {
  if (storage.getItem("code60.appearanceVersion") === "theme-4") return;
  for (const key of appearanceKeys) storage.removeItem(`code60.${key}`);
  for (const table of ["sessions", "messages", "configurations", "worktrees", "polling"])
    storage.removeItem(`code60.tableView.v1:${table}`);
  storage.setItem("code60.appearanceVersion", "theme-4");
}
const systemFont = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const typefaces = [
  { id: "system", label: "System", family: systemFont },
  { id: "computer-modern", label: "Computer Modern", family: '"CMU Serif", Georgia, serif' },
  { id: "d-din", label: "D-DIN", family: `"D-DIN", ${systemFont}` },
  { id: "georgia", label: "Georgia", family: "Georgia, serif" },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", family: `"IBM Plex Sans", ${systemFont}` },
  { id: "ibm-plex-serif", label: "IBM Plex Serif", family: '"IBM Plex Serif", Georgia, serif' },
  { id: "shantell-sans", label: "Shantell Sans", family: '"Shantell Sans", sans-serif' },
  { id: "ocr-a", label: "OCR-A", family: '"OCR-A", ui-monospace, monospace' },
  { id: "roboto", label: "Roboto", family: `Roboto, ${systemFont}` },
  { id: "tahoma", label: "Tahoma", family: `Tahoma, Verdana, ${systemFont}` },
  { id: "verdana", label: "Verdana", family: `Verdana, ${systemFont}` },
] as const;
export type Typeface = (typeof typefaces)[number]["id"];
export function parseTypeface(value: string | null): Typeface {
  return typefaces.find((typeface) => typeface.id === value)?.id ?? "system";
}
export function fontFamily(typeface: Typeface): string {
  return typefaces.find((entry) => entry.id === typeface)?.family ?? systemFont;
}
export function letterSpacing(typeface: Typeface): string {
  const entry: { family: string; letterSpacing?: string } | undefined = typefaces.find(
    (item) => item.id === typeface,
  );
  return entry?.letterSpacing ?? "normal";
}
export const monospaceFont = "ui-monospace, SFMono-Regular, Menlo, monospace";
/** Text that can be styled on its own. `size` and `weight` are the built-in defaults. */
export const textRoles = [
  { id: "tableHeadings", label: "Table Headings", css: "heading", size: 12, weight: 400 },
  { id: "buttons", label: "Button Text", css: "button", size: 13, weight: 400 },
  { id: "agentMessages", label: "Agent Chat Messages", css: "agent", size: 14, weight: 400 },
  { id: "humanMessages", label: "Human Chat Messages", css: "human", size: 14, weight: 400 },
  { id: "pageTitles", label: "Page Titles", css: "title", size: 18, weight: 400 },
  { id: "normalText", label: "Normal Text", css: "text", size: 13, weight: 400 },
] as const;
export type TextRole = (typeof textRoles)[number]["id"];
export const fontWeights = [
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
] as const;
export type FontWeight = (typeof fontWeights)[number]["value"];
export const fontSizes = { min: 8, max: 48 } as const;
/** A role's choices; anything left out keeps the built-in default. */
export type TextStyle = {
  typeface?: Typeface | undefined;
  size?: number | undefined;
  weight?: FontWeight | undefined;
  case?: "upper" | "lower" | "none" | undefined;
};
export type TextStyles = Record<TextRole, TextStyle>;
export const defaultTextStyles: TextStyles = {
  tableHeadings: {},
  buttons: {},
  agentMessages: {},
  humanMessages: {},
  pageTitles: {},
  normalText: {},
};
/** Reads stored text styles, dropping anything invalid. */
export function parseTextStyles(value: string | null): TextStyles {
  const styles: TextStyles = structuredClone(defaultTextStyles);
  let stored: unknown;
  try {
    stored = JSON.parse(value ?? "null");
  } catch {}
  if (!stored || typeof stored !== "object") return styles;
  for (const role of textRoles) {
    const entry = (stored as Record<string, unknown>)[role.id];
    if (!entry || typeof entry !== "object") continue;
    const { typeface, size, weight, case: textCase } = entry as Record<string, unknown>;
    const style = styles[role.id];
    const known = typefaces.find((item) => item.id === typeface)?.id;
    if (known) style.typeface = known;
    if (
      typeof size === "number" &&
      Number.isInteger(size) &&
      size >= fontSizes.min &&
      size <= fontSizes.max
    )
      style.size = size;
    const knownWeight = fontWeights.find((item) => item.value === weight)?.value;
    if (knownWeight) style.weight = knownWeight;
    if (textCase === "upper" || textCase === "lower" || textCase === "none") style.case = textCase;
  }
  return styles;
}
/** Apply D-DIN Regular once, preserving sizes, case, theme and later user choices. */
export function migrateTypography(storage: Pick<Storage, "getItem" | "setItem">): void {
  if (storage.getItem("code60.typographyVersion") === "d-din-regular-1") return;
  const styles = parseTextStyles(storage.getItem("code60.textStyles"));
  for (const role of textRoles) {
    delete styles[role.id].typeface;
    delete styles[role.id].weight;
  }
  storage.setItem("code60.textStyles", JSON.stringify(styles));
  storage.setItem("code60.typographyVersion", "d-din-regular-1");
}
/** The concrete text style a role draws with, after applying defaults. */
export type ResolvedText = {
  family: string;
  spacing: string;
  size: number;
  weight: FontWeight;
  case: TextStyle["case"];
};
export function resolveText(styles: TextStyles, role: TextRole): ResolvedText {
  const style = styles[role];
  const defaults = textRoles.find((entry) => entry.id === role) ?? textRoles[5];
  const typeface = style.typeface ?? "d-din";
  return {
    family: fontFamily(typeface),
    spacing: letterSpacing(typeface),
    size: style.size ?? defaults.size,
    weight: style.weight ?? defaults.weight,
    case: style.case,
  };
}
export function applyCase(text: string, textCase: ResolvedText["case"]): string {
  if (textCase === "upper") return text.toUpperCase();
  if (textCase === "lower") return text.toLowerCase();
  return text;
}
/**
 * CSS custom properties for the text styles. Family, spacing, size, and weight are always set;
 * case only when chosen. Sent prompts use regular weight unless a weight is chosen.
 */
export function textStyleProperties(styles: TextStyles): Record<string, string | undefined> {
  const properties: Record<string, string | undefined> = {};
  for (const role of textRoles) {
    const resolved = resolveText(styles, role.id);
    const prefix = `--${role.css}`;
    properties[`${prefix}-font`] = resolved.family;
    properties[`${prefix}-spacing`] = resolved.spacing;
    properties[`${prefix}-tracking`] = resolved.spacing === "normal" ? undefined : resolved.spacing;
    properties[`${prefix}-size`] = `${resolved.size}px`;
    properties[`${prefix}-weight`] = String(resolved.weight);
    properties[`${prefix}-case`] =
      resolved.case === "upper"
        ? "uppercase"
        : resolved.case === "lower"
          ? "lowercase"
          : resolved.case === "none"
            ? "none"
            : undefined;
  }
  const human = styles.humanMessages.weight;
  properties["--human-prompt-weight"] = human ? String(human) : undefined;
  return properties;
}
export const rowDensities = [
  { id: "high", label: "High", height: 24 },
  { id: "medium", label: "Medium", height: 32 },
  { id: "low", label: "Low", height: 44 },
] as const;
export type RowDensity = (typeof rowDensities)[number]["id"];
export function parseRowDensity(value: string | null): RowDensity {
  return rowDensities.find((density) => density.id === value)?.id ?? "high";
}
export function rowHeight(density: RowDensity): number {
  return rowDensities.find((entry) => entry.id === density)?.height ?? 32;
}
/** `heading` is the pair of lines directly above and below the column headings. */
/**
 * Scales column widths to fill `available` pixels, keeping their proportions. Widths are whole
 * pixels, the last column takes the rounding remainder, and none goes below `min`.
 */
export function fitWidths(widths: readonly number[], available: number, min = 20): number[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (!widths.length || total <= 0) return [...widths];
  if (available <= min * widths.length) return widths.map(() => min);
  const fitted = widths.map((width) => Math.max(min, Math.floor((width / total) * available)));
  const used = fitted.reduce((sum, width) => sum + width, 0);
  fitted[fitted.length - 1] = Math.max(min, (fitted.at(-1) ?? min) + available - used);
  return fitted;
}
export function parseFitColumns(value: string | null): boolean {
  return value === "true";
}
export type TableLines = { horizontal: boolean; vertical: boolean; heading: boolean };
/** Reads stored table line settings, keeping the defaults for anything missing or invalid. */
export function parseTableLines(value: string | null): TableLines {
  const lines: TableLines = { horizontal: false, vertical: false, heading: false };
  try {
    const stored: unknown = JSON.parse(value ?? "{}");
    if (stored && typeof stored === "object") {
      for (const key of ["horizontal", "vertical", "heading"] as const) {
        const setting = (stored as Record<string, unknown>)[key];
        if (typeof setting === "boolean") lines[key] = setting;
      }
    }
  } catch {}
  return lines;
}

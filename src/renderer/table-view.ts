import { useEffect, useState } from "react";
import type { RowDensity, TableLines } from "./table-preferences.js";

export type TableId =
  | "automations"
  | "automation-history"
  | "memories"
  | "logs"
  | "sessions"
  | "messages"
  | "events"
  | "configurations"
  | "worktrees"
  | "polling";
export interface TableView {
  lines: TableLines;
  density: RowDensity;
  fit: boolean;
  charts: boolean;
  hidden: string[];
  order: string[];
  widths: Record<string, number>;
}
export type ViewDefaults = Pick<TableView, "lines" | "density" | "fit"> & { charts?: boolean };
export function defaultView(defaults: ViewDefaults): TableView {
  return {
    lines: { ...defaults.lines },
    density: defaults.density,
    fit: defaults.fit,
    charts: defaults.charts ?? true,
    hidden: [],
    order: [],
    widths: {},
  };
}
export const viewKey = (id: TableId) => `code60.tableView.v1:${id}`;

export function parseView(value: string | null, defaults: ViewDefaults): TableView {
  const fallback = defaultView(defaults);
  try {
    const data = JSON.parse(value ?? "null") as Partial<TableView> | null;
    if (!data || typeof data !== "object" || Array.isArray(data)) return fallback;
    return {
      lines: {
        horizontal:
          typeof data.lines?.horizontal === "boolean"
            ? data.lines.horizontal
            : defaults.lines.horizontal,
        vertical:
          typeof data.lines?.vertical === "boolean" ? data.lines.vertical : defaults.lines.vertical,
        heading:
          typeof data.lines?.heading === "boolean" ? data.lines.heading : defaults.lines.heading,
      },
      density: ["high", "medium", "low"].includes(data.density ?? "")
        ? (data.density as RowDensity)
        : defaults.density,
      fit: typeof data.fit === "boolean" ? data.fit : defaults.fit,
      charts: typeof data.charts === "boolean" ? data.charts : fallback.charts,
      hidden: Array.isArray(data.hidden)
        ? data.hidden.filter((id): id is string => typeof id === "string")
        : [],
      order: Array.isArray(data.order)
        ? [...new Set(data.order.filter((id): id is string => typeof id === "string"))]
        : [],
      widths:
        data.widths && typeof data.widths === "object"
          ? Object.fromEntries(
              Object.entries(data.widths).filter(
                ([key, width]) =>
                  key !== "__proto__" &&
                  typeof width === "number" &&
                  Number.isFinite(width) &&
                  width >= 50 &&
                  width <= 500,
              ),
            )
          : {},
    };
  } catch {
    return fallback;
  }
}

export function useTableView(id: TableId, defaults: ViewDefaults, enabled = true) {
  const [saved, setSaved] = useState<TableView | undefined>(() => {
    try {
      const value = localStorage.getItem(viewKey(id));
      return value === null ? undefined : parseView(value, defaults);
    } catch {
      return undefined;
    }
  });
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    try {
      if (saved) localStorage.setItem(viewKey(id), JSON.stringify(saved));
      else localStorage.removeItem(viewKey(id));
      setError("");
    } catch {
      setError("Table preferences could not be stored. Changes last until the app closes.");
    }
  }, [id, saved, enabled]);
  return [saved ?? defaultView(defaults), setSaved, error] as const;
}

export type FilterKind = "text" | "number" | "date" | "category";
export type ColumnFilter = {
  op: "contains" | "eq" | "ne" | "ge" | "le" | "empty" | "present" | "recent" | "older";
  value: string;
};
export const filterLabels: Record<ColumnFilter["op"], string> = {
  recent: "Within the last (minutes)",
  older: "More than (minutes) ago",
  contains: "Contains",
  eq: "Is",
  ne: "Is not",
  ge: "At least / on or after",
  le: "At most / on or before",
  empty: "Is empty",
  present: "Is present",
};
export function matchesColumn(
  raw: unknown,
  text: string,
  kind: FilterKind,
  filter: ColumnFilter,
  now = Date.now(),
): boolean {
  const empty = raw === null || raw === undefined || raw === "";
  if (filter.op === "empty") return empty;
  if (filter.op === "present") return !empty;
  if (empty) return false;
  const actual =
    kind === "number"
      ? Number(raw)
      : kind === "date"
        ? typeof raw === "number"
          ? raw
          : Date.parse(String(raw))
        : text.toLocaleLowerCase();
  if (filter.op === "recent" || filter.op === "older") {
    const minutes = Number(filter.value);
    if (
      kind !== "date" ||
      typeof actual !== "number" ||
      !Number.isFinite(actual) ||
      !filter.value.trim() ||
      !Number.isFinite(minutes) ||
      minutes < 0
    )
      return false;
    const boundary = now - minutes * 60000;
    return filter.op === "recent" ? actual >= boundary && actual <= now : actual < boundary;
  }
  const expected =
    kind === "number"
      ? Number(filter.value)
      : kind === "date"
        ? Date.parse(filter.value)
        : filter.value.toLocaleLowerCase();
  if (filter.op === "contains") return String(actual).includes(String(expected));
  if (typeof actual === "number" && (!Number.isFinite(actual) || !Number.isFinite(expected)))
    return false;
  switch (filter.op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "ge":
      return actual >= expected;
    case "le":
      return actual <= expected;
  }
}
export function orderedColumns<T extends { key: string }>(
  columns: readonly T[],
  view: Pick<TableView, "hidden" | "order">,
): T[] {
  const visible = columns.filter((column) => !view.hidden.includes(column.key));
  const safe = visible.length ? visible : columns.slice(0, 1);
  return [...safe].sort((a, b) => {
    const aIndex = view.order.indexOf(a.key);
    const bIndex = view.order.indexOf(b.key);
    return (aIndex < 0 ? view.order.length : aIndex) - (bIndex < 0 ? view.order.length : bIndex);
  });
}

import {
  CompactSelection,
  DataEditor,
  type DataEditorRef,
  type GridCell,
  GridCellKind,
  type GridSelection,
  type Item,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FilterControls } from "./filter-controls.js";
import { drawIcon, Icon } from "./icons.js";
import {
  filterProblem,
  matchesSavedFilter,
  type SavedFilter,
  useSavedFilters,
} from "./saved-filters.js";
import { useTableAppearance } from "./table-appearance.js";
import { ColumnMenu, TableControlGroup } from "./table-controls.js";
import { fitWidths, type RowDensity, rowHeight, type TableLines } from "./table-preferences.js";
import { type SettingsColumn, TableSettings } from "./table-settings.js";
import {
  type ColumnFilter,
  type FilterKind,
  matchesColumn,
  orderedColumns,
  type TableId,
  useTableView,
} from "./table-view.js";
import { useTicker } from "./ticker.js";
import { applyCase, type TextStyles } from "./typography.js";

export { useCssColors } from "./table-appearance.js";

const markerWidth = 40;
const tableTitles: Record<TableId, string> = {
  automations: "Schedules",
  "automation-history": "Execution history",
  memories: "Memories",
  logs: "Logs",
  sessions: "Sessions",
  messages: "Messages",
  events: "Events",
  configurations: "Configurations",
  worktrees: "Worktrees",
  polling: "Polling",
};

function dataColumnIndex(index: number, actionsColumn: number): number {
  return actionsColumn >= 0 && index >= actionsColumn ? index - 1 : index;
}

function compare<Row, Key extends keyof Row>(a: Row, b: Row, key: Key): number {
  const x = a[key] ?? "";
  const y = b[key] ?? "";
  return typeof x === "number" && typeof y === "number"
    ? x - y
    : String(x).localeCompare(String(y));
}

export interface TableOptions {
  tableId: TableId;
  actions?: ReactNode;
  workspace?: string | undefined;
  lines: TableLines;
  density: RowDensity;
  fit: boolean;
  textStyles: TextStyles;
  selected: string | undefined;
  onSelect(id: string): void;
}
export interface RetainedTableQuery {
  search: string;
  conditions: { column: string; op: ColumnFilter["op"]; value: string }[];
  columnConditions: { column: string; op: ColumnFilter["op"]; value: string }[];
  match: "all" | "any";
}

type Paint = (
  args: Parameters<NonNullable<ComponentProps<typeof DataEditor>["drawCell"]>>[0],
) => void;

export function DataTable<Row extends { id: string }, Key extends keyof Row & string>({
  rows,
  selected,
  onSelect,
  onActions,
  lines: defaultLines,
  density: defaultDensity,
  fit: defaultFit,
  textStyles,
  columns: allColumns,
  settingsColumns,
  defaultCharts = true,
  display,
  initialSort,
  initialDescending = false,
  tint,
  align,
  paint,
  parent,
  hasActions,
  tableId,
  workspace,
  onAdd,
  addLabel,
  addDisabled,
  viewState,
  actions: toolbarActions,
  scope,
  onRetainedQuery,
}: {
  rows: Row[];
  columns: { key: Key; title: string; width: number; filter?: FilterKind }[];
  settingsColumns?: SettingsColumn[];
  defaultCharts?: boolean;
  onAdd?(): void;
  addLabel?: string;
  addDisabled?: boolean;
  viewState?: ReturnType<typeof useTableView>;
  display(row: Row, key: Key): string;
  initialSort: Key;
  initialDescending?: boolean;
  tint?(row: Row, key: Key): string | undefined;
  align?(key: Key): "left" | "right";
  /** Draws a cell itself and returns true, or returns false for the default text. */
  paint?(args: Parameters<Paint>[0], row: Row, key: Key): boolean;
  onActions?(id: string, bounds: Rectangle, contextual?: boolean): void;
  /** Nests a row under the row with this ID; nested rows keep their given order under it. */
  parent?(row: Row): string | undefined;
  /** Whether a row's Actions cell opens its menu; defaults to every row. */
  hasActions?(row: Row): boolean;
  /** Store-wide selectors shown beside the title, separate from page-local table filters. */
  scope?: ReactNode;
  /** Server-backed tables apply search and filters to retained history, not this page. */
  onRetainedQuery?(query: RetainedTableQuery): void;
} & TableOptions) {
  const ownView = useTableView(
    tableId,
    { lines: defaultLines, density: defaultDensity, fit: defaultFit },
    !viewState,
  );
  const [view, setView, storageError] = viewState ?? ownView;
  const { lines, density, fit } = view;
  const columns = useMemo(() => orderedColumns(allColumns, view), [allColumns, view]);
  const columnKeys = columns.map((column) => column.key);
  const gridKeys = [...columnKeys];
  if (onActions) gridKeys.splice(1, 0, "actions" as Key);
  const actionsColumn = onActions ? 1 : -1;
  const [filters, setFilters] = useState<Partial<Record<Key, ColumnFilter>>>({});
  const named = useSavedFilters(tableId, workspace ?? "none");
  const fields = allColumns.map((column) => ({
    key: column.key,
    title: column.title,
    kind:
      column.filter ??
      (typeof rows.find((row) => row[column.key] != null)?.[column.key] === "number"
        ? ("number" as const)
        : ("text" as const)),
  }));
  const definition = named.library.definitions.find(
    (item) => item && typeof item === "object" && "id" in item && item.id === named.library.active,
  );
  const incompatibility = named.library.active ? filterProblem(definition, fields) : "";
  const activeFilter = definition && !incompatibility ? (definition as SavedFilter) : undefined;
  const now = useTicker(
    !!activeFilter?.conditions.some((rule) => rule.op === "recent" || rule.op === "older") ||
      Object.values(filters).some(
        (rule) => (rule as ColumnFilter)?.op === "recent" || (rule as ColumnFilter)?.op === "older",
      ),
    30000,
  );
  const matchesColumns = useCallback(
    (row: Row) =>
      allColumns.every((column) => {
        const filter = filters[column.key];
        return (
          !filter ||
          matchesColumn(
            row[column.key],
            display(row, column.key),
            column.filter ?? (typeof row[column.key] === "number" ? "number" : "text"),
            filter,
            now,
          )
        );
      }),
    [allColumns, display, filters, now],
  );
  const matchesNamed = useCallback(
    (row: Row, filter: SavedFilter, at = now) =>
      matchesSavedFilter(
        filter,
        (key) => ({ raw: row[key as Key], text: display(row, key as Key) }),
        at,
      ),
    [display, now],
  );
  const [showSearch, setShowSearch] = useState(false);
  const findShortcut = navigator.platform.startsWith("Mac") ? "⌘F" : "Ctrl+F";
  const [retainedSearch, setRetainedSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const retainedHandler = useRef(onRetainedQuery);
  const focusRetainedSearch = useCallback(
    (element: HTMLInputElement | null) => element?.focus(),
    [],
  );
  retainedHandler.current = onRetainedQuery;
  const retainedQuery = JSON.stringify({
    search: submittedSearch,
    match: activeFilter?.mode ?? "all",
    conditions:
      activeFilter?.conditions.map(({ column, op, value }) => ({ column, op, value })) ?? [],
    columnConditions: Object.entries(filters).map(([column, rule]) => ({
      column,
      ...(rule as ColumnFilter),
    })),
  });
  useEffect(() => {
    retainedHandler.current?.(JSON.parse(retainedQuery) as RetainedTableQuery);
  }, [retainedQuery]);
  const [settings, setSettings] = useState<string>();
  const settingsScope = JSON.stringify([tableId, workspace]);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const closeSettings = () => {
    setSettings(undefined);
    if (settingsTrigger.current?.checkVisibility()) settingsTrigger.current.focus();
  };
  const [headerMenu, setHeaderMenu] = useState<{ key: Key; bounds: Rectangle }>();
  const [currentId, setCurrentId] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters are scoped to the workspace, not persisted.
  useEffect(() => {
    setSettings(undefined);
    setFilters({});
    setShowSearch(false);
    setHeaderMenu(undefined);
    setCurrent(undefined);
    setCurrentId(undefined);
  }, [workspace, tableId]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (
        !container.current?.closest(".page-panel")?.checkVisibility() ||
        document.querySelector("dialog[open]")
      )
        return;
      event.preventDefault();
      setShowSearch(true);
    };
    window.addEventListener("keydown", find);
    return () => window.removeEventListener("keydown", find);
  }, []);
  const { color, heading, normal, cellTheme, theme, tracking, getRowThemeOverride } =
    useTableAppearance(textStyles, lines);
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({
    key: initialSort,
    desc: initialDescending,
  });
  const [current, setCurrent] = useState<GridSelection["current"]>(undefined);
  const grid = useRef<DataEditorRef>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const actions = useRef(onActions);
  actions.current = onActions;

  // In fit mode the columns share the grid's width, less the row numbers and any scrollbar.
  const container = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a row or density change can show or hide the scrollbar.
  useEffect(() => {
    const element = container.current;
    if (!fit || !element) return;
    const measure = () => {
      const scroller = element.querySelector<HTMLElement>(".dvn-scroller");
      const scrollbar = scroller ? scroller.offsetWidth - scroller.clientWidth : 0;
      setAvailable(element.clientWidth - markerWidth - scrollbar);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit, rows.length, density]);

  const sorted = useMemo(() => {
    const direction = sort.desc ? -1 : 1;
    const top = rows.filter(
      (row) =>
        !parent?.(row) &&
        (onRetainedQuery ||
          (matchesColumns(row) && (!activeFilter || matchesNamed(row, activeFilter)))),
    );
    top.sort((a, b) => direction * compare(a, b, sort.key));
    if (!parent) return top;
    const children = new Map<string, Row[]>();
    for (const row of rows) {
      const id = parent(row);
      if (id) children.set(id, [...(children.get(id) ?? []), row]);
    }
    return top.flatMap((row) => [row, ...(children.get(row.id) ?? [])]);
  }, [rows, sort, parent, matchesColumns, activeFilter, matchesNamed, onRetainedQuery]);
  const actionable = (row: Row | undefined) => !!row && (hasActions?.(row) ?? true);

  const gridColumns = useMemo(() => {
    const list = columns.map((column) => ({
      id: String(column.key),
      title: applyCase(column.title, heading.case),
      width: view.widths[column.key] ?? column.width,
      hasMenu: true,
      trailingRowOptions: { disabled: !!addDisabled },
    }));
    if (onActions)
      list.splice(actionsColumn, 0, {
        id: "actions",
        title: applyCase("Actions", heading.case),
        width: view.widths.actions ?? 90,
        hasMenu: false,
        trailingRowOptions: { disabled: true },
      });
    if (!fit || available === undefined) return list;
    const fitted = fitWidths(
      list.map((column) => column.width),
      available,
    );
    return list.map((column, index) => ({ ...column, width: fitted[index] ?? column.width }));
  }, [columns, onActions, view.widths, heading.case, fit, available, actionsColumn, addDisabled]);

  const drawHeader: NonNullable<ComponentProps<typeof DataEditor>["drawHeader"]> = (
    args,
    content,
  ) => {
    tracking.header(args, content);
    if (args.column.id !== sort.key) return;
    // Sorted columns carry a Carbon arrow at the right edge of the heading.
    const { ctx, rect } = args;
    ctx.save();
    ctx.fillStyle = color("--text");
    drawIcon(
      ctx,
      sort.desc ? "arrow--down" : "arrow--up",
      rect.x + rect.width - 44,
      rect.y + rect.height / 2 - 8,
    );
    ctx.restore();
  };

  const rowMarkers = useMemo(
    () => ({
      kind: "number" as const,
      width: markerWidth,
      theme: { ...cellTheme, textLight: color("--muted"), textMedium: color("--muted") },
    }),
    [color, cellTheme],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const session = sorted[row];
      if (session && col === actionsColumn) {
        const label = (hasActions?.(session) ?? true) ? "Actions" : "";
        return {
          kind: GridCellKind.Text,
          data: label,
          displayData: applyCase(label, normal.case),
          allowOverlay: false,
          readonly: true,
          themeOverride: cellTheme,
        };
      }
      const key = columns[dataColumnIndex(col, actionsColumn)]?.key;
      if (!session || !key) return { kind: GridCellKind.Loading, allowOverlay: false };
      const text = display(session, key);
      const colorName = tint?.(session, key);
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: applyCase(text, normal.case),
        allowOverlay: false,
        readonly: true,
        contentAlign: align?.(key) ?? "left",
        themeOverride: { ...cellTheme, ...(colorName ? { textDark: color(colorName) } : {}) },
      };
    },
    [
      sorted,
      color,
      cellTheme,
      normal.case,
      columns,
      display,
      tint,
      align,
      actionsColumn,
      hasActions,
    ],
  );

  // Selection belongs to the session ID, so it follows the row through sorting and updates.
  const selectedIndex = sorted.findIndex((row) => row.id === selected);
  const focusedIndex = sorted.findIndex((row) => row.id === currentId);
  const focused =
    current && focusedIndex >= 0
      ? {
          ...current,
          cell: [Math.min(current.cell[0], gridColumns.length - 1), focusedIndex] as Item,
          range: {
            ...current.range,
            x: Math.min(current.cell[0], gridColumns.length - 1),
            y: focusedIndex,
          },
        }
      : undefined;
  const selection: GridSelection = {
    ...(focused ? { current: focused } : {}),
    rows:
      selectedIndex < 0
        ? CompactSelection.empty()
        : CompactSelection.fromSingleSelection(selectedIndex),
    columns: CompactSelection.empty(),
  };

  // The Actions cell opens its menu instead of the chat, by mouse or by Enter.
  const open = ([col, row]: Item) => {
    const session = sorted[row];
    if (!session) return;
    if (col !== actionsColumn || !actionable(session)) return select.current(session.id);
    const bounds = grid.current?.getBounds(col, row);
    if (bounds) actions.current?.(session.id, bounds);
  };

  const drawCell: NonNullable<ComponentProps<typeof DataEditor>["drawCell"]> = (args, content) => {
    if (args.col === actionsColumn) {
      tracking.cell(args, content);
      if (!actionable(sorted[args.row])) return;
      const { ctx, rect } = args;
      ctx.save();
      ctx.fillStyle = color("--muted");
      drawIcon(ctx, "chevron--down", rect.x + rect.width - 24, rect.y + rect.height / 2 - 8);
      ctx.restore();
      return;
    }
    const key = columns[dataColumnIndex(args.col, actionsColumn)]?.key;
    const row = sorted[args.row];
    if (!key || !row || !paint) return tracking.cell(args, content);
    const { ctx, rect } = args;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    const drawn = paint(args, row, key);
    ctx.restore();
    if (!drawn) tracking.cell(args, content);
  };
  return (
    <div className="data-table" data-heading-lines={lines.heading}>
      <div className="table-controls">
        <h1 className="table-title">{tableTitles[tableId]}</h1>
        {scope && <div className="table-scope">{scope}</div>}
        <TableControlGroup label="Table controls">
          <button
            type="button"
            className="icon-button"
            onClick={() => setShowSearch(true)}
            aria-label={`Search ${tableId}`}
            data-tooltip="Search"
            data-tooltip-keys={findShortcut}
          >
            <Icon name="search" />
          </button>
          <FilterControls
            key={`${tableId}:${workspace}`}
            fields={fields}
            library={named.library}
            error={named.error}
            onChange={named.update}
            preview={(filter, at) =>
              rows.filter(
                (row) => !parent?.(row) && matchesColumns(row) && matchesNamed(row, filter, at),
              ).length
            }
            retained={!!onRetainedQuery}
          />
          <span className="icon-select">
            <Icon name="column" />
            <select
              aria-label="Column menu"
              data-tooltip="Column filter and sort"
              value=""
              onChange={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                if (event.target.value) setHeaderMenu({ key: event.target.value as Key, bounds });
              }}
            >
              <option value="">Columns…</option>
              {allColumns.map((column) => (
                <option key={column.key} value={column.key}>
                  {column.title}
                </option>
              ))}
            </select>
          </span>
          <button
            type="button"
            className="icon-button"
            ref={settingsTrigger}
            aria-haspopup="dialog"
            aria-label="Settings"
            data-tooltip="Table settings"
            onClick={() => setSettings(settingsScope)}
          >
            <Icon name="settings--adjust" />
          </button>
          {toolbarActions && <span className="table-toolbar-divider" aria-hidden="true" />}
          {toolbarActions}
          {onAdd && (
            <button
              type="button"
              className="table-add-accessible"
              disabled={addDisabled}
              onClick={onAdd}
            >
              {addLabel}
            </button>
          )}
        </TableControlGroup>
      </div>
      {incompatibility && (
        <p role="alert">Saved filter is incompatible and has not been applied: {incompatibility}</p>
      )}
      {storageError && <p role="status">{storageError}</p>}
      {onRetainedQuery && showSearch && (
        <form
          className="table-filter-bar"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedSearch(retainedSearch);
          }}
        >
          <input
            ref={focusRetainedSearch}
            className="table-search-input"
            aria-label="Search retained logs"
            placeholder="Search retained logs"
            maxLength={200}
            value={retainedSearch}
            onChange={(event) => setRetainedSearch(event.target.value)}
          />
          <button type="submit" className="icon-button" aria-label="Search history">
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close search"
            onClick={() => {
              setRetainedSearch("");
              setSubmittedSearch("");
              setShowSearch(false);
              grid.current?.focus();
            }}
          >
            <Icon name="close" />
          </button>
        </form>
      )}
      {settings === settingsScope &&
        createPortal(
          <TableSettings
            title={`${tableTitles[tableId]} table settings`}
            tableId={tableId}
            columns={settingsColumns ?? allColumns}
            defaults={{
              lines: defaultLines,
              density: defaultDensity,
              fit: defaultFit,
              charts: defaultCharts,
            }}
            view={view}
            onApply={setView}
            onClose={closeSettings}
            charts={tableId === "sessions"}
            actions={!!onActions}
            textStyles={textStyles}
          />,
          document.body,
        )}
      {Object.keys(filters).length > 0 && (
        <section className="table-filter-bar" aria-label="Applied column filters">
          {allColumns
            .filter((column) => filters[column.key])
            .map((column) => (
              <button
                type="button"
                className="filter-chip"
                key={column.key}
                aria-label={`Clear ${column.title} filter`}
                onClick={() =>
                  setFilters((value) => {
                    const next = { ...value };
                    delete next[column.key];
                    return next;
                  })
                }
              >
                {column.title}
                <Icon name="close" />
              </button>
            ))}
          <button type="button" className="link-button" onClick={() => setFilters({})}>
            Clear all filters
          </button>
          <span className="table-filter-count" role="status">
            {sorted.filter((row) => !parent?.(row)).length} of{" "}
            {rows.filter((row) => !parent?.(row)).length} rows
          </span>
        </section>
      )}
      {headerMenu &&
        createPortal(
          <ColumnMenu
            key={headerMenu.key}
            title={
              allColumns.find((column) => column.key === headerMenu.key)?.title ?? headerMenu.key
            }
            kind={
              allColumns.find((column) => column.key === headerMenu.key)?.filter ??
              (typeof rows.find((row) => row[headerMenu.key] !== null)?.[headerMenu.key] ===
              "number"
                ? "number"
                : "text")
            }
            values={[
              ...new Set(
                rows.filter((row) => !parent?.(row)).map((row) => display(row, headerMenu.key)),
              ),
            ].sort()}
            filter={filters[headerMenu.key]}
            bounds={headerMenu.bounds}
            onClose={() => {
              setHeaderMenu(undefined);
              grid.current?.focus();
            }}
            onSort={(desc) => {
              setSort({ key: headerMenu.key, desc });
              setHeaderMenu(undefined);
            }}
            onFilter={(filter) => {
              setFilters((value) => {
                const next = { ...value };
                if (filter) next[headerMenu.key] = filter;
                else delete next[headerMenu.key];
                return next;
              });
              setHeaderMenu(undefined);
            }}
          />,
          document.body,
        )}
      <div
        onKeyDownCapture={(event) => {
          if (
            !onActions ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          const row = current?.cell[1] ?? selectedIndex;
          const entry = sorted[row];
          const bounds = grid.current?.getBounds(current?.cell[0] ?? 0, row);
          if (!entry || !bounds || !actionable(entry)) return;
          event.preventDefault();
          event.stopPropagation();
          onActions(entry.id, bounds, true);
        }}
        ref={container}
        className="sessions-grid"
        data-row-height={rowHeight(density)}
        data-fit-columns={fit}
      >
        <DataEditor
          ref={grid}
          columns={gridColumns}
          rows={sorted.length}
          getCellsForSelection
          showSearch={!onRetainedQuery && showSearch}
          onSearchClose={() => {
            setShowSearch(false);
            grid.current?.focus();
          }}
          {...(onAdd
            ? {
                trailingRowOptions: { sticky: true, tint: true, hint: addLabel ?? "New row" },
                onRowAppended: () => {
                  if (!addDisabled) onAdd();
                },
              }
            : {})}
          onHeaderMenuClick={(index, bounds) => {
            const key = columns[dataColumnIndex(index, actionsColumn)]?.key;
            if (key && index !== actionsColumn) setHeaderMenu({ key, bounds });
          }}
          onColumnMoved={(from, to) => {
            if (from === actionsColumn || to === actionsColumn) return;
            const keys = [...gridKeys];
            const [key] = keys.splice(from, 1);
            if (!key) return;
            keys.splice(to, 0, key);
            setView({
              ...view,
              order: [
                ...keys.filter((id) => id !== "actions"),
                ...view.order.filter((id) => !keys.includes(id as Key)),
              ],
            });
          }}
          getCellContent={getCellContent}
          theme={theme}
          width="100%"
          height="100%"
          rowHeight={rowHeight(density)}
          headerHeight={Math.max(32, heading.size + 12)}
          rowMarkers={rowMarkers}
          drawCell={drawCell}
          drawHeader={drawHeader}
          getRowThemeOverride={getRowThemeOverride}
          rowSelect="single"
          columnSelect="none"
          rangeSelect="cell"
          verticalBorder={lines.vertical}
          smoothScrollX={false}
          smoothScrollY={false}
          gridSelection={selection}
          onGridSelectionChange={(next) => {
            setCurrent(next.current);
            setCurrentId(sorted[next.current?.cell[1] ?? -1]?.id);
          }}
          onCellContextMenu={([, row], event) => {
            const entry = sorted[row];
            if (!entry || !onActions || !actionable(entry)) return;
            event.preventDefault();
            onActions(
              entry.id,
              {
                x: event.bounds.x + event.localEventX,
                y: event.bounds.y + event.localEventY,
                width: 0,
                height: 0,
              },
              true,
            );
          }}
          onCellClicked={open}
          // A pointer activation always follows a click that was already handled, and handling both
          // would toggle twice.
          onCellActivated={(cell, event) => {
            if (event.inputType !== "pointer") open(cell);
          }}
          onHeaderClicked={(index) => {
            if (index === actionsColumn) return;
            const key = columns[dataColumnIndex(index, actionsColumn)]?.key;
            if (!key) return;
            setSort((value) => ({ key, desc: value.key === key ? !value.desc : false }));
            setCurrent(undefined);
          }}
          // Fitted widths follow the window, so dragging a column edge is off while fitting.
          {...(fit
            ? {}
            : {
                onColumnResize: (column: { id?: string }, size: number) => {
                  if (column.id)
                    setView({ ...view, widths: { ...view.widths, [column.id]: size } });
                },
              })}
          minColumnWidth={fit ? 20 : 50}
          maxColumnWidth={fit ? 4000 : 500}
        />
      </div>
    </div>
  );
}

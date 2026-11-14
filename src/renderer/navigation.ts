import type { IconName } from "./icons.js";
import type { NavigationIconName } from "./navigation-icons.js";
import type { Command } from "./overlays.js";

type Group =
  | "chat"
  | "primary"
  | "apps"
  | "tables"
  | "settings"
  | "advanced"
  | "experiments"
  | "legacy";
interface PageDefinition {
  id: string;
  label: string;
  group: Group;
  order: number;
  initialOrder: number;
  database: boolean;
  icon?: NavigationIconName;
  paletteLabel?: string;
  commandIcon?: IconName;
}
export const pages = [
  {
    id: "home",
    initialOrder: -2,
    label: "Home",
    group: "primary",
    order: -1,
    database: false,
    icon: "house",
  },
  {
    id: "automations",
    initialOrder: 16,
    label: "Automations",
    group: "primary",
    order: 1,
    database: false,
    icon: "arrows-clockwise",
  },
  {
    id: "apps",
    initialOrder: 14,
    label: "Apps",
    group: "primary",
    order: 1,
    database: false,
    icon: "app-window",
  },
  {
    id: "chat",
    initialOrder: 2,
    label: "Projects",
    group: "chat",
    order: 0,
    database: false,
    icon: "clipboard",
  },
  {
    id: "episodic-memory",
    initialOrder: 3,
    label: "Episodic Memory",
    group: "experiments",
    order: 0,
    database: true,
    icon: "brain",
  },
  {
    id: "rag",
    initialOrder: -1,
    label: "RAG",
    group: "experiments",
    order: 1,
    database: true,
    icon: "flask",
  },
  {
    id: "contributor-tools",
    initialOrder: 1,
    label: "Contributor Tools",
    group: "advanced",
    order: 1,
    database: false,
    icon: "code",
  },
  {
    id: "files",
    initialOrder: -1,
    label: "Files",
    paletteLabel: "File Explorer",
    group: "legacy",
    order: 0,
    database: true,
  },
  {
    id: "sessions",
    initialOrder: 4,
    label: "Sessions",
    group: "tables",
    order: 6,
    database: true,
    icon: "grid-nine",
  },
  {
    id: "configurations",
    initialOrder: 8,
    label: "Configurations",
    group: "tables",
    order: 0,
    database: true,
    icon: "grid-nine",
  },
  {
    id: "memories",
    initialOrder: 15,
    label: "Memories",
    group: "tables",
    order: 3,
    database: false,
    icon: "grid-nine",
  },
  {
    id: "messages",
    initialOrder: 5,
    label: "Messages",
    group: "tables",
    order: 4,
    database: true,
    icon: "grid-nine",
  },
  {
    id: "events",
    initialOrder: 6,
    label: "Events",
    group: "tables",
    order: 1,
    database: true,
    icon: "grid-nine",
  },
  {
    id: "logs",
    initialOrder: 0,
    label: "Logs",
    group: "tables",
    order: 2,
    database: false,
    icon: "grid-nine",
  },
  {
    id: "search",
    initialOrder: 7,
    label: "Search",
    group: "primary",
    order: 2,
    database: true,
    icon: "magnifying-glass",
  },
  {
    id: "worktrees",
    initialOrder: 9,
    label: "Worktrees",
    group: "tables",
    order: 7,
    database: true,
    icon: "grid-nine",
  },
  {
    id: "polling",
    initialOrder: 10,
    label: "Polling",
    group: "tables",
    order: 5,
    database: true,
    icon: "grid-nine",
  },
  {
    id: "prompts",
    initialOrder: 11,
    label: "Prompt Builder",
    group: "apps",
    order: 1,
    database: true,
    icon: "pencil-line",
  },
  {
    id: "commands",
    initialOrder: 12,
    label: "Command Builder",
    group: "apps",
    order: 0,
    database: true,
    icon: "megaphone",
  },
  {
    id: "settings",
    initialOrder: 13,
    label: "Settings",
    group: "settings",
    order: 0,
    database: false,
    icon: "gear",
    commandIcon: "settings",
  },
] as const satisfies readonly PageDefinition[];
export type PageId = (typeof pages)[number]["id"];
export type RenderedPageId = Exclude<PageId, "files">;
export const pageDefinitions = Object.fromEntries(pages.map((page) => [page.id, page])) as Record<
  PageId,
  PageDefinition
>;
export const renderedPages = pages.filter(
  (page) => page.id !== "files",
) as readonly (PageDefinition & { id: RenderedPageId })[];
const settingsSections = [
  { id: "agents", label: "Agents", icon: "robot" },
  { id: "memory", label: "Memory", icon: "brain" },
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "table-defaults", label: "Table defaults", icon: "table" },
  { id: "text", label: "Text", icon: "text-aa" },
  { id: "polling-settings", label: "Polling", icon: "arrows-clockwise" },
  { id: "updates", label: "Updates", icon: "download-simple" },
  { id: "about", label: "About", icon: "info" },
] as const satisfies readonly { id: string; label: string; icon: NavigationIconName }[];
export type SettingsSectionId = (typeof settingsSections)[number]["id"];
export const settingsSectionIds = settingsSections.map((section) => section.id);
export const settingsLabels = Object.fromEntries(
  settingsSections.map((section) => [section.id, section.label]),
) as Record<SettingsSectionId, string>;
export const settingsIcons = Object.fromEntries(
  settingsSections.map((section) => [section.id, section.icon]),
) as Record<SettingsSectionId, NavigationIconName>;
export const groups = {
  tables: { label: "Data Viewer", icon: "database" },
  advanced: { label: "Advanced", icon: "wrench" },
  experiments: { label: "Experiments", icon: "flask" },
} as const;
export function isSettingsSection(id: string): id is SettingsSectionId {
  return settingsSectionIds.some((section) => section === id);
}
export function pagesInGroup(group: Group): PageId[] {
  return [...pages]
    .filter((page) => page.group === group)
    .sort((a, b) => a.order - b.order)
    .map((page) => page.id);
}
export function pageGroup(id: PageId | SettingsSectionId) {
  if (isSettingsSection(id)) return "settings";
  const group = pageDefinitions[id].group;
  return group === "experiments" ? "advanced" : group;
}
export function pageAvailable(id: PageId, database: string | null) {
  return !pageDefinitions[id].database || database !== null;
}
export function resolvePage(id: PageId): RenderedPageId {
  return id === "files" ? "chat" : id;
}
export function pageCommands(
  active: PageId,
  database: string | null,
  navigate: (id: PageId) => void,
  settingsShortcut: string,
): Command[] {
  return pages.map(({ id }): Command => {
    const page = pageDefinitions[id];
    const disabled = !pageAvailable(id, database);
    return {
      id,
      label: page.paletteLabel ?? page.label,
      group: "Pages",
      icon: page.commandIcon ?? "document",
      checked: active === id,
      disabled,
      ...(disabled ? { reason: "Connect to a database first" } : {}),
      ...(id === "settings" ? { keys: settingsShortcut } : {}),
      run: () => {
        if (!disabled) navigate(id);
      },
    };
  });
}

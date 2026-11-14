import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../bridge/index.js";
import { PageTabBar } from "./page-tabs.js";
import { initialTabs, type SettingsSectionId } from "./tabs.js";

afterEach(() => vi.unstubAllGlobals());

function navigation(
  database: string | null,
  _directory?: string,
  settingsSection: SettingsSectionId = "agents",
  active = initialTabs.active,
  expanded = true,
) {
  vi.stubGlobal("localStorage", { getItem: () => String(expanded), setItem: () => {} });
  return renderToStaticMarkup(
    <PageTabBar
      tabs={{ ...initialTabs, active }}
      settingsSection={settingsSection}
      database={database}
      onSelect={() => {}}
      onSettingsSectionSelect={() => {}}
      onOpenProject={() => {}}
      onConnectDatabase={() => {}}
      projectDisabled={false}
      api={{} as DesktopApi}
      chats={[]}
      runs={[]}
      onWorkerSelect={() => {}}
      selectedId={undefined}
      navigationSerial={undefined}
      eventsByRun={{}}
    />,
  );
}

describe("database connection navigation", () => {
  it("opens Search from a labelled icon above the page list with its selected state", () => {
    const html = navigation("/database.sqlite", undefined, "agents", "search");
    const search = html.match(/<button[^>]*id="tab-search"[\s\S]*?<\/button>/)?.[0];
    expect(search).toContain('class="icon-button sidebar-search"');
    expect(search).toContain('aria-label="Search"');
    expect(search).toContain('aria-pressed="true"');
    expect(search).toContain('aria-controls="panel-search"');
    expect(search).not.toContain('role="tab"');
    expect(search).not.toContain("disabled");
    expect(html.match(/id="tab-search"/g)).toHaveLength(1);
    expect(html.indexOf('id="tab-search"')).toBeLessThan(html.indexOf('class="page-tabs"'));
  });

  it("leaves the separate database action to the application footer", () => {
    for (const database of [null, "/database.sqlite"]) {
      const html = navigation(database);
      expect(html).not.toContain('aria-label="Select or create database"');
      expect(html).not.toContain("sidebar-actions");
    }
  });

  it("replaces project identity with database connection and disables workspace destinations", () => {
    const html = navigation(null, "/old-project");
    const card = html.match(
      /<button[^>]*class="icon-button project-sidebar-open"[\s\S]*?<\/button>/,
    )?.[0];
    expect(card).toContain("Connect to database");
    expect(card).not.toContain("old-project");
    expect(card).not.toContain("disabled");
    for (const id of ["prompts", "search", "sessions", "episodic-memory", "rag"]) {
      expect(html.match(new RegExp(`<button[^>]*id="tab-${id}"[^>]*>`))?.[0]).toContain("disabled");
    }
    expect(html.match(/<button[^>]*id="tables-toggle"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html.match(/<button[^>]*id="tab-logs"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html.match(/<button[^>]*id="tab-memories"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html.indexOf('id="tab-events"')).toBeLessThan(html.indexOf('id="tab-logs"'));
    expect(html.indexOf('id="tab-logs"')).toBeLessThan(html.indexOf('id="tab-messages"'));
    expect(html.match(/<button[^>]*id="tab-settings"[^>]*>/)?.[0]).not.toContain("disabled");
    for (const section of [
      "agents",
      "memory",
      "appearance",
      "table-defaults",
      "text",
      "polling-settings",
      "updates",
      "about",
    ]) {
      expect(
        html.match(new RegExp(`<button[^>]*id="tab-settings-${section}"[^>]*>`))?.[0],
      ).not.toContain("disabled");
    }
    expect(html.match(/<button[^>]*id="tab-chat"[^>]*>/)?.[0]).not.toContain("disabled");
  });
  it("keeps the Open Project action and workspace controls independent of the selected folder", () => {
    for (const directory of [undefined, "/project"]) {
      const html = navigation("/database.sqlite", directory);
      expect(html).toContain('aria-label="Open Project"');
      expect(html).not.toContain("sidebar-header");
      expect(html).toContain('title="Open Project"');
      expect(html).not.toContain(">project</span>");
      expect(html).not.toContain("Connect to database");
      expect(html.match(/<button[^>]*id="tab-prompts"[^>]*>/)?.[0]).not.toContain("disabled");
      expect(html.match(/<button[^>]*id="tables-toggle"[^>]*>/)?.[0]).not.toContain("disabled");
    }
  });
  it("nests each settings section as its own page before Advanced", () => {
    const html = navigation("/database.sqlite", undefined, "appearance", "settings");
    const sections = [
      ["agents", "Agents"],
      ["memory", "Memory"],
      ["appearance", "Appearance"],
      ["table-defaults", "Table defaults"],
      ["text", "Text"],
      ["polling-settings", "Polling"],
      ["updates", "Updates"],
      ["about", "About"],
    ] as const;
    for (const [section, label] of sections) {
      const tab = html.match(
        new RegExp(`<button[^>]*id="tab-settings-${section}"[\\s\\S]*?</button>`),
      )?.[0];
      expect(tab).toContain(`aria-controls="panel-settings-${section}"`);
      expect(tab).toContain(label);
    }
    expect(html.match(/<button[^>]*id="tab-settings-appearance"[^>]*>/)?.[0]).toContain(
      'aria-selected="true"',
    );
    expect(html.indexOf('id="settings-pages"')).toBeLessThan(
      html.indexOf('id="tab-settings-agents"'),
    );
    expect(html.indexOf('id="tab-settings-about"')).toBeLessThan(
      html.indexOf('id="advanced-toggle"'),
    );
  });
});

describe("sidebar labels and disclosure icons", () => {
  it("nests Data Viewer alphabetically under Apps and gives every child the grid icon", () => {
    const html = navigation("/database.sqlite");
    const order = [
      "app-pages",
      "tab-commands",
      "tables-toggle",
      "table-pages",
      "tab-configurations",
      "tab-events",
      "tab-logs",
      "tab-memories",
      "tab-messages",
      "tab-polling",
      "tab-sessions",
      "tab-worktrees",
      "tab-prompts",
      "tab-settings",
    ];
    for (let index = 1; index < order.length; index++) {
      expect(html.indexOf(`id="${order[index - 1]}"`)).toBeLessThan(
        html.indexOf(`id="${order[index]}"`),
      );
    }
    for (const id of [
      "configurations",
      "events",
      "logs",
      "memories",
      "messages",
      "polling",
      "sessions",
      "worktrees",
    ]) {
      const tab = html.match(new RegExp(`<button[^>]*id="tab-${id}"[\\s\\S]*?</button>`))?.[0];
      expect(tab).toContain('data-icon="grid-nine"');
    }
    expect(html).toContain('aria-label="Data Viewer"');
    expect(html).not.toContain('title="Tables"');
  });

  it.each([true, false])("selects Apps independently of its expansion (%s)", (expanded) => {
    const html = navigation(null, undefined, "agents", "apps", expanded);
    const tab = html.match(/<button[^>]*id="tab-apps"[\s\S]*?<\/button>/)?.[0];
    expect(tab).toContain('role="tab"');
    expect(tab).toContain('aria-selected="true"');
    expect(tab).toContain('aria-controls="panel-apps app-pages"');
    expect(tab).toContain(`aria-expanded="${expanded}"`);
    expect(tab).not.toContain('disabled=""');
  });

  it.each([true, false])(
    "keeps disclosure contents mounted and immediately inaccessible when closed (expanded: %s)",
    (expanded) => {
      const html = navigation(
        "/database.sqlite",
        undefined,
        "agents",
        initialTabs.active,
        expanded,
      );
      for (const id of [
        "chat-pages",
        "app-pages",
        "table-pages",
        "settings-pages",
        "advanced-pages",
        "experiment-pages",
      ]) {
        const group = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))?.[0];
        expect(group).toContain(`aria-hidden="${!expanded}"`);
        if (expanded) {
          expect(group).not.toContain('hidden=""');
          expect(group).not.toContain('inert=""');
        } else {
          expect(group).toContain('hidden=""');
          expect(group).toContain('inert=""');
        }
      }
      expect(html).toContain('id="tab-configurations"');
      expect(html).toContain('id="tab-settings-text"');
      expect(html).toContain('id="tab-episodic-memory"');
      expect(html).toContain('id="tab-rag"');
    },
  );

  it.each([true, false])("keeps navigation icons decorative (expanded: %s)", (expanded) => {
    for (const database of [null, "/database.sqlite"]) {
      const html = navigation(database, undefined, "agents", initialTabs.active, expanded);
      const promptTab = html.match(/<button[^>]*id="tab-prompts"[\s\S]*?<\/button>/)?.[0];
      const project = html.match(
        /<button[^>]*class="icon-button project-sidebar-open"[\s\S]*?<\/button>/,
      )?.[0];
      expect(promptTab).toContain("Prompt Builder");
      expect(promptTab).toContain('data-icon="pencil-line"');
      expect(project).toContain("<svg");
      expect(html).not.toContain("<img");
      expect(html.match(/class="carbon-icon"/g)).toHaveLength(2);
      expect(html.match(/class="navigation-icon"/g)).toHaveLength(29);
      for (const [id, icon, label] of [
        ["tab-home", "house", "Home"],
        ["tab-automations", "arrows-clockwise", "Automations"],
        ["tab-chat", "clipboard", "Projects"],
        ["tab-prompts", "pencil-line", "Prompt Builder"],
        ["tab-commands", "megaphone", "Command Builder"],
        ["tab-settings", "gear", "Settings"],
        ["tab-apps", "app-window", "Apps"],
        ["tables-toggle", "database", "Data Viewer"],
        ["tab-configurations", "grid-nine", "Configurations"],
        ["tab-logs", "grid-nine", "Logs"],
        ["tab-settings-agents", "robot", "Agents"],
        ["advanced-toggle", "wrench", "Advanced"],
        ["experiments-toggle", "flask", "Experiments"],
        ["tab-episodic-memory", "brain", "Episodic Memory"],
        ["tab-contributor-tools", "code", "Contributor Tools"],
      ]) {
        const tab = html.match(new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`))?.[0];
        expect(tab).toContain(`data-icon="${icon}"`);
        expect(tab).toContain(`class="page-tab-label">${label}</span>`);
        expect(tab).toMatch(/class="navigation-icon"[^>]*aria-hidden="true"[^>]*focusable="false"/);
        expect(tab).toContain('opacity="0.2"');
      }
      expect(project).toContain('class="icon-button project-sidebar-open"');
      expect(project?.match(/<svg/g)).toHaveLength(1);
      expect(project).toContain('aria-haspopup="dialog"');
      expect(html).not.toContain('aria-label="New chat"');
      const settingsToggle = html.match(/<button[^>]*id="tab-settings"[\s\S]*?<\/button>/)?.[0];
      expect(settingsToggle).toContain("<svg");
      expect(settingsToggle).toContain(`aria-expanded="${expanded}"`);
      for (const id of [
        "tab-chat",
        "tab-apps",
        "tables-toggle",
        "advanced-toggle",
        "experiments-toggle",
      ]) {
        const toggle = html.match(new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`))?.[0];
        expect(toggle).toContain(`aria-expanded="${expanded}"`);
        expect(toggle).not.toContain('class="carbon-icon"');
      }
    }
  });
});

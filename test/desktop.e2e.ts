import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type _electron, expect, type Locator, type Page, test } from "@playwright/test";
import type { MemoryGeneration, MemorySource, Snapshot, UpdateState } from "../src/bridge/index.js";
import { DEFAULT_CONFIG } from "../src/core/index.js";
import { MemoryStore } from "../src/desktop/memory-store.js";
import { RelayStore } from "../src/desktop/relay-store.js";
import { privateDirectory } from "../src/platform/index.js";
import { launchDesktop, removeDesktopFixture as rm } from "./electron-launcher.js";
import { commitFixture } from "./fixtures/git-repository.js";
import { verifiedAgents } from "./fixtures/verified-agents.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const windowTitle = () =>
  application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle());
type TitleBarOverlayCall = {
  color?: string | undefined;
  symbolColor?: string | undefined;
  height?: number | undefined;
};
const watchTitleBarOverlay = () =>
  application.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) throw new Error("Desktop window is missing");
    const scope = globalThis as typeof globalThis & {
      __code60TitleBarOverlayCalls?: TitleBarOverlayCall[];
    };
    scope.__code60TitleBarOverlayCalls = [];
    const setTitleBarOverlay = mainWindow.setTitleBarOverlay.bind(mainWindow);
    mainWindow.setTitleBarOverlay = (options) => {
      scope.__code60TitleBarOverlayCalls?.push({
        color: options.color,
        symbolColor: options.symbolColor,
        height: options.height,
      });
      setTitleBarOverlay(options);
    };
  });
const lastTitleBarOverlay = () =>
  application.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __code60TitleBarOverlayCalls?: TitleBarOverlayCall[];
    };
    return scope.__code60TitleBarOverlayCalls?.at(-1) ?? null;
  });
let application: Awaited<ReturnType<typeof _electron.launch>>;
const menuItem = (id: string) =>
  application.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    return item && { label: item.label, enabled: item.enabled, accelerator: item.accelerator };
  }, id);
const clickMenu = (id: string) =>
  application.evaluate(({ Menu }, itemId) => {
    Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click();
  }, id);

// The row-number column, Agent width, and half the Actions width.
const actionsColumnX = 40 + 95 + 45;

// Check controls whose component styles can override the shared keyboard treatment.
async function expectActionFocus(page: Page, controls: Locator[]) {
  const saved = await page.locator("html").evaluate((element) => ({
    theme: element.dataset.colorScheme,
    focus: element.dataset.focusHighlight,
  }));
  try {
    for (const theme of ["light", "dark"]) {
      for (const enhanced of [false, true]) {
        await page.locator("html").evaluate(
          (element, state) => {
            element.dataset.colorScheme = state.theme;
            element.dataset.focusHighlight = state.enhanced ? "on" : "off";
          },
          { theme, enhanced },
        );
        for (const forcedColors of ["none", "active"] as const) {
          await page.emulateMedia({ forcedColors });
          for (const control of controls) {
            await control.focus();
            await page.keyboard.press("Tab");
            await page.keyboard.press("Shift+Tab");
            await expect(control).toBeFocused();
            await expect(control).toHaveCSS("outline-width", "2px");
            if (forcedColors === "active") {
              await expect(control).toHaveCSS("box-shadow", "none");
              await expect(control).not.toHaveCSS("outline-color", "rgba(0, 0, 0, 0)");
            } else {
              await expect(control).toHaveCSS("box-shadow", enhanced ? /3px/ : /4px/);
            }
          }
        }
      }
    }
  } finally {
    await page.emulateMedia({ forcedColors: "none" });
    await page.locator("html").evaluate((element, state) => {
      if (state.theme) element.dataset.colorScheme = state.theme;
      else delete element.dataset.colorScheme;
      if (state.focus) element.dataset.focusHighlight = state.focus;
      else delete element.dataset.focusHighlight;
    }, saved);
  }
}

async function expectSelectedProject(page: Page, directory: string) {
  await expect(page.locator(".project-sidebar-open")).toHaveAttribute("aria-label", "Open Project");
  await expect(
    page.locator('.project-chat-heading[data-project-selected="true"] .project-chat-name'),
  ).toHaveAttribute("title", directory);
}

async function scrollGrid(grid: Locator, left: number) {
  await grid.locator(".dvn-scroller").evaluate(async (element, position) => {
    element.scrollLeft = position;
    // Glide debounces its accessibility tree by 200ms after scrolling.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, left);
}

async function expectGridHeaders(grid: Locator, expected: string[]) {
  // Glide exposes only visible columns. Inspect the whole table on small CI displays.
  await expect
    .poll(async () => {
      const { width, total } = await grid.locator(".dvn-scroller").evaluate((element) => ({
        width: element.clientWidth,
        total: element.scrollWidth,
      }));
      const seen = new Set<string>();
      try {
        for (let left = 0; left < total; left += Math.max(1, width / 2)) {
          await scrollGrid(grid, left);
          for (const label of await grid.locator("th[role='columnheader']").allTextContents())
            seen.add(label);
        }
        return [...seen];
      } finally {
        await scrollGrid(grid, 0);
      }
    })
    .toEqual(expected);
}

async function selectProjectConversation(page: Page) {
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).projectInstanceId)
    .toBeTruthy();
  const snapshot = await page.evaluate(() => window.desktop.snapshot());
  const owner = snapshot.openProjects?.find((owner) => owner.id === snapshot.projectInstanceId);
  if (!owner) throw new Error("Open a project before selecting its conversation");
  const existing = snapshot.chats.find((chat) => chat.projectId === owner.id && !chat.archived);
  const group = page.getByRole("region", { name: `Project ${owner.path}`, exact: true });
  if (existing?.run) {
    const toggle = group.locator(".project-chat-name");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await group.locator(`[id="conversation-${existing.run.id}"]`).click();
  } else {
    await group
      .getByRole("button", { name: `New chat in ${basename(owner.path)}`, exact: true })
      .click();
  }
  await expect
    .poll(async () => {
      const { chat } = await page.evaluate(() => window.desktop.snapshot());
      return chat.projectId === owner.id && !!chat.run?.id;
    })
    .toBe(true);
  const id = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
  await expect(page.locator(`.orchestration-chat-page[data-chat-id="${id}"]`)).toBeVisible();
}

async function selectSidebarPage(page: Page, name: string) {
  if (name === "Prompt Builder" || name === "Command Builder") {
    const tools = page.locator("#tab-apps");
    if ((await tools.getAttribute("aria-expanded")) === "false") await tools.click();
    await page.locator("#app-pages").getByRole("tab", { name, exact: true }).click();
    return;
  }
  if (name === "Search") {
    await page.locator(".sidebar-search").click();
    return;
  }
  if (name === "Chat") name = "Projects";
  if (name === "Files") {
    await selectSidebarPage(page, "Chat");
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    if (snapshot.chat.kind === "relay" && snapshot.directory) await selectProjectConversation(page);
    const toggle = page.getByRole("button", { name: "Toggle files panel", exact: true });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const explorer = page
      .locator(".file-tabs")
      .getByRole("tab", { name: "File Explorer", exact: true });
    // A workspace change can reset file tabs between finding a tab and clicking it,
    // so retry the whole choice instead of waiting on a tab that no longer exists.
    const attempt = { timeout: 2_000 };
    await expect(async () => {
      if (await explorer.count()) await explorer.first().click(attempt);
      else {
        const open = page.getByRole("button", { name: "Open Files", exact: true });
        if (!(await open.isVisible()))
          await page.getByRole("button", { name: "New file tab" }).click(attempt);
        await open.click(attempt);
      }
      await expect(explorer.first()).toHaveAttribute("aria-selected", "true", attempt);
    }).toPass({ timeout: 15_000 });
    return;
  }
  if (
    name === "Projects" &&
    (await page.locator("#tab-chat").getAttribute("aria-selected")) === "true"
  ) {
    await page.locator("#tab-chat").focus();
    return;
  }
  if (
    [
      "Configurations",
      "Events",
      "Logs",
      "Memories",
      "Messages",
      "Polling",
      "Sessions",
      "Worktrees",
    ].includes(name)
  ) {
    const apps = page.locator("#tab-apps");
    if ((await apps.getAttribute("aria-expanded")) === "false") await apps.click();
    const tables = page.getByRole("button", { name: "Data Viewer", exact: true });
    if ((await tables.getAttribute("aria-expanded")) === "false") await tables.click();
    await page.locator("#table-pages").getByRole("tab", { name, exact: true }).click();
    return;
  }
  await page.getByRole("tab", { name, exact: true }).click();
}

async function selectSettingsPage(page: Page, name: string) {
  const disclosure = page.getByRole("tab", { name: "Settings", exact: true });
  if ((await disclosure.getAttribute("aria-expanded")) === "false") await disclosure.click();
  await page.locator("#settings-pages").getByRole("tab", { name, exact: true }).click();
}

async function expectSplashLayout(page: Page, scheme: "light" | "dark" = "light") {
  await page.mouse.move(1, 1);
  expect(
    await page.evaluate(async () => {
      const fonts = await document.fonts.load('400 64px "D-DIN"', "Code60");
      return fonts.some((font) => font.status === "loaded");
    }),
  ).toBe(true);
  const foreground = scheme === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
  const theme = await page.evaluate(() => localStorage.getItem("code60.theme"));
  const title = await page.locator(".splash-title").boundingBox();
  const logo = await page.locator(".splash-logo").boundingBox();
  const lockup = await page.locator(".splash-lockup").boundingBox();
  const subtitle = await page.locator(".splash-subtitle").boundingBox();
  const start = await page.locator(".splash-enter").boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(title).not.toBeNull();
  expect(logo).not.toBeNull();
  expect(lockup).not.toBeNull();
  expect(subtitle).not.toBeNull();
  expect(start).not.toBeNull();
  if (title && logo && start && lockup && subtitle) {
    expect(Math.abs(title.x + title.width / 2 - logo.x - logo.width / 2)).toBeLessThan(2);
    const lift = Math.min(48, Math.max(0, (logo.height - lockup.height) / 2));
    expect(Math.abs(lockup.y + lockup.height / 2 - (logo.y + logo.height / 2 - lift))).toBeLessThan(
      2,
    );
    expect(lockup.y).toBeGreaterThanOrEqual(logo.y - 1);
    expect(Math.abs(subtitle.x + subtitle.width / 2 - title.x - title.width / 2)).toBeLessThan(2);
    expect(subtitle.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(subtitle.y + subtitle.height).toBeLessThanOrEqual(logo.y + logo.height);
    expect(Math.abs(title.x + title.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(Math.abs(start.x + start.width / 2 - title.x - title.width / 2)).toBeLessThan(2);
    expect(start.y).toBeGreaterThan(subtitle.y + subtitle.height);
    expect(start.y + start.height).toBeLessThanOrEqual(viewport.height);
  }
  await expect(page.locator(".splash")).toHaveAttribute("data-theme", theme ?? "system");
  await expect(page.locator(".splash")).toHaveCSS("color-scheme", scheme);
  await expect(page.locator("html")).toHaveCSS("color-scheme", scheme);
  await expect(page.locator(".splash-brand")).toHaveCSS(
    "background-color",
    scheme === "dark" ? "rgb(15, 23, 42)" : "rgb(255, 255, 255)",
  );
  await expect(page.locator(".splash-brand")).toHaveCSS("opacity", "1");
  if (scheme === "dark")
    await expect(page.locator(".splash-brand")).toHaveCSS(
      "background-image",
      /^url\(".*stripes[^"]*\.jpeg"\)$/,
    );
  else await expect(page.locator(".splash-brand")).toHaveCSS("background-image", "none");
  await expect(page.locator(".splash")).toHaveCSS("overflow", "hidden");
  await expect(page.locator(".splash")).toHaveCSS("filter", "none");
  const background = await page.locator(".splash").evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return {
      content: style.content,
      image: style.backgroundImage,
    };
  });
  await expect(page.locator(".splash")).not.toHaveAttribute("data-background");
  await expect(page.locator(".splash")).toHaveCSS("background-image", "none");
  expect(background).toEqual({ content: "none", image: "none" });
  await expect(page.locator(".splash-title")).toHaveCSS("color", foreground);
  await expect(page.locator(".splash-title")).toHaveCSS("font-family", /^"?D-DIN"?/);
  await expect(page.locator(".splash-title")).toHaveCSS("font-weight", "400");
  await expect(page.locator(".splash-title")).toHaveCSS("opacity", "1");
  await expect(page.locator(".splash-subtitle")).toHaveText("v0.2 'Paddock' (Beta)");
  await expect(page.locator(".splash-subtitle")).toHaveCSS("color", foreground);
  await expect(page.locator(".splash-subtitle")).toHaveCSS("font-family", /^"?D-DIN"?/);
  await expect(page.locator(".splash-subtitle")).toHaveCSS("opacity", "1");
  await expect(page.locator(".splash-subtitle")).toHaveCSS("text-transform", "none");
  await expect(page.locator(".splash-title b")).toHaveCSS(
    "background-color",
    scheme === "dark" ? "rgb(119, 183, 245)" : "rgb(91, 159, 230)",
  );
  await expect(page.locator(".splash-enter")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".splash-enter")).toHaveCSS("color", foreground);
  await expect(page.locator(".splash-title")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const themes = page.getByRole("group", { name: "Color theme", exact: true });
  await expect(themes.getByRole("button")).toHaveCount(2);
  await expect(themes.getByRole("button", { name: "Light mode", exact: true })).toHaveAttribute(
    "aria-pressed",
    String(scheme === "light"),
  );
  await expect(themes.getByRole("button", { name: "Dark mode", exact: true })).toHaveAttribute(
    "aria-pressed",
    String(scheme === "dark"),
  );
  const themeBounds = await themes.boundingBox();
  const stripBounds = await page.locator(".splash > .window-drag-strip").boundingBox();
  expect(themeBounds).not.toBeNull();
  expect(stripBounds).not.toBeNull();
  if (themeBounds && stripBounds) {
    expect(viewport.width - themeBounds.x - themeBounds.width).toBe(16);
    expect(themeBounds.y).toBeGreaterThanOrEqual(stripBounds.y + stripBounds.height);
  }
  await expect(page.getByRole("group", { name: "Splash background", exact: true })).toHaveCount(0);
  await expect(
    page.locator(".splash-background-picker, .splash-background-dot, .splash-background-status"),
  ).toHaveCount(0);
  for (const button of await themes.getByRole("button").all()) {
    await expect(button).toHaveCSS("-webkit-app-region", "no-drag");
    expect(
      await button.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          document
            .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            ?.closest("button") === element
        );
      }),
    ).toBe(true);
  }
  await expect(page.locator(".splash")).toHaveCSS("-webkit-app-region", "no-drag");
  await expect(page.locator(".splash-enter")).toHaveCSS("-webkit-app-region", "no-drag");
  await expect(page.locator(".splash > .window-drag-strip")).toHaveCSS(
    "-webkit-app-region",
    "drag",
  );
  await expect(page.locator(".splash-projects, .splash .project-list")).toHaveCount(0);
  await expect(page.locator(".splash").getByRole("button", { name: "Open Folder" })).toHaveCount(0);
  await expect(
    page.locator(".splash").getByRole("button", { name: "Start", exact: true }),
  ).toBeVisible();
}

async function expectMessageCopy(control: Locator) {
  await expect(control).toHaveCSS("border-radius", "0px");
  await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(control).toHaveCSS("border-top-width", "0px");
  await expect(control).toHaveCSS("box-shadow", "none");
  await expect(control.locator("svg")).toHaveCSS("width", "16px");
  await expect(control.locator("svg")).toHaveCSS("height", "16px");
  await expect(control).toHaveCSS("width", "24px");
  await expect(control).toHaveCSS("height", "24px");
  const timestamp = control.locator("..").locator(".message-sent-time");
  await expect(timestamp).toHaveText(/^\d+[smhd] ago$/);
  await expect(timestamp).toHaveAttribute("datetime", /T.*Z$/);
  await expect(timestamp).toHaveAttribute("aria-live", "off");
  const timeBox = await timestamp.boundingBox();
  const copyBox = await control.boundingBox();
  expect(timeBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect((timeBox?.x ?? 0) + (timeBox?.width ?? 0)).toBeLessThanOrEqual(copyBox?.x ?? 0);
  await control.hover();
  await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(control).toHaveCSS("border-top-width", "0px");
}

async function iconHighlight(control: Locator) {
  return control.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    element.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

async function expectIconAction(control: Locator) {
  const page = control.page();
  await page.bringToFront();
  await control.evaluate((element) => (element as HTMLElement).blur());
  const corner = await page.evaluate(() => ({ x: innerWidth - 2, y: innerHeight - 2 }));
  await page.mouse.move(corner.x, corner.y);
  await expect.poll(() => control.evaluate((element) => element.matches(":hover"))).toBe(false);
  const resting = await control.evaluate((element) => getComputedStyle(element).color);
  for (const edge of ["top", "right", "bottom", "left"])
    await expect(control).toHaveCSS(`border-${edge}-width`, "0px");
  await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await control.hover();
  await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(control).toHaveCSS("background-image", "none");
  await expect(control).toHaveCSS("box-shadow", "none");
  if (await control.isEnabled()) {
    await expect(async () => {
      await page.mouse.move(corner.x, corner.y);
      await control.hover();
      await expect(control).not.toHaveCSS("color", resting, { timeout: 500 });
    }).toPass({ timeout: 5_000 });
    const highlighted = await iconHighlight(control);
    await page.mouse.move(corner.x, corner.y);
    await expect.poll(() => control.evaluate((element) => element.matches(":hover"))).toBe(false);
    await control.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("color", highlighted);
    await expect(control).toHaveCSS("outline-style", "none");
    await expect(control).toHaveCSS("box-shadow", "none");
  } else await expect(control).toHaveCSS("color", resting);
}

async function openPollingControls(page: Page) {
  await page.getByRole("button", { name: "Open polling controls", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Polling controls", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("border-radius", "0px");
  const dimensions = await dialog.evaluate((element) => {
    const group = element.querySelector(".button-group");
    const buttons = [...element.querySelectorAll(".button-group > button")].map((button) =>
      button.getBoundingClientRect(),
    );
    const bounds = element.getBoundingClientRect();
    const row = group?.getBoundingClientRect();
    return {
      height: bounds.height,
      widths: buttons.map((button) => button.width),
      center: row ? Math.abs(row.x + row.width / 2 - bounds.x - bounds.width / 2) : 100,
    };
  });
  expect(dimensions.height).toBeGreaterThanOrEqual(200);
  expect(Math.abs((dimensions.widths[0] ?? 0) - (dimensions.widths[1] ?? 0))).toBeLessThanOrEqual(
    1,
  );
  expect(dimensions.center).toBeLessThan(1);
  return dialog;
}

async function refreshProjectData(page: Page) {
  const dialog = await openPollingControls(page);
  await dialog.getByRole("button", { name: "Refresh project data", exact: true }).click();
  await dialog.getByRole("button", { name: "Close Polling controls", exact: true }).click();
}

/** Composers are defined by their hairline border alone, with no outer shadow. */
async function expectComposerShadow(composer: Locator) {
  await expect(composer).toHaveCSS("box-shadow", "none");
}

async function expectTurnSeparator(line: Locator) {
  await expect(line).toHaveCSS("border-top-width", "1px");
  await expect(line).toHaveCSS("border-top-style", "solid");
  const geometry = await line.evaluate((element) => {
    const previous = element.previousElementSibling;
    const parent = element.parentElement;
    if (!previous || !parent) throw new Error("Missing completed turn");
    const style = getComputedStyle(element);
    const parentStyle = getComputedStyle(parent);
    const bounds = element.getBoundingClientRect();
    return {
      timing: previous.matches(".turn-timer"),
      below: bounds.top >= previous.getBoundingClientRect().bottom,
      width: bounds.width,
      available:
        parent.clientWidth -
        Number.parseFloat(parentStyle.paddingLeft) -
        Number.parseFloat(parentStyle.paddingRight) -
        Number.parseFloat(style.marginLeft) -
        Number.parseFloat(style.marginRight),
    };
  });
  expect(geometry.timing).toBe(true);
  expect(geometry.below).toBe(true);
  expect(geometry.width).toBeCloseTo(geometry.available, 1);
}

async function expectChatBorder(composer: Locator, color = "var(--focus-line)") {
  const expected = await composer.evaluate((_, color) => {
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.append(probe);
    const result = getComputedStyle(probe).color;
    probe.remove();
    return result;
  }, color);
  for (const side of ["top", "right", "bottom", "left"])
    await expect(composer).toHaveCSS(`border-${side}-color`, expected);
  await expect(composer).toHaveCSS("border-top-width", "1px");
  await expect(composer).toHaveCSS("border-radius", "0px");
  await expect(composer).toHaveCSS("outline-width", "0px");
  await expectComposerShadow(composer);
}

async function expectStackedComposer(chat: Locator) {
  const page = chat.page();
  const composer = chat.locator(".composer");
  const send = composer.getByRole("button", { name: "Send", exact: true });
  const panel = page.locator("#chat-file-panel");
  const conversations = page.locator(".chat-conversations");
  await expect
    .poll(async () => {
      const [form, section, files] = await Promise.all(
        [composer, conversations, panel].map((element) => element.boundingBox()),
      );
      if (!form || !section || !files) return false;
      return (
        section.height >= 300 &&
        form.y + form.height <= section.y + section.height + 0.5 &&
        section.y + section.height <= files.y + 0.5
      );
    })
    .toBe(true);
  expect((await chat.locator(".transcript").boundingBox())?.height).toBeGreaterThanOrEqual(120);
  await send.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(send).toBeFocused();
  await composer.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect(composer).toBeInViewport({ ratio: 1 });
  await expect(send).toBeInViewport({ ratio: 1 });
}

async function expectIndustrialSurfaces(page: Page) {
  const surfaces = await page
    .locator(
      "button, input, select, textarea, dialog:not(.splash), .button-group, .chat-sidebar-row, .segmented, .segmented-option, .settings-card, .settings-group, .composer, .event.prompt:not(.automatic) > pre, .event.toolCall, .approval, .worker-chat-page, .actions-menu",
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const style = getComputedStyle(element);
          const grouped =
            element.matches("button, select, .segmented-option") &&
            element.parentElement?.matches(".button-group, .chat-sidebar-row, .segmented");
          // Every surface is square; only radio inputs remain true circles.
          const circle = element.matches("input[type=radio]");
          return {
            label: `${element.tagName.toLowerCase()}.${element.className} ${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40)}`,
            expectedRadii: Array(4).fill(circle ? 50 : 0),
            radii: [
              style.borderTopLeftRadius,
              style.borderTopRightRadius,
              style.borderBottomRightRadius,
              style.borderBottomLeftRadius,
            ].map(Number.parseFloat),
            corner: style.getPropertyValue("corner-top-right-shape"),
            indicatorRadius: element.matches("input[role=switch], input[type=radio]:checked")
              ? getComputedStyle(element, "::before").borderRadius
              : null,
            expectedIndicatorRadius: element.matches("input[type=radio]") ? "50%" : "0px",
            navSelected: element.matches(
              '.sidebar [data-nav-active="true"], .page-tab [role="tab"][aria-selected="true"]:not(.page-group-toggle), .page-tab .page-group-toggle[data-active="true"], .sidebar-settings-heading[data-active="true"]',
            ),
            checkboxMarkRadius: element.matches("input[type=checkbox]:checked:not([role=switch])")
              ? getComputedStyle(element, "::before").borderRadius
              : null,
            segmentedChoice: element.matches(".segmented-option"),
            promptBubble: element.matches(".event.prompt:not(.automatic) > pre"),
            forcedColors: matchMedia("(forced-colors: active)").matches,
            shadow: style.boxShadow,
            overlay: element.matches(
              "dialog, [role=dialog], [popover], .app-toast, .button-group, .worker-chat-page",
            ),
            baseline: element.matches(
              "input:not([type=checkbox], [type=radio]), select, textarea, .composer",
            ),
            focused: element.matches(":focus-visible"),
            image: style.backgroundImage,
            disabled: element.matches(":disabled, [aria-disabled='true']"),
            // Icon actions stay glyph-only; disabled ones dim the glyph instead of hatching.
            iconOnly: element.matches("button.icon-button"),
            animation: style.animationName,
            height: element.tagName === "BUTTON" ? element.getBoundingClientRect().height : 36,
            minHeight: element.matches(
              ".app-footer > button, .footer-polling > .poll-timestamp, .footer-database, .footer-splash",
            )
              ? 20
              : element.matches(".table-add-accessible:not(:focus-visible)")
                ? 0
                : grouped
                  ? 28
                  : element.matches(
                        "[role='tab'], button.icon-button, .message-copy button, .sidebar button, .info-tip, .settings-group-reset",
                      )
                    ? 24
                    : 36,
          };
        }),
    );
  expect(surfaces.length).toBeGreaterThan(0);
  for (const surface of surfaces) {
    expect(surface.radii, surface.label).toEqual(surface.expectedRadii);
    if (surface.indicatorRadius !== null)
      expect(surface.indicatorRadius, surface.label).toBe(surface.expectedIndicatorRadius);
    if (surface.checkboxMarkRadius !== null)
      expect(surface.checkboxMarkRadius, surface.label).toBe("0px");
    if (surface.navSelected && !surface.focused && !surface.forcedColors)
      expect(surface.shadow, surface.label).toMatch(/^rgba?\([^)]+\) 2px 0px 0px 0px inset$/);
    else if (!surface.focused && !surface.overlay && !surface.baseline && !surface.segmentedChoice)
      expect(surface.shadow, surface.label).toBe("none");
    expect(surface.image, surface.label).toBe("none");
    expect(surface.animation).toBe("none");
    expect(surface.height, surface.label).toBeGreaterThanOrEqual(surface.minHeight);
  }
  const scrollers = await page.locator("body *").evaluateAll((elements) =>
    elements
      .filter(
        (element) =>
          element.getClientRects().length > 0 && getComputedStyle(element).overflowY === "auto",
      )
      .map((element) => ({
        label: `${element.tagName.toLowerCase()}.${element.className}`,
        gutter: getComputedStyle(element).scrollbarGutter,
        scrollbarWidth: getComputedStyle(element).scrollbarWidth,
        sidebar: element.matches(".sidebar .page-tabs"),
      })),
  );
  for (const scroller of scrollers)
    if (scroller.sidebar) expect(scroller.scrollbarWidth, scroller.label).toBe("none");
    else expect(scroller.gutter, scroller.label).toMatch(/^stable(?: both-edges)?$/);
}

async function expectThemeContrast(page: Page) {
  const ratios = await page.evaluate(() => {
    // The build may shorten hex colors, so let the browser resolve each variable to rgb().
    const probe = document.createElement("span");
    document.body.append(probe);
    const luminance = (name: string) => {
      probe.style.color = `var(${name})`;
      const rgb =
        getComputedStyle(probe)
          .color.match(/\d+(\.\d+)?/g)
          ?.slice(0, 3) ?? [];
      const channels = rgb.map((channel) => {
        const value = Number(channel) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return (
        (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
      );
    };
    const result = [
      "--bg",
      "--surface",
      "--surface-hover",
      "--row-alt",
      "--accent-bg",
      "--code",
      "--chat-bg",
    ].flatMap((background) =>
      ["--text", "--muted", "--control-border"].map((foreground) => {
        const a = luminance(foreground);
        const b = luminance(background);
        return {
          foreground,
          background,
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      }),
    );
    const human = luminance("--human-text");
    const chat = luminance("--chat-bg");
    result.push({
      foreground: "--human-text",
      background: "--chat-bg",
      ratio: (Math.max(human, chat) + 0.05) / (Math.min(human, chat) + 0.05),
    });
    const primary = luminance("--primary");
    const primaryText = luminance("--primary-text");
    result.push({
      foreground: "--primary-text",
      background: "--primary",
      ratio: (Math.max(primary, primaryText) + 0.05) / (Math.min(primary, primaryText) + 0.05),
    });
    probe.remove();
    return result;
  });
  for (const { foreground, background, ratio } of ratios) {
    expect(ratio, `${foreground} on ${background}`).toBeGreaterThanOrEqual(
      foreground === "--control-border" ? 3 : 4.5,
    );
  }
}

async function expectNeutralTheme(page: Page) {
  const palette = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const color = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
    const fills = Object.fromEntries(
      [
        "--bg",
        "--surface",
        "--surface-hover",
        "--row-alt",
        "--code",
        "--chat-bg",
        "--control-fill",
        "--field-fill",
        "--group-fill",
        "--disabled-fill",
        "--warning-bg",
        "--surface-band",
        "--footer-bg",
      ].map((token) => [token, color(token)]),
    );
    const colors = Object.fromEntries(
      [
        "--text",
        "--muted",
        "--border",
        "--control-border",
        "--accent-bg",
        "--surface-edge",
        "--disabled-stripe",
        "--primary",
        "--hover-bg",
        "--human-text",
      ].map((token) => [token, color(token)]),
    );
    probe.remove();
    return { dark, fills, colors };
  });
  for (const [token, fill] of Object.entries(palette.fills))
    expect(fill, token).toBe(
      palette.dark
        ? ["--surface-band", "--group-fill"].includes(token)
          ? "rgb(22, 32, 54)"
          : "rgb(15, 23, 42)"
        : "rgb(255, 255, 255)",
    );
  expect(palette.colors).toEqual(
    palette.dark
      ? {
          "--text": "rgb(255, 255, 255)",
          "--muted": "rgb(154, 168, 191)",
          "--border": "rgb(42, 58, 85)",
          "--control-border": "rgb(100, 121, 157)",
          "--accent-bg": "rgb(30, 43, 69)",
          "--surface-edge": "rgb(42, 58, 85)",
          "--disabled-stripe": "rgba(0, 0, 0, 0)",
          "--primary": "rgb(119, 183, 245)",
          "--hover-bg": "rgb(27, 45, 74)",
          "--human-text": "rgb(155, 202, 255)",
        }
      : {
          "--text": "rgb(0, 0, 0)",
          "--muted": "rgb(85, 85, 85)",
          "--border": "rgb(208, 208, 208)",
          "--control-border": "rgb(119, 119, 119)",
          "--accent-bg": "rgb(237, 237, 237)",
          "--surface-edge": "rgb(208, 208, 208)",
          "--disabled-stripe": "rgba(0, 0, 0, 0)",
          "--primary": "rgb(91, 159, 230)",
          "--hover-bg": "rgb(229, 240, 252)",
          "--human-text": "rgb(36, 95, 158)",
        },
  );
}

async function expectNavigationHighlight(page: Page, row: Locator) {
  await expect(row).toHaveAttribute("data-nav-active", "true");
  const highlight = await row.evaluate((element) => {
    const sidebar = element.closest(".sidebar");
    if (!sidebar) throw new Error("Missing navigation sidebar");
    const bounds = element.getBoundingClientRect();
    const bar = sidebar.getBoundingClientRect();
    const line = getComputedStyle(element, "::after");
    return {
      left: bounds.left,
      right: bounds.right,
      edge: bar.right - Number.parseFloat(getComputedStyle(sidebar).borderRightWidth),
      content: line.content,
      border: line.borderBottomWidth,
      decoration: getComputedStyle(
        element.querySelector(".page-tab-label, .chat-sidebar-label") ?? element,
      ).textDecorationLine,
      // The resize grip overlays the row's right edge and must not hide its highlight.
      grip: getComputedStyle(sidebar.querySelector(".sidebar-resize:not(:hover)") ?? sidebar)
        .backgroundColor,
    };
  });
  expect(highlight.left).toBe(0);
  expect(highlight.right).toBe(highlight.edge);
  expect(highlight.content).toBe("none");
  expect(highlight.border).toBe("0px");
  expect(highlight.decoration).toBe("none");
  expect(highlight.grip).toMatch(/^rgba\(\d+, \d+, \d+, 0\)$/);
  await expect(page.locator(".sidebar [data-nav-active='true']:visible")).toHaveCount(1);
  await expect(row).toHaveCSS("border-radius", "0px");
  // Forced colors drop box shadows; the system outline marks selection there.
  if (
    !(await row.evaluate(
      (element) =>
        element.matches(":focus-visible") || matchMedia("(forced-colors: active)").matches,
    ))
  )
    await expect(row).toHaveCSS("box-shadow", /^rgba?\([^)]+\) 2px 0px 0px 0px inset$/);
  if (await row.evaluate((element) => element.classList.contains("chat-sidebar-row")))
    for (const control of await row.locator(":scope > button").all())
      await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}

async function expectTabAppearance(page: Page) {
  // The native drag strip can retain stale hover. Clear into the non-draggable footer instead.
  await page.bringToFront();
  const corner = await page.evaluate(() => ({ x: innerWidth - 2, y: innerHeight - 2 }));
  const clearPointer = () => page.mouse.move(corner.x, corner.y);
  await clearPointer();
  await expect(page.locator(".sidebar button:hover")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .every((animation) => animation.playState !== "running"),
        ),
    )
    .toBe(true);
  const appearance = await page.evaluate(() => {
    const active = document.querySelector<HTMLElement>("[role='tab'][aria-selected='true']");
    const inactive = document.querySelector<HTMLElement>("[role='tab'][aria-selected='false']");
    const bar = document.querySelector(".sidebar");
    const controlled = document.getElementById(active?.getAttribute("aria-controls") ?? "");
    // Settings pages are nested inside the Settings page panel, which aligns with the sidebar.
    const panel = controlled?.closest(".page-panel") ?? controlled;
    if (!active || !inactive || !bar || !panel) throw new Error("Missing page tabs");
    return {
      activeId: active.id,
      activeBackground: getComputedStyle(active).backgroundColor,
      activeDecoration: getComputedStyle(active.querySelector(".page-tab-label") as Element)
        .textDecorationLine,
      panelBackground: getComputedStyle(panel).backgroundColor,
      leftBorders: [active, inactive, document.querySelector(".project-sidebar-open")].map(
        (element) => (element ? getComputedStyle(element).borderLeftWidth : ""),
      ),
      hoverBackground: (() => {
        const probe = document.createElement("span");
        probe.style.background = "var(--hover-bg)";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      })(),
      sidebarBackground: getComputedStyle(bar).backgroundColor,
      buttonBackgrounds: [...bar.querySelectorAll("button")].map((button) => ({
        label: button.getAttribute("aria-label") ?? button.textContent,
        background: getComputedStyle(button).backgroundColor,
        transparent: button.matches(
          ".icon-button, .sidebar-resize, .chat-sidebar-row > button, .project-chat-name",
        ),
        highlighted: button.matches(
          '[aria-selected="true"]:not(.page-group-toggle), [data-active="true"], [data-nav-active="true"] button',
        ),
      })),
      activeRight: active.getBoundingClientRect().right,
      panelLeft: panel.getBoundingClientRect().left,
      barTop: bar.getBoundingClientRect().top,
      barLeft: bar.getBoundingClientRect().left,
      barBottom: bar.getBoundingClientRect().bottom,
      versionBottom: (() => {
        const version = document.querySelector(".app-version");
        if (!version) throw new Error("Missing sidebar version");
        const range = document.createRange();
        range.selectNodeContents(version);
        return range.getBoundingClientRect().bottom;
      })(),
      timestampTop: document.querySelector(".poll-timestamp")?.getBoundingClientRect().top,
      footerTop: document.querySelector(".app-footer")?.getBoundingClientRect().top,
      footerBottom: document.querySelector(".app-footer")?.getBoundingClientRect().bottom,
      dragBottom: document.querySelector(".window-drag-strip")?.getBoundingClientRect().bottom,
      dragBackground: getComputedStyle(document.querySelector(".window-drag-strip") as Element)
        .backgroundImage,
      panelTop: panel.getBoundingClientRect().top,
      panelBottom: panel.getBoundingClientRect().bottom,
      barWidth: bar.getBoundingClientRect().width,
      tabTops: [...bar.querySelectorAll("[role='tab']")]
        .filter((tab) => tab.getClientRects().length > 0)
        .map((tab) => tab.getBoundingClientRect().top),
      inactiveBackground: getComputedStyle(inactive).backgroundColor,
    };
  });
  expect(appearance.leftBorders).toEqual(["1px", "1px", "0px"]);
  expect(appearance.activeBackground).not.toBe(appearance.sidebarBackground);
  expect(appearance.activeDecoration).toBe("none");
  await expectNavigationHighlight(page, page.locator(".sidebar [data-nav-active='true']:visible"));
  for (const button of appearance.buttonBackgrounds)
    expect(button.background, button.label ?? "Sidebar button").toBe(
      button.transparent
        ? "rgba(0, 0, 0, 0)"
        : button.highlighted
          ? appearance.activeBackground
          : appearance.sidebarBackground,
    );
  expect(appearance.activeBackground).not.toBe(appearance.hoverBackground);
  expect(appearance.barWidth).toBe(220);
  expect(appearance.activeRight).toBeLessThan(appearance.panelLeft);
  expect(appearance.barTop).toBe(appearance.panelTop);
  expect(appearance.barTop).toBe(appearance.dragBottom);
  expect(appearance.barLeft).toBe(0);
  expect(appearance.barBottom).toBe(appearance.panelBottom);
  expect((appearance.footerTop ?? 0) - appearance.barBottom).toBe(12);
  // The version's text stays clear of the footer's floating message-age row.
  expect(appearance.versionBottom).toBeLessThanOrEqual(appearance.footerBottom ?? 0);
  expect(appearance.dragBackground).toBe("none");
  await expect(page.locator(".sidebar")).toHaveCSS("border-radius", "0px");
  await expect(page.locator("#tab-chat")).toHaveCSS("padding-top", "4px");
  expect(appearance.tabTops.every((top, i, tops) => i === 0 || top > (tops[i - 1] ?? 0))).toBe(
    true,
  );
  await expect(page.locator("#app-pages [role=tablist]").first()).toHaveAttribute(
    "aria-orientation",
    "vertical",
  );
  expect(appearance.inactiveBackground).toBe(appearance.sidebarBackground);
  await expect(page.locator(".sidebar")).toHaveCSS("border-width", "0px 1px 0px 0px");
  const inactive = page.locator('[role="tab"][aria-selected="false"]:visible').first();
  const border = await inactive.evaluate((element) => getComputedStyle(element).borderColor);
  const glyph = inactive.locator("svg").first();
  async function expectHover(button: Locator) {
    const paint = (await button.evaluate((element) =>
      element.matches(".chat-sidebar-row > button"),
    ))
      ? button.locator("..")
      : button;
    await expect(async () => {
      await clearPointer();
      await button.hover();
      await expect(paint).toHaveCSS("background-color", appearance.hoverBackground, {
        timeout: 500,
      });
    }).toPass({ timeout: 5_000 });
  }
  await expectHover(inactive);
  await expect(glyph).toHaveCSS(
    "color",
    await inactive.evaluate((element) => getComputedStyle(element).color),
  );
  const newChat = page.getByRole("button", { name: /^New chat in / });
  if (await newChat.count()) await expectIconAction(newChat.first());
  else await expect(page.getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
  await expect(inactive).toHaveCSS("border-color", border);
  await expect(inactive).toHaveCSS("outline-style", "none");
  await expectHover(page.locator(`#${appearance.activeId}`));
  const otherButtons = page.locator(
    ".sidebar .page-group-toggle:visible, .sidebar .chat-sidebar-entry[aria-current='true']:visible:enabled",
  );
  for (const button of await otherButtons.all()) {
    await expectHover(button);
  }
  await clearPointer();

  await expect(page.getByRole("button", { name: "Close Settings tab" })).toHaveCount(0);
}

async function appendRow(page: Page, table: "sessions" | "configurations" = "sessions") {
  const grid = page.locator(`#panel-${table} .sessions-grid`);
  const canvas = grid.getByTestId("data-grid-canvas");
  // The add row ignores clicks while it is disabled, such as while a project opens.
  await expect(page.locator(`#panel-${table} .table-add-accessible`)).toBeEnabled();
  // Project success toasts can arrive during that wait and cover the sticky row.
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
  for (let count = 0; count < 3 && (await dismiss.count()); count++) await dismiss.first().click();
  // Glide's canvas fills the scroller's client area, excluding its reserved gutter.
  await expect
    .poll(() =>
      grid.evaluate((element) => {
        const canvas = element.querySelector('[data-testid="data-grid-canvas"]');
        const scroller = element.querySelector(".dvn-scroller");
        return (
          !!canvas &&
          !!scroller &&
          Math.abs(canvas.getBoundingClientRect().width - scroller.clientWidth) < 1
        );
      }),
    )
    .toBe(true);
  const box = await canvas.boundingBox();
  // Glide receives pointer events on its transparent scroller above the canvas.
  const scroller = grid.locator(".dvn-scroller");
  const receiver = await scroller.boundingBox();
  if (!box || !receiver) throw new Error("Missing table canvas");
  const row = Number(await grid.getAttribute("data-row-height"));
  // The sticky add row is pinned to the bottom of the canvas, whatever the row count.
  await scroller.click({
    position: { x: box.x + 70 - receiver.x, y: box.y + box.height - row / 2 - receiver.y },
  });
}

async function launch(directory: string, folder: string, database: string, configured = true) {
  // Every automatic orchestration session uses the local ACP fixture, never a live provider.
  const configFile = join(directory, "config", "code60", "config.json");
  await mkdir(dirname(configFile), { recursive: true });
  try {
    // Exclusive creation keeps any config a scenario wrote, without a check-then-write race.
    await writeFile(
      configFile,
      JSON.stringify({
        agents: {
          claude: { command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs")] },
        },
      }),
      { flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Most scenarios start with an existing provider; setup is covered without this fixture below.
  if (configured) {
    const file = join(directory, "state", "code60", "desktop.json");
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    if (!Object.hasOwn(saved, "agentSetup")) {
      const config = JSON.parse(await readFile(configFile, "utf8"));
      const provider = config.defaultAgent ?? "claude";
      await privateDirectory(dirname(file));
      await writeFile(
        file,
        JSON.stringify({
          ...saved,
          orchestrationProvider: provider,
          agentSetup: verifiedAgents(
            {
              ...DEFAULT_CONFIG,
              ...config,
              agents: { ...DEFAULT_CONFIG.agents, ...config.agents },
            },
            provider,
          ),
        }),
      );
    }
  }
  return launchDesktop(directory, folder, database);
}

test("desktop: project chat recovers a missed update without losing messages or drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-snapshot-gap-"));
  const project = join(directory, "project");
  await mkdir(project);
  try {
    application = await launch(directory, project, join(directory, "relay.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      const { databaseEpoch } = await window.desktop.snapshot();
      await window.desktop.connectDatabase("create", databaseEpoch);
      const opened = await window.desktop.snapshot();
      await window.desktop.chooseFolder(opened.databaseEpoch);
    });
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.kind)
      .toBe("project");
    const selectedChat = await page.evaluate(
      async () => (await window.desktop.snapshot()).chat.run?.id,
    );
    const chat = page.locator(".orchestration-chat-page:visible");
    await expect(chat).toHaveAttribute("data-chat-id", selectedChat as string);
    const composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    const text = "Preserve this prompt across a missed broadcast";
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Missing desktop window");
      const scope = globalThis as typeof globalThis & { __code60DroppedUpdate?: boolean };
      scope.__code60DroppedUpdate = false;
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...args) => {
        const snapshot = args[0] as Snapshot | undefined;
        if (
          channel === "desktop:update" &&
          !scope.__code60DroppedUpdate &&
          snapshot?.chat.kind === "project" &&
          snapshot.chat.run?.turns === 1
        ) {
          if (!snapshot.summaryOnly || snapshot.chat.events.length)
            throw new Error("App updates must contain summaries, not transcripts");
          scope.__code60DroppedUpdate = true;
          return;
        }
        send(channel, ...args);
      };
    });
    await composer.fill(text);
    await composer.press("Enter");
    const sent = await page.evaluate(async () => {
      const snapshot = await window.desktop.snapshot();
      return {
        kind: snapshot.chat.kind,
        turns: snapshot.chat.run?.turns,
        relayTurns: snapshot.chats.find((chat) => chat.kind === "relay")?.run?.turns,
      };
    });
    expect(sent).toEqual({ kind: "project", turns: 1, relayTurns: 0 });
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            (globalThis as typeof globalThis & { __code60DroppedUpdate?: boolean })
              .__code60DroppedUpdate,
        ),
      )
      .toBe(true);
    await composer.fill("Draft retained during resynchronization");
    await page.evaluate(() => window.desktop.poll(["config"]));
    await expect(chat.locator(".event.prompt:not(.automatic) pre")).toHaveText(text);
    await expect(chat.locator(".event.message .chat-markdown")).toHaveText("ok");
    await expect(composer).toHaveValue("Draft retained during resynchronization");
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.turns).toBe(1);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: project chat recovers a missed detail frame without app transcript fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-detail-gap-"));
  const project = join(directory, "project");
  await mkdir(project);
  try {
    application = await launch(directory, project, join(directory, "relay.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      const { databaseEpoch } = await window.desktop.snapshot();
      await window.desktop.connectDatabase("create", databaseEpoch);
      await window.desktop.chooseFolder((await window.desktop.snapshot()).databaseEpoch);
    });
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.kind)
      .toBe("project");
    const selected = await page.evaluate(
      async () => (await window.desktop.snapshot()).chat.run?.id,
    );
    const chat = page.locator(".orchestration-chat-page:visible");
    await expect(chat).toHaveAttribute("data-chat-id", selected as string);
    const composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    const text = "Recover this second prompt through its detail subscription";
    await application.evaluate(({ BrowserWindow }, text) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Missing desktop window");
      const scope = globalThis as typeof globalThis & { __code60DroppedDetail?: boolean };
      scope.__code60DroppedDetail = false;
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...args) => {
        if (channel === "desktop:update") {
          const snapshot = args[0] as Snapshot;
          const compact = (chat: Snapshot["chat"]) =>
            chat.kind === "project" ? { ...chat, events: [] } : chat;
          // Detail recovery must work without the compatibility app transcript.
          send(channel, {
            ...snapshot,
            chat: compact(snapshot.chat),
            chats: snapshot.chats.map(compact),
          });
          return;
        }
        const frame = args[0] as import("../src/bridge/index.js").DetailFrame | undefined;
        if (
          channel === "desktop:detail" &&
          !scope.__code60DroppedDetail &&
          frame &&
          !frame.closed &&
          frame.payload.kind === "conversation" &&
          frame.payload.chat.events.some(
            ({ event }) => event.type === "prompt" && event.text === text,
          )
        ) {
          scope.__code60DroppedDetail = true;
          return;
        }
        send(channel, ...args);
      };
    }, text);
    await composer.fill("Warmup for the independent detail stream");
    await composer.press("Enter");
    await expect(chat.locator(".event.message .chat-markdown")).toHaveText("ok");
    await expect(composer).toBeEnabled();
    await composer.fill(text);
    await composer.press("Enter");
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            (globalThis as typeof globalThis & { __code60DroppedDetail?: boolean })
              .__code60DroppedDetail,
        ),
      )
      .toBe(true);
    await composer.fill("Draft survives scoped detail recovery");
    await page.evaluate(() => window.desktop.poll(["config"]));
    await expect(chat.locator(".event.prompt:not(.automatic) pre")).toHaveText([
      "Warmup for the independent detail stream",
      text,
    ]);
    await expect(chat.locator(".event.message .chat-markdown")).toHaveText(["ok", "ok"]);
    await expect(composer).toHaveValue("Draft survives scoped detail recovery");
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Automations keeps maintenance collapsed and adapts its editor to narrow windows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-automations-layout-"));
  try {
    application = await launch(directory, directory, join(directory, "code60.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("tab", { name: "Automations", exact: true }).click();
    const panel = page.locator("#panel-automations");
    await expect(panel.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Install service", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Uninstall", exact: true })).not.toBeVisible();
    for (const grid of await panel.locator(".automation-grid").all()) {
      const canvas = grid.locator("canvas").first();
      await expect(canvas).toBeVisible();
      expect((await canvas.boundingBox())?.height).toBeGreaterThan(100);
    }
    for (const scheme of ["light", "dark"]) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-color-scheme", value),
        scheme,
      );
      await page.screenshot({ path: test.info().outputPath(`automations-${scheme}.png`) });
    }
    await panel.getByText("Service options", { exact: true }).click();
    await expect(panel.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
    await panel.getByText("Service options", { exact: true }).click();
    await panel.getByRole("button", { name: "New automation", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "New automation", exact: true });
    await expect(editor.getByLabel("Saved prompt", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("automation-editor-wide.png") });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(760, 650),
    );
    await expect(editor).toBeVisible();
    expect(
      await editor.locator(".automation-form").evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth,
        scrollable: element.scrollHeight > element.clientHeight,
      })),
    ).toEqual({ overflow: false, scrollable: true });
    await editor
      .getByRole("button", { name: "Save automation", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(editor.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("automation-editor-narrow.png") });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      await panel
        .locator(".automations-page")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(false);
    await page.screenshot({ path: test.info().outputPath("automations-narrow.png") });
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Home cards navigate, align with page titles and adapt to themes and large text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-home-cards-"));
  try {
    application = await launch(directory, directory, join(directory, "code60.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const homeTab = page.getByRole("tab", { name: "Home", exact: true });
    const home = page.locator("#panel-home");
    const relay = home.getByRole("button", { name: "Open Relay", exact: true });
    const commands = home.getByRole("button", { name: "Open Command Builder", exact: true });
    const prompts = home.getByRole("button", { name: "Open Prompt Builder", exact: true });
    await homeTab.click();
    await expect(home.locator(".home-card")).toHaveCount(3);
    await expect(relay).toBeEnabled();
    await expect(commands).toBeDisabled();
    await expect(prompts).toBeDisabled();
    await expect(home.locator(".home-card-description")).toHaveCount(0);
    await relay.focus();
    await relay.press("Enter");
    await expect(page.locator("#panel-chat")).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message to orchestrator", exact: true });
    await composer.fill("Keep my Relay draft");
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await selectProjectConversation(page);
    await homeTab.click();
    await expect(commands).toBeEnabled();
    await relay.click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.kind)
      .toBe("relay");
    await expect(composer).toHaveValue("Keep my Relay draft");
    await homeTab.click();
    const homeTitle = await home.getByRole("heading", { name: "Home", exact: true }).boundingBox();
    await commands.click();
    const commandsTitle = page
      .locator("#panel-commands")
      .getByRole("heading", { name: "Command Builder", exact: true });
    await expect(commandsTitle).toBeVisible();
    const commandsBounds = await commandsTitle.boundingBox();
    expect(homeTitle?.x).toBe(commandsBounds?.x);
    expect(homeTitle?.y).toBe(commandsBounds?.y);
    await homeTab.click();
    await prompts.click();
    await expect(
      page.locator("#panel-prompts").getByRole("heading", { name: "Prompt Builder", exact: true }),
    ).toBeVisible();
    await homeTab.click();
    for (const scheme of ["light", "dark"]) {
      await page.evaluate(
        (scheme) => document.documentElement.setAttribute("data-color-scheme", scheme),
        scheme,
      );
      await expect(relay).toHaveCSS(
        "background-color",
        scheme === "dark" ? "rgb(15, 23, 42)" : "rgb(255, 255, 255)",
      );
      await page.screenshot({ path: test.info().outputPath(`home-cards-${scheme}.png`) });
    }
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 650),
    );
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--text-size", "32px");
      document.documentElement.style.setProperty("--title-size", "32px");
    });
    const overflow = await home
      .locator(".home-content")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(false);
    await prompts.focus();
    await expect(prompts).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("home-cards-large-text.png") });
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await expect(prompts).toHaveCSS("transition-duration", "0s");
    await expect(prompts).toBeFocused();
    await prompts.press("Enter");
    await expect(page.locator("#panel-prompts")).toBeVisible();
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Relay connects without a database and retains identity, draft and bounded restart history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-relay-desktop-"));
  const project = join(directory, "project");
  await mkdir(project);
  try {
    const store = await RelayStore.open(join(directory, "state", "code60", "relay"));
    try {
      await store.markIncomplete();
    } finally {
      await store.close();
    }
    application = await launch(directory, project, join(directory, "relay.sqlite"));
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    let chat = page.locator(".orchestration-chat-page:visible");
    let composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    await expect(chat.getByRole("region", { name: "Previous Relay conversation" })).toHaveCount(0);
    const relay = page.getByRole("button", { name: "Relay", exact: true });
    const mark = relay.locator(".relay-navigation-icon");
    await expect(relay).toBeEnabled();
    const sidebarRows = page.locator(".page-tabs");
    await expect(sidebarRows.locator(":scope > :first-child")).toHaveText("Home");
    await expect(sidebarRows.locator(":scope > :nth-child(2)")).toHaveClass(/\brelay-sidebar\b/);
    await expect(sidebarRows.locator(":scope > :nth-child(3)")).toHaveText("Projects");
    await expect(page.locator(".sidebar .wordmark")).toHaveCount(0);
    const home = page.getByRole("tab", { name: "Home", exact: true });
    await expect(home.locator('[data-icon="house"]')).toHaveCount(1);
    await composer.fill("Home navigation preserves this draft");
    await relay.press("ArrowUp");
    await expect(home).toBeFocused();
    await expect(page.locator("#panel-home")).toBeVisible();
    await expect(
      page.locator("#panel-home").getByRole("heading", { name: "Home", exact: true }),
    ).toBeVisible();
    await expect(home).toHaveAttribute("aria-selected", "true");
    await expectNavigationHighlight(page, home.locator(".."));
    await home.press("ArrowDown");
    await expect(relay).toBeFocused();
    await relay.press("Enter");
    await expect(composer).toHaveValue("Home navigation preserves this draft");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Home");
    await page.keyboard.press("Enter");
    await expect(page.locator("#panel-home")).toBeVisible();
    await relay.click();
    await expect(page.locator("#chat-pages").getByRole("button", { name: "Relay" })).toHaveCount(0);
    await expect(mark).toHaveAttribute("data-state", "ready");
    await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeHidden();
    const initial = await page.evaluate(() => window.desktop.snapshot());
    expect(initial.database).toBeNull();
    expect(initial.chat.kind).toBe("relay");
    expect(initial.chat.run?.status).toBe("idle");
    expect(initial.chat.run?.turns).toBe(0);
    expect(initial.chat.workers).toEqual([]);
    const identity = initial.chat.conversationId;
    const runId = initial.chat.run?.id;
    await composer.fill("Relay draft survives database and project changes");
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await expect(composer).toHaveValue("Relay draft survives database and project changes");
    const connected = await page.evaluate(() => window.desktop.snapshot());
    expect(connected.chat.conversationId).toBe(identity);
    expect(connected.chat.run?.id).toBe(runId);
    expect(connected.chat.run?.turns).toBe(0);
    await expect(
      page.getByRole("button", { name: "Toggle files panel", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("#relay-plan-panel")).toHaveAttribute("aria-hidden", "true");
    expect(connected.files).toBeNull();
    await composer.fill("/p");
    await composer.press("Tab");
    await expect(composer).toHaveValue("/p");
    await composer.focus();
    await composer.press("Enter");
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.turns)
      .toBe(1);
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.status)
      .toBe("idle");
    const literal = await page.evaluate(() => window.desktop.snapshot());
    expect(
      literal.chat.events.some(({ event }) => event.type === "prompt" && event.text === "/p"),
    ).toBe(true);
    await composer.fill(JSON.stringify([{ hang: "cancellable" }]));
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Enter");
    await expect(mark).toHaveAttribute("data-state", "working");
    const car = mark.locator(".relay-car").first();
    await expect(car).toHaveCSS("animation-name", "relay-lap");
    const distance = await car.evaluate((element) => getComputedStyle(element).offsetDistance);
    await expect(car).not.toHaveCSS("offset-distance", distance);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(car).toHaveCSS("animation-name", "none");
    await expect(mark).toHaveAttribute("data-state", "working");
    await page.emulateMedia({ reducedMotion: null });
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(mark).toHaveAttribute("data-state", "ready");
    await expect(composer).toBeEnabled();
    await composer.fill("/review literal Relay request 😀");
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Enter");
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.turns)
      .toBe(3);
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.status)
      .toBe("idle");
    await composer.fill("Persistent Relay draft");
    await page.reload();
    chat = page.locator(".orchestration-chat-page:visible");
    composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toHaveValue("Persistent Relay draft");
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(runId);
    await application.close();
    application = await launch(directory, project, join(directory, "relay.sqlite"));
    page = await application.firstWindow();
    chat = page.locator(".orchestration-chat-page:visible");
    await expect(chat.getByRole("combobox", { name: "Message to orchestrator" })).toBeEnabled();
    await expect(chat.getByRole("region", { name: "Previous Relay conversation" })).toHaveCount(0);
    const restarted = await page.evaluate(() => window.desktop.snapshot());
    expect(restarted.chat.conversationId).toBe(identity);
    expect(restarted.chat.run?.id).not.toBe(runId);
    expect(restarted.chat.run?.turns).toBe(0);
    expect(restarted.chat.workers).toEqual([]);
    expect(restarted.chat.history?.characters).toBeLessThanOrEqual(64_000);
    expect(restarted.chats.filter((entry) => entry.kind === "relay")).toHaveLength(1);
    if (process.platform !== "win32") {
      await page.getByRole("button", { name: "Start", exact: true }).click();
      const journal = join(directory, "state", "code60", "relay", "history.frames");
      await chmod(journal, 0o400);
      try {
        composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
        await composer.fill("Keep chatting when history cannot be saved");
        await composer.press("Enter");
        await expect(
          chat.getByRole("status").filter({ hasText: "History isn’t being saved." }),
        ).toBeVisible();
        await expect
          .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.status)
          .toBe("idle");
        await expect(page.getByRole("button", { name: "Relay", exact: true })).not.toContainText(
          "Failed",
        );
        await composer.fill("A second live message");
        await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await composer.press("Enter");
        await expect
          .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.turns)
          .toBe(2);
        const failedSaving = await page.evaluate(() => window.desktop.snapshot());
        expect(failedSaving.chat.error).toBeNull();
        expect(failedSaving.chat.historySaving).toBe("unavailable");
      } finally {
        await chmod(journal, 0o600);
      }
    }
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: incomplete Relay history remains usable and navigable from a project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-relay-failed-"));
  const project = join(directory, "project");
  await mkdir(project);
  const store = await RelayStore.open(join(directory, "state", "code60", "relay"));
  try {
    await store.append({
      id: randomUUID(),
      role: "human",
      at: new Date().toISOString(),
      text: "Preserved recovery evidence",
    });
    await store.markIncomplete();
  } finally {
    await store.close();
  }
  try {
    application = await launch(directory, project, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const relay = page.getByRole("button", { name: "Relay", exact: true });
    await expect(relay).toBeEnabled();
    const chat = page.locator(".orchestration-chat-page:visible");
    await expect(chat.getByRole("region", { name: "Previous Relay conversation" })).toHaveCount(0);
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.status)
      .toBe("idle");
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectProjectConversation(page);
    await expect(chat.getByRole("combobox")).toBeEnabled();
    await relay.click();
    await expect(relay).toHaveAttribute("aria-current", "true");
    await expect(chat.getByRole("region", { name: "Previous Relay conversation" })).toHaveCount(0);
    // The recorded gap stays in the snapshot but is not announced in Chat.
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.history?.incomplete).toBe(
      true,
    );
    await expect(chat.getByText(/weren’t saved/)).toHaveCount(0);
    await page.reload();
    await expect(chat.getByText(/weren’t saved/)).toHaveCount(0);
    await chat.getByRole("combobox", { name: "Message to orchestrator" }).fill("Continue chatting");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.turns)
      .toBe(1);
    await expect(chat.locator(".error-banner")).toHaveCount(0);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Relay shows live chat without a historical transcript or history controls", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "code60-relay-copy-")));
  const project = join(directory, "project");
  await mkdir(project);
  const original =
    "  **Original head**\n```txt\n" + "😀文line\n".repeat(15_000) + "\n```\nTail\t\n";
  const store = await RelayStore.open(join(directory, "state", "code60", "relay"));
  try {
    const at = new Date().toISOString();
    await store.append({ id: randomUUID(), role: "human", at, text: "Earlier request" });
    await store.append({ id: randomUUID(), role: "assistant", at, text: original });
    await store.append({ id: randomUUID(), role: "human", at, text: "Latest request" });
  } finally {
    await store.close();
  }
  try {
    application = await launch(directory, project, join(directory, "unused.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const chat = page.locator(".orchestration-chat-page:visible");
    const composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    await expect(chat.getByRole("region", { name: "Previous Relay conversation" })).toHaveCount(0);
    await expect(
      chat.getByRole("button", { name: /Read older history|Latest history|Copy original message/ }),
    ).toHaveCount(0);
    await expect(chat.getByText("Partial excerpt", { exact: false })).toHaveCount(0);
    await expect(chat.getByText("Latest request", { exact: false })).toHaveCount(0);
    await composer.fill("A live Relay message");
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Enter");
    await expect(chat.getByRole("log")).toContainText("A live Relay message");
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.status)
      .toBe("idle");
    const reply = chat.getByRole("log").locator(".event.message").last();
    await reply.hover();
    await reply.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect
      .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("ok");
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.chat.history?.characters).toBeLessThanOrEqual(64_000);
    expect(snapshot.chat.run?.turns).toBe(1);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: database writes reject stale epochs without retargeting Relay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-database-epoch-"));
  const firstPath = join(directory, "first.sqlite");
  const secondPath = join(directory, "second.sqlite");
  application = await launch(directory, directory, firstPath);
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const first = await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      const snapshot = await window.desktop.snapshot();
      const epoch = snapshot.databaseEpoch;
      if (epoch === undefined) throw new Error("Missing database epoch");
      await window.desktop.saveCommand(
        { name: "epoch-check", title: "Saved in A", prompt: "Original" },
        epoch,
      );
      await window.desktop.saveConfiguration(
        {
          name: "Saved in A",
          settings: { agents: ["claude"], allow: [], allowAll: false },
        },
        epoch,
      );
      await window.desktop.savePromptTemplate(
        { id: "handoffTurn", template: "Edit {{message}}" },
        epoch,
      );
      const saved = await window.desktop.snapshot();
      return {
        epoch,
        relayId: saved.chat.conversationId,
        commandId: saved.commands[0]?.id as string,
        configurationId: saved.configurations[0]?.id as string,
      };
    });
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, secondPath);
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    const statuses = await page.evaluate(async ({ epoch, commandId, configurationId }) => {
      const results = await Promise.allSettled([
        window.desktop.saveCommand(
          { name: "stale", title: "Stale", prompt: "Must not save" },
          epoch,
        ),
        window.desktop.deleteCommand({ id: commandId }, epoch),
        window.desktop.saveConfiguration(
          {
            name: "Stale",
            settings: { agents: ["claude"], allow: [], allowAll: false },
          },
          epoch,
        ),
        window.desktop.deleteConfiguration(configurationId, epoch),
        window.desktop.savePromptTemplate(
          { id: "handoffTurn", template: "Stale {{message}}" },
          epoch,
        ),
        window.desktop.resetPromptTemplate("handoffTurn", epoch),
      ]);
      return results.map((result) => result.status);
    }, first);
    expect(statuses).toEqual(Array(6).fill("rejected"));
    await expect(
      page.evaluate(() =>
        window.desktop.saveCommand({
          name: "missing",
          title: "Missing epoch",
          prompt: "Must not save",
        }),
      ),
    ).rejects.toThrow("current database epoch");
    const second = await page.evaluate(() => window.desktop.snapshot());
    expect(second.commands).toEqual([]);
    expect(second.configurations).toEqual([]);
    expect(second.prompts.find((prompt) => prompt.id === "handoffTurn")?.source).toBe("built-in");
    expect(second.chat.conversationId).toBe(first.relayId);
    expect(second.chat.run?.turns).toBe(0);
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, firstPath);
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("open", databaseEpoch)),
    );
    const reopened = await page.evaluate(() => window.desktop.snapshot());
    expect(reopened.commands).toMatchObject([{ id: first.commandId, title: "Saved in A" }]);
    expect(reopened.configurations).toMatchObject([
      { id: first.configurationId, name: "Saved in A" },
    ]);
    expect(reopened.prompts.find((prompt) => prompt.id === "handoffTurn")?.template).toBe(
      "Edit {{message}}",
    );
    expect(reopened.chat.conversationId).toBe(first.relayId);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

for (const stage of ["database", "folder", "confirmation"] as const) {
  test(`desktop: stale native ${stage} result cannot act after same-path database reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "code60-picker-epoch-"));
    const firstPath = join(directory, "first.sqlite");
    const secondPath = join(directory, "second.sqlite");
    const stalePath = join(directory, "must-not-create.sqlite");
    application = await launch(directory, directory, firstPath);
    try {
      const page = await application.firstWindow();
      await page.getByRole("button", { name: "Start", exact: true }).click();
      await page.evaluate(async () => {
        const { databaseEpoch } = await window.desktop.snapshot();
        await window.desktop.connectDatabase("create", databaseEpoch);
      });
      const initial = await page.evaluate(() => window.desktop.snapshot());
      await application.evaluate(
        ({ dialog }, { stage, directory, secondPath, stalePath }) => {
          const scope = globalThis as typeof globalThis & { __code60PickerRelease?: () => void };
          dialog.showSaveDialog = async () => {
            if (stage !== "database" || scope.__code60PickerRelease)
              return { canceled: false, filePath: secondPath };
            return new Promise((resolve) => {
              scope.__code60PickerRelease = () => resolve({ canceled: false, filePath: stalePath });
            });
          };
          dialog.showOpenDialog = async () => {
            if (stage !== "folder") return { canceled: false, filePaths: [directory] };
            return new Promise((resolve) => {
              scope.__code60PickerRelease = () =>
                resolve({ canceled: false, filePaths: [directory] });
            });
          };
          dialog.showMessageBox = async () => {
            if (stage !== "confirmation") return { response: 1, checkboxChecked: false };
            return new Promise((resolve) => {
              scope.__code60PickerRelease = () => resolve({ response: 1, checkboxChecked: false });
            });
          };
        },
        { stage, directory, secondPath, stalePath },
      );
      await page.evaluate(
        ({ stage, epoch }) => {
          const scope = window as typeof window & { __code60PickerResult?: Promise<string> };
          const pending =
            stage === "database"
              ? window.desktop.connectDatabase("create", epoch)
              : window.desktop.chooseFolder(epoch);
          scope.__code60PickerResult = pending.then(
            () => "unexpected success",
            (error: unknown) => String(error),
          );
        },
        { stage, epoch: initial.databaseEpoch },
      );
      await expect
        .poll(() =>
          application.evaluate(
            () =>
              typeof (globalThis as typeof globalThis & { __code60PickerRelease?: () => void })
                .__code60PickerRelease,
          ),
        )
        .toBe("function");
      await page.evaluate(async () => {
        const { databaseEpoch } = await window.desktop.snapshot();
        await window.desktop.connectDatabase("create", databaseEpoch);
      });
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, firstPath);
      await page.evaluate(async () => {
        const { databaseEpoch } = await window.desktop.snapshot();
        await window.desktop.connectDatabase("open", databaseEpoch);
      });
      await application.evaluate(() => {
        (
          globalThis as typeof globalThis & { __code60PickerRelease?: () => void }
        ).__code60PickerRelease?.();
      });
      const result = await page.evaluate(
        () =>
          (window as typeof window & { __code60PickerResult?: Promise<string> })
            .__code60PickerResult,
      );
      expect(result).toContain("database instance changed");
      await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
      for (const operation of [
        () => page.evaluate(() => window.desktop.connectDatabase("open")),
        () => page.evaluate(() => window.desktop.chooseFolder()),
      ])
        await expect(operation()).rejects.toThrow("current database epoch");
      const reopened = await page.evaluate(() => window.desktop.snapshot());
      expect(reopened.database).toBe(firstPath);
      expect(reopened.databaseEpoch).not.toBe(initial.databaseEpoch);
      expect(reopened.projects).toEqual([]);
      expect(reopened.openProjects).toEqual([]);
      expect(reopened.chat.conversationId).toBe(initial.chat.conversationId);
      expect(reopened.chat.run?.turns).toBe(0);
    } finally {
      await application.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("desktop: multi-project sidebar has aligned hierarchy and anchored menus", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-sidebar-layout-"));
  const folders = ["project-a", "project-b", "project-c"].map((name) => join(directory, name));
  for (const folder of folders) {
    await mkdir(folder);
    execFileSync("git", ["init", "-q", folder]);
    commitFixture(folder);
  }
  const configFile = join(directory, "config", "code60", "config.json");
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--review"],
        },
      },
    }),
  );
  try {
    application = await launch(directory, folders[0] ?? "", join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    const composer = () => page.locator(".orchestration-chat-page:visible").getByRole("combobox");
    await expect(page.locator(".project-sidebar-open")).not.toHaveAttribute(
      "aria-label",
      "Connect to database",
    );
    for (const [index, folder] of folders.entries()) {
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, folder);
      await page.locator(".project-sidebar-open").click();
      await page
        .getByRole("dialog", { name: "Open Project", exact: true })
        .getByRole("button", { name: "Open Folder", exact: true })
        .click();
      const group = page.getByRole("region", { name: `Project ${folder}`, exact: true });
      for (let chat = 0; chat < (index === 0 ? 2 : index === 1 ? 3 : 1); chat++) {
        const previous = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
        await group
          .getByRole("button", { name: `New chat in ${basename(folder)}`, exact: true })
          .click();
        await expect
          .poll(async () => {
            const id = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
            return id !== undefined && id !== previous;
          })
          .toBe(true);
        const selected = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
        await expect(
          page.locator(`.orchestration-chat-page[data-chat-id="${selected}"]`),
        ).toBeVisible();
        await expect(composer()).toBeEnabled();
        if (index === 0 && chat === 0) {
          await composer().fill("Implement validation");
          await composer().press("Enter");
          await expect(
            group.getByRole("button", { name: "Validation", exact: true }),
          ).toBeVisible();
          await expect(composer()).toBeEnabled();
        }
        await composer().fill(`${basename(folder)} draft ${chat}`);
      }
    }
    await expect(page.locator(".project-chat-group")).toHaveCount(3);
    const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
    while (await dismiss.count()) await dismiss.first().click();
    await page.screenshot({ path: join(root, "test-results", "multi-project-sidebar.png") });
    const expectHierarchy = async () => {
      const positions = await page.locator("#chat-pages").evaluate((element) => {
        const x = (node: Element | null) => node?.getBoundingClientRect().x ?? -1;
        return {
          chat: x(document.querySelector("#tab-chat .page-tab-label")),
          projects: [...element.querySelectorAll(".project-chat-title")].map(x),
          clipped: [
            ...element.querySelectorAll(".project-chat-title, .project-chat-activity"),
          ].some((label) => {
            // Trimmed titles keep their ascenders and descenders visible.
            const parent = label.closest(".project-chat-name")?.getBoundingClientRect();
            const bounds = label.getBoundingClientRect();
            return !parent || bounds.top < parent.top || bounds.bottom > parent.bottom;
          }),
          chats: [
            ...element.querySelectorAll(
              ".project-chat-pages [data-role='orchestrator'] .chat-sidebar-label",
            ),
          ].map(x),
          workers: [
            ...element.querySelectorAll(
              ".project-chat-pages [data-role='worker'] .chat-sidebar-label",
            ),
          ].map(x),
          toggles: [...element.querySelectorAll(".project-chat-heading")].map((heading) => ({
            label: x(heading.querySelector(".project-chat-name")),
            more: x(heading.querySelector("[aria-haspopup='menu']")),

            right: heading.querySelector("[aria-haspopup='menu']")?.getBoundingClientRect().right,
            edge: heading.getBoundingClientRect().right,
          })),
        };
      });
      const projectInset = positions.chat + 19;
      expect.soft(positions.projects).toEqual(Array(3).fill(projectInset));
      expect.soft(positions.chats).toEqual(Array(6).fill(projectInset + 24));
      expect.soft(positions.workers).toEqual(Array(2).fill(projectInset + 48));
      expect.soft(positions.clipped).toBe(false);
      for (const row of positions.toggles) {
        expect.soft(row.more).toBeGreaterThan(row.label);
        expect.soft(row.right).toBe(row.edge);
      }
    };
    await expectHierarchy();
    await expect
      .soft(page.locator(".project-sidebar-open"))
      .toHaveAttribute("aria-label", "Open Project");
    await expect.soft(page.locator("#chat-pages")).not.toContainText("Legacy history:");
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect
      .soft(snapshot.chats.every((chat) => chat.kind === "relay" || chat.kind === "project"))
      .toBe(true);

    const group = page.getByRole("region", { name: `Project ${folders[0]}`, exact: true });
    const more = group.getByRole("button", { name: `More for ${folders[0]}`, exact: true });
    await more.click();
    const menu = page.getByRole("menu", { name: `Actions for ${folders[0]}`, exact: true });
    await expect(menu).toBeVisible();
    const anchor = await more.boundingBox();
    const popup = await menu.boundingBox();
    expect(anchor).not.toBeNull();
    expect(popup).not.toBeNull();
    if (anchor && popup) {
      expect.soft(Math.abs(popup.y - anchor.y - anchor.height)).toBeLessThanOrEqual(8);
      expect.soft(Math.abs(popup.x - anchor.x)).toBeLessThanOrEqual(8);
    }
    await page.screenshot({ path: join(root, "test-results", "multi-project-menu.png") });
    await expect
      .soft(menu.getByRole("menuitem", { name: "Stop folder", exact: true }))
      .toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect
      .soft(menu.getByRole("menuitem", { name: "Close project", exact: true }))
      .toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    await more.click();
    await page.locator(".orchestration-chat-page:visible .chat-title").click();
    await expect(menu).toBeHidden();
    // The title's own action is unrelated to the menu; cancel its rename dialog.
    await page.keyboard.press("Escape");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 650),
    );
    await more.click();
    await page.locator(".page-tabs").evaluate((element) => {
      element.scrollTop += 20;
    });
    await expect(menu).toBeHidden();
    await more.click();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 780),
    );
    await expect(menu).toBeHidden();
    const aChat = group.getByRole("button", { name: "Chat 2", exact: true });
    await aChat.click();
    await expect(composer()).toHaveValue("project-a draft 1");
    const beforeClose = await page.evaluate(() => window.desktop.snapshot());
    const selected = beforeClose.chat.run?.id;
    const toggle = group.locator(".project-chat-name");
    const projectName = group.locator(".project-chat-name");
    await expect(projectName.locator(".project-chat-label > svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await projectName.locator(".project-chat-title").click();
    await expect(projectName).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(group.locator(".project-chat-pages")).toHaveAttribute("inert", "");
    await projectName.click({ position: { x: 4, y: 10 } });
    await expect(projectName).toHaveAttribute("aria-expanded", "true");
    await expect(aChat).toBeVisible();
    await toggle.click();
    await expect(group.locator(".project-chat-pages")).toHaveAttribute("inert", "");
    await toggle.press("ArrowRight");
    await expect(aChat).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(selected);
    const cGroup = page.getByRole("region", { name: `Project ${folders[2]}`, exact: true });
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setMinimumSize(640, 480);
      window?.setSize(1100, 500);
    });
    await expect.poll(() => page.evaluate(() => innerHeight)).toBeLessThan(530);
    const cMore = cGroup.getByRole("button", { name: `More for ${folders[2]}`, exact: true });
    await cMore.scrollIntoViewIfNeeded();
    await cMore.evaluate((element) => {
      const scroller = element.closest(".page-tabs");
      if (scroller)
        scroller.scrollTop +=
          element.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 24;
    });
    await cMore.click();
    const clamped = page.getByRole("menu", { name: `Actions for ${folders[2]}`, exact: true });
    await expect(clamped).toBeVisible();
    const clampedBox = await clamped.boundingBox();
    const cAnchor = await cMore.boundingBox();
    const viewportHeight = await page.evaluate(() => innerHeight);
    expect(clampedBox).not.toBeNull();
    expect(cAnchor).not.toBeNull();
    if (clampedBox && cAnchor) {
      expect(clampedBox.y + clampedBox.height).toBeLessThanOrEqual(viewportHeight - 8);
      expect(clampedBox.y).toBeLessThan(cAnchor.y + cAnchor.height);
    }
    await page.screenshot({ path: join(root, "test-results", "multi-project-menu-clamped.png") });
    await page.getByRole("menuitem", { name: "Close project", exact: true }).click();
    await expect(cGroup).toHaveCount(0);
    await expect(composer()).toHaveValue("project-a draft 1");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 780),
    );
    await page.locator(".project-sidebar-open").click();
    await page
      .getByRole("dialog", { name: "Open Project", exact: true })
      .locator(".project-item")
      .filter({ hasText: join(directory, "project-c") })
      .click();
    await page
      .getByRole("dialog", { name: "Open project?", exact: true })
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await cGroup.getByRole("button", { name: "Chat 1", exact: true }).click();
    await expect(composer()).toHaveValue("project-c draft 0");
    await aChat.click();
    await expect(composer()).toHaveValue("project-a draft 1");
    const retained = await page.evaluate(() => window.desktop.snapshot());
    const workerIds = retained.chats.find((chat) => chat.run?.id === selected)?.workers;
    // The first conversation, not Chat 2, owns the workers.
    expect(workerIds).toEqual([]);
    expect(retained.runs.filter((run) => run.view?.status === "idle")).toHaveLength(2);
    expect(retained.runs.map((run) => run.record.id).sort()).toEqual(
      beforeClose.runs.map((run) => run.record.id).sort(),
    );
    while (await dismiss.count()) await dismiss.first().click();
    for (const theme of ["light", "dark"]) {
      for (const [width, size] of [
        [180, 15],
        [220, 15],
        [480, 24],
      ] as const) {
        const resizer = page.getByRole("button", {
          name: "Resize navigation sidebar",
          exact: true,
        });
        const current = await page.evaluate(() =>
          Number(localStorage.getItem("code60.sidebarWidth")),
        );
        for (let remaining = Math.abs(width - current); remaining > 0; remaining -= 20)
          await resizer.press(width > current ? "ArrowRight" : "ArrowLeft");
        await page.evaluate((size) => {
          const style = document.documentElement.style;
          style.setProperty("--nav-font-size", `${size}px`);
          if (size === 15) style.removeProperty("--button-size");
          else style.setProperty("--button-size", `${size}px`);
        }, size);
        await page.evaluate(
          (theme) => document.documentElement.setAttribute("data-color-scheme", theme),
          theme,
        );
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expectHierarchy();
        await expect(page.locator(".project-sidebar-open")).toHaveAttribute(
          "aria-label",
          "Open Project",
        );
        await more.click();
        const bounds = await menu.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: innerWidth,
            height: innerHeight,
          };
        });
        expect(bounds.left).toBeGreaterThanOrEqual(8);
        expect(bounds.top).toBeGreaterThanOrEqual(8);
        expect(bounds.right).toBeLessThanOrEqual(bounds.width - 8);
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 8);
        await page.screenshot({
          path: join(root, "test-results", `multi-project-${theme}-${width}-${size}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(more).toBeFocused();
      }
    }
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Relay project accordions retain independent chat and file views", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-relay-projects-"));
  const a = join(directory, "project-a");
  const b = join(directory, "project-b");
  await mkdir(a);
  await mkdir(b);
  await writeFile(join(a, "a.txt"), "A source");
  for (const path of [a, b]) {
    execFileSync("git", ["init", "-q", path]);
    commitFixture(path);
  }
  try {
    application = await launch(directory, a, join(directory, "relay.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const composer = () =>
      page
        .locator(".orchestration-chat-page:visible")
        .getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer()).toBeEnabled();
    await composer().fill("Relay draft remains independent");
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    const relay = await page.evaluate(() => window.desktop.snapshot());
    await page.getByRole("button", { name: "New chat in project-a", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.snapshot())).chats.filter(
            (chat) => chat.kind === "project",
          ).length,
      )
      .toBe(1);
    const aChat = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    const aPage = page.locator(`.orchestration-chat-page[data-chat-id="${aChat}"]`);
    await expect(aPage).toBeVisible();
    await expect(aPage.getByRole("combobox")).toBeEnabled();
    await aPage.getByRole("combobox").fill("Project A draft");
    await page.getByRole("button", { name: "Toggle files panel", exact: true }).click();
    await page.getByRole("button", { name: "Open Files", exact: true }).click();
    await expect(page.getByRole("tab", { name: "File Explorer", exact: true })).toBeVisible();
    const [worker] = await page.evaluate(() =>
      window.desktop.start({
        agents: ["claude"],
        allow: [],
        allowAll: true,
        prompt: JSON.stringify([{ hang: "cancellable" }]),
      }),
    );
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).active)
      .toBe(true);
    await page.locator(`[id="conversation-${worker}"]`).click();
    await expect(page.locator(".worker-chat-page:visible")).toBeVisible();
    await page.getByRole("button", { name: "Relay", exact: true }).click();
    await expect(page.locator(".worker-chat-page:visible")).toHaveCount(0);
    await expect(composer()).toHaveValue("Relay draft remains independent");
    await page.locator(`[id="conversation-${worker}"]`).click();
    await expect(page.locator(".worker-chat-page:visible")).toBeVisible();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, b);
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await expect(composer()).toHaveValue("Relay draft remains independent");
    await page.getByRole("button", { name: "New chat in project-b", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.snapshot())).chats.filter(
            (chat) => chat.kind === "project",
          ).length,
      )
      .toBe(2);
    const bChat = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    const bPage = page.locator(`.orchestration-chat-page[data-chat-id="${bChat}"]`);
    await expect(bPage).toBeVisible();
    await expect(bPage.getByRole("combobox")).toBeEnabled();
    await bPage.getByRole("combobox").fill("Project B draft");
    const pollingOwners = await page.evaluate(() => window.desktop.snapshot());
    const aOwner = pollingOwners.openProjects?.find((owner) => owner.path === a);
    const bOwner = pollingOwners.openProjects?.find((owner) => owner.path === b);
    if (!aOwner || !bOwner) throw new Error("Missing retained polling owners");
    const aAddress = { projectId: aOwner.id, databaseEpoch: pollingOwners.databaseEpoch };
    await expect(page.evaluate(() => window.desktop.poll(["history"]))).rejects.toThrow(
      "database epoch",
    );
    await page.evaluate((identity) => window.desktop.poll(["worktrees"], identity), aAddress);
    const afterPoll = await page.evaluate(() => window.desktop.snapshot());
    expect(afterPoll.projectInstanceId).toBe(bOwner.id);
    expect(afterPoll.polling.sources.find((source) => source.key === "worktrees")?.scope).toEqual({
      kind: "target",
      id: bOwner.id,
    });
    expect(afterPoll.worktrees?.repository).not.toBe("project-a");
    const panelIds = await page
      .locator(".file-panel")
      .evaluateAll((panels) => panels.map((panel) => panel.id));
    expect(new Set(panelIds).size).toBe(panelIds.length);
    const aGroup = page.getByRole("region", { name: `Project ${a}`, exact: true });
    await aGroup.locator(`[id="conversation-${aChat}"]`).click();
    await expect(composer()).toHaveValue("Project A draft");
    await expect(page.getByRole("tab", { name: "File Explorer", exact: true })).toBeVisible();
    const restored = await page.evaluate(() => window.desktop.snapshot());
    expect(restored.worktrees?.repository).toBe("project-a");
    expect(restored.polling.sources.find((source) => source.key === "worktrees")?.scope).toEqual({
      kind: "target",
      id: aOwner.id,
    });
    expect(restored.chat.run?.id).toBe(aChat);
    expect(restored.openProjects).toHaveLength(2);
    expect(restored.chats.find((chat) => chat.kind === "relay")?.run?.id).toBe(relay.chat.run?.id);
    expect(restored.chats.filter((chat) => chat.kind === "project")).toHaveLength(2);
    await page.locator(".project-sidebar-open").click();
    await page
      .getByRole("dialog", { name: "Open Project", exact: true })
      .locator(".project-item")
      .filter({ hasText: b })
      .click();
    const confirmation = page.getByRole("dialog", { name: "Open project?", exact: true });
    await expect(
      confirmation.getByRole("button", { name: "Open project", exact: true }),
    ).toBeEnabled();
    await confirmation.getByRole("button", { name: "Open project", exact: true }).click();
    await expect(bPage.getByRole("combobox")).toHaveValue("Project B draft");
    await page.getByRole("button", { name: `More for ${b}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Close project", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).openProjects?.length)
      .toBe(1);
    await expect(composer()).toHaveValue("Relay draft remains independent");
    const closed = await page.evaluate(() => window.desktop.snapshot());
    await expect(
      page.evaluate((identity) => window.desktop.poll(["history"], identity), {
        projectId: bOwner.id,
        databaseEpoch: pollingOwners.databaseEpoch,
      }),
    ).rejects.toThrow("no longer open");
    expect(closed.runs.find((run) => run.record.id === worker)?.view?.status).toBe("running");
    expect(closed.chats.find((chat) => chat.kind === "relay")?.run?.id).toBe(relay.chat.run?.id);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Relay files explicitly browse workspace or owned targets without borrowing the selected project", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-relay-files-ui-"));
  const target = join(directory, "target");
  await mkdir(target);
  await writeFile(join(target, "note.txt"), "target version");
  await mkdir(join(directory, "config", "code60"), { recursive: true });
  await writeFile(
    join(directory, "config", "code60", "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--relay"],
        },
      },
    }),
  );
  try {
    application = await launch(directory, target, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const composer = page
      .locator(".orchestration-chat-page:visible")
      .getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    let snapshot = await page.evaluate(() => window.desktop.snapshot());
    const workspace = snapshot.chat.directory;
    if (!workspace) throw new Error("Missing Relay workspace");
    await writeFile(join(workspace, "note.txt"), "workspace version");
    await composer.fill("Keep this Relay draft");
    await page.getByRole("button", { name: "Toggle files panel", exact: true }).click();
    const panel = page.locator("#relay-plan-panel");
    await panel.getByRole("button", { name: "Open Files", exact: true }).click();
    const explorer = panel.getByRole("tab", { name: "File Explorer", exact: true });
    await expect(panel.getByLabel("File root")).toHaveValue("workspace");
    await panel.getByRole("treeitem", { name: "note.txt", exact: true }).click();
    const inspector = panel.getByRole("complementary", { name: "File preview", exact: true });
    await expect(inspector.locator(".view-lines")).toContainText("workspace version");
    await expect(composer).toHaveValue("Keep this Relay draft");
    snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.database).toBeNull();
    expect(snapshot.directory).toBeNull();
    expect(snapshot.files).toBeNull();
    expect(snapshot.chat.run?.turns).toBe(0);
    await composer.fill(
      `Relay target: ${JSON.stringify({ cwd: target, workspaceMode: "direct" })}`,
    );
    await composer.press("Enter");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.snapshot())).runs.find((run) => run.relay)
            ?.relay?.targetId,
      )
      .toBeTruthy();
    const targetId = (await page.evaluate(() => window.desktop.snapshot())).runs.find(
      (run) => run.relay,
    )?.relay?.targetId;
    await explorer.click();
    await panel.getByLabel("File root").selectOption(`target:${targetId}`);
    await panel.getByRole("treeitem", { name: "note.txt", exact: true }).click();
    await expect(inspector.locator(".view-lines")).toContainText("target version");
    await composer.fill("Still my Relay draft");
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await expect(inspector.locator(".view-lines")).toContainText("target version");
    await selectProjectConversation(page);
    await expect(panel).toBeHidden();
    await writeFile(join(target, "note.txt"), "target after navigation");
    await page.getByRole("button", { name: "Relay", exact: true }).click();
    await expect(inspector.locator(".view-lines")).toContainText("target after navigation");
    await expect(composer).toHaveValue("Still my Relay draft");
    await page.getByRole("button", { name: `More for ${target}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Close project", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).openProjects?.length)
      .toBe(0);
    await expect(inspector.locator(".view-lines")).toContainText("target after navigation");
    await explorer.click();
    await expect(panel.getByLabel("File root")).toHaveValue(`target:${targetId}`);
    await panel.getByLabel("File root").selectOption("workspace");
    await panel.getByRole("treeitem", { name: "note.txt", exact: true }).click();
    await expect(inspector.locator(".view-lines")).toContainText("workspace version");
    await expect(composer).toHaveValue("Still my Relay draft");
    const relayWorkerId = (await page.evaluate(() => window.desktop.snapshot())).runs.find(
      (run) => run.relay,
    )?.record.id;
    if (!relayWorkerId) throw new Error("Missing Relay worker");
    const unrelated = join(directory, "unrelated-project");
    await mkdir(unrelated);
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, unrelated);
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).directory)
      .toBe(unrelated);
    await page.locator(".sidebar-search").click();
    const search = page.locator("#panel-search");
    await search.getByRole("searchbox", { name: "Query", exact: true }).fill(relayWorkerId);
    await search.getByRole("button", { name: "Search", exact: true }).click();
    await expect(search.getByRole("list", { name: "Search results" })).not.toContainText(
      relayWorkerId,
    );
    await expect(search).not.toContainText("A search source is no longer in the open project");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByRole("button", { name: "Experiments", exact: true }).click();
    await page.getByRole("tab", { name: "Episodic Memory", exact: true }).click();
    await expect(
      page
        .locator("#panel-episodic-memory")
        .getByRole("button", { name: "Extract from 0 events", exact: true }),
    ).toBeDisabled();
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Relay direct workers remain visible and controllable without a project or database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-relay-worker-desktop-"));
  const target = join(directory, "unopened-target");
  await mkdir(target);
  await mkdir(join(directory, "config", "code60"), { recursive: true });
  await writeFile(
    join(directory, "config", "code60", "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--relay"],
        },
      },
    }),
  );
  try {
    application = await launch(directory, target, join(directory, "unused.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const composer = page
      .locator(".orchestration-chat-page:visible")
      .getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    await composer.fill(
      `Relay target: ${JSON.stringify({ cwd: target, workspaceMode: "direct" })}`,
    );
    await composer.press("Enter");
    const row = page.locator(".chat-sidebar-entry", { hasText: "Relay fixture worker" });
    await expect(row).toBeEnabled();
    await row.click();
    const worker = page.locator(".worker-chat-page:visible");
    await expect(worker).toContainText("Direct edits have no isolated apply, undo or discard");
    const reply = worker.getByRole("textbox", { name: "Message", exact: true });
    await expect(reply).toBeEnabled();
    await reply.fill("A human follow-up without a project");
    await reply.press("Enter");
    await expect(worker.locator(".event.prompt").last()).toContainText(
      "A human follow-up without a project",
    );
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.database).toBeNull();
    expect(snapshot.directory).toBeNull();
    const run = snapshot.runs.find((run) => run.relay);
    expect(run?.relay?.cwd).toBe(target);
    await page.evaluate(async (id) => {
      if (!id) throw new Error("Missing worker");
      await window.desktop.action({ type: "stop", id });
    }, run?.record.id);
    await expect(reply).toBeDisabled();
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Relay Changes captures two unopened targets, applies locally, undoes and delivers feedback", async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-relay-changes-ui-"));
  const targets = [join(directory, "target-a"), join(directory, "target-b")] as const;
  for (const target of targets) {
    await mkdir(target);
    execFileSync("git", ["init", "-b", "main"], { cwd: target });
    await writeFile(join(target, "result.txt"), "original\n");
    execFileSync("git", ["add", "result.txt"], { cwd: target });
    commitFixture(target);
  }
  await mkdir(join(directory, "config", "code60"), { recursive: true });
  await writeFile(
    join(directory, "config", "code60", "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--relay"],
        },
      },
    }),
  );
  try {
    application = await launch(directory, targets[0] as string, join(directory, "unused.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const composer = page
      .locator(".orchestration-chat-page:visible")
      .getByRole("combobox", { name: "Message to orchestrator" });
    for (const [index, cwd] of targets.entries()) {
      await expect(composer).toBeEnabled();
      await composer.fill(
        `Relay target: ${JSON.stringify({
          cwd,
          workspaceMode: "worktree",
          requestId: `review-target-${index}`,
          label: `Target ${index + 1} changes`,
          prompt: JSON.stringify([
            { write: { path: "result.txt", content: `target ${index + 1} changed\n` } },
            { message: "Isolated target change ready." },
          ]),
        })}`,
      );
      await composer.press("Enter");
      await expect
        .poll(async () => {
          const snapshot = await page.evaluate(() => window.desktop.snapshot());
          return snapshot.runs.filter((run) => run.relay && run.view?.status === "idle").length;
        })
        .toBe(index + 1);
    }
    await expect(composer).toBeEnabled();
    await page.getByRole("button", { name: "Toggle files panel", exact: true }).click();
    const panel = page.locator("#relay-plan-panel");
    await panel.getByRole("button", { name: "Open Changes", exact: true }).click();
    const changes = panel.getByRole("region", { name: "Relay changes by target" });
    await expect(changes.getByRole("heading", { name: targets[0], exact: true })).toBeVisible();
    await expect(changes.getByRole("heading", { name: targets[1], exact: true })).toBeVisible();
    await changes
      .getByRole("button", { name: "Target 1 changes · Current generation", exact: true })
      .click();
    const review = changes.getByRole("region", { name: "Selected Relay review" });
    await review.getByRole("button", { name: "Refresh changes", exact: true }).click();
    await expect(review.getByLabel("Revision", { exact: true })).not.toHaveValue("");
    await expect(review.locator(".review-panel .review-diff-editor")).toContainText(
      "target 1 changed",
    );
    await review.getByRole("checkbox", { name: "Mark file reviewed", exact: true }).check();
    await expect(
      review.getByRole("checkbox", { name: "Mark file reviewed", exact: true }),
    ).toBeChecked();
    await review.getByRole("button", { name: "Use these changes…", exact: true }).click();
    await expect(review.getByRole("status")).toHaveText("prepared");
    await review
      .getByRole("list", { name: "Application files" })
      .getByRole("button", { name: "result.txt", exact: true })
      .click();
    await expect(review.locator(".review-diff-editor").last()).toContainText("target 1 changed");
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await review.getByRole("button", { name: "Apply changes…", exact: true }).click();
    await expect
      .poll(() => readFile(join(targets[0] as string, "result.txt"), "utf8"))
      .toBe("target 1 changed\n");
    expect(await readFile(join(targets[1] as string, "result.txt"), "utf8")).toBe("original\n");
    await review.getByRole("button", { name: "Undo application…", exact: true }).click();
    await expect
      .poll(() => readFile(join(targets[0] as string, "result.txt"), "utf8"))
      .toBe("original\n");
    await review
      .getByRole("textbox", { name: "Feedback", exact: true })
      .fill("Keep the target-specific change.");
    await review.getByRole("button", { name: "Send feedback", exact: true }).click();
    await expect(review.getByRole("list", { name: "Feedback delivery" })).toContainText(
      "delivered",
    );
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.database).toBeNull();
    expect(snapshot.directory).toBeNull();
    await page.reload();
    await page.getByRole("button", { name: "Toggle files panel", exact: true }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Open Changes", exact: true }).click();
    await changes
      .getByRole("button", { name: "Target 1 changes · Current generation", exact: true })
      .click();
    await expect(review.getByRole("list", { name: "Feedback delivery" })).toContainText(
      "delivered",
    );
    await application.close();
    application = await launch(directory, targets[0], join(directory, "unused.sqlite"));
    const restarted = await application.firstWindow();
    await restarted.getByRole("button", { name: "Start", exact: true }).click();
    await restarted.getByRole("button", { name: "Toggle files panel", exact: true }).click();
    const saved = restarted.locator("#relay-plan-panel");
    await saved.getByRole("button", { name: "Open Changes", exact: true }).click();
    await saved
      .getByRole("button", { name: "Target 1 changes · Historical evidence", exact: true })
      .click();
    await expect(saved).toContainText("Historical evidence only");
    await expect(saved.getByRole("textbox", { name: "Feedback", exact: true })).toBeDisabled();
    await expect(saved.getByRole("list", { name: "Feedback delivery" })).toContainText("delivered");
    expect((await restarted.evaluate(() => window.desktop.snapshot())).chat.workers).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Relay plans bind human acceptance to explicit targets without a database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-relay-plan-ui-"));
  const target = join(directory, "target");
  await mkdir(target);
  await mkdir(join(directory, "config", "code60"), { recursive: true });
  await writeFile(
    join(directory, "config", "code60", "config.json"),
    JSON.stringify({
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--relay"],
        },
      },
    }),
  );
  try {
    application = await launch(directory, target, join(directory, "projects.sqlite"));
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const composer = page
      .locator(".orchestration-chat-page:visible")
      .getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    await composer.fill(`Relay plan: ${JSON.stringify({ cwd: target, workspaceMode: "direct" })}`);
    await composer.press("Enter");
    let panel = page.locator("#relay-plan-panel");
    await expect(panel.getByRole("heading", { name: "Relay target plan" })).toBeVisible();
    await expect(panel).toContainText(target);
    await expect(panel).toContainText("direct edits, no isolated apply or undo");
    let snapshot = await page.evaluate(() => window.desktop.snapshot());
    const identity = snapshot.chat.conversationId;
    expect(snapshot.database).toBeNull();
    expect(snapshot.chat.workers).toEqual([]);
    expect(snapshot.chat.plans?.[0]?.state).toBe("draft");
    await expect(readFile(join(target, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await panel.getByRole("button", { name: "Accept", exact: true }).click();
    await expect
      .poll(async () => {
        try {
          return await readFile(join(target, "result.txt"), "utf8");
        } catch {
          return "";
        }
      })
      .toBe("human accepted target\n");
    await expect(panel).toContainText("In progress");
    snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.runs.find((run) => run.relay)?.relay).toMatchObject({
      cwd: target,
      workspaceMode: "direct",
    });
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await expect(panel.getByRole("heading", { name: "Relay target plan" })).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.conversationId).toBe(
      identity,
    );
    await application.close();
    application = await launch(directory, target, join(directory, "projects.sqlite"));
    page = await application.firstWindow();
    await expect
      .poll(async () => {
        const chat = (await page.evaluate(() => window.desktop.snapshot())).chats.find(
          (chat) => chat.kind === "relay",
        );
        return chat?.error ?? chat?.plans?.[0]?.state ?? "Waiting for Relay";
      })
      .toBe("paused");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("button", { name: "Relay", exact: true }).click();
    panel = page.locator("#relay-plan-panel");
    await panel.getByRole("button", { name: "Relay target plan", exact: true }).click();
    await expect(panel).toContainText("Paused");
    snapshot = await page.evaluate(() => window.desktop.snapshot());
    expect(snapshot.chat.run?.turns).toBe(0);
    expect(snapshot.chat.workers).toEqual([]);
    await panel.getByRole("button", { name: "Resume plan", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("no live task authority");
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.turns).toBe(0);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: renderer scopes retain Relay and database drafts and project views across A to B to A", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-renderer-scopes-"));
  const first = join(directory, "project-a");
  const second = join(directory, "project-b");
  await mkdir(first);
  await mkdir(second);
  try {
    application = await launch(directory, first, join(directory, "scope.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    const chat = page.locator(".orchestration-chat-page:visible");
    const composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    await composer.fill("Retain this conversation");
    await composer.press("Enter");
    await expect(chat.locator(".event.message")).not.toHaveCount(0);
    await composer.fill("Database conversation draft");
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const history = await chat.locator(".event.message .chat-markdown").allTextContents();
    const original = await page.evaluate(() => window.desktop.snapshot());
    await selectSidebarPage(page, "Command Builder");
    const commands = page.locator("#panel-commands");
    await commands.getByLabel("Title", { exact: true }).fill("Database command draft");
    await commands.getByLabel("Prompt", { exact: true }).fill("Do not save or discard me.");
    await selectSidebarPage(page, "Prompt Builder");
    const role = page.locator("#panel-prompts").getByRole("textbox", { name: "Role", exact: true });
    await role.fill("Database prompt draft");
    await selectSidebarPage(page, "Files");
    const fileTabs = page.locator(".retained-project-panel:not([hidden]) .file-tabs");
    await expect(fileTabs.getByRole("tab", { includeHidden: true })).toHaveCount(1);
    const verifyDatabaseDrafts = async () => {
      await selectSidebarPage(page, "Chat");
      await page.locator(`[id="conversation-${original.chat.run?.id}"]`).click();
      await expect(composer).toHaveValue("Database conversation draft");
      expect(await chat.locator(".event.message .chat-markdown").allTextContents()).toEqual(
        history,
      );
      expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(
        original.chat.run?.id,
      );
      await selectSidebarPage(page, "Command Builder");
      await expect(commands.getByLabel("Title", { exact: true })).toHaveValue(
        "Database command draft",
      );
      await selectSidebarPage(page, "Prompt Builder");
      await expect(role).toHaveValue("Database prompt draft");
    };
    for (const project of [second, first]) {
      await application.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      }, project);
      await page.locator(".project-sidebar-open").click();
      const picker = page.getByRole("dialog", { name: "Open Project", exact: true });
      await picker.getByRole("button", { name: "Open Folder", exact: true }).click();
      await expect(picker).toHaveCount(0);
      await expect(page.locator(".project-sidebar-open")).toHaveAttribute(
        "aria-label",
        "Open Project",
      );
      await expect
        .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).directory)
        .toBe(project);
      await expect(fileTabs.getByRole("tab", { includeHidden: true })).toHaveCount(
        project === first ? 1 : 0,
      );
      await verifyDatabaseDrafts();
    }
    await selectSidebarPage(page, "Files");
    await page.getByRole("button", { name: "return to splash page", exact: true }).click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(fileTabs.getByRole("tab", { includeHidden: true })).toHaveCount(1);
    await verifyDatabaseDrafts();
    await application.evaluate(
      ({ dialog }, database) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: database });
      },
      join(directory, "replacement.sqlite"),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await expect(role).not.toHaveValue("Database prompt draft");
    await selectSidebarPage(page, "Command Builder");
    await expect(commands.getByLabel("Title", { exact: true })).toHaveValue("");
    await selectSidebarPage(page, "Chat");
    await expect(composer).toHaveValue("Database conversation draft");
    await expect(fileTabs.getByRole("tab", { includeHidden: true })).toHaveCount(0);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Tactics preview, keyboard selection, draft preservation and stopped-chat recovery", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-tactics-ui-"));
  const project = join(directory, "project");
  const database = join(directory, "projects.sqlite");
  await mkdir(project);
  application = await launch(directory, project, database);
  try {
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await selectProjectConversation(page);
    let chat = page.locator(".orchestration-chat-page:visible");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(chat.getByRole("button", { name: "Tactics", exact: true })).toBeEnabled();
    const composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
    await composer.fill("Keep this draft");
    const initial = await page.evaluate(() => window.desktop.snapshot());
    const id = initial.chat.run?.id as string;
    await expect(page.getByRole("dialog", { name: "Tactics", exact: true })).toHaveCount(0);
    await chat.getByRole("button", { name: "Tactics", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Tactics", exact: true });
    await expect(dialog.getByRole("radio")).toHaveCount(8);
    await dialog.getByRole("radio", { name: "Independent review", exact: true }).focus();
    await page.keyboard.press("End");
    await expect(
      dialog.getByRole("radio", { name: "Challenge the plan", exact: true }),
    ).toBeFocused();
    await expect(
      dialog.getByRole("heading", { name: "Challenge the plan", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Home");
    await expect(
      dialog.getByRole("radio", { name: "Independent review", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      dialog.getByRole("radio", { name: "Implement and review", exact: true }),
    ).toBeFocused();
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.tactic).toBeUndefined();
    await dialog.getByRole("searchbox", { name: "Search tactics" }).fill("zz-no-match");
    await expect(dialog.getByText("No matching tactics.", { exact: true })).toBeVisible();
    await expect(dialog.locator(".tactics-details h3")).toHaveCount(0);
    await dialog.getByRole("searchbox", { name: "Search tactics" }).fill("concrete trigger");
    await expect(dialog.getByRole("radio")).toHaveCount(1);
    await dialog.getByText("Orchestrator prompt", { exact: true }).click();
    await dialog.getByText("Shared instructions", { exact: true }).click();
    await expect(dialog.getByText(/own worktree is not the implementation/)).toBeVisible();
    for (let n = 0; n < 12; n++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }
    await page.screenshot({ path: test.info().outputPath("tactics-light.png") });
    const metadataDirectory = join(dirname(initial.chat.directory as string), "chats");
    const backup = `${metadataDirectory}.saved`;
    await rename(metadataDirectory, backup);
    await writeFile(metadataDirectory, "Intentional storage failure");
    try {
      await dialog.getByRole("button", { name: "Apply to chat", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("could not be saved");
      await expect(dialog).toBeVisible();
      expect((await page.evaluate(() => window.desktop.snapshot())).chat.tactic).toBeUndefined();
      await expect(composer).toHaveValue("Keep this draft");
    } finally {
      await unlink(metadataDirectory);
      await rename(backup, metadataDirectory);
    }
    await dialog.getByRole("button", { name: "Apply to chat", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      chat.getByRole("button", { name: "Change tactic: Independent review", exact: true }),
    ).toBeFocused();
    await expect(composer).toHaveValue("Keep this draft");
    const selected = await page.evaluate(() => window.desktop.snapshot());
    expect(selected.chat.tactic).toBe("independent-review");
    expect(selected.chat.run?.turns).toBe(0);
    expect(selected.runs).toEqual([]);
    await chat
      .getByRole("button", { name: "Change tactic: Independent review", exact: true })
      .click();
    await expect(dialog.getByRole("button", { name: "Applied", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await chat.getByRole("button", { name: "Remove tactic", exact: true }).click();
    await expect(composer).toHaveValue("Keep this draft");
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.tactic).toBeNull();
    await chat.getByRole("button", { name: "Tactics", exact: true }).click();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 520, height: 720 });
    await expect(
      dialog.getByRole("button", { name: "Apply to chat", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath("tactics-dark-narrow.png") });
    const geometry = await dialog.evaluate((element) => ({
      width: element.clientWidth,
      overflow: element.scrollWidth - element.clientWidth,
      padding: getComputedStyle(element).padding,
      children: [...element.querySelectorAll("*")]
        .filter((child) => {
          const rect = child.getBoundingClientRect();
          const outer = element.getBoundingClientRect();
          return rect.right > outer.right + 1;
        })
        .map((child) => ({ name: child.className, right: child.getBoundingClientRect().right }))
        .slice(0, 10),
    }));
    expect(geometry.overflow, JSON.stringify(geometry)).toBe(0);
    await dialog.getByRole("button", { name: "Apply to chat", exact: true }).click();
    await page.setViewportSize({ width: 1200, height: 850 });
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.turns)
      .toBe(1);
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.status)
      .toBe("idle");
    const sent = await page.evaluate(() => window.desktop.snapshot());
    expect(
      sent.chat.events.some(
        ({ event }) => event.type === "prompt" && event.text === "Keep this draft",
      ),
    ).toBe(true);
    await chat
      .getByRole("button", { name: "Change tactic: Independent review", exact: true })
      .click();
    await dialog.getByRole("searchbox", { name: "Search tactics" }).fill("Explore the codebase");
    await dialog.getByRole("button", { name: "Apply to chat", exact: true }).click();
    await application.close();
    application = await launch(directory, project, database);
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await selectProjectConversation(page);
    chat = page.locator(".orchestration-chat-page:visible");
    await expect(
      chat.getByRole("button", { name: "Change tactic: Explore the codebase", exact: true }),
    ).toBeVisible();
    const restored = await page.evaluate(() => window.desktop.snapshot());
    expect(restored.chat).toMatchObject({
      restored: true,
      taskId: sent.chat.taskId,
      run: { id, turns: 1 },
      workers: [],
      updates: { paused: true, pending: 0 },
    });
    const metadata = JSON.parse(
      await readFile(
        join(
          dirname(sent.chat.directory as string),
          "chats",
          `${basename(sent.chat.directory as string)}.json`,
        ),
        "utf8",
      ),
    );
    expect(metadata.tasks[0].tactic).toMatchObject({ id: "independent-review", version: 1 });
    expect(metadata.tasks[0].tactic.prompt).toContain("Shared instructions");
    await chat.getByRole("button", { name: "Continue task", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.turns)
      .toBe(2);
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.tactic).toBe(
      "explore-the-codebase",
    );
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: read-only task revisions preserve project files and switch reviews", async () => {
  test.setTimeout(90_000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "code60-task-loop-ui-")));
  const repo = join(directory, "repo");
  const config = join(directory, "config", "code60");
  await mkdir(repo);
  await mkdir(config, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "core.autocrlf", "false"]);
  await writeFile(join(repo, "task.txt"), "initial project\n");
  git(["add", "task.txt"]);
  commitFixture(repo);
  const initialHead = git(["rev-parse", "HEAD"]);
  await writeFile(join(repo, "staged.txt"), "staged user file\n");
  git(["add", "staged.txt"]);
  const originalIndex = git(["diff", "--cached", "--binary"]);
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      defaultAgent: "claude",
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--review"],
        },
      },
    }),
  );
  try {
    application = await launch(directory, repo, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectProjectConversation(page);
    const composer = page.getByRole("combobox", { name: "Message to orchestrator" });
    const waitForCapture = (title: string, path: string) =>
      expect
        .poll(
          () =>
            page.evaluate(
              async ({ title, path }) => {
                const snapshot = await window.desktop.snapshot();
                const summary = snapshot.reviews?.find((review) => review.title === title);
                if (!summary) return "Waiting for review";
                const review = await window.desktop.readReview({
                  project: summary.project,
                  projectId: summary.projectId,
                  databaseEpoch: summary.databaseEpoch,
                  reviewId: summary.id,
                  requestId: crypto.randomUUID(),
                });
                const latest = review.revisions.at(-1);
                if (!latest?.files.some((file) => file.path === path))
                  return review.error ?? latest?.errors[0]?.message ?? "Waiting for capture";
                const worker = snapshot.runs.find(
                  (run) => run.record.id === review.workers[0]?.runId,
                );
                return worker?.view?.status ?? worker?.record.status;
              },
              { title, path },
            ),
          // The dispatch-time capture can precede worktree creation; the idle capture replaces it.
          { timeout: 30_000 },
        )
        .toBe("idle");
    await expect(composer).toBeEditable();
    await composer.fill("Implement task loop");
    await composer.press("Enter");
    await waitForCapture("Implement task loop", "task.txt");
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    const review = page.getByRole("region", { name: "Revision diff", exact: true });
    await expect(review.locator(".monaco-diff-editor")).toBeVisible();
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "accepted task result",
    );
    await expect(review.getByRole("combobox")).toHaveCount(0);
    await expect(review.locator(".review-diff-actions")).toHaveCount(0);
    await expect(review.getByRole("checkbox", { name: "Side by side" })).toHaveCount(0);
    await expect(
      review.getByRole("button", { name: /Previous change|Next change|Find/ }),
    ).toHaveCount(0);
    await expect(review.locator("form, .task-actions, .review-feedback")).toHaveCount(0);
    await expect(
      review.getByRole("button", {
        name: /Use these changes|Undo application|Refresh changes|Mark file/,
      }),
    ).toHaveCount(0);
    expect(await readFile(join(repo, "task.txt"), "utf8")).toBe("initial project\n");
    expect(git(["diff", "--cached", "--binary"])).toBe(originalIndex);
    expect(git(["rev-parse", "HEAD"])).toBe(initialHead);
    await expect(composer).toBeEditable();
    await composer.fill("Implement second task loop");
    await composer.press("Enter");
    await waitForCapture("Implement second task loop", "second.txt");
    await page.getByRole("button", { name: "Review changes", exact: true }).last().click();
    await expect(page.getByRole("tab", { name: "Changes", exact: true })).toHaveCount(1);
    await expect(review.locator(".review-files")).toContainText("second.txt");
    const secondTab = await page
      .getByRole("tab", { name: /Revision \d+ · Implement second task loop/ })
      .getAttribute("aria-selected");
    expect(secondTab).toBe("true");
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    const revisionList = page.getByRole("navigation", { name: "Task revisions" });
    await expect(
      revisionList.getByRole("heading", { name: "Implement task loop", exact: true }),
    ).toBeVisible();
    await expect(
      revisionList.getByRole("heading", { name: "Implement second task loop", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Select changes review" })).toHaveCount(0);
    await expect(review).toHaveCount(0);
    await page.screenshot({ path: "test-results/task-revisions.png" });
    const firstTask = revisionList.getByRole("region", {
      name: "Implement task loop",
      exact: true,
    });
    await firstTask.getByRole("button").last().focus();
    await page.keyboard.press("Enter");
    await expect(review.locator(".review-files")).toContainText("task.txt");
    await expect(
      page.getByRole("tab", { name: /Revision \d+ · Implement task loop$/ }),
    ).toHaveCount(1);
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    const next = snapshot.runs.find((run) => run.record.firstPrompt.includes("second.txt"));
    if (!next) throw new Error("Missing second task");
    expect(await readFile(join(next.record.worktree, "task.txt"), "utf8")).toBe(
      "initial project\n",
    );
    expect(await readFile(join(repo, "task.txt"), "utf8")).toBe("initial project\n");
    expect(git(["diff", "--cached", "--binary"])).toBe(originalIndex);
    expect(git(["rev-parse", "HEAD"])).toBe(initialHead);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: database connection gates splash and workspace controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-database-gate-"));
  const database = join(directory, "projects.sqlite");
  const invalid = join(directory, "invalid.sqlite");
  await writeFile(invalid, "Not a SQLite database");
  try {
    application = await launch(directory, directory, database);
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const splash = page.locator(".splash");
    const notice = page.getByRole("status", { name: "Database connection required" });
    await expect(splash.locator(".database-notice")).toBeVisible();
    await expect(notice).toContainText("No database connected");
    await expect(splash.getByRole("heading", { name: /^Continue / })).toHaveCount(0);
    await notice.getByRole("button", { name: "Connect to database", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Select database", exact: true });
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await modal.getByRole("button", { name: "Open existing database…", exact: true }).click();
    await expect(modal).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).database).toBeNull();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, invalid);
    await modal.getByRole("button", { name: "Open existing database…", exact: true }).click();
    await expect(modal.getByRole("alert")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(splash.locator(".database-notice")).toBeVisible();
    await splash.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".sidebar-search")).toBeDisabled();
    const card = page.locator(".sidebar .project-sidebar-open");
    await expect(card).toHaveAttribute("aria-label", "Connect to database");
    await expect(card).toBeEnabled();
    await expect(notice).toBeVisible();
    const bounds = await notice.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(40);
    expect(bounds?.height).toBeLessThanOrEqual(56);
    expect(bounds?.y).toBeLessThan(60);
    for (const name of ["Command Builder", "Prompt Builder"]) {
      await expect(page.getByRole("tab", { name, exact: true })).toBeDisabled();
    }
    await expect(page.getByRole("button", { name: "Data Viewer", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Toggle files panel", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("#relay-plan-panel")).toHaveAttribute("aria-hidden", "true");
    await expect(
      page.getByRole("button", { name: "Open polling controls", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("combobox", { name: "Message to orchestrator", exact: true }),
    ).toBeEnabled();
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.kind).toBe("relay");
    const relay = page.getByRole("button", { name: "Relay", exact: true });
    const chatTab = page.getByRole("tab", { name: "Projects", exact: true });
    await chatTab.press("ArrowUp");
    await expect(relay).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(chatTab).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(card).toBeFocused();
    await card.press("Shift+Tab");
    await expect(chatTab).toBeFocused();
    await chatTab.press("Shift+Tab");
    await expect(relay).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(chatTab).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Automations", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Apps", exact: true })).toBeFocused();
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    await expect(page.getByLabel("Theme", { exact: true })).toBeEnabled();
    await selectSettingsPage(page, "Polling");
    await expect(
      page.getByRole("button", { name: "Open polling monitor", exact: true }),
    ).toBeDisabled();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(notice).toBeVisible();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(620, 620),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath("database-required.png") });
    await card.click();
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Create database…", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await expect(card).toHaveAttribute("aria-label", "Open Project");
    await expect(page.getByRole("tab", { name: "Prompt Builder", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Toggle files panel", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("#relay-plan-panel")).toHaveAttribute("aria-hidden", "true");
    expect((await page.evaluate(() => window.desktop.snapshot())).database).toBe(database);
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: database connection from splash restores normal entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-splash-database-"));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    const splash = page.locator(".splash");
    await splash.getByRole("button", { name: "Connect to database", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Select database", exact: true })
      .getByRole("button", { name: "Create database…", exact: true })
      .click();
    await expect(splash.locator(".database-notice")).toHaveCount(0);
    await splash.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".sidebar .project-sidebar-open")).toHaveAttribute(
      "aria-label",
      "Open Project",
    );
    await expect(page.locator(".database-notice")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Message to orchestrator", exact: true }),
    ).toBeEnabled();
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: chat titles, context menus, archive and advanced navigation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-chat-names-"));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await selectProjectConversation(page);
    const chat = page.locator(".orchestration-chat-page:visible");
    await chat
      .getByRole("combobox", { name: "Message to orchestrator", exact: true })
      .fill("Fix parser validation");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chat.getByRole("button", { name: "Rename chat: ok", exact: true })).toBeVisible();
    const sidebar = page.locator("nav.chat-sidebar");
    await sidebar.getByRole("button", { name: "Actions for ok", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Chat actions", exact: true });
    await expect(menu.getByRole("menuitem")).toHaveText(["Open", "Rename", "Archive"]);
    await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename chat", exact: true });
    await rename.getByRole("textbox", { name: "Chat name" }).fill("Parser work");
    await rename.getByRole("button", { name: "Save", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "Parser work", exact: true })).toBeVisible();
    await chat.getByRole("button", { name: "Rename chat: Parser work", exact: true }).click();
    await rename.getByRole("textbox", { name: "Chat name" }).fill("Header name");
    await rename.getByRole("button", { name: "Save", exact: true }).click();
    await sidebar
      .getByRole("button", { name: "Header name", exact: true })
      .click({ button: "right" });
    await expect(menu).toBeVisible();
    await menu.press("Escape");
    await sidebar.getByRole("button", { name: "Header name", exact: true }).press("Shift+F10");
    await menu.getByRole("menuitem", { name: "Open", exact: true }).click();
    await expect(
      chat.getByRole("button", { name: "Rename chat: Header name", exact: true }),
    ).toBeVisible();
    const before = await page.evaluate(() => window.desktop.snapshot());
    await sidebar.getByRole("button", { name: "Actions for Header name", exact: true }).click();
    await menu.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(sidebar.getByRole("button", { name: "Header name", exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Done notification", exact: true })).toContainText(
      "Chat archived.",
    );
    await expect(page.getByRole("button", { name: "Relay", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.kind)
      .toBe("relay");
    await expect(page.getByRole("button", { name: "Relay", exact: true })).toBeFocused();
    const archived = await page.evaluate(() => window.desktop.snapshot());
    expect(archived.chats.find((item) => item.run?.id === before.chat.run?.id)?.archived).toBe(
      true,
    );
    expect(
      await readFile(
        join(
          before.chat.directory as string,
          ".code60",
          "runs",
          before.chat.run?.id as string,
          "run.json",
        ),
        "utf8",
      ),
    ).toContain(before.chat.run?.id);
    await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    // Archiving a different project chat must leave Relay and its draft selected.
    await selectProjectConversation(page);
    const background = await page.evaluate(() => window.desktop.snapshot());
    const backgroundId = background.chat.run?.id;
    await page.getByRole("button", { name: "Relay", exact: true }).click();
    const relayChat = page.locator(
      `.orchestration-chat-page[data-chat-id="${archived.chat.run?.id}"]`,
    );
    await expect(relayChat).toBeVisible();
    const relayComposer = relayChat.getByRole("combobox", {
      name: "Message to orchestrator",
      exact: true,
    });
    await relayComposer.fill("Keep this Relay draft");
    await expect(relayComposer).toHaveValue("Keep this Relay draft");
    await page.locator(`#conversation-${backgroundId}`).click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(page.locator(`#conversation-${backgroundId}`)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Relay", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(relayComposer).toHaveValue("Keep this Relay draft");
    await expect(page.getByRole("group", { name: "Done notification", exact: true })).toHaveCount(
      0,
    );
    await page.reload();
    await expect(sidebar.getByRole("button", { name: "Header name", exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    const advanced = page.getByRole("button", { name: "Advanced", exact: true });
    await advanced.click();
    const experiments = page.getByRole("button", { name: "Experiments", exact: true });
    await experiments.press("ArrowRight");
    await experiments.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Episodic Memory", exact: true })).toBeFocused();
    await page.getByRole("tab", { name: "Contributor Tools", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Contributor Tools", exact: true }),
    ).toBeVisible();
    await advanced.click();
    await expect(page.locator("#panel-contributor-tools")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Episodic Memory");
    await page.keyboard.press("Enter");
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(experiments).toHaveAttribute("aria-expanded", "true");
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: update footer, once-per-version popup, download and automatic-check preference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-updates-"));
  application = await launch(directory, directory, join(directory, "projects.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSettingsPage(page, "Updates");
    const toggle = page.getByRole("switch", { name: "Automatically check for updates" });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect
      .poll(() => page.evaluate(() => window.desktop.update("status")))
      .toMatchObject({ autoCheck: false });
    await page.reload();
    await selectSettingsPage(page, "Updates");
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect
      .poll(() => page.evaluate(() => window.desktop.update("status")))
      .toMatchObject({ autoCheck: true });

    // Inject only the updater boundary, leaving the real renderer and preload in place.
    const publish = (
      version: string,
      status: UpdateState["status"] = "available",
      revision = 100,
    ) =>
      application.evaluate(
        ({ ipcMain, BrowserWindow }, next: UpdateState) => {
          let state = next;
          ipcMain.removeHandler("desktop:app-update");
          ipcMain.handle("desktop:app-update", (_event, action) => {
            if (action === "download")
              state = {
                ...state,
                revision: state.revision + 1,
                status: "downloading",
                percent: 42,
                message: "Downloading update…",
              };
            if (action === "cancel")
              state = {
                ...state,
                revision: state.revision + 1,
                status: "available",
                percent: 0,
                message: "Download cancelled.",
              };
            return state;
          });
          BrowserWindow.getAllWindows()[0]?.webContents.send("desktop:app-update-state", state);
        },
        {
          revision,
          status,
          version,
          percent: status === "ready" ? 100 : 0,
          message: `Code60 ${version} is available.`,
          autoCheck: true,
        },
      );

    // An update waits for another modal to close, without interrupting it.
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await expect(page.locator(".project-sidebar-open")).toHaveAttribute(
      "aria-label",
      "Open Project",
    );
    await page.locator(".project-sidebar-open").click();
    const project = page.getByRole("dialog", { name: "Open Project", exact: true });
    await expect(project).toBeVisible();
    await publish("9.1.0");
    const popup = page.getByRole("dialog", { name: "Update available", exact: true });
    await expect(popup).toHaveCount(0);
    await project.getByRole("button", { name: "Close Open Project" }).click();
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("9.1.0");
    await popup.getByRole("button", { name: "Later", exact: true }).click();
    const footer = page.locator(".app-footer");
    await expect(
      footer.getByRole("button", { name: "Update available", exact: true }),
    ).toBeVisible();
    await selectSidebarPage(page, "Chat");
    await footer.getByRole("button", { name: "Update available", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Settings" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download update", exact: true }),
    ).toBeInViewport();
    await page.reload();
    await expect(
      footer.getByRole("button", { name: "Update available", exact: true }),
    ).toBeVisible();
    await expect(popup).toHaveCount(0);

    await publish("9.2.0", "available", 200);
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await publish("9.2.0", "available", 201);
    await expect(popup).toHaveCount(0);
    await publish("9.3.0", "available", 300);
    await expect(popup).toBeVisible();
    await popup.getByRole("button", { name: "Download now", exact: true }).click();
    await expect(popup).toHaveCount(0);
    await expect(footer.getByRole("button", { name: "Downloading update 42%" })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Update download" })).toHaveAttribute(
      "value",
      "42",
    );
    await page.getByRole("button", { name: "Cancel download", exact: true }).click();
    await expect(
      footer.getByRole("button", { name: "Update available", exact: true }),
    ).toBeVisible();
    await expect(popup).toHaveCount(0);
    await publish("9.3.0", "ready", 400);
    await footer.getByRole("button", { name: "Ready to install", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Install and restart", exact: true }),
    ).toBeInViewport();
    // A stale status response cannot erase a downloaded update.
    await publish("9.1.0", "available", 1);
    await expect(
      footer.getByRole("button", { name: "Ready to install", exact: true }),
    ).toBeVisible();
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: navigation sidebar resizes without closing or losing state", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-sidebar-"));
  application = await launch(directory, directory, join(directory, "projects.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1500, 900),
    );
    const sidebar = page.getByRole("navigation", { name: "Sidebar", exact: true });
    const grip = sidebar.getByRole("button", { name: "Resize navigation sidebar" });
    const composer = page.locator("#panel-chat .orchestration-chat-page:visible textarea");
    await expect(sidebar.locator(".wordmark")).toHaveCount(0);
    const expectFullHeightDivider = async () => {
      await expect
        .poll(() =>
          sidebar.evaluate((element) => {
            const workspace = element.parentElement;
            if (!workspace) return false;
            const line = getComputedStyle(workspace, "::before");
            const bounds = workspace.getBoundingClientRect();
            const edge = element.getBoundingClientRect().right - 1;
            const database = document.querySelector(".footer-database")?.getBoundingClientRect();
            const timestamp = document.querySelector(".poll-timestamp")?.getBoundingClientRect();
            return (
              Math.abs(bounds.left + Number.parseFloat(line.left) - edge) < 1 &&
              Math.abs(bounds.top + Number.parseFloat(line.top)) < 1 &&
              Math.abs(bounds.bottom - Number.parseFloat(line.bottom) - innerHeight) < 1 &&
              line.width === "1px" &&
              line.pointerEvents === "none" &&
              database !== undefined &&
              timestamp !== undefined &&
              Math.abs(database.right - edge + 7) < 1 &&
              Math.abs(database.top + database.height / 2 - timestamp.top - timestamp.height / 2) <
                1
            );
          }),
        )
        .toBe(true);
    };
    await composer.fill("Keep this draft while resizing");
    await expect(page.getByRole("button", { name: "Toggle navigation sidebar" })).toHaveCount(0);
    await expect(sidebar).toHaveCSS("width", "220px");
    await expectFullHeightDivider();
    const selectedRow = sidebar.locator(".chat-sidebar-row[data-nav-active='true']");
    await expectNavigationHighlight(page, selectedRow);
    const hoverFill = await selectedRow.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--hover-bg)";
      element.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    for (const control of await selectedRow.locator(":scope > button").all()) {
      await control.hover();
      await expect(selectedRow).toHaveCSS("background-color", hoverFill);
      await expectNavigationHighlight(page, selectedRow);
    }
    await grip.focus();
    await grip.press("ArrowRight");
    await expect(sidebar).toHaveCSS("width", "240px");
    await expectFullHeightDivider();
    await expectNavigationHighlight(page, selectedRow);
    await grip.press("ArrowLeft");
    await expect(sidebar).toHaveCSS("width", "220px");
    await expectFullHeightDivider();
    const bounds = await grip.boundingBox();
    if (!bounds) throw new Error("Missing sidebar resize handle");
    await page.bringToFront();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 100, bounds.y + 100, { steps: 8 });
    await page.mouse.up();
    const resized = await sidebar.evaluate((element) => element.getBoundingClientRect().width);
    expect(resized).toBeGreaterThan(300);
    expect(resized).toBeLessThan(330);
    await expectFullHeightDivider();
    await expect(composer).toHaveValue("Keep this draft while resizing");
    await page.reload();
    await expect(sidebar).toHaveCSS("width", `${resized}px`);
    await expectFullHeightDivider();
    await expect(composer).toHaveValue("Keep this draft while resizing");
    await grip.focus();
    for (let i = 0; i < 20; i++) await grip.press("ArrowLeft");
    await expect(sidebar).toHaveCSS("width", "180px");
    await expectFullHeightDivider();
    await expectNavigationHighlight(page, selectedRow);
    await expect(sidebar.getByRole("note", { name: "Running Code60 version" })).toHaveCount(0);
    const versionNote = page
      .locator(".app-footer")
      .getByRole("note", { name: "Running Code60 version" });
    await expect(versionNote).toBeVisible();
    const versionBounds = await versionNote.boundingBox();
    const footerBounds = await page.locator(".app-footer").boundingBox();
    expect(
      versionBounds &&
        footerBounds &&
        Math.abs(versionBounds.x + versionBounds.width - footerBounds.x - footerBounds.width + 12) <
          1,
    ).toBe(true);
    await expect(sidebar.getByRole("button", { name: "Relay", exact: true })).toBeVisible();
    await page.mouse.move(600, 180);
    await expect(sidebar).toHaveCSS("width", "180px");
    await expectFullHeightDivider();
    for (let i = 0; i < 20; i++) await grip.press("ArrowRight");
    await expect(sidebar).toHaveCSS("width", "480px");
    await expectNavigationHighlight(page, selectedRow);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 650),
    );
    await expect
      .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
      .toBeLessThan(480);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expectFullHeightDivider();
    await expectNavigationHighlight(page, selectedRow);
    await page.screenshot({ path: test.info().outputPath("resizable-sidebar.png") });
    await expect(page.getByRole("button", { name: "Toggle files panel" })).toBeEnabled();
    await expect(page.locator("#relay-plan-panel")).toHaveAttribute("aria-hidden", "true");
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: unread turns stay isolated and survive renderer reloads", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-unread-"));
  application = await launch(directory, directory, join(directory, "projects.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await selectProjectConversation(page);
    const chat = page.locator("#panel-chat .orchestration-chat-page:visible");
    await expect(chat.locator(".activity-display")).toHaveCount(0);
    const firstId = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    if (!firstId) throw new Error("Missing initial conversation");
    // Automatic titles may change the label after a reply; unread state belongs to the ID.
    const first = page.locator(`[id="conversation-${firstId}"]`);
    await expect(first.locator('[data-icon="chat-circle"]')).toHaveCount(1);
    await page.getByRole("button", { name: /^New chat in / }).click();
    await expect(chat.locator(".activity-display")).toHaveCount(0);
    const second = page.getByRole("button", { name: "Chat 2", exact: true });
    const send = async (text: string) => {
      // Opening another chat does not wait for this hidden chat's ACP connection.
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.snapshot())).chats.find(
              (chat) => chat.run?.id === firstId,
            )?.run?.status,
        )
        .toBe("idle");
      const turn = (await page.evaluate(() => window.desktop.snapshot())).chats.find(
        (chat) => chat.run?.id === firstId,
      )?.run?.turns;
      if (turn === undefined) throw new Error("Missing fixture conversation");
      await page.evaluate(
        ({ id, text }) => window.desktop.orchestrationChatAction({ type: "send", id, text }),
        { id: firstId, text },
      );
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.snapshot())).chats.find(
              (chat) => chat.run?.id === firstId,
            )?.run,
        )
        .toMatchObject({ status: "idle", turns: turn + 1 });
    };
    await send(
      JSON.stringify([
        { message: "" },
        { thought: "not a reply" },
        { message: "first\n".repeat(120) },
        { message: "streamed chunk" },
        { thought: "between chunks" },
        { message: "last chunk" },
      ]),
    );
    await expect(first.locator(".chat-unread")).toHaveText("1");
    await expect(first.locator(".chat-unread svg")).toHaveCount(0);
    await expect(second.locator(".chat-unread")).toHaveCount(0);
    await send("second turn");
    await expect(first.locator(".chat-unread")).toHaveText("2");
    const grip = page.getByRole("button", { name: "Resize navigation sidebar" });
    for (let i = 0; i < 3; i++) await grip.press("ArrowLeft");
    const separated = await first.evaluate((element) => {
      const label = element.querySelector<HTMLElement>(".chat-sidebar-label");
      const indicators = element.querySelector<HTMLElement>(".chat-sidebar-indicators");
      if (!label || !indicators) throw new Error("Missing chat row content");
      label.textContent = "A very long conversation name that must not overlap its badges";
      const name = label.getBoundingClientRect();
      const badges = indicators.getBoundingClientRect();
      return name.right <= badges.left && getComputedStyle(label).textOverflow === "ellipsis";
    });
    expect(separated).toBe(true);
    await page.screenshot({ path: test.info().outputPath("sidebar-unread-narrow.png") });
    await page.reload();
    await expect(second).toHaveAttribute("aria-current", "true");
    await expect(first.locator(".chat-unread")).toHaveText("2");
    await first.focus();
    await first.press("Enter");
    await expect(first.locator(".chat-unread")).toHaveCount(0);
    await chat.locator(".transcript").evaluate((element) => {
      element.scrollTop = 0;
    });
    await send(JSON.stringify([{ message: "read while open" }, { message: "more" }]));
    await expect(chat.locator(".event.message .chat-markdown").last()).toHaveText(
      "read while openmore",
    );
    await expect(first.locator(".chat-unread")).toHaveCount(0);
    await selectSidebarPage(page, "Settings");
    await send("reply while on another page");
    await expect(first.locator(".chat-unread")).toHaveText("1");
    await selectSidebarPage(page, "Chat");
    await expect(first.locator(".chat-unread")).toHaveCount(0);
    await expect(first.locator('[data-icon="chat-circle"]')).toHaveCount(1);
    await page.reload();
    await expect(first.locator(".chat-unread")).toHaveCount(0);
    const markers = await page.evaluate(() =>
      Object.entries(sessionStorage).filter(([key]) => key.startsWith("code60.chatRead:")),
    );
    expect(markers.length).toBe(3);
    expect(
      markers.filter(([key]) =>
        JSON.parse(key.slice("code60.chatRead:".length))[0].startsWith("relay:"),
      ),
    ).toHaveLength(1);
    for (const [, marker] of markers) expect(marker).toMatch(/^\d+$/);
    await expect(
      page.locator(
        ".sidebar svg:not(.navigation-icon):not(.page-group-toggle > svg):not(.icon-button > svg):not(.project-chat-label > svg), .sidebar img",
      ),
    ).toHaveCount(0);
    await expect(
      first
        .locator("..")
        .getByRole("button", { name: /^Actions for / })
        .locator("svg"),
    ).toHaveCount(1);
    for (const disclosure of [
      page.locator("#tab-apps"),
      page.locator("#tables-toggle"),
      page.getByRole("tab", { name: "Settings", exact: true }),
      page.locator("#advanced-toggle"),
      page.locator("#experiments-toggle"),
    ])
      if ((await disclosure.getAttribute("aria-expanded")) === "false") await disclosure.click();
    const pageIcons = [
      ["tab-home", "house"],
      ["tab-apps", "app-window"],
      ["tab-chat", "clipboard"],
      ["tab-automations", "arrows-clockwise"],
      ["tab-prompts", "pencil-line"],
      ["tab-commands", "megaphone"],
      ["tab-settings", "gear"],
      ["tables-toggle", "database"],
      ["tab-configurations", "grid-nine"],
      ["tab-events", "grid-nine"],
      ["tab-logs", "grid-nine"],
      ["tab-memories", "grid-nine"],
      ["tab-messages", "grid-nine"],
      ["tab-polling", "grid-nine"],
      ["tab-sessions", "grid-nine"],
      ["tab-worktrees", "grid-nine"],
      ["tab-settings-agents", "robot"],
      ["tab-settings-memory", "brain"],
      ["tab-settings-appearance", "palette"],
      ["tab-settings-table-defaults", "table"],
      ["tab-settings-text", "text-aa"],
      ["tab-settings-polling-settings", "arrows-clockwise"],
      ["tab-settings-updates", "download-simple"],
      ["tab-settings-about", "info"],
      ["advanced-toggle", "wrench"],
      ["experiments-toggle", "flask"],
      ["tab-episodic-memory", "brain"],
      ["tab-rag", "flask"],
      ["tab-contributor-tools", "code"],
    ] as const;
    for (const [id, icon] of pageIcons) {
      const control = page.locator(`#${id}`);
      const glyph = control.locator(".navigation-icon");
      await expect(control).toHaveCSS("font-size", "15px");
      await expect(control).toHaveCSS("font-family", /D-DIN/);
      await expect(glyph).toBeVisible();
      await expect(glyph).toHaveAttribute("data-icon", icon);
      await expect(glyph).toHaveAttribute("aria-hidden", "true");
      await expect(glyph).toHaveAttribute("focusable", "false");
      await expect(glyph.locator('path[opacity="0.2"]')).toHaveCount(1);
    }
    const navigationScheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-color-scheme"),
    );
    const sidebarGlyphs = page.locator(
      ".sidebar svg, .footer-sidebar > button svg, .poll-timestamp svg",
    );
    const mismatchedGlyphs = () =>
      sidebarGlyphs.evaluateAll((icons) =>
        icons
          .filter((icon) => {
            const control = icon.parentElement;
            return control && getComputedStyle(icon).color !== getComputedStyle(control).color;
          })
          .map((icon) => icon.parentElement?.id || icon.parentElement?.getAttribute("aria-label")),
      );
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute("data-color-scheme", theme),
        theme,
      );
      await page.locator("#tab-search").hover();
      await expect.poll(mismatchedGlyphs).toEqual([]);
    }
    await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
    await expect.poll(mismatchedGlyphs).toEqual([]);
    await page.emulateMedia({ forcedColors: null, colorScheme: null });
    await page.evaluate((scheme) => {
      if (scheme === null) document.documentElement.removeAttribute("data-color-scheme");
      else document.documentElement.setAttribute("data-color-scheme", scheme);
    }, navigationScheme);
    const sidebar = page.locator(".sidebar");
    const originalButtonSize = await sidebar.evaluate((element) => ({
      value: (element as HTMLElement).style.getPropertyValue("--button-size"),
      priority: (element as HTMLElement).style.getPropertyPriority("--button-size"),
    }));
    try {
      for (const size of [8, 13, 15, 16, 24, 32, 48]) {
        await sidebar.evaluate(
          (element, size) =>
            (element as HTMLElement).style.setProperty("--button-size", `${size}px`),
          size,
        );
        const geometry = await sidebar.locator(".navigation-icon:visible").evaluateAll((icons) =>
          icons.map((icon) => {
            const control = icon.parentElement;
            const label = control?.querySelector(".page-tab-label, .chat-sidebar-label");
            if (!control || !label) throw new Error("Missing navigation label");
            const glyph = icon.getBoundingClientRect();
            const button = control.getBoundingClientRect();
            const text = label.getBoundingClientRect();
            return {
              control: control.id,
              scale: icon.classList.contains("relay-navigation-icon") ? 1.25 : 1,
              size: glyph.width,
              height: glyph.height,
              textSize: Number.parseFloat(getComputedStyle(label).fontSize),
              labelHeight: text.height,
              leading: glyph.left - button.left,
              gap: text.left - glyph.right,
              centerOffset: Math.abs((glyph.top + glyph.bottom - text.top - text.bottom) / 2),
              top: glyph.top - button.top,
              bottom: button.bottom - glyph.bottom,
              row: button.height,
            };
          }),
        );
        expect(geometry).toHaveLength(
          pageIcons.length + (await sidebar.locator(".chat-sidebar-entry:visible").count()),
        );
        for (const icon of geometry) {
          expect(icon.textSize).toBe(size);
          expect(icon.size).toBe(size * icon.scale);
          expect(icon.height).toBe(icon.size);
          expect(icon.labelHeight).toBeLessThan(size);
          expect(icon.leading).toBeGreaterThanOrEqual(12);
          expect(icon.gap, `Icon gap for ${icon.control} at ${size}px`).toBeGreaterThanOrEqual(8);
          expect(icon.centerOffset, `Icon alignment for ${icon.control} at ${size}px`).toBeLessThan(
            1,
          );
          expect(icon.top).toBeGreaterThanOrEqual(3);
          expect(icon.bottom).toBeGreaterThanOrEqual(3);
          expect(icon.row).toBe(Math.max(40, size * 1.25 + 8));
        }
        const actionSizes = await sidebar.locator(".carbon-icon:visible").evaluateAll((icons) =>
          icons.map((icon) => ({
            width: icon.getBoundingClientRect().width,
            height: icon.getBoundingClientRect().height,
          })),
        );
        expect(actionSizes.length).toBeGreaterThan(0);
        for (const action of actionSizes) expect(action).toEqual({ width: size, height: size });
        const leading = await sidebar.locator("#tab-chat > .navigation-icon").boundingBox();
        const projectAction = await sidebar
          .locator(".project-sidebar-open > .carbon-icon")
          .boundingBox();
        if (!leading || !projectAction) throw new Error("Missing Projects row controls");
        const center = (box: { y: number; height: number }) => box.y + box.height / 2;
        expect(Math.abs(center(leading) - center(projectAction))).toBeLessThan(1);
        expect(leading.x + leading.width).toBeLessThanOrEqual(projectAction.x);
      }
    } finally {
      await sidebar.evaluate((element, original) => {
        const style = (element as HTMLElement).style;
        if (original.value) style.setProperty("--button-size", original.value, original.priority);
        else style.removeProperty("--button-size");
      }, originalButtonSize);
    }
    await expect(page.locator("#tab-chat > .carbon-icon")).toHaveCount(0);
    const newChat = page.getByRole("button", { name: /^New chat in / });
    await expect(newChat).toHaveText("");
    await expect(newChat.locator("svg")).toHaveCount(1);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: scoped message ages, turn timers, Copy, and minimized lifecycle", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-qol-"));
  execFileSync("git", ["init", "-q", directory]);
  commitFixture(directory);
  application = await launch(directory, directory, join(directory, "projects.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.getByRole("button", { name: "Open Project", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Open Project", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
      await window.desktop.setPollingPaused(true);
    });
    await selectProjectConversation(page);
    const chat = page.locator("#panel-chat .orchestration-chat-page:visible");
    const composer = chat.getByLabel("Message to orchestrator", { exact: true });
    await expect(composer).toBeEnabled();
    const age = page.locator(".footer-polling [role=img]");
    await expect(age).toHaveText("No messages yet");
    await expect(page.getByRole("note", { name: "Running Code60 version" })).toHaveText(
      `Code60 ${version}`,
    );
    const source = "  ```ts\n  const value = '<not markup>';\n```\n";
    const prompt = JSON.stringify([
      { message: source },
      { sleep: 2000 },
      { message: "later chunk" },
      { hang: "cancellable" },
    ]);
    await composer.fill(prompt);
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chat.locator(".event.message .chat-markdown pre code")).toHaveText(
      "const value = '<not markup>';\n",
    );
    await expect(chat.locator(".turn-timer")).toHaveCount(0);
    await expect(chat.locator(".turn-separator")).toHaveCount(0);
    await expect(chat.locator(".activity-display")).toHaveCount(1);
    await expect(chat.locator(".activity-timer")).toBeVisible();
    await expect(age).toHaveText(/Last message \d+s ago/);
    await expect(age).toHaveAttribute("aria-label", /selected conversation/);
    await expect(page.getByRole("button", { name: "Start polling", exact: true })).toHaveCount(0);
    const pollingDialog = await openPollingControls(page);
    await expect(
      pollingDialog.getByRole("button", { name: "Start polling", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pollingDialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Open polling controls", exact: true }),
    ).toBeFocused();
    await composer.fill("untouched draft");
    await page.evaluate(() => {
      const harness = {
        values: [] as string[],
        resolve: () => {},
        reject: () => {},
      };
      (window as unknown as { copyHarness: typeof harness }).copyHarness = harness;
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: (value: string) => {
          harness.values.push(value);
          return new Promise<void>((resolve, reject) => {
            harness.resolve = resolve;
            harness.reject = () => reject(new Error("Clipboard denied"));
          });
        },
      });
    });
    const agentCopy = chat.locator(".event.message").getByRole("button", { name: "Copy message" });
    const copyToast = page
      .getByRole("group", { name: "Done notification", exact: true })
      .filter({ hasText: "Copied." });
    await expect(agentCopy).toHaveText("");
    await expect(agentCopy.locator("svg")).toHaveCount(1);
    await expectMessageCopy(agentCopy);
    await composer.focus();
    const selectedText = await chat.locator(".event.message .chat-markdown").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString();
    });
    await agentCopy.click();
    await expect(composer).toBeFocused();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(selectedText);
    await expect(agentCopy).toHaveAttribute("aria-disabled", "true");
    await expect(agentCopy).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(chat.getByText("Copied.", { exact: true })).toHaveCount(0);
    await expect(copyToast).toHaveCount(0);
    await expect(chat.locator(".event.message .chat-markdown p")).toHaveText("later chunk");
    const clipboardValues = () =>
      page.evaluate(
        () => (window as unknown as { copyHarness: { values: string[] } }).copyHarness.values,
      );
    expect(await clipboardValues()).toEqual([source]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const agentMessage = chat.locator(".event.message");
    const agentControls = agentMessage.locator(".message-copy");
    await composer.focus();
    await composer.hover();
    await expect(agentControls).toHaveCSS("opacity", "0");
    await expect(agentControls).toHaveCSS("transition-property", "opacity");
    await expect(agentControls).toHaveCSS("transition-duration", "0.175s");
    await agentMessage.locator(".chat-markdown").hover();
    await expect(agentControls).toHaveCSS("opacity", "1");
    await agentControls.locator("time").hover();
    await expect(agentControls).toHaveCSS("opacity", "1");
    await composer.hover();
    await expect(agentControls).toHaveCSS("opacity", "0");
    await agentCopy.focus();
    await expect(agentControls).toHaveCSS("opacity", "1");
    await composer.focus();
    await expect(agentControls).toHaveCSS("opacity", "0");
    await agentCopy.hover();
    await expect(agentControls).toHaveCSS("opacity", "1");
    // Streaming may legitimately move a following transcript. Measure feedback
    // only after the final chunk, independently of the viewport's available height.
    const beforeFeedback = await chat.locator(".transcript").evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
    }));
    await page.evaluate(() =>
      (window as unknown as { copyHarness: { reject(): void } }).copyHarness.reject(),
    );
    const retry = chat.getByRole("button", { name: "Retry Copy message", exact: true });
    await expect(retry).toHaveText("");
    await expect(retry.locator("svg")).toHaveCount(1);
    await expect(retry).toBeVisible();
    await expectMessageCopy(retry);
    await expect(chat.getByRole("status").filter({ hasText: "Copy failed." })).toBeVisible();
    await expect(copyToast).toHaveCount(0);
    await retry.focus();
    await page.keyboard.press("Enter");
    expect(await clipboardValues()).toEqual([source, `${source}later chunk`]);
    await page.evaluate(() =>
      (window as unknown as { copyHarness: { resolve(): void } }).copyHarness.resolve(),
    );
    await expect(copyToast).toBeVisible();
    await expect(copyToast).toHaveCSS("border-radius", "0px");
    await expect(copyToast).toHaveAttribute("data-tone", "success");
    await expect(page.locator(".toast-stack").getByRole("status")).toHaveText("Done: Copied.");
    await expect(chat.getByText("Copied.", { exact: true })).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    await expect(composer).toHaveValue("untouched draft");
    // Feedback is overlaid, not inserted into the transcript's scrolling layout.
    const afterFeedback = await chat.locator(".transcript").evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
    }));
    expect(afterFeedback.height).toBe(beforeFeedback.height);
    // Native focus can round the Windows scroll offset by one CSS pixel.
    expect(Math.abs(afterFeedback.top - beforeFeedback.top)).toBeLessThanOrEqual(1);
    await copyToast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(copyToast).toHaveCount(0);
    const userCopy = chat.locator(".event.prompt").getByRole("button", { name: "Copy message" });
    await expectMessageCopy(userCopy);
    const userBubble = await chat.locator(".event.prompt pre").boundingBox();
    const userControl = await userCopy.boundingBox();
    expect(userControl?.y).toBeGreaterThanOrEqual((userBubble?.y ?? 0) + (userBubble?.height ?? 0));
    const userControls = userCopy.locator("..");
    const userGlyph = userCopy.locator(".message-copy-glyph");
    const userGeometry = () =>
      userCopy.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      });
    const beforeCopy = await userGeometry();
    await userCopy.hover();
    await page.mouse.down();
    await expect(userGlyph).not.toHaveCSS("transform", "none");
    expect(await userGeometry()).toEqual(beforeCopy);
    await page.mouse.up();
    await expect(userGlyph).toHaveAttribute("data-clicked", "true");
    await expect(userGlyph).toHaveCSS("animation-name", "message-copy-depress");
    expect(await userGeometry()).toEqual(beforeCopy);
    expect((await clipboardValues()).at(-1)).toBe(prompt);
    await page.evaluate(() =>
      (window as unknown as { copyHarness: { resolve(): void } }).copyHarness.resolve(),
    );
    await expect(copyToast).toBeVisible();
    await expect(userControls.getByRole("status")).toHaveCount(0);
    expect(await userGeometry()).toEqual(beforeCopy);
    await expect(userControls.locator(".message-copy-feedback")).toHaveText("");
    await copyToast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(copyToast).toHaveCount(0);
    expect(await userGeometry()).toEqual(beforeCopy);
    const firstGlyph = await userGlyph.elementHandle();
    if (!firstGlyph) throw new Error("Missing copy glyph");
    await userCopy.click();
    expect(await firstGlyph.evaluate((element) => element.isConnected)).toBe(false);
    await expect(userGlyph).toHaveCSS("animation-name", "message-copy-depress");
    expect(await userGeometry()).toEqual(beforeCopy);
    await page.evaluate(() =>
      (window as unknown as { copyHarness: { resolve(): void } }).copyHarness.resolve(),
    );
    await expect(copyToast).toBeVisible();
    await expect(userControls.getByRole("status")).toHaveCount(0);
    await copyToast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(copyToast).toHaveCount(0);
    await composer.focus();
    await composer.hover();
    await expect(userControls).toHaveCSS("opacity", "0");
    await userControls.locator("time").hover();
    await expect(userControls).toHaveCSS("opacity", "1");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(userControls).toHaveCSS("transition-duration", "0s");
    await userCopy.focus();
    await userCopy.press("Enter");
    await expect(userGlyph).toHaveCSS("animation-name", "none");
    await page.evaluate(() =>
      (window as unknown as { copyHarness: { resolve(): void } }).copyHarness.resolve(),
    );
    await expect(copyToast).toBeVisible();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(chat.locator(".turn-timer")).toContainText(/Worked for .+ \(cancelled\)/);
    await expectTurnSeparator(chat.locator(".turn-separator"));
    const frozen = await chat.locator(".turn-timer").textContent();
    await page.getByRole("button", { name: /^New chat in / }).click();
    await expect(age).toHaveText("No messages yet");
    await page.getByRole("button", { name: "Chat 1", exact: true }).click();
    await expect(composer).toHaveValue("untouched draft");
    await expect(chat.locator(".turn-timer")).toHaveText(frozen ?? "");
    await page.locator("#tab-chat").press("ArrowLeft");
    await page.reload();
    await expect(page.locator("#tab-chat")).toHaveAttribute("aria-expanded", "false");
    await expect(chat.locator(".turn-timer")).toHaveText(frozen ?? "");
    await page.locator("#tab-chat").press("ArrowRight");
    await page.locator("#tab-chat").press("ArrowDown");
    await expect(page.locator(".project-chat-name").first()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "Home", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const relay = page.getByRole("button", { name: "Relay", exact: true });
    await expect(relay).toBeFocused();
    await page.locator("#tab-chat").press("ArrowLeft");
    await page.locator("#tab-chat").press("ArrowUp");
    await expect(relay).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#tab-chat")).toBeFocused();
    await page.locator("#tab-chat").press("ArrowRight");
    const [id] = await page.evaluate(() =>
      window.desktop.start({
        agents: ["claude"],
        allow: [],
        allowAll: false,
        prompt: JSON.stringify([
          { permission: { id: "qol-approval", title: "Execute fixture", kind: "execute" } },
          { message: "  historical\n```code```\n" },
        ]),
      }),
    );
    if (!id) throw new Error("Missing fixture run");
    const head = page.locator(`#conversation-${id}`);
    await expect(head).toContainText("Approval needed");
    await expect(head).not.toHaveAttribute("aria-current", "true");
    await expect(page.locator(".chat-popup:visible")).toHaveCount(0);
    // A manual session must not become delegated activity for the orchestrator.
    await expect(chat.locator(".chat-loader")).toHaveCount(0);
    await selectSidebarPage(page, "Chat");
    await page.locator("#tab-chat").press("ArrowRight");
    await head.click();
    const popup = page.locator(`#chat-${id}`);
    await expect(popup).toBeVisible();
    await expect(popup.locator(".turn-timer")).toContainText("Working for");
    await expect(popup.locator(".turn-separator")).toHaveCount(0);
    await popup.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(head).toContainText("Awaiting input");
    await expect(popup.locator(".turn-timer")).toContainText(/Worked for .+ \(finished\)/);
    await expectTurnSeparator(popup.locator(".turn-separator"));
    const worked = await popup.locator(".turn-timer").textContent();
    await page.reload();
    await expect(head).not.toHaveAttribute("aria-current", "true");
    await head.click();
    await expect(popup.locator(".turn-timer")).toHaveText(worked ?? "");
    const historical = popup.locator(".event.message");
    await expectMessageCopy(historical.getByRole("button", { name: "Copy message" }));
    await expect(historical).toHaveCSS("border-top-width", "0px");
    await expect(popup.locator(".event.prompt pre")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(popup.locator(".event.prompt pre")).toHaveCSS(
      "border-top-color",
      "rgb(91, 159, 230)",
    );
    await expect(popup.locator(".event.prompt pre")).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(historical.getByRole("button", { name: "Copy message" })).toHaveText("");
    await historical.getByRole("button", { name: "Copy message" }).click();
    await expect(copyToast).toBeVisible();
    await expect(historical.getByRole("status")).toHaveCount(0);
    // Native Windows clipboard text uses CRLF; the write harness above checks exact source.
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      ["permission qol-approval: opt-allow_once  historical", "```code```", ""].join(
        process.platform === "win32" ? "\r\n" : "\n",
      ),
    );
    await selectSidebarPage(page, "Sessions");
    await expect(age).toHaveAttribute("aria-label", /current project sessions/);
    await expect(age).toHaveText(/Last message/);
    await expect(page.locator(".app-footer")).toHaveCSS("height", "24px");
    await expect(page.locator(".app-footer")).toHaveCSS("padding-bottom", "4px");
    await page.evaluate(() => document.documentElement.style.setProperty("--button-size", "32px"));
    expect(
      await page.locator(".app-footer").evaluate((element) => element.clientHeight),
    ).toBeGreaterThan(24);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: sidebar tabs, solid background, and restart-only transparent background", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-appearance-"));
  const database = join(directory, "projects.sqlite");
  const enter = async () => {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    if (!(await page.evaluate(() => window.desktop.snapshot())).database)
      await page.evaluate(() =>
        window.desktop
          .snapshot()
          .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
      );
    await selectSidebarPage(page, "Sessions");
    return page;
  };
  try {
    application = await launch(directory, directory, database);
    let page = await enter();
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
    await expect(page.locator(".sidebar")).toHaveCSS("width", "220px");
    const sidebarHeader = page.locator(".project-sidebar-open");
    await expect(sidebarHeader).toHaveAttribute("aria-label", "Open Project");
    await expect(sidebarHeader).toHaveClass(/project-sidebar-open/);
    await expect(sidebarHeader).toHaveCSS("border-radius", "0px");

    const tabs = page.locator(".page-tabs [role='tab']");
    await expect(tabs).toHaveCount(26);
    const searchAction = page.locator(".sidebar-search");
    await expect(searchAction).toHaveAccessibleName("Search");
    await expect(page.locator(".page-tabs #tab-search")).toHaveCount(0);
    const toolbarBounds = await page.locator(".sidebar-toolbar").boundingBox();
    const relayBounds = await page.locator(".relay-sidebar").boundingBox();
    const searchBounds = await searchAction.boundingBox();
    const navBounds = await page.locator(".sidebar").boundingBox();
    if (!toolbarBounds || !relayBounds || !searchBounds || !navBounds)
      throw new Error("Sidebar utility row is missing");
    expect(toolbarBounds.height).toBe(40);
    expect(relayBounds.y).toBe(toolbarBounds.y + toolbarBounds.height + 40);
    expect(searchBounds.x + searchBounds.width).toBeGreaterThan(navBounds.x + navBounds.width - 10);
    const originalScheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-color-scheme"),
    );
    for (const [scheme, color] of [
      ["light", "rgb(0, 0, 0)"],
      ["dark", "rgb(170, 170, 170)"],
    ]) {
      await page.evaluate(
        (scheme) => document.documentElement.setAttribute("data-color-scheme", scheme ?? "light"),
        scheme,
      );
      for (const icon of await page.locator(".relay-navigation-icon").all()) {
        await expect(icon.locator(".relay-track")).toHaveCSS("stroke", color as string);
        await expect(icon.locator(".relay-track-edge")).toHaveCSS("stroke", color as string);
      }
    }
    await page.evaluate(
      (scheme) => document.documentElement.setAttribute("data-color-scheme", scheme ?? "light"),
      originalScheme,
    );
    await searchAction.focus();
    await searchAction.press("Enter");
    await expect(page.locator("#panel-search")).toBeVisible();
    await expect(searchAction).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Relay", exact: true }).click();
    await expect(searchAction).toHaveAttribute("aria-pressed", "false");

    const roundedControls = await page
      .locator(".sidebar button")
      .evaluateAll(
        (elements) =>
          elements.filter((element) => getComputedStyle(element).borderRadius !== "0px").length,
      );
    expect(roundedControls).toBe(0);
    const tabGaps = await page.locator("#table-pages button:visible").evaluateAll((elements) =>
      elements.slice(1).map((element, index) => {
        const previous = elements[index];
        if (!previous) throw new Error("Missing previous tab");
        return element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
      }),
    );
    expect(tabGaps).toEqual(Array(7).fill(0));
    await expect(page.locator(".page-tabs")).toHaveCSS("gap", "0px");
    const nativeTitlebarHeight = await page.evaluate(() => {
      const overlay = (
        navigator as Navigator & {
          windowControlsOverlay: { getTitlebarAreaRect(): DOMRect };
        }
      ).windowControlsOverlay;
      return overlay.getTitlebarAreaRect().height;
    });
    await expect(page.locator(".window-drag-strip")).toHaveCSS(
      "height",
      `${Math.max(28, nativeTitlebarHeight)}px`,
    );
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page.locator(".sidebar-settings-toggle")).toHaveCount(0);
    await expectTabAppearance(page);
    await selectSettingsPage(page, "Appearance");
    await expect(page.getByLabel("Theme", { exact: true }).locator("option")).toHaveText([
      "Light",
      "Dark",
      "System",
    ]);
    await page.evaluate(() => localStorage.setItem("code60.theme", "paper"));
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("code60.theme")))
      .toBe("light");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    // Collapse Data Viewer so the expanded Settings pages fit without a navigation scrollbar.
    await page.getByRole("button", { name: "Data Viewer", exact: true }).click();
    await expect(page.getByRole("button", { name: "Data Viewer", exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // The sidebar stays fixed while the page shrinks, without overflowing the window.
    const originalSize = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getSize(),
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 640),
    );
    await expectTabAppearance(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const pageBox = await page.locator("#panel-settings").boundingBox();
    if (!pageBox) throw new Error("Missing Settings page");
    expect(pageBox.width).toBeGreaterThan(500);
    if (originalSize)
      await application.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]?.setSize(size[0] ?? 1100, size[1] ?? 800),
        originalSize,
      );
    const toggle = () => page.getByRole("switch", { name: "Transparent background", exact: true });
    await expect(toggle()).not.toBeChecked();
    await toggle().check();
    await expect(toggle()).toBeEnabled();
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    await expect(toggle()).toBeChecked();
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
    await application.close();

    application = await launch(directory, directory, database);
    page = await enter();
    await expect(page.locator("html")).toHaveAttribute("data-transparent", "true");
    await selectSidebarPage(page, "Settings");
    await selectSettingsPage(page, "Appearance");
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await selectSidebarPage(page, "Sessions");
    await expectNeutralTheme(page);
    await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgb(15, 23, 42)");
    for (const selector of ["#panel-sessions", ".app-footer"])
      await expect(page.locator(selector)).toHaveCSS("background-color", "rgb(15, 23, 42)");
    for (const selector of ["html", "body", ".app", ".page-tabs"])
      await expect(page.locator(selector)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
    await expect(page.locator("#panel-sessions")).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.getByRole("tab", { name: "Sessions", exact: true })).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getBackgroundColor(),
      ),
      // Electron reports a transparent window's color without its alpha channel.
    ).not.toBe("#111318");

    // Observe native hit-test requests while still exercising Electron's actual implementation.
    await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("Missing window");
      const original = win.setIgnoreMouseEvents.bind(win);
      Object.assign(win, { lastIgnore: false });
      win.setIgnoreMouseEvents = (ignore, options) => {
        Object.assign(win, { lastIgnore: ignore });
        original(ignore, options);
      };
    });
    const ignored = () =>
      application.evaluate(
        ({ BrowserWindow }) =>
          (BrowserWindow.getAllWindows()[0] as unknown as { lastIgnore: boolean }).lastIgnore,
      );
    const move = async (x: number, y: number) =>
      page.evaluate(
        ({ x, y }) => window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y })),
        { x, y },
      );
    const mac = process.platform === "darwin";
    const width = await page.evaluate(() => window.innerWidth);
    await move(width - 4, 200);
    await expect.poll(ignored).toBe(mac);
    await move(16, 200);
    await expect.poll(ignored).toBe(false);
    // Passive page corners are square and remain clickable.
    await move(width - 15, 31);
    await expect.poll(ignored).toBe(false);
    const firstTab = await page.getByRole("tab", { name: "Sessions", exact: true }).boundingBox();
    if (!firstTab) throw new Error("Missing sidebar tab");
    await move(firstTab.x + firstTab.width / 2, firstTab.y + firstTab.height / 2);
    await expect.poll(ignored).toBe(false);
    const appFooter = await page.locator(".app-footer").boundingBox();
    if (!appFooter) throw new Error("Missing application footer");
    expect(appFooter.x).toBe(0);
    expect(appFooter.width).toBe(width);
    expect(appFooter.y + appFooter.height).toBe(await page.evaluate(() => window.innerHeight));
    await expect(page.locator(".app-footer")).toHaveCSS("border-top-width", "0px");
    await expect(
      page.locator(".sidebar .footer-polling, .page-panel .chat-dock-region"),
    ).toHaveCount(0);
    await move(4, appFooter.y + 10);
    await expect.poll(ignored).toBe(false);
    // The enclosing sidebar stays opaque and interactive between its buttons.
    await move(firstTab.x + firstTab.width / 2, firstTab.y + firstTab.height + 2);
    await expect.poll(ignored).toBe(false);
    await move(16, 200);
    await expect.poll(ignored).toBe(false);
    await move(100, 14);
    await expect.poll(ignored).toBe(mac);
    await move(width - 4, 200);
    await expect.poll(ignored).toBe(mac);
    await move(30, 14);
    await expect.poll(ignored).toBe(false);

    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    await toggle().uncheck();
    await expect(toggle()).toBeEnabled();
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
    await application.close();
    application = await launch(directory, directory, database);
    page = await enter();
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: workspace, streaming, approvals, follow-up, review, themes, shutdown", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-electron-"));
  const repo = join(directory, "repo");
  const config = join(directory, "config", "code60");
  await mkdir(config, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "hello.txt"), "before\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  // Use the environment's configured Git identity, as with normal development.
  commitFixture(repo);
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      defaultAgent: "fake",
      agents: { fake: { command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs")] } },
    }),
  );
  const database = join(directory, "code60.sqlite");
  application = await launch(directory, repo, database);
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Console errors include Content Security Policy violations, e.g. injected styles.
    page.on("console", (entry) => {
      if (entry.type() === "error") errors.push(entry.text());
    });
    // The splash offers centered entry without opening or switching a project.
    await page.emulateMedia({ colorScheme: "light" });
    const splash = page.locator(".splash");
    await expect(splash.locator(".splash-title")).toHaveText("Code60");
    await expect(splash.locator(".database-notice")).toContainText("No database connected");
    await expect(splash.locator(".splash-title")).toHaveCSS("font-family", /^"?D-DIN"?/);
    await expect(
      splash.getByRole("button", { name: "Connect to database", exact: true }),
    ).toBeFocused();
    await expect(splash.getByRole("button")).toHaveCount(4);
    await expectSplashLayout(page);
    await expectIndustrialSurfaces(page);
    // Light keeps a solid surface; Dark/System dark add the bundled artwork.
    // Legacy background preferences are ignored without rewriting storage.
    for (const [theme, systemScheme, scheme] of [
      ["dark", "light", "dark"],
      ["system", "dark", "dark"],
      ["system", "light", "light"],
      ["light", "dark", "light"],
    ] as const) {
      await page.evaluate((value) => {
        localStorage.setItem("code60.theme", value);
        localStorage.setItem("code60.splashBackground", "circuit-blue");
      }, theme);
      await page.emulateMedia({ colorScheme: systemScheme });
      await page.reload();
      await expectSplashLayout(page, scheme);
      expect(await page.evaluate(() => localStorage.getItem("code60.theme"))).toBe(theme);
      expect(await page.evaluate(() => localStorage.getItem("code60.splashBackground"))).toBe(
        "circuit-blue",
      );
      await expect(splash.getByRole("button")).toHaveCount(4);
      await expect(splash.locator(".database-notice")).toHaveCSS(
        "background-color",
        scheme === "dark" ? "rgb(15, 23, 42)" : "rgb(255, 255, 255)",
      );
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      ).toBe(scheme);
      if (theme === "system") {
        const nextScheme = scheme === "dark" ? "light" : "dark";
        await page.emulateMedia({ colorScheme: nextScheme });
        await expectSplashLayout(page, nextScheme);
        expect(await page.evaluate(() => localStorage.getItem("code60.theme"))).toBe("system");
        await page.emulateMedia({ colorScheme: systemScheme });
        await expectSplashLayout(page, scheme);
      }
    }
    const themes = splash.getByRole("group", { name: "Color theme", exact: true });
    await themes.getByRole("button", { name: "Dark mode", exact: true }).click();
    await expectSplashLayout(page, "dark");
    expect(await page.evaluate(() => localStorage.getItem("code60.theme"))).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("code60.splashBackground"))).toBe(
      "circuit-blue",
    );
    const lightMode = themes.getByRole("button", { name: "Light mode", exact: true });
    await lightMode.focus();
    await page.keyboard.press("Space");
    await expectSplashLayout(page);
    await expect(lightMode).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem("code60.theme"))).toBe("light");
    await page.emulateMedia({ colorScheme: null });
    await page.reload();
    await expect(splash).not.toHaveAttribute("data-background");
    await expectSplashLayout(page);
    const originalViewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    for (const viewport of [
      { width: 1600, height: 650 },
      { width: 660, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expectSplashLayout(page);
    }
    await page.setViewportSize(originalViewport);
    await page.emulateMedia({ forcedColors: "active" });
    expect(await splash.evaluate((element) => getComputedStyle(element, "::before").content)).toBe(
      "none",
    );
    expect(
      await splash.evaluate((element) => getComputedStyle(element, "::before").backgroundImage),
    ).toBe("none");
    await expect(splash.getByRole("button")).toHaveCount(4);
    await expect(splash.locator(".splash-enter")).toHaveCSS("opacity", "1");
    await page.emulateMedia({ forcedColors: "none" });
    await expectSplashLayout(page);
    await page.waitForTimeout(1500);
    await expect(splash).toBeVisible();
    await splash.getByRole("button", { name: "Start", exact: true }).click();
    await expect(splash).toHaveCount(0);
    // Workspace pages stay unavailable until a database is connected.
    await expect(page.locator(".topbar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Data Viewer", exact: true })).toBeEnabled();
    const sessionsTab = page.getByRole("tab", { name: "Sessions", exact: true });
    const messagesTab = page.getByRole("tab", { name: "Messages", exact: true });
    const worktreesTab = page.getByRole("tab", { name: "Worktrees", exact: true });
    const settingsTab = page.getByRole("tab", { name: "Settings", exact: true });
    await settingsTab.click();
    await expect(page.locator("#tab-settings-agents")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Settings" })).toBeVisible();
    const about = page.getByRole("region", { name: "About", exact: true });
    const updates = page.getByRole("region", { name: "Updates", exact: true });
    await selectSettingsPage(page, "Updates");
    await expect(updates.getByRole("status")).toContainText("installed release build");
    await expect(updates.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(await page.evaluate(() => window.desktop.update("status"))).toMatchObject({
      status: "unavailable",
    });
    await expect(page.evaluate(() => window.desktop.update("execute" as never))).rejects.toThrow();
    await selectSettingsPage(page, "About");
    await expect(about.getByText(version, { exact: true })).toBeVisible();
    const versions = (await page.evaluate(() => window.desktop.snapshot())).versions;
    expect(versions).toMatchObject({
      code60: version,
      databaseSchema: 5,
      runRecordFormat: 1,
      acpProtocol: 1,
      mcpProtocol: "2025-03-26",
    });
    for (const runtime of [versions.electron, versions.chromium, versions.node]) {
      expect(runtime).toBeTruthy();
      await expect(about.getByText(runtime as string, { exact: true })).toBeVisible();
    }
    await about.getByRole("button", { name: "Copy version info" }).click();
    await expect(about.getByRole("status")).toHaveText("Version info copied.");
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain(
      `Code60: ${version}`,
    );
    await expect(
      about.getByText(
        "Copyright 2026 Code Manufactory LLC. Licensed under the Apache License 2.0.",
      ),
    ).toBeVisible();
    await expect(settingsTab).toHaveCount(1);
    await expect(settingsTab).toBeVisible();
    const toolbar = page.locator("#panel-sessions .table-controls");
    const newSession = page.locator("#panel-sessions .table-add-accessible");
    expect(await windowTitle()).toBe(`Code60 - ${version}`);
    // The first native menu is the Code60 app menu, starting with About (which shows the version).
    expect(
      await application.evaluate(({ Menu }) => {
        const first = Menu.getApplicationMenu()?.items[0];
        return { label: first?.label, about: first?.submenu?.items[0]?.label };
      }),
    ).toEqual({ label: "Code60", about: process.platform === "linux" ? "About" : "About Code60" });
    // The command palette filters commands, exposes unavailable actions, and restores focus.
    const connect = page.locator(".project-sidebar-open");
    // Let the preceding sidebar navigation finish its deferred focus before choosing
    // the control whose focus the palette is expected to restore.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await connect.focus();
    await expect(connect).toBeFocused();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    await expect(palette).toBeVisible();
    await expect(palette).toHaveCSS("border-radius", "0px");
    const searchCommands = palette.getByRole("combobox", { name: "Search commands" });
    await expect(searchCommands).toBeFocused();
    await searchCommands.fill("new agent");
    await expect(palette.getByRole("option", { name: "New agent session" })).toBeDisabled();
    await searchCommands.fill("not-a-command");
    await expect(palette.getByText("No matching commands.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(connect).toBeFocused();
    // Default interface text uses D-DIN Regular.
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).fontFamily))
      .toMatch(/^"?D-DIN"?/);
    expect(await page.evaluate(() => localStorage.getItem("code60.appearanceVersion"))).toBe(
      "theme-4",
    );
    expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
      "undefined",
    );
    expect(await menuItem("open-project")).toEqual({
      label: "Open Project…",
      enabled: false,
      accelerator: "CmdOrCtrl+O",
    });
    expect(await menuItem("database")).toEqual({
      label: "Database Connection…",
      enabled: true,
      accelerator: null,
    });
    await clickMenu("database");
    await expect(page.getByRole("heading", { name: "Select database" })).toBeVisible();
    await page.getByRole("button", { name: "Create database…" }).click();
    await expect(page.getByRole("heading", { name: "Select database" })).toBeHidden();
    // The database notice shifts the layout, so tab geometry is checked once connected.
    await expect(page.locator(".database-notice")).toHaveCount(0);
    await expectTabAppearance(page);
    await selectSidebarPage(page, "Sessions");
    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab")).toHaveCount(23);
    await expectTabAppearance(page);
    await sessionsTab.click();
    await expect(sessionsTab).toBeFocused();
    await expect(newSession).toBeDisabled();
    await expect(newSession).toHaveText("New agent session");
    await expect(page.getByText(/code60\.sqlite|Database:|Project:/)).toHaveCount(0);
    await expect.poll(async () => (await menuItem("open-project"))?.enabled).toBe(true);
    await clickMenu("open-project");
    await expect(page.getByRole("heading", { name: "Open Project" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Open Project" })).toBeHidden();
    await clickMenu("open-project");
    await page.getByRole("button", { name: "Open Folder" }).click();
    await expect(newSession).toBeEnabled();
    await page.getByRole("button", { name: "Dismiss notification" }).click();
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("combobox").fill("poll project");
    await page.keyboard.press("Enter");
    await expect(palette).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Note notification", exact: true })).toContainText(
      "Project data polled.",
    );
    await page.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(page.locator(".app-toast")).toHaveCount(0);
    const cornerRadius = await newSession.evaluate(
      (element) => getComputedStyle(element).borderTopRightRadius,
    );
    // Toolbar actions share the square button geometry.
    expect(cornerRadius).toBe("0px");
    await appendRow(page);
    await expect(page.getByRole("dialog", { name: "Select run configuration" })).toBeVisible();
    await page.getByRole("button", { name: "Do not use a run configuration" }).click();
    await expectIndustrialSurfaces(page);
    // Fieldset-disabled controls share the same treatment as individually disabled buttons.
    const setupFields = page.locator(".setup-dialog fieldset");
    await setupFields.evaluate((element) => {
      (element as HTMLFieldSetElement).disabled = true;
    });
    await expectIndustrialSurfaces(page);
    await setupFields.evaluate((element) => {
      (element as HTMLFieldSetElement).disabled = false;
    });
    await page.getByRole("button", { name: "Start agents", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Save Run Configuration" })).not.toBeChecked();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect.poll(async () => (await menuItem("open-project"))?.enabled).toBe(true);
    // Launching a batch adds a sidebar conversation without opening it.
    const chatPopup = page.locator(".worker-chat-page");
    const chatHead = page.locator('.chat-sidebar-entry[data-role="worker"]');
    await expect(chatHead).toHaveCount(1);
    await expect(chatPopup).toHaveCount(0);
    await selectSidebarPage(page, "Chat");
    await chatHead.click();
    await expect(chatPopup).toBeVisible();
    await expect(page.locator(".app-footer .chat-head, .chat-popup")).toHaveCount(0);
    const expectChatFooterLayout = async () => {
      await expect(page.locator(".app-footer")).toBeVisible();
      await expect(page.locator(".app-footer .chat-head, .chat-popup")).toHaveCount(0);
    };
    const expectDistinctChatSurfaces = async () => {
      await chatHead.click();
      const dark = await page.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme === "dark",
      );
      await expect(chatPopup.locator(".composer")).toHaveCSS(
        "background-color",
        dark ? "rgb(15, 23, 42)" : "rgb(255, 255, 255)",
      );
      await expectComposerShadow(chatPopup.locator(".composer"));
      await expect(chatPopup.locator(".composer")).toHaveCSS("border-top-width", "1px");
      for (const message of await chatPopup.locator(".event.message").all())
        await expect(message).toHaveCSS("border-top-width", "0px");
      for (const prompt of await chatPopup.locator(".event.prompt:not(.automatic)").all()) {
        await expect(prompt.locator("pre")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(prompt.locator("pre")).toHaveCSS(
          "border-top-color",
          dark ? "rgb(119, 183, 245)" : "rgb(91, 159, 230)",
        );
        await expect(prompt.locator("pre")).toHaveCSS(
          "color",
          dark ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
        );
        await expectMessageCopy(prompt.getByRole("button", { name: "Copy message" }));
      }
    };
    await expectDistinctChatSurfaces();
    await expect(chatPopup.getByLabel("Message", { exact: true })).toBeEnabled();
    await settingsTab.click();
    await selectSettingsPage(page, "Appearance");
    const focusHighlight = page.getByRole("switch", {
      name: "Focus highlight border",
      exact: true,
    });
    await focusHighlight.check();
    await chatHead.click();
    // Navigation restores tab focus on the next frame; focus the composer after it settles.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await chatPopup.getByLabel("Message", { exact: true }).focus();
    await expect(chatPopup.getByLabel("Message", { exact: true })).toBeFocused();
    await expectChatBorder(chatPopup.locator(".composer"));
    await expect(chatPopup.getByLabel("Message", { exact: true })).toHaveCSS(
      "outline-width",
      "0px",
    );
    await page.screenshot({ path: "test-results/worker-chat-border-highlight.png" });
    await settingsTab.click();
    await focusHighlight.uncheck();
    await worktreesTab.click();
    const worktreesPanel = page.locator("#panel-worktrees");
    const worktreesGrid = worktreesPanel.locator(".sessions-grid");
    await expect(worktreesGrid.locator("tbody [role='row']")).toHaveCount(2);
    await expectGridHeaders(worktreesGrid, [
      "Worktree",
      "Actions",
      "Branch",
      "Created",
      "Repository",
      "Size",
    ]);
    const listedPaths = await worktreesGrid
      .locator("[data-testid^='glide-cell-1-']")
      .allTextContents();
    const listedBranches = await worktreesGrid
      .locator("[data-testid^='glide-cell-3-']")
      .allTextContents();
    expect(listedPaths.some((path) => path.includes(".worktrees"))).toBe(true);
    expect(listedBranches.some((branch) => branch.startsWith("code60/"))).toBe(true);
    await expectSelectedProject(page, repo);
    await worktreesGrid.locator(".dvn-scroller").evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(worktreesGrid.getByTestId("glide-cell-5-0")).toHaveText("repo");
    await expect(worktreesGrid.getByTestId("glide-cell-6-0")).not.toHaveText("Unknown");
    await worktreesGrid.locator(".dvn-scroller").evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect(worktreesPanel.getByRole("heading", { name: "Worktrees" })).toBeVisible();
    // The page stays aligned to the right of the sidebar without an outer frame.
    const panelFrame = await worktreesPanel.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const bar = document.querySelector(".page-tabs") as Element;
      const toolbar = element.querySelector(".table-controls") as Element;
      const firstTab = document.querySelector("[role='tab']") as Element;
      return {
        widths: [
          style.borderTopWidth,
          style.borderLeftWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
        ],
        left: box.left,
        right: window.innerWidth - box.right,
        bottom: window.innerHeight - box.bottom,
        clip: style.clipPath.replaceAll(" ", ""),
        barRule: [
          getComputedStyle(bar).borderBottomWidth,
          getComputedStyle(bar, "::after").content,
        ],
        toolbarPadding: [
          getComputedStyle(toolbar).paddingLeft,
          getComputedStyle(toolbar).paddingRight,
        ],
        tabClear: firstTab.getBoundingClientRect().right <= box.left - 12,
      };
    });
    expect(panelFrame).toEqual({
      widths: ["0px", "0px", "0px", "0px"],
      left: 232,
      right: 12,
      bottom: 36,
      clip: "none",
      barRule: ["0px", "none"],
      toolbarPadding: ["16px", "16px"],
      tabClear: true,
    });
    await refreshProjectData(page);
    await expect(worktreesGrid.locator("tbody [role='row']")).toHaveCount(2);
    // Opening the tab scans once, and Refresh polls the same worktrees source again.
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.desktop.snapshot());
        return snapshot.polling.sources.find((source) => source.key === "worktrees")?.history
          .length;
      })
      .toBeGreaterThanOrEqual(2);
    await selectSidebarPage(page, "Polling");
    const monitor = page.locator("#panel-polling");
    // Polling uses the same title and controls header as the other tables.
    await expect(monitor.getByRole("heading", { name: "Polling", level: 1 })).toBeVisible();
    await expect(monitor.locator(".sessions-toolbar p")).toHaveCount(0);
    const pollGrid = monitor.locator(".sessions-grid");
    const sourceRows = pollGrid.locator("tbody [role='row']");
    await expect(sourceRows).toHaveCount(5);
    const worktreesSource = sourceRows.filter({ hasText: "Worktrees" });
    await expect(worktreesSource).toContainText("Hidden");
    // Nested result rows name their source too, so match the source row's own label.
    const historySource = sourceRows.filter({ hasText: "Run history, " });
    const sourcesCanvas = await pollGrid.getByTestId("data-grid-canvas").boundingBox();
    if (!sourcesCanvas) throw new Error("Missing polling sources grid");
    // Sources sort by name, so Run history is the fourth row. The row-number column, Source
    // width, and half the Actions width locate its Actions cell.
    const historyY = sourcesCanvas.y + 32 + 24 * 3.5;
    await page.mouse.click(sourcesCanvas.x + 40 + 180 + 45, historyY);
    const sourceMenu = page.getByRole("menu", { name: "Actions for Run history" });
    await expect(sourceMenu).toBeVisible();
    await expect(sourceMenu).toHaveText("Poll nowPolling settings");
    await sourceMenu.getByRole("menuitem", { name: "Poll now" }).click();
    // The sidebar leaves fewer columns visible. Scroll to verify the result, then return.
    const scrollPollGrid = async (right: boolean) => {
      await pollGrid.locator(".dvn-scroller").evaluate(async (element, toRight) => {
        element.scrollLeft = toRight ? element.scrollWidth : 0;
        // Let the scroll event and canvas redraw finish before clicking a cell.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, right);
    };
    await scrollPollGrid(true);
    await expect(pollGrid.getByTestId("glide-cell-10-3")).toHaveText(/Success, manual, \d+ ms/);
    await scrollPollGrid(false);
    // Clicking a source shows its latest results as nested rows, and clicking again hides them.
    await expect(historySource).toContainText("collapsed");
    await page.mouse.click(sourcesCanvas.x + 40 + 60, historyY);
    await expect(historySource).toContainText("expanded");
    const historyResults = sourceRows.filter({ hasText: "poll of Run history" });
    await expect(historyResults.first()).toContainText(/Manual poll of Run history.*Success/);
    await scrollPollGrid(true);
    await expect(pollGrid.getByTestId("glide-cell-10-4")).toHaveText(/\d+ ms/);
    await scrollPollGrid(false);
    expect(await sourceRows.count()).toBeGreaterThan(4);
    await page.mouse.click(sourcesCanvas.x + 40 + 60, historyY);
    await expect(sourceRows).toHaveCount(5);
    const pollingWidget = page.getByRole("region", { name: "Polling controls" });
    const controls = await openPollingControls(page);
    await controls.getByRole("button", { name: "Pause polling" }).click();
    await expect(historySource).toContainText("Paused");
    await controls.getByRole("button", { name: "Refresh project data" }).click();
    await expect
      .poll(async () => {
        const { polling } = await page.evaluate(() => window.desktop.snapshot());
        return (
          polling.paused &&
          polling.sources
            .filter((source) => source.status !== "unavailable")
            .every((source) => source.history.at(-1)?.trigger === "manual")
        );
      })
      .toBe(true);
    await controls.getByRole("button", { name: "Close Polling controls" }).click();
    await expect(pollingWidget.getByRole("img")).toHaveAttribute(
      "aria-label",
      /Agent text in current project sessions:/,
    );
    const stamp = await pollingWidget.locator(".poll-timestamp").boundingBox();
    const footer = await page.locator(".app-footer").boundingBox();
    if (!stamp || !footer) throw new Error("Missing polling timestamp");
    expect(Math.abs(stamp.y + stamp.height / 2 - footer.y - (footer.height - 4) / 2)).toBeLessThan(
      1,
    );
    await pollingWidget.screenshot({
      path: join(root, "test-results", "footer-polling-paused.png"),
    });
    await openPollingControls(page);
    await controls.getByRole("button", { name: "Start polling" }).click();
    await controls.getByRole("button", { name: "Close Polling controls" }).click();
    await expect(historySource).not.toContainText("Paused");
    await worktreesTab.click();
    await sessionsTab.click();
    await expect(
      page
        .locator("#panel-sessions .table-controls")
        .getByRole("button", { name: "Stop all runs" }),
    ).toBeVisible();
    await chatHead.click();
    await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        JSON.stringify([
          { message: "<script>literal</script> streamed response" },
          { permission: { id: "exec-1", title: "Run tests", kind: "execute" } },
          { write: { path: "hello.txt", content: "after\n" } },
        ]),
      );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chatHead).toHaveAttribute("aria-description", /1 approvals waiting/);
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await expectIndustrialSurfaces(page);
    await expect(chatHead).toHaveCSS("font-family", /D-DIN/);
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
    await expect(page.locator(".event.message").first()).toContainText(
      "<script>literal</script> streamed response",
    );
    expect(await page.locator(".transcript script").count()).toBe(0);
    // The chat header has no turn controls; Shift+Enter adds a line and Enter sends.
    await expect(
      chatPopup.getByRole("button", { name: /^(Cancel turn|Finish run)$/i }),
    ).toHaveCount(0);
    await expect(chatPopup.locator(".composer-footer")).not.toContainText("Enter");
    await page.getByLabel("Message", { exact: true }).fill("follow");
    await page.getByLabel("Message", { exact: true }).press("Shift+Enter");
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("follow\n");
    await page.getByLabel("Message", { exact: true }).fill("follow up");
    await page.getByLabel("Message", { exact: true }).press("Enter");
    await expect(page.locator(".event.prompt").last()).toContainText("follow up");
    await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
    await messagesTab.click();
    const messagesGrid = page.locator("#panel-messages .sessions-grid");
    await expect(messagesGrid.locator("tbody [role='row']")).toHaveCount(5);
    await expectGridHeaders(messagesGrid, ["Time", "Agent", "Session", "Type", "Message"]);
    await scrollGrid(messagesGrid, Number.MAX_SAFE_INTEGER);
    await expect(
      messagesGrid.locator("[data-testid^='glide-cell-5-']").filter({ hasText: /^follow up$/ }),
    ).toHaveCount(1);
    await expect(
      messagesGrid.locator("[data-testid^='glide-cell-5-']").filter({ hasText: /^ok$/ }),
    ).toHaveCount(1);
    await chatHead.click();
    // The chat shows no speaker, turn, or status labels, and no stop-reason note.
    await expect(chatPopup.locator(".event-label, .event.status, .status")).toHaveCount(0);
    await expect(chatPopup).not.toContainText(/Turn \d|end_turn|Reply below/);
    // Renderer reload must reattach to the same live session with its full transcript.
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await selectSidebarPage(page, "Chat");
    await chatHead.click();
    await expect(chatPopup.locator(".event.prompt").last()).toContainText("follow up");
    // The splash shows once per launch, not on renderer reloads.
    await expect(page.locator(".splash")).toHaveCount(0);
    expect(await windowTitle()).toBe(`Code60 - ${version}`);
    await chatHead.click();
    await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
    await selectSidebarPage(page, "Sessions");
    await expect(chatPopup).toBeHidden();
    await expectChatFooterLayout();
    await expect(toolbar.getByRole("button", { name: /^(Changes|Discard worktree)$/ })).toHaveCount(
      0,
    );
    // The Actions cell opens a menu; an idle session's worktree cannot be deleted yet.
    const actionsCell = async (target: Page) => {
      const box = await target
        .locator("#panel-sessions .sessions-grid")
        .getByTestId("data-grid-canvas")
        .boundingBox();
      if (!box) throw new Error("Missing sessions grid");
      return { x: box.x + actionsColumnX, y: box.y + 48 };
    };
    let cell = await actionsCell(page);
    await page.mouse.click(cell.x, cell.y);
    const menu = page.getByRole("menu", { name: /^Actions for fake \/ / });
    await expect(menu).toHaveText(
      "Open chatReview changesBrowse project filesCancel turnFinish runResumeStop leftover agentDelete worktree",
    );
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Open chat",
      "Review changes",
      "Browse project files",
      "Cancel turn",
      "Finish run",
      "Resume",
      "Stop leftover agent",
      "Delete worktree",
    ]);
    await expect(menu.getByRole("menuitem", { name: "Finish run" })).toBeEnabled();
    await expect(menu.getByRole("menuitem").first()).toHaveCSS("cursor", "pointer");
    await expect(menu.getByRole("menuitem").first()).toHaveCSS("border-top-width", "0px");
    await expect(menu.getByRole("menuitem", { name: "Delete worktree" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(menu.getByRole("menuitem", { name: "Open chat" })).toBeFocused();
    await expect(chatPopup).toBeHidden();
    await menu.getByRole("menuitem", { name: "Review changes" }).click();
    await expect(menu).toBeHidden();
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Task revisions" })
      .getByRole("button")
      .last()
      .click();
    const changes = page.locator(".review-panel");
    await expect(changes.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "after",
    );
    await page.getByRole("button", { name: /^Close Revision \d+ ·/ }).click();
    await selectSidebarPage(page, "Sessions");
    await expect(changes).toBeHidden();
    cell = await actionsCell(page);
    await page.mouse.click(cell.x - actionsColumnX + 80, cell.y, { button: "right" });
    await expect(menu.getByRole("menuitem", { name: "Open chat", exact: true })).toBeFocused();
    await expect(menu.getByRole("menuitem", { name: "Delete worktree" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Delete worktree" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await chatHead.click();
    await expect(chatPopup).toBeVisible();
    // Settings has no native menu; the permanent sidebar tab selects its page.
    expect(
      await application.evaluate(({ Menu }) =>
        (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label),
      ),
    ).not.toContain("Settings");
    const appearance = page.getByRole("heading", { name: "Settings", exact: true });
    await page.getByLabel("Message", { exact: true }).fill("draft retained across tabs");
    await settingsTab.click();
    await expect(appearance).toBeVisible();
    await expect(settingsTab).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByRole("tab")).toHaveCount(23);
    // Tab switching preserves Settings scroll, session selection, and the open chat draft.
    const settingsPage = page.locator(".settings-page");
    await selectSettingsPage(page, "Text");
    await settingsPage.evaluate((element) => {
      element.scrollTop = 180;
    });
    const settingsScroll = await settingsPage.evaluate((element) => element.scrollTop);
    expect(settingsScroll).toBeGreaterThan(0);
    await sessionsTab.click();
    await expect(appearance).toBeHidden();
    await expect(settingsTab).toHaveCount(1);
    await expect(chatPopup).toBeHidden();
    await chatHead.click();
    await expect(chatPopup).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "draft retained across tabs",
    );
    await selectSidebarPage(page, "Sessions");
    await expect(
      page.locator("#panel-sessions .sessions-grid tbody [role='row'][aria-selected='true']"),
    ).toHaveCount(1);
    await chatHead.click();
    await page.getByLabel("Message", { exact: true }).fill("");
    await selectSidebarPage(page, "Sessions");
    // Keyboard navigation follows the visual order, including wraparound.
    const settingsDisclosure = page.getByRole("tab", { name: "Settings", exact: true });
    if ((await settingsDisclosure.getAttribute("aria-expanded")) === "false")
      await settingsDisclosure.click();
    const sidebarPages = [
      "Projects",
      "Automations",
      "Apps",
      "Command Builder",
      "Data Viewer",
      "Configurations",
      "Events",
      "Logs",
      "Memories",
      "Messages",
      "Polling",
      "Sessions",
      "Worktrees",
      "Prompt Builder",
      "Settings",
      "Agents",
      "Memory",
      "Appearance",
      "Table defaults",
      "Text",
      "Polling",
      "Updates",
      "About",
    ] as const;
    await expect(page.getByRole("tab")).toHaveText([
      "Home",
      ...sidebarPages.filter((name) => name !== "Data Viewer"),
    ]);
    await sessionsTab.focus();
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "Home", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const relay = page.getByRole("button", { name: "Relay", exact: true });
    await expect(relay).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: sidebarPages[0], exact: true })).toBeFocused();
    for (const [index, name] of sidebarPages.entries()) {
      if (index === 0) continue;
      await page.keyboard.press("ArrowDown");
      await expect(
        page
          .locator(
            index >= sidebarPages.indexOf("Agents")
              ? "#settings-pages"
              : index === sidebarPages.indexOf("Polling")
                ? "#table-pages"
                : ".page-tabs",
          )
          .getByRole(name === "Data Viewer" ? "button" : "tab", {
            name,
            exact: true,
          }),
      ).toBeFocused();
    }
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("button", { name: "Advanced", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Home", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(relay).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("button", { name: "Advanced", exact: true })).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("button", { name: "Advanced", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Home", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(relay).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Projects", exact: true })).toBeFocused();
    await settingsTab.click();
    await expect(page.getByRole("tab")).toHaveCount(23);
    await settingsPage.evaluate((element) => {
      element.scrollTop = 0;
    });
    // Only the heading moves the window; the scrolling page must stay out of the drag region.
    expect(
      await page.evaluate(() =>
        [".settings-page", ".settings-page-heading"].map((selector) => {
          const element = document.querySelector(selector);
          return element ? getComputedStyle(element).getPropertyValue("app-region") : "";
        }),
      ),
    ).toEqual(["none", "drag"]);
    for (const name of [
      "Agents",
      "Appearance",
      "Table defaults",
      "Text",
      "Polling",
      "Updates",
      "About",
    ]) {
      await selectSettingsPage(page, name);
      await expect(page.locator("#panel-settings").getByRole("heading", { level: 2 })).toHaveText([
        name,
      ]);
    }
    await selectSettingsPage(page, "Appearance");
    // The settings content is centered in the page, excluding the sidebar.
    const centered = await page.evaluate(() => {
      const box = document.querySelector(".settings-page-heading")?.getBoundingClientRect();
      const panel = document.querySelector("#panel-settings")?.getBoundingClientRect();
      return box && panel
        ? Math.abs(box.left + box.width / 2 - panel.left - panel.width / 2)
        : Infinity;
    });
    expect(centered).toBeLessThan(10);
    if (process.platform === "win32") await watchTitleBarOverlay();
    for (const theme of ["dark", "light", "system"]) {
      await page.getByLabel("Theme").selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const darkTheme =
        theme === "dark" ||
        (theme === "system" &&
          (await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)));
      if (process.platform === "win32") {
        await expect
          .poll(() => lastTitleBarOverlay())
          .toEqual({
            color: darkTheme ? "#0f172a" : "#ffffff",
            symbolColor: darkTheme ? "#ffffff" : "#000000",
            height: 28,
          });
      }
      await expectThemeContrast(page);
      await expectNeutralTheme(page);
      const chatVisible = await chatPopup.isVisible();
      if (chatVisible) {
        await selectSidebarPage(page, "Sessions");
        await expect(chatPopup).toBeHidden();
      }
      await page.screenshot({ path: `test-results/neutral-theme-settings-${theme}.png` });
      if (chatVisible) await chatHead.click();
      await expectIndustrialSurfaces(page);
      await sessionsTab.click();
      await expectTabAppearance(page);
      await expectChatFooterLayout();
      await expectDistinctChatSurfaces();
      if (theme === "system" && process.platform === "win32") {
        const currentSystemTheme = darkTheme ? "dark" : "light";
        const alternateSystemTheme = darkTheme ? "light" : "dark";
        await page.emulateMedia({ colorScheme: alternateSystemTheme });
        await expect
          .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
          .toBe(alternateSystemTheme);
        await expect
          .poll(() => lastTitleBarOverlay())
          .toEqual({
            color: darkTheme ? "#ffffff" : "#0f172a",
            symbolColor: darkTheme ? "#000000" : "#ffffff",
            height: 28,
          });
        await page.emulateMedia({ colorScheme: null });
        await expect
          .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
          .toBe(currentSystemTheme);
        await expect
          .poll(() => lastTitleBarOverlay())
          .toEqual({
            color: darkTheme ? "#0f172a" : "#ffffff",
            symbolColor: darkTheme ? "#ffffff" : "#000000",
            height: 28,
          });
      }
      await expect(page.locator(".event.prompt pre").first()).toHaveCSS(
        "font-family",
        /^"?D-DIN"?/,
      );
      await expect(page.locator(".event.message .chat-markdown").first()).toHaveCSS(
        "font-family",
        /^"?D-DIN"?/,
      );
      // Outlined human messages keep contrasting text and no side rule.
      await expect(page.locator(".event.prompt pre").first()).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(page.locator(".event.prompt pre").first()).toHaveCSS(
        "border-top-color",
        darkTheme ? "rgb(119, 183, 245)" : "rgb(91, 159, 230)",
      );
      await expect(page.locator(".event.prompt pre").first()).toHaveCSS(
        "color",
        darkTheme ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
      );
      await expect(page.locator(".event.prompt").first()).toHaveCSS("border-left-width", "0px");
      if (theme === "dark") {
        await page.mouse.move(1, 1);
        // The open worker conversation uses the shared navigation highlight.
        await expect(chatHead.locator("..")).toHaveCSS("background-color", "rgb(30, 43, 69)");
        await expect(chatHead).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(chatHead).toHaveCSS("color", "rgb(255, 255, 255)");
        await expect(page.locator("#panel-chat")).toHaveCSS("background-color", "rgb(15, 23, 42)");
        // Primary buttons stay filled in dark mode.
        const primary = await page.evaluate(() => {
          const probe = document.createElement("button");
          probe.className = "primary";
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        });
        expect(primary).toBe("rgb(119, 183, 245)");
        await page.screenshot({ path: "test-results/dark-theme-sessions-chat.png" });
      }
      await settingsTab.click();
    }
    await selectSettingsPage(page, "Text");
    const typeface = page
      .getByRole("group", { name: "Normal Text", exact: true })
      .getByLabel("Typeface");
    await expect(typeface).toHaveValue("");
    const headingCase = page
      .getByRole("group", { name: "Table Headings", exact: true })
      .getByRole("radio", { name: "Uppercase", exact: true });
    await expect(headingCase).not.toBeChecked();
    await expect(headingCase).toBeEnabled();
    await page
      .getByRole("group", { name: "Table Headings", exact: true })
      .getByLabel("Typeface")
      .selectOption("d-din");
    await page
      .getByRole("group", { name: "Table Headings", exact: true })
      .getByRole("radio", { name: "As written", exact: true })
      .check();
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
    await expect(settingsTab).toHaveCount(1);
    await settingsTab.click();
    await selectSettingsPage(page, "Text");
    await expect(headingCase).not.toBeChecked();
    await headingCase.check();
    await expect(typeface.locator("option")).toHaveText([
      "Default (D-DIN)",
      "System",
      "Computer Modern",
      "D-DIN",
      "Georgia",
      "IBM Plex Sans",
      "IBM Plex Serif",
      "Lexend",
      "Shantell Sans",
      "OCR-A",
      "Roboto",
      "Space Grotesk",
      "Tahoma",
      "Verdana",
    ]);
    // Each bundled typeface must load under the Content Security Policy once it is in use.
    for (const [value, family] of [
      ["computer-modern", "CMU Serif"],
      ["ibm-plex-sans", "IBM Plex Sans"],
      ["ibm-plex-serif", "IBM Plex Serif"],
      ["lexend", "Lexend"],
      ["shantell-sans", "Shantell Sans"],
      ["ocr-a", "OCR-A"],
      ["roboto", "Roboto"],
      ["space-grotesk", "Space Grotesk"],
      ["georgia", "Georgia"],
      ["d-din", "D-DIN"],
    ] as const) {
      await typeface.selectOption(value);
      await expect
        .poll(() =>
          page.evaluate(async (name) => {
            await document.fonts.load(`13px "${name}"`);
            return [
              getComputedStyle(document.body).fontFamily.split(",")[0]?.replaceAll('"', ""),
              document.fonts.check(`13px "${name}"`),
            ];
          }, family),
        )
        .toEqual([family, true]);
      // Typefaces use normal tracking; data controls keep D-DIN and normal tracking.
      const spacing = await page.evaluate(() => {
        const body = getComputedStyle(document.body);
        const select = getComputedStyle(document.querySelector("select") ?? document.body);
        const em =
          body.letterSpacing === "normal"
            ? 0
            : Number.parseFloat(body.letterSpacing) / Number.parseFloat(body.fontSize);
        return [
          Math.round(em * 100) / 100,
          select.fontFamily.includes("D-DIN") && select.letterSpacing === "normal",
        ];
      });
      expect(spacing).toEqual([0, true]);
    }
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("code60.textStyles") ?? "{}").normalText.typeface,
      ),
    ).toBe("d-din");
    // Navigation defaults to 15px; explicit Button Text sizes still control it.
    const buttonSize = page
      .getByRole("group", { name: "Button Text", exact: true })
      .getByLabel("Font size");
    const resetText = page.getByRole("button", { name: "Reset text", exact: true });
    await expect(page.locator("#tab-chat")).toHaveCSS("font-size", "15px");
    await expect(resetText).toHaveCSS("font-size", "13px");
    for (const size of [8, 13, 15, 16, 24, 32, 48]) {
      await buttonSize.fill(String(size));
      await expect(page.locator("#tab-chat")).toHaveCSS("font-size", `${size}px`);
      await expect(page.locator("#tab-settings-text")).toHaveCSS("font-size", `${size}px`);
      await expect(chatHead).toHaveCSS("font-size", `${size}px`);
      await expect(resetText).toHaveCSS("font-size", `${size}px`);
    }
    await buttonSize.fill("");
    await expect(page.locator("#tab-chat")).toHaveCSS("font-size", "15px");
    await expect(resetText).toHaveCSS("font-size", "13px");
    // Settings never shows a worker overlay.
    await expect(chatPopup).toBeHidden();
    // Every role has independent controls; the case switches exclude one another.
    const roles = [
      "Table Headings",
      "Button Text",
      "Agent Chat Messages",
      "Human Chat Messages",
      "Page Titles",
      "Normal Text",
    ];
    for (const [index, name] of roles.entries()) {
      const group = page.getByRole("group", { name, exact: true });
      await group.getByLabel("Typeface").selectOption("georgia");
      await group.getByLabel("Font size").fill(String(16 + index));
      await group.getByLabel("Font weight").selectOption("700");
      await group.getByRole("radio", { name: "Uppercase", exact: true }).check();
      await group.getByRole("radio", { name: "Lowercase", exact: true }).check();
      await expect(group.getByRole("radio", { name: "Uppercase", exact: true })).not.toBeChecked();
    }
    await expect(page.locator(".settings-page-heading h1")).toHaveCSS("font-size", "20px");
    await expect(page.locator(".settings-page-heading h1")).toHaveCSS(
      "text-transform",
      "lowercase",
    );
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await settingsTab.click();
    await selectSettingsPage(page, "Text");
    for (const [index, name] of roles.entries()) {
      const group = page.getByRole("group", { name, exact: true });
      await expect(group.getByLabel("Font size")).toHaveValue(String(16 + index));
      await expect(group.getByLabel("Typeface")).toHaveValue("georgia");
      await expect(group.getByRole("radio", { name: "Lowercase", exact: true })).toBeChecked();
    }
    await expect(page.locator("#tab-chat")).toHaveCSS("font-size", "17px");
    await expect(page.locator("#tab-chat")).toHaveCSS("font-family", /Georgia/);
    await sessionsTab.click();
    if (!(await chatPopup.isVisible())) await chatHead.click();
    await expectChatFooterLayout();
    await expect(page.locator(".event.message .chat-markdown").first()).toHaveCSS(
      "font-size",
      "18px",
    );
    await expect(page.locator(".event.prompt pre").first()).toHaveCSS("font-size", "19px");
    await expect(page.locator(".event.message .chat-markdown").first()).toHaveCSS(
      "text-transform",
      "lowercase",
    );
    await selectSidebarPage(page, "Sessions");
    await settingsTab.click();
    await page.getByRole("button", { name: "Reset text", exact: true }).click();
    for (const name of roles) {
      const group = page.getByRole("group", { name, exact: true });
      await expect(group.getByLabel("Font size")).toHaveValue("");
      await expect(group.getByLabel("Typeface")).toHaveValue("");
      await expect(group.getByRole("radio", { name: "As written", exact: true })).toBeChecked();
    }
    await expect(page.locator(".settings-page-heading h1")).toHaveCSS("text-transform", "none");
    await expect(page.locator("#tab-chat")).toHaveCSS("font-size", "15px");
    await expect(page.locator("#tab-chat")).toHaveCSS("font-family", /D-DIN/);
    await expect(page.getByRole("button", { name: "Reset text", exact: true })).toHaveCSS(
      "font-size",
      "13px",
    );
    await selectSettingsPage(page, "Appearance");
    await expect(page.getByLabel("Theme")).toHaveValue("system");
    await expect(page.locator(".settings-page pre, .settings-page code")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(appearance).toBeVisible();
    await sessionsTab.click();
    await expect(appearance).toBeHidden();
    await expect(settingsTab).toHaveCount(1);
    await expect(sessionsTab).toBeFocused();
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(appearance).toBeVisible();
    await sessionsTab.click();
    await expect(appearance).toBeHidden();
    if (!(await chatPopup.isVisible())) await chatHead.click();
    await expect(chatPopup).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe("dark");
    await expectThemeContrast(page);
    await expectNeutralTheme(page);
    await page.mouse.move(1, 1);
    await expect(chatHead.locator("..")).toHaveCSS("background-color", "rgb(30, 43, 69)");
    await expect(chatHead).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expectChatFooterLayout();
    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
      .toBe("light");
    await expectThemeContrast(page);
    await expectNeutralTheme(page);
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    const id = snapshot.liveIds[0] as string;
    expect(snapshot.runs[0]?.view?.turns).toBe(2);
    await application.close();
    const record = JSON.parse(
      await readFile(join(repo, ".git/code60/runs", id, "run.json"), "utf8"),
    );
    expect(record.status).toBe("finished");
    expect(() => process.kill(record.agentPid, 0)).toThrow();
    // Startup recreates a missing workspace beside the remembered database.
    const workspaceDirectory = join(dirname(database), ".code60_workspace");
    expect((await stat(workspaceDirectory)).isDirectory()).toBe(true);
    await rm(workspaceDirectory, { recursive: true });
    // A restart reconnects to the remembered database; recent projects stay in the workspace picker.
    application = await launch(directory, join(directory, "unused"), database);
    const again = await application.firstWindow();
    await expect
      .poll(async () => (await stat(workspaceDirectory).catch(() => null))?.isDirectory())
      .toBe(true);
    again.on("pageerror", (error) => errors.push(error.message));
    again.on("console", (entry) => {
      if (entry.type() === "error") errors.push(entry.text());
    });
    await expectSplashLayout(again);
    await expect(again.locator(".splash-enter")).toBeFocused();
    await again.screenshot({ path: "test-results/splash-start.png" });
    await again.getByRole("button", { name: "Start", exact: true }).click();
    await again.locator(".project-sidebar-open").click();
    const offer = again.getByRole("dialog", { name: "Open Project", exact: true });
    await expect(offer.getByRole("heading")).toHaveText("Open Project");
    await expect(offer.getByRole("list", { name: "Recent projects" })).toBeVisible();
    await expect(offer.locator(".project-item .path")).toHaveText(repo);
    await expect(offer.getByRole("button", { name: "Open Folder", exact: true })).toBeEnabled();
    await expect(offer.getByRole("button", { name: "Clear history", exact: true })).toHaveCount(0);
    await expect(offer.getByRole("button", { name: "Remove repo from history" })).toBeEnabled();
    await expect(offer.getByRole("button", { name: /^(Yes|No)$/ })).toHaveCount(0);

    // Cancelling the native folder picker leaves the full selector and history intact.
    await application.evaluate(({ dialog }) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original;
        return { canceled: true, filePaths: [] };
      };
    });
    await offer.getByRole("button", { name: "Open Folder", exact: true }).click();
    await expect(offer.locator(".project-item")).toBeEnabled();
    expect((await again.evaluate(() => window.desktop.snapshot())).directory).toBeNull();
    // Selecting a project asks for confirmation; Escape cancels without entering.
    await again.waitForTimeout(1500);
    await expect(offer).toBeVisible();
    await offer.locator(".project-item").click();
    const projectConfirmation = again.getByRole("dialog", { name: "Open project?", exact: true });
    await expect(projectConfirmation).toContainText(repo);
    expect((await again.evaluate(() => window.desktop.snapshot())).directory).toBeNull();
    await again.keyboard.press("Escape");
    await expect(projectConfirmation).toHaveCount(0);
    await expect(offer.locator(".project-item")).toBeFocused();
    await offer.locator(".project-item").click();
    await projectConfirmation.getByRole("button", { name: "Open project", exact: true }).click();
    await selectSidebarPage(again, "Sessions");
    await expect(again.locator(".splash")).toHaveCount(0);
    await expect(again.locator("#panel-sessions .table-add-accessible")).toBeEnabled();
    const grid = again.locator("#panel-sessions .sessions-grid");
    // The grid paints on a canvas; its accessibility table mirrors the visible cells.
    const canvas = grid.getByTestId("data-grid-canvas");
    await expect(grid.locator("tbody [role='row']")).toHaveCount(1);
    // Accessibility cell IDs count the row-number column, which the table itself omits.
    await expect(grid.getByTestId("glide-cell-3-0")).toHaveText("Finished");
    await scrollGrid(grid, 500);
    await expect(grid.getByTestId("glide-cell-7-0")).toHaveText(/^\d+$/);
    // The grid exposes only visible columns, so widen the window past the sidebar to list them all.
    const sessionSize = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getSize(),
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1700, 900),
    );
    await expectGridHeaders(grid, [
      "Agent",
      "Actions",
      "Status",
      "Turns",
      "Approvals",
      "ID",
      "PID",
      "Branch",
      "Started",
      "Turn time",
      "Events, 5 min",
      "Last 2 min",
    ]);
    await expect(grid.getByTestId("glide-cell-2-0")).toHaveText("Actions");
    await expect(grid.locator("tbody [role='row'][aria-selected='true']")).toHaveCount(1);
    if (sessionSize)
      await application.evaluate(
        ({ BrowserWindow }, [w, h]) =>
          BrowserWindow.getAllWindows()[0]?.setSize(w ?? 1280, h ?? 860),
        sessionSize,
      );
    // Window controls overlay a dedicated drag strip, above every sidebar button.
    const titlebar = await again.evaluate(() => {
      // Chromium's Window Controls Overlay API is not in TypeScript's DOM types yet.
      const overlay = (
        navigator as Navigator & {
          windowControlsOverlay: { visible: boolean; getTitlebarAreaRect(): DOMRect };
        }
      ).windowControlsOverlay;
      const area = overlay.getTitlebarAreaRect();
      const bar = document.querySelector(".window-drag-strip");
      const list = document.querySelector(".page-tabs");
      if (!list) throw new Error("Missing navigation scroller");
      const clipTop = list.getBoundingClientRect().top + list.clientTop;
      const buttons = [...document.querySelectorAll(".page-tabs button")]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => button.getBoundingClientRect());
      return {
        visible: overlay.visible,
        // Scrolled rows can have negative bounds; their paint stays inside the native scrollport.
        clear: buttons.every((box) => Math.max(box.top, clipTop) >= area.bottom),
        clipping: getComputedStyle(list).overflowY,
        drag: bar ? getComputedStyle(bar).getPropertyValue("app-region") : "",
      };
    });
    expect(titlebar).toEqual({
      visible: true,
      clear: true,
      clipping: "auto",
      drag: "drag",
    });
    // Table display settings are local and do not change other tables.
    const tableSettings = again
      .locator("#panel-sessions")
      .getByRole("button", { name: "Settings", exact: true });
    const sessionsGrid = again.locator("#panel-sessions .sessions-grid");
    await expect(sessionsGrid).toHaveAttribute("data-row-height", "24");
    await tableSettings.click();
    expect(errors).toEqual([]);
    const tableDialog = again.getByRole("dialog", { name: "Sessions table settings" });
    for (const name of ["Row lines", "Column lines", "Heading lines"]) {
      const toggle = tableDialog.getByRole("switch", { name, exact: true });
      await expect(toggle).not.toBeChecked();
      await toggle.check();
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
    }
    await tableDialog.getByLabel("Row density").selectOption("low");
    await tableDialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(sessionsGrid).toHaveAttribute("data-row-height", "44");
    expect(
      await again.evaluate(
        () => JSON.parse(localStorage.getItem("code60.tableView.v1:sessions") ?? "{}").density,
      ),
    ).toBe("low"); // Historical sessions remain in Chat without opening on startup.
    const restoredChat = again.locator(".worker-chat-page");
    await expect(restoredChat).toBeHidden();
    // Quitting finished this unowned worker, so Chat hides it until it is opened again.
    await expect(again.locator('.chat-sidebar-entry[data-role="worker"]')).toHaveCount(0);
    await selectSidebarPage(again, "Messages");
    await expect(
      again.locator("#panel-messages [data-testid^='glide-cell-5-']").filter({
        hasText: /^follow up$/,
      }),
    ).toHaveCount(1);
    await selectSidebarPage(again, "Sessions");
    cell = await actionsCell(again);
    await again.mouse.click(cell.x, cell.y);
    const restoredMenu = again.getByRole("menu", { name: /^Actions for fake \/ / });
    await expect(restoredMenu.getByRole("menuitem", { name: "Delete worktree" })).toBeEnabled();
    await expect(restoredChat).toBeHidden();
    await again.keyboard.press("Escape");
    await expect(restoredMenu).toBeHidden();
    // Enter on the focused Actions cell opens the menu; arrows move between items.
    await canvas.press("Enter");
    await expect(restoredMenu.getByRole("menuitem", { name: "Open chat" })).toBeFocused();
    await again.keyboard.press("ArrowDown");
    await expect(restoredMenu.getByRole("menuitem", { name: "Review changes" })).toBeFocused();
    await again.keyboard.press("ArrowDown");
    await expect(
      restoredMenu.getByRole("menuitem", { name: "Browse project files" }),
    ).toBeFocused();
    await again.keyboard.press("ArrowDown");
    await expect(restoredMenu.getByRole("menuitem", { name: "Cancel turn" })).toBeFocused();
    await again.keyboard.press("End");
    await expect(restoredMenu.getByRole("menuitem", { name: "Delete worktree" })).toBeFocused();
    await again.keyboard.press("Home");
    await again.keyboard.press("ArrowDown");
    await again.keyboard.press("Enter");
    await again.getByRole("tab", { name: "Changes", exact: true }).click();
    await again
      .getByRole("navigation", { name: "Task revisions" })
      .getByRole("button")
      .last()
      .click();
    await expect(
      again.locator(".review-panel .modified .view-lines:not([monaco-view-zone])"),
    ).toContainText("after");
    await again.getByRole("button", { name: /^Close Revision \d+ ·/ }).click();
    await selectSidebarPage(again, "Sessions");
    await expect(again.locator(".review-panel")).toBeHidden();
    // The grid's scroll layer sits above the canvas and receives pointer input.
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Missing sessions grid");
    // Clicking the row number opens the chat, like clicking any other cell in the row.
    await again.mouse.click(box.x + 20, box.y + 48);
    await expect(restoredChat).toBeVisible();
    await selectSidebarPage(again, "Sessions");
    await expect(canvas).toBeVisible();
    const shownBox = await canvas.boundingBox();
    if (!shownBox) throw new Error("Missing sessions grid");
    await again.mouse.click(shownBox.x + 80, shownBox.y + 48);
    await expect(restoredChat).toBeVisible();
    await expect(restoredChat.locator(".event.prompt").last()).toContainText("follow up");
    await expect(again.locator('.chat-sidebar-entry[data-role="worker"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await selectSidebarPage(again, "Sessions");
    await expect(restoredChat).toBeHidden();
    await canvas.press("Enter");
    await expect(restoredChat).toBeVisible();
    await selectSidebarPage(again, "Sessions");
    await expect(again.locator("#panel-sessions .table-add-accessible")).toBeEnabled();
    // Fit columns to width fills the grid with the columns and follows window resizes.
    await selectSidebarPage(again, "Sessions");
    const windowSize = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getSize(),
    );
    const resize = (width: number, height: number) =>
      application.evaluate(
        ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setSize(w ?? 0, h ?? 0),
        [width, height],
      );
    const overflow = () =>
      again.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(
          "#panel-sessions .sessions-grid .dvn-scroller",
        );
        return scroller ? scroller.scrollWidth - scroller.clientWidth : -1;
      });
    await resize(700, 600);
    await expect.poll(overflow).toBeGreaterThan(0);
    await tableSettings.click();
    const fitColumns = again.getByRole("switch", { name: "Fit columns to width" });
    await expect(fitColumns).not.toBeChecked();
    await fitColumns.check();
    await tableDialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(sessionsGrid).toHaveAttribute("data-fit-columns", "true");
    await expect.poll(overflow).toBe(0);
    // Wide enough that the grid, right of the sidebar, still grows past its default columns.
    await resize(1650, 700);
    await expect.poll(overflow).toBe(0);
    // Fitted columns keep Actions beside Agent and scale both columns with the grid.
    await expect
      .poll(async () => {
        const grown = await canvas.boundingBox();
        return grown ? grown.width : 0;
      })
      .toBeGreaterThan(1300);
    const grownBox = await canvas.boundingBox();
    if (!grownBox) throw new Error("Missing sessions grid");
    const fittedActionsX = await again.evaluate(() => {
      const grid = document.querySelector<HTMLElement>("#panel-sessions .sessions-grid");
      const scroller = grid?.querySelector<HTMLElement>(".dvn-scroller");
      if (!grid || !scroller) return 0;
      const scrollbar = scroller.offsetWidth - scroller.clientWidth;
      const available = grid.clientWidth - 40 - scrollbar;
      // 1377px is the sum of the default column widths, including the three chart columns.
      return 40 + Math.floor((95 / 1377) * available) + Math.floor((90 / 1377) * available) / 2;
    });
    await again.mouse.click(grownBox.x + fittedActionsX, grownBox.y + 48);
    await expect(restoredMenu).toBeVisible();
    await again.keyboard.press("Escape");
    await expect(restoredMenu).toBeHidden();
    expect(
      await again.evaluate(
        () => JSON.parse(localStorage.getItem("code60.tableView.v1:sessions") ?? "{}").fit,
      ),
    ).toBe(true);
    if (windowSize) await resize(windowSize[0] ?? 0, windowSize[1] ?? 0);
    // Escape enters without opening a project, just like the splash Start action.
    await application.close();
    application = await launch(directory, join(directory, "unused"), database);
    const third = await application.firstWindow();
    const declined = third.locator(".splash");
    await expect(declined.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await third.keyboard.press("Escape");
    await expect(third.locator(".splash")).toHaveCount(0);
    await expect(third.locator("#panel-sessions .table-add-accessible")).toBeDisabled();
    await clickMenu("open-project");
    await third.getByRole("button", { name: "Remove repo from history" }).click();
    await expect(third.getByText("No recent projects.")).toBeVisible();
    await third
      .getByRole("dialog", { name: "Open Project", exact: true })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await application.close();
    expect(errors).toEqual([]);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: agent setup wizard gates legacy entry, connects three agents without a database and reconfigures Settings", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-onboarding-"));
  const database = join(directory, "projects.sqlite");
  const file = join(directory, "state/code60/desktop.json");
  const configFile = join(directory, "config/code60/config.json");
  const command = [process.execPath, join(root, "test/fixtures/fake-agent.mjs")];
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({
      agents: Object.fromEntries(
        ["claude", "codex", "droid", "kiro"].map((id) => [id, { command }]),
      ),
    }),
  );
  await privateDirectory(dirname(file));
  await writeFile(file, JSON.stringify({ orchestrationProvider: "claude" }));
  try {
    application = await launch(directory, directory, database, false);
    const page = await application.firstWindow();
    const wizard = page.locator(".agent-setup-dialog");
    await expect(wizard).toBeVisible();
    await expect(wizard.locator(".agent-choice")).toHaveText([
      "Antigravity",
      "Claude",
      "Codex",
      "Copilot",
      "Droid",
      "Kiro",
      "OpenCode",
    ]);
    await expect(wizard.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(wizard).toHaveCount(0);
    await expect(page.locator(".splash")).toBeVisible();
    await page.evaluate(() => sessionStorage.setItem("code60.splashShown", "1"));
    await page.reload();
    await expect(wizard).toBeVisible();
    // Arrow keys move focus; Space starts detection and connection immediately.
    await expect(wizard.getByRole("button", { name: "Antigravity", exact: true })).toBeEnabled();
    await wizard.getByRole("button", { name: "Antigravity", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(wizard.getByRole("button", { name: "Claude", exact: true })).toBeFocused();
    await expect(wizard.locator('input[type="radio"]')).toHaveCount(0);
    await page.evaluate(() => document.documentElement.style.setProperty("--title-size", "28px"));
    await expect(wizard.getByRole("heading")).toHaveCSS("font-size", "16px");
    await expect(wizard.getByRole("button", { name: "Claude", exact: true })).toHaveCSS(
      "font-size",
      "13px",
    );
    await page.screenshot({ path: "test-results/agent-setup-select.png" });
    // Selecting a connector also saves it, without any confirmation or review step.
    // A failed atomic save stays on the result screen and Retry saves the verified result.
    const saved = await readFile(file, "utf8");
    await rm(file, { recursive: true });
    await mkdir(file);
    await page.keyboard.press("Space");
    await expect(wizard.getByRole("alert")).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).agentSetup?.complete).toBe(false);
    expect((await page.evaluate(() => window.desktop.snapshot())).database).toBeNull();
    await expect(wizard.getByText("Connected", { exact: true })).toHaveCount(0);
    await rm(file, { recursive: true });
    await writeFile(file, saved);
    await wizard.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(wizard.getByRole("status")).toHaveText("Claude connected");
    await expect(wizard.getByText("Connected", { exact: true })).toBeVisible();
    expect(JSON.parse(await readFile(file, "utf8")).agentSetup.enabled).toEqual(["claude"]);
    for (const name of ["Codex", "Droid"]) {
      await wizard.getByRole("button", { name: "Add another agent", exact: true }).click();
      await expect(wizard.getByRole("button", { name, exact: true })).toBeEnabled();
      await expect(wizard).toHaveCount(1);
      await expect(wizard.getByRole("button", { name: "Claude", exact: true })).toHaveCount(0);
      await page.screenshot({ path: "test-results/agent-setup-add-another.png" });
      await wizard.getByRole("button", { name, exact: true }).click();
      await expect(wizard.getByRole("status")).toHaveText(`${name} connected`);
      await expect(wizard.getByText("Connected", { exact: true })).toBeVisible();
    }
    await expect(
      wizard.getByRole("button", { name: /finish setup|Review agents|Yes,|No,/i }),
    ).toHaveCount(0);
    const record = JSON.parse(await readFile(file, "utf8")).agentSetup;
    expect(record).toMatchObject({
      version: 1,
      primary: "claude",
      enabled: ["claude", "codex", "droid"],
    });
    await page.screenshot({ path: "test-results/agent-setup-connected.png" });
    await wizard.getByRole("button", { name: "Close agent setup", exact: true }).click();
    await expect(wizard).toHaveCount(0);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.status)
      .toBe("idle");
    const chatId = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    await selectSidebarPage(page, "Settings");
    await page.getByRole("button", { name: "Add agents", exact: true }).click();
    await wizard.getByRole("button", { name: "Kiro", exact: true }).click();
    await expect(wizard.getByRole("status")).toHaveText("Kiro connected");
    expect((await page.evaluate(() => window.desktop.snapshot())).agents).toEqual([
      "claude",
      "codex",
      "droid",
      "kiro",
    ]);
    await wizard.getByRole("button", { name: "Close", exact: true }).click();
    await expect(wizard).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(chatId);
    await page.getByRole("button", { name: "Change primary", exact: true }).click();
    await wizard.getByRole("button", { name: "Codex", exact: true }).click();
    await expect(wizard.getByRole("status")).toHaveText("Codex connected");
    await page.evaluate(() => (document.documentElement.dataset.colorScheme = "dark"));
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 600),
    );
    await page.screenshot({ path: "test-results/agent-setup-dark.png" });
    await page.keyboard.press("Escape");
    await expect(wizard).toHaveCount(0);
    await expect
      .poll(
        async () => (await page.evaluate(() => window.desktop.snapshot())).orchestration.provider,
      )
      .toBe("codex");
    await page.reload();
    await expect(page.locator(".splash")).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).agents).toEqual(["codex"]);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Apps cards open nested pages and preserve drafts, disclosure and keyboard navigation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-apps-nav-"));
  try {
    application = await launch(directory, directory, join(directory, "code60.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const apps = page.getByRole("tab", { name: "Apps", exact: true });
    const home = page.locator("#panel-apps");
    const children = page.locator("#app-pages");
    // Apps starts open, so the first click closes it and the second reopens it with its home page.
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await apps.click();
    await expect(apps).toHaveAttribute("aria-expanded", "false");
    await expect(home).toBeHidden();
    await apps.click();
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await expect(home.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
    await expect(apps).toHaveAttribute("aria-selected", "true");
    await expect(apps.locator("svg")).toHaveAttribute("data-icon", "app-window");
    await expect(home.locator(".home-card")).toHaveCount(3);
    await expect(
      home.getByRole("button", { name: "Open Command Builder", exact: true }),
    ).toBeDisabled();
    await expect(
      home.getByRole("button", { name: "Open Prompt Builder", exact: true }),
    ).toBeDisabled();
    const viewer = children.getByRole("button", { name: "Data Viewer", exact: true });
    await expect(viewer).toHaveAttribute("aria-expanded", "false");
    const viewerCard = home.getByRole("button", { name: "Open Data Viewer", exact: true });
    await expect(viewerCard).toBeEnabled();
    await apps.press("ArrowLeft");
    await viewerCard.click();
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await expect(viewer).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#tab-logs")).toBeFocused();
    await expect(page.locator("#panel-logs")).toBeVisible();
    await viewer.press("ArrowLeft");
    await expect(page.locator("#panel-logs")).toBeVisible();
    await expect(viewer).toHaveAttribute("data-active", "true");
    await viewer.press("ArrowLeft");
    await expect(apps).toBeFocused();
    await apps.press("ArrowLeft");
    await expect(apps).toHaveAttribute("data-active", "true");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Logs");
    await page.keyboard.press("Enter");
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await expect(viewer).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#tab-logs")).toBeFocused();
    await viewer.press("ArrowLeft");
    await apps.click();
    await apps.click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await expect(children.getByRole("tab")).toHaveText(["Command Builder", "Prompt Builder"]);
    const commandsCard = home.getByRole("button", { name: "Open Command Builder", exact: true });
    await expect(commandsCard).toBeEnabled();
    await commandsCard.focus();
    await commandsCard.press("Enter");
    await expect(page.locator("#panel-commands")).toBeVisible();
    await apps.click();
    await expect(apps).toHaveAttribute("aria-expanded", "false");
    await expect(children).toHaveAttribute("inert", "");
    await expect(page.locator("#panel-commands")).toBeVisible();
    await apps.click();
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await expect(home).toBeVisible();
    await home.getByRole("button", { name: "Open Prompt Builder", exact: true }).click();
    await expect(page.locator("#panel-prompts")).toBeVisible();
    const builder = children.getByRole("tab", { name: "Prompt Builder", exact: true });
    await expect(builder).toBeEnabled();
    const commandBuilder = children.getByRole("tab", { name: "Command Builder", exact: true });
    await apps.press("ArrowRight");
    await expect(commandBuilder).toBeFocused();
    await expect(page.locator("#panel-commands")).toBeVisible();
    await commandBuilder.press("ArrowDown");
    await expect(viewer).toBeFocused();
    await expect(page.locator("#panel-commands")).toBeVisible();
    await viewer.press("ArrowDown");
    await expect(builder).toBeFocused();
    await expect(page.locator("#panel-prompts")).toBeVisible();
    const role = page.locator("#panel-prompts").getByRole("textbox", { name: "Role", exact: true });
    await role.fill("Keep this Apps draft");
    await builder.press("ArrowLeft");
    await expect(apps).toBeFocused();
    await expect(children).toHaveAttribute("inert", "");
    await expect(apps).toHaveAttribute("data-active", "true");
    await expect(page.locator("#panel-prompts")).toBeVisible();
    await apps.press("ArrowRight");
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await builder.press("ArrowUp");
    await expect(viewer).toBeFocused();
    await viewer.press("ArrowUp");
    await expect(commandBuilder).toBeFocused();
    await builder.click();
    await expect(role).toHaveValue("Keep this Apps draft");
    // Clicking the open group closes it without leaving the current app.
    await apps.click();
    await expect(apps).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#panel-prompts")).toBeVisible();
    await apps.click();
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await expect(home).toBeVisible();
    await apps.click();
    await expect(apps).toHaveAttribute("aria-expanded", "false");
    await expect(home).toBeVisible();
    await apps.click();
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await builder.click();
    await expect(role).toHaveValue("Keep this Apps draft");
    await builder.press("ArrowLeft");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Command Builder");
    await page.keyboard.press("Enter");
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await expect(commandBuilder).toBeFocused();
    await expect(page.locator("#panel-commands")).toBeVisible();
    await page.getByRole("button", { name: "Relay", exact: true }).click();
    await apps.press("ArrowLeft");
    await page.reload();
    await expect(apps).toHaveAttribute("aria-expanded", "false");
    await apps.click();
    await expect(children.getByRole("tab")).toHaveText(["Command Builder", "Prompt Builder"]);
    await expect(home).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("apps-home.png") });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(620, 620),
    );
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const bounds = await home.evaluate((element) => ({
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
    }));
    expect(bounds.contentWidth).toBeLessThanOrEqual(bounds.width);
    await home.getByRole("button", { name: "Open Prompt Builder", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#panel-prompts")).toBeVisible();
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: prompt template editing and persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-prompts-"));
  application = await launch(directory, directory, join(directory, "code60.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const tab = page.getByRole("tab", { name: "Prompt Builder", exact: true });
    await expect(tab).toBeDisabled();
    await page
      .locator(".database-notice")
      .getByRole("button", { name: "Connect to database" })
      .click();
    await page.getByRole("button", { name: "Create database…" }).click();
    await tab.click();
    const panel = page.locator("#panel-prompts");
    const template = panel.getByLabel("Template", { exact: true });
    const role = panel.getByRole("textbox", { name: "Role", exact: true });
    const planning = panel.getByRole("textbox", { name: "Planning", exact: true });
    const originalContract = (
      await readFile(join(root, "test/fixtures/operating-contract.txt"), "utf8")
    ).trimEnd();
    const originalPlanning = originalContract.split("\n")[3];
    await expect(panel.getByRole("textbox")).toHaveCount(13);
    await expect(template).toHaveCount(0);
    const save = panel.getByRole("button", { name: "Save", exact: true });
    const fields = panel.getByRole("combobox", { name: "Insert merge field" });
    const preview = panel.locator(".prompt-editor-main .prompt-editor-preview");
    const showPreview = panel.getByRole("button", { name: "Preview", exact: true });
    const editTemplate = panel.getByRole("button", { name: "Edit template", exact: true });
    await expect(role).toBeVisible();
    await expect(showPreview).toBeVisible();
    await expect(preview).toHaveCount(0);
    await expect(panel.locator(".prompt-editor-mcp")).toHaveCount(0);
    await expect(
      panel.getByRole("heading", { name: "MCP tool descriptions", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("heading", { name: "Operating Contract", exact: true }),
    ).toBeVisible();
    const system = panel.getByRole("button", { name: "System", exact: true });
    const promptList = panel.locator(".prompt-system-list");
    await expect(system).toHaveAttribute("aria-expanded", "true");
    await expect(promptList.getByRole("button")).toHaveCount(4);
    await expect(panel.getByText("Built-in", { exact: true })).toHaveCount(0);
    const selectedPrompt = promptList.getByRole("button", {
      name: "Operating Contract",
      exact: true,
    });
    const otherPrompt = promptList.getByRole("button", { name: "Handoff summary", exact: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(async (theme) => {
        document.documentElement.dataset.colorScheme = theme;
        await document.fonts.ready;
      }, theme);
      // Late layout updates can move the item beneath the native Electron pointer.
      await expect(async () => {
        await otherPrompt.hover();
        await expect(otherPrompt).toHaveCSS(
          "background-color",
          theme === "light" ? "rgb(229, 240, 252)" : "rgb(27, 45, 74)",
          { timeout: 500 },
        );
      }).toPass({ timeout: 5_000 });
      await expect(otherPrompt).toHaveCSS("border-top-width", "0px");
      await expect(otherPrompt).toHaveCSS("outline-style", "none");
      await expect(selectedPrompt).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(237, 237, 237)" : "rgb(30, 43, 69)",
      );
      await panel.locator(".prompt-editor").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: join(tmpdir(), `wow-prompts-${theme}.png`) });
      await selectedPrompt.hover();
      await expect(selectedPrompt).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(237, 237, 237)" : "rgb(30, 43, 69)",
      );
      await expect(selectedPrompt).toHaveCSS("border-top-width", "0px");
    }
    await page.emulateMedia({ forcedColors: "active" });
    await expect(selectedPrompt).toHaveCSS("outline-style", "solid");
    await page.emulateMedia({ forcedColors: "none" });
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setMinimumSize(0, 0);
      window?.setSize(600, 650);
    });
    await panel.locator(".prompt-editor").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: join(tmpdir(), "wow-prompts-narrow.png") });
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 850),
    );
    await expect(fields).toHaveCount(0);
    await role.fill("You are controlled by Code60.");
    await planning.fill("Make a plan and wait for acceptance.");
    await system.click();
    await expect(system).toHaveAttribute("aria-expanded", "false");
    await expect(promptList).toBeHidden();
    await expect(role).toHaveValue("You are controlled by Code60.");
    await system.focus();
    await page.keyboard.press("Space");
    await expect(promptList).toBeVisible();
    await expect(promptList.getByRole("button", { name: /Operating Contract/ })).toContainText(
      "Unsaved changes",
    );
    await showPreview.focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await expect(preview).toHaveCount(1);
    const editedContract = originalContract.split("\n");
    editedContract[0] = "You are controlled by Code60.";
    editedContract[3] = "Make a plan and wait for acceptance.";
    await expect(preview).toHaveText(editedContract.join("\n"));
    expect(await preview.evaluate((element) => (element as HTMLElement).isContentEditable)).toBe(
      false,
    );
    await editTemplate.focus();
    await page.keyboard.press("Space");
    await expect(role).toHaveValue(editedContract[0]);
    await expect(planning).toHaveValue(editedContract[3]);
    await panel.getByRole("button", { name: /^Handoff summary/ }).click();
    await panel.getByRole("button", { name: /^Operating Contract/ }).click();
    await expect(role).toHaveValue(editedContract[0]);
    await expect(planning).toHaveValue(editedContract[3]);
    await selectSidebarPage(page, "Sessions");
    await tab.click();
    await expect(role).toHaveValue(editedContract[0]);
    await expect(planning).toHaveValue(editedContract[3]);
    await planning.fill("");
    await expect(save).toBeDisabled();
    await expect(panel.locator(".prompt-editor-problem")).toContainText("Planning");
    await planning.fill(editedContract[3]);
    // Save all clauses while viewing their combined, read-only body.
    await showPreview.click();
    await save.click();
    await expect(panel.getByRole("status")).toHaveText("Source: Saved edit.");
    await expect(preview).toHaveText(editedContract.join("\n"));
    await editTemplate.click();
    await panel.getByRole("button", { name: /^Handoff summary/ }).click();
    await template.fill("Agent: ");
    await fields.selectOption("agent");
    await expect(template).toHaveValue("Agent: {{agent}}");
    await expect(template).toBeFocused();
    await expect(fields).toHaveValue("");
    await fields.selectOption("agent");
    await expect(template).toHaveValue("Agent: {{agent}}{{agent}}");
    // The preceding insertion restores its cursor on the next animation frame.
    await template.evaluate(
      (element: HTMLTextAreaElement) =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            element.setSelectionRange(7, 25);
            resolve();
          });
        }),
    );
    await fields.selectOption("agent");
    await expect(template).toHaveValue("Agent: {{agent}}");
    // Let the insertion's frame-delayed focus restoration finish before moving focus.
    await template.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await showPreview.focus();
    await page.keyboard.press("Enter");
    await expect(preview).toHaveText("Agent: claude");
    await expect(template).toHaveCount(0);
    await expect(fields).toHaveCount(0);
    expect(
      await preview.evaluate((element) => ({
        tag: element.tagName,
        editable: (element as HTMLElement).isContentEditable,
      })),
    ).toEqual({ tag: "PRE", editable: false });
    await editTemplate.focus();
    await page.keyboard.press("Space");
    await expect(preview).toHaveCount(0);
    await expect(template).toHaveValue("Agent: {{agent}}");
    await showPreview.click();
    // The first-prompt preview merges the summary draft, so switching templates changes it.
    await panel.getByRole("button", { name: /^Handoff first prompt/ }).click();
    await expect(preview).toContainText("Agent: claude\n\nThe user's new message follows.");
    await expect(preview).toContainText("Please finish the failing test.");
    await panel.getByRole("button", { name: /^Handoff summary/ }).click();
    await expect(preview).toHaveText("Agent: claude");
    await editTemplate.click();
    await selectSidebarPage(page, "Sessions");
    await tab.click();
    await expect(template).toHaveValue("Agent: {{agent}}");
    await save.click();
    await expect(panel.getByRole("status")).toHaveText("Source: Saved edit.");
    await page.reload();
    await tab.click();
    await expect(role).toHaveValue("You are controlled by Code60.");
    await expect(planning).toHaveValue("Make a plan and wait for acceptance.");
    await role.fill("Unsaved role.");
    await planning.fill("Unsaved planning.");
    await showPreview.click();
    await panel.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(preview).toHaveText(editedContract.join("\n"));
    await editTemplate.click();
    await expect(role).toHaveValue("You are controlled by Code60.");
    await expect(planning).toHaveValue("Make a plan and wait for acceptance.");
    await panel.getByRole("button", { name: "Reset to default", exact: true }).click();
    await expect(role).toHaveValue(/Code60's orchestration assistant/);
    await expect(planning).toHaveValue(originalPlanning ?? "");
    await showPreview.click();
    await expect(preview).toHaveText(originalContract);
    await editTemplate.click();
    await panel.getByRole("button", { name: /^Handoff summary/ }).click();
    await expect(template).toHaveValue("Agent: {{agent}}");
    await expect(panel.getByRole("status")).toHaveText("Source: Saved edit.");
    await template.fill("{{unknown}}");
    await expect(template).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    await showPreview.click();
    await expect(preview).toHaveText("Fix the template to see a preview.");
    await expect(panel.getByRole("status")).toContainText([
      "Unsaved changes.",
      "This template unknown merge field 'unknown'.",
    ]);
    await expect(save).toBeDisabled();
    await panel.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(preview).toHaveText("Agent: claude");
    await editTemplate.click();
    await expect(template).toHaveValue("Agent: {{agent}}");
    await panel.getByRole("button", { name: "Reset to default", exact: true }).click();
    await expect(panel.getByRole("status")).toBeEmpty();
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: run configurations, launch selection, and post-launch saving", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-configurations-"));
  const repo = join(directory, "repo");
  const config = join(directory, "config", "code60");
  execFileSync("git", ["init", "-q", repo]);
  commitFixture(repo);
  await mkdir(config, { recursive: true });
  const command = [process.execPath, join(root, "test/fixtures/fake-agent.mjs")];
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      defaultAgent: "fake",
      agents: { fake: { command }, fake2: { command } },
    }),
  );
  application = await launch(directory, repo, join(directory, "code60.sqlite"));
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("button", { name: "Data Viewer", exact: true })).toBeEnabled();
    await page
      .locator(".database-notice")
      .getByRole("button", { name: "Connect to database" })
      .click();
    await page.getByRole("button", { name: "Create database…" }).click();
    await selectSidebarPage(page, "Configurations");
    const configurationsTab = page.getByRole("tab", { name: "Configurations", exact: true });
    const sessionsTab = page.getByRole("tab", { name: "Sessions", exact: true });
    const panel = page.locator("#panel-configurations");
    await expect(panel.getByRole("heading", { name: "Configurations", exact: true })).toBeVisible();
    await expect(panel.getByText(/No run configurations yet/)).toHaveCount(0);
    await appendRow(page, "configurations");
    const editor = page.getByRole("dialog", { name: "Run configuration", exact: true });
    await expect(editor.getByLabel("Task prompt")).toHaveCount(0);
    await editor.getByLabel("Configuration name").fill("Team");
    await editor.getByRole("button", { name: "Add agent" }).click();
    await editor.getByLabel("Agent 2", { exact: true }).selectOption("fake2");
    await editor.getByLabel("Maximum active runs").fill("1");
    await editor.getByText("Advanced options", { exact: true }).click();
    await editor.getByLabel("Turn timeout").fill("5m");
    await editor.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const grid = panel.locator(".sessions-grid");
    await expectGridHeaders(grid, [
      "Name",
      "Actions",
      "Preset Provider",
      "# Agents",
      "Uses",
      "Last Used",
    ]);
    await expect(grid.getByTestId("glide-cell-1-0")).toHaveText("Team");
    await expect(grid.getByTestId("glide-cell-2-0")).toHaveText("Actions");
    await expect(grid.getByTestId("glide-cell-3-0")).toHaveText("fake, fake2");
    await expect(grid.getByTestId("glide-cell-4-0")).toHaveText("2");
    await expect(grid.getByTestId("glide-cell-5-0")).toHaveText("0");
    await scrollGrid(grid, Number.MAX_SAFE_INTEGER);
    await expect(grid.getByTestId("glide-cell-6-0")).toHaveText("Never");
    await scrollGrid(grid, 0);
    await expect(panel.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
    await clickMenu("open-project");
    await page.getByRole("button", { name: "Open Folder" }).click();
    await page
      .getByRole("group", { name: "Done notification", exact: true })
      .filter({ hasText: "Opened repo." })
      .getByRole("button", { name: "Dismiss notification" })
      .click();
    await sessionsTab.click();
    await appendRow(page);
    await page.getByRole("button", { name: "Do not use a run configuration" }).click();
    await expect(page.getByLabel("Agent 1", { exact: true })).toHaveValue("fake");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: /^Team/ }).click();
    await expect(page.getByLabel("Agent 2", { exact: true })).toHaveValue("fake2");
    await expect(page.getByLabel("Maximum active runs")).toHaveValue("1");
    await expect(page.getByLabel("Task prompt")).toHaveValue("");
    await page.getByLabel("Task prompt").fill("one-time private task");
    await page.getByLabel("Maximum active runs").fill("2");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: /^Team/ }).click();
    await expect(page.getByLabel("Task prompt")).toHaveValue("one-time private task");
    await page.getByRole("button", { name: "Start agents", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Agent sessions started", exact: true });
    await expect(confirmation).toContainText("2 agent sessions started");
    await expect(
      confirmation.getByRole("checkbox", { name: "Save Run Configuration" }),
    ).not.toBeChecked();
    await expect(confirmation.getByLabel("Configuration name")).toHaveCount(0);
    const started = await page.evaluate(() => window.desktop.snapshot());
    expect(started.configurations[0]).toMatchObject({ uses: 1, settings: { parallel: "1" } });
    await confirmation.getByRole("checkbox", { name: "Save Run Configuration" }).check();
    await confirmation.getByLabel("Configuration name").fill("team");
    await confirmation.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(confirmation.getByRole("alert")).toContainText("already exists");
    await confirmation.getByLabel("Configuration name").fill("Adjusted");
    await confirmation.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(confirmation).toContainText("Run configuration saved.");
    await confirmation.getByRole("button", { name: "Done", exact: true }).click();
    const after = await page.evaluate(() => window.desktop.snapshot());
    expect(after.runs.map((run) => run.record.id)).toEqual(
      started.runs.map((run) => run.record.id),
    );
    expect(after.configurations.find((entry) => entry.name === "Adjusted")).toMatchObject({
      uses: 1,
      settings: { parallel: "2" },
    });
    expect(JSON.stringify(after.configurations)).not.toContain("one-time private task");
    // Starting the batch leaves table actions unobscured.
    await expect(page.locator('.chat-sidebar-entry[data-role="worker"]')).toHaveCount(2);
    await expect(page.locator(".worker-chat-page:visible")).toHaveCount(0);
    await configurationsTab.click();
    await expect(grid.locator("tbody [role='row']")).toHaveCount(2);
    await scrollGrid(grid, 0);
    const bounds = await grid.getByTestId("data-grid-canvas").boundingBox();
    if (!bounds) throw new Error("Missing configuration grid");
    // The row-number column, Name width, and half the Actions width.
    const configurationActions = { x: bounds.x + 40 + 260 + 45, y: bounds.y + 45 };
    const configurationMenu = page.getByRole("menu", { name: /^Actions for / });
    await page.mouse.click(configurationActions.x, configurationActions.y);
    await expect(configurationMenu.getByRole("menuitem")).toHaveText(["Edit", "Delete"]);
    await expect(configurationMenu).toHaveText("EditDelete");
    await expect(configurationMenu.getByRole("menuitem", { name: "Edit" })).toBeFocused();
    await expect(editor).toHaveCount(0);
    await configurationMenu.getByRole("menuitem", { name: "Edit" }).click();
    await editor.getByLabel("Configuration name").fill("Adjusted renamed");
    await editor.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(grid.getByTestId("glide-cell-1-0")).toHaveText("Adjusted renamed");
    await page.mouse.click(configurationActions.x, configurationActions.y);
    await configurationMenu.getByRole("menuitem", { name: "Delete" }).click();
    await expect(grid.locator("tbody [role='row']")).toHaveCount(1);
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
    await configurationsTab.click();
    await expect(grid.getByTestId("glide-cell-1-0")).toHaveText("Team");
    await expect(grid.getByTestId("glide-cell-5-0")).toHaveText("1");
    expect(errors).toEqual([]);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: workers use the Chat hierarchy with independent full-page conversations", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-chats-"));
  const repo = join(directory, "repo");
  const config = join(directory, "config", "code60");
  await mkdir(config, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "hello.txt"), "before\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  commitFixture(repo);
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      defaultAgent: "fake",
      agents: { fake: { command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs")] } },
    }),
  );
  application = await launch(directory, repo, join(directory, "code60.sqlite"));
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await expect(page.locator(".orchestration-chat-page:visible .activity-display")).toHaveCount(0);
    await selectProjectConversation(page);
    const start = () =>
      page.evaluate(() => window.desktop.start({ agents: ["fake"], allow: [], allowAll: false }));
    const [a] = await start();
    const [b] = await start();
    if (!a || !b) throw new Error("Missing fixture runs");
    const initial = await page.evaluate(() => window.desktop.snapshot());
    const owner = initial.chat.run?.id;
    if (!owner) throw new Error("Missing orchestrator");
    const row = (id: string) => page.locator(`#conversation-${id}`);
    const worker = (id: string) => page.locator(`#chat-${id}`);
    await expect(row(a)).toBeVisible();
    await expect(row(b)).toBeVisible();
    await expect(page.locator(".worker-chat-page:visible")).toHaveCount(0);
    await expect(row(owner)).toHaveAttribute("aria-current", "true");
    await expect(row(owner)).toHaveAttribute("data-role", "orchestrator");
    await expect(row(a)).toHaveAttribute("data-role", "worker");
    await expect(row(owner).locator('[data-icon="chat-circle"]')).toHaveCount(1);
    await expect(row(a).locator('[data-icon="arrow-elbow-down-right"]')).toHaveCount(1);
    await expect(page.locator(".chat-dock, .chat-popup")).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    const conversation = row(a);
    await conversation.hover();
    const colors = () =>
      conversation.evaluate((button) => ({
        fill: getComputedStyle(button.closest(".chat-sidebar-row") ?? button).backgroundColor,
        text: getComputedStyle(button).color,
      }));
    const hovered = await colors();
    await page.mouse.down();
    try {
      expect(await conversation.evaluate((button) => button.matches(":active"))).toBe(true);
      expect(await colors()).toEqual(hovered);
    } finally {
      await page.mouse.up();
      await page.emulateMedia({ reducedMotion: null });
    }
    await expect(worker(a).getByLabel("Message", { exact: true })).toBeEnabled();
    await expectNavigationHighlight(page, row(a).locator(".."));
    await expect(row(owner)).not.toHaveAttribute("aria-current", "true");
    await expect(page.locator(".chat-page-heading[data-nav-active='true']")).toHaveCount(0);
    const nameBounds = await worker(a).locator(".worker-chat-title").boundingBox();
    const statusBounds = await worker(a).locator(".worker-chat-subtitle").boundingBox();
    expect(nameBounds && statusBounds && statusBounds.y >= nameBounds.y + nameBounds.height).toBe(
      true,
    );
    const iconRatio = await worker(a)
      .locator(".worker-chat-title > .chat-role-icon")
      .evaluate(
        (element) =>
          element.getBoundingClientRect().width /
          Number.parseFloat(getComputedStyle(element.parentElement ?? element).fontSize),
      );
    expect(iconRatio).toBe(1);

    await worker(a).getByLabel("Message", { exact: true }).fill("draft A");
    await row(b).click();
    await worker(b)
      .getByLabel("Message", { exact: true })
      .fill(JSON.stringify([{ message: "only chat B" }]));
    await worker(b).getByRole("button", { name: "Send", exact: true }).click();
    await expect(worker(b).locator(".event.message")).toContainText("only chat B");
    await row(a).click();
    await expect(worker(a).getByLabel("Message", { exact: true })).toHaveValue("draft A");
    await expect(worker(a)).not.toContainText("only chat B");
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(owner);
    await selectSidebarPage(page, "Settings");
    await expect(worker(a)).toBeHidden();
    await expect(page.locator(".chat-sidebar-entry[aria-current='true']")).toHaveCount(0);
    await expectNavigationHighlight(page, page.locator("#tab-settings-agents").locator(".."));
    await selectSidebarPage(page, "Chat");
    await expect(worker(a).getByLabel("Message", { exact: true })).toHaveValue("draft A");
    await expectNavigationHighlight(page, row(a).locator(".."));

    // Pushed worker replies use the same per-turn unread markers as orchestrators.
    await row(b).click();
    await expect(worker(b)).toBeVisible();
    await page.evaluate(
      (id) =>
        window.desktop.action({
          type: "reply",
          id,
          text: JSON.stringify([
            { message: "background reply" },
            { thought: "between chunks" },
            { message: "more text" },
          ]),
        }),
      a,
    );
    await expect(row(a).locator(".chat-unread")).toHaveText("1");
    await row(a).click();
    await expect(row(a).locator(".chat-unread")).toHaveCount(0);
    const scroller = worker(a).locator(".transcript");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.snapshot())).runs.find(
            ({ record }) => record.id === a,
          )?.view?.status,
      )
      .toBe("idle");
    await page.evaluate(
      (id) =>
        window.desktop.action({
          type: "reply",
          id,
          text: JSON.stringify([{ message: "scrollable reply\n".repeat(120) }]),
        }),
      a,
    );
    await expect(worker(a).locator(".event.message").last()).toContainText("scrollable reply");
    await expect(worker(a).getByLabel("Message", { exact: true })).toBeEnabled();
    // The view follows the streamed reply to the bottom; scrolling up must then stop following.
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect
      .poll(() =>
        scroller.evaluate(async (element) => {
          element.scrollTop = 0;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return element.scrollTop;
        }),
      )
      .toBe(0);
    await row(b).click();
    await row(a).click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
    // Exercise layout ownership with real runs and a controlled snapshot projection.
    // Controller ownership authorization is covered by the worker gateway integration tests.
    await application.evaluate(
      ({ BrowserWindow, ipcMain }, { owner, a, b }) => {
        const handlers = (
          ipcMain as unknown as {
            _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
          }
        )._invokeHandlers;
        const original = handlers.get("desktop:snapshot-summary");
        const project = (value: unknown) => {
          const snapshot = value as import("../src/bridge/index.js").Snapshot;
          if (!snapshot?.chats) return value;
          return {
            ...snapshot,
            chats: snapshot.chats.map((chat) =>
              chat.run?.id === owner ? { ...chat, workers: [a, b] } : chat,
            ),
          };
        };
        if (!original) throw new Error("Missing snapshot handler");
        handlers.set("desktop:snapshot-summary", async (...args) =>
          project(await original(...args)),
        );
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (!contents) throw new Error("Missing window");
        const send = contents.send.bind(contents);
        contents.send = (channel, ...args) =>
          send(
            channel,
            ...args.map((value) => (channel === "desktop:update" ? project(value) : value)),
          );
      },
      { owner, a, b },
    );
    await page.reload();
    const children = page.getByRole("group", { name: "Chat 1 workers", exact: true });
    const toggle = page.getByRole("button", { name: "Workers for Chat 1", exact: true });
    await expect(children).toBeVisible();
    await expect(children.locator('[data-role="worker"]')).toHaveCount(2);
    await children.locator(`#conversation-${a}`).click();
    await expect(worker(a).getByLabel("Message", { exact: true })).toHaveValue("draft A");
    await expectNavigationHighlight(page, row(a).locator(".."));
    await toggle.click();
    await expect(page.locator(`#workers-${owner}`)).toHaveAttribute("inert", "");
    await expect(page.locator(`#workers-${owner}`)).toHaveAttribute("aria-hidden", "true");
    await expect(children).toBeHidden();
    await expect(worker(a)).toBeVisible();
    await page.evaluate(() =>
      window.desktop.snapshot().then((snapshot) =>
        window.desktop.poll(["history"], {
          projectId: snapshot.projectInstanceId ?? undefined,
          databaseEpoch: snapshot.databaseEpoch,
        }),
      ),
    );
    await expect(children).toBeHidden();
    await row(owner).press("ArrowRight");
    await expect(page.locator(`#workers-${owner}`)).not.toHaveAttribute("inert", "");
    await expect(page.locator(`#workers-${owner}`)).toHaveAttribute("aria-hidden", "false");
    await expect(children).toBeVisible();
    await row(owner).press("ArrowRight");
    await expect(row(a)).toBeFocused();
    await row(a).press("ArrowLeft");
    await expect(row(owner)).toBeFocused();
    await page.getByRole("button", { name: /^New chat in / }).click();
    await expect(page.getByRole("button", { name: "Chat 2", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(children).toBeVisible();
    await children.locator(`#conversation-${a}`).click();
    await expect(worker(a)).toBeVisible();
    const secondOwner = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    expect(secondOwner).not.toBe(owner);

    await worker(a)
      .getByLabel("Message", { exact: true })
      .fill(
        JSON.stringify([
          { message: "before approval" },
          { permission: { id: "approval", title: "Execute fixture", kind: "execute" } },
          { message: "after approval" },
        ]),
      );
    await worker(a).getByRole("button", { name: "Send", exact: true }).click();
    await expect(worker(a).getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await row(b).click();
    await expect(page.locator(".app-footer .footer-note")).toContainText("1 approvals waiting");
    await page.locator(".app-footer .footer-note").click();
    await expect(worker(a)).toBeVisible();
    await worker(a).getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(worker(a).getByLabel("Message", { exact: true })).toBeEnabled();
    await expect(worker(a).locator(".event.message").last()).toContainText("after approval");
    await expect(page.locator(".app-footer .footer-note")).toHaveCount(0);
    await expect(worker(a).getByRole("button", { name: "Copy message" }).first()).toBeVisible();
    await expect(worker(a).locator(".turn-timer").last()).toContainText("Worked for");

    // Historical sessions stay listed and continuation happens only after Send.
    await page.evaluate((id) => window.desktop.action({ type: "finish", id }), a);
    await row(b).click();
    await row(a).click();
    await expect(worker(a).getByLabel("Message", { exact: true })).toBeEnabled();
    await worker(a).getByLabel("Message", { exact: true }).fill("Continue with tests");
    await worker(a).getByRole("button", { name: "Send", exact: true }).click();
    await expect(worker(a).getByLabel("Message", { exact: true })).toHaveValue("");
    await expect(worker(a).locator(".event.prompt").last()).toContainText("Continue with tests");
    await expect(
      worker(a).locator(".event.message").filter({ hasText: "before approval" }),
    ).toHaveCount(1);

    for (const theme of ["light", "dark"]) {
      await selectSettingsPage(page, "Appearance");
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await selectSidebarPage(page, "Chat");
      await expectComposerShadow(worker(a).locator(".composer"));
      await expect(worker(a).locator(".event.message").first()).toHaveCSS(
        "border-top-width",
        "0px",
      );
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 650),
    );
    await page.evaluate(() => {
      for (const role of ["button", "human", "agent", "text"])
        document.documentElement.style.setProperty(`--${role}-size`, "32px");
    });
    await expect(worker(a)).toBeVisible();
    const panelToggle = page.getByRole("button", { name: "Toggle files panel" });
    if ((await panelToggle.getAttribute("aria-expanded")) !== "true") await panelToggle.click();
    const workerDraft = worker(a).getByLabel("Message", { exact: true });
    await workerDraft.fill("A multiline worker draft.\nKeep the entire composer visible.");
    await expectStackedComposer(worker(a));
    const workerTranscript = worker(a).locator(".transcript");
    const beforeScroll = await page.locator(".chat-workspace-body").evaluate((el) => el.scrollTop);
    const transcriptScroll = await workerTranscript.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(transcriptScroll).toBeGreaterThan(0);
    expect(await page.locator(".chat-workspace-body").evaluate((el) => el.scrollTop)).toBe(
      beforeScroll,
    );
    await page.screenshot({ path: join(root, "test-results", "worker-chat-hierarchy.png") });
    expect(errors).toEqual([]);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: project search, shared transcripts, and saved filters", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-project-pages-"));
  const repo = join(directory, "recorded-project");
  const other = join(directory, "other-project");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["init", "-q", other]);
  const records = join(repo, ".git", "code60", "runs");
  const samples = [
    { id: "record-a", agent: "codex", turns: 2, day: "01" },
    { id: "record-b", agent: "claude", turns: 1, day: "02" },
    { id: "zero", agent: "codex", turns: 0, day: "03" },
    { id: "corrupt", agent: "claude", turns: 1, day: "04" },
    { id: "missing", agent: "codex", turns: 1, day: "05" },
  ];
  for (const sample of samples) {
    const folder = join(records, sample.id);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "run.json"),
      JSON.stringify({
        ...sample,
        status: "finished",
        firstPrompt: "Review parser",
        base: null,
        branch: null,
        worktree: repo,
        ownerPid: 1,
        startedAt: `2026-11-${sample.day}T12:00:00Z`,
      }),
    );
    if (sample.id === "missing") continue;
    const events = Array.from({ length: sample.turns }, (_, turn) => [
      {
        runId: sample.id,
        type: "prompt",
        turn: turn + 1,
        text: `Review parser ${turn + 1}`,
        at: `2026-11-${sample.day}T12:0${turn}:00Z`,
      },
      {
        runId: sample.id,
        type: "thought",
        text: "Inspect syntax tree",
        at: `2026-11-${sample.day}T12:0${turn}:01Z`,
      },
      {
        runId: sample.id,
        type: "message",
        text: `Parser fixed for ${sample.id}`,
        at: `2026-11-${sample.day}T12:0${turn}:02Z`,
      },
      {
        runId: sample.id,
        type: "status",
        status: "idle",
        at: `2026-11-${sample.day}T12:0${turn}:06Z`,
      },
    ]).flat();
    await writeFile(
      join(folder, "events.jsonl"),
      sample.id === "corrupt"
        ? "not-json\n"
        : events.map((event) => JSON.stringify(event)).join("\n"),
    );
  }
  await mkdir(join(records, "bad-record"));
  await writeFile(join(records, "bad-record", "run.json"), "invalid");
  application = await launch(directory, repo, join(directory, "projects.sqlite"));
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (entry) => {
      if (
        entry.type() === "error" &&
        !entry.text().includes("Could not read events.jsonl") &&
        !entry.text().includes("Invalid events.jsonl")
      )
        errors.push(entry.text());
    });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await application.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
        }
      )._invokeHandlers;
      const original = handlers.get("desktop:action");
      if (!original) throw new Error("Missing action handler");
      const counts: Record<string, number> = {};
      (globalThis as unknown as { transcriptReads: Record<string, number> }).transcriptReads =
        counts;
      handlers.set("desktop:action", async (...args: unknown[]) => {
        const action = args[1] as { type: string; id: string };
        if (action.type === "events") counts[action.id] = (counts[action.id] ?? 0) + 1;
        return original(...args);
      });
    });
    // Instrument before opening: the footer shares history with Search, Messages and Events.
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectSidebarPage(page, "Sessions");
    await expect(page.locator("#panel-sessions .sessions-grid tbody [role='row']")).toHaveCount(5);
    await page.locator(".sidebar-search").click();
    const search = page.locator("#panel-search");
    const query = search.getByLabel("Query", { exact: true });
    const type = search.getByLabel("Type", { exact: true });
    const sort = search.getByLabel("Sort", { exact: true });
    const submitSearch = search.getByRole("button", { name: "Search", exact: true });
    const pendingLabel = "Unapplied Search Changes";
    const pending = search.getByRole("img", { name: pendingLabel, exact: true });
    const pendingTip = page.getByRole("tooltip").filter({ hasText: pendingLabel });
    await expect(type).toBeVisible();
    await expect(sort).toBeVisible();
    await expect(type).toHaveCSS("border-radius", "0px");
    await expect(sort).toHaveCSS("border-radius", "0px");
    const [buttonBox, typeBox, sortBox] = await Promise.all(
      [submitSearch, type, sort].map((control) => control.boundingBox()),
    );
    if (!buttonBox || !typeBox || !sortBox) throw new Error("Missing search controls");
    expect(typeBox.x).toBeGreaterThan(buttonBox.x + buttonBox.width);
    expect(sortBox.x).toBeGreaterThan(typeBox.x + typeBox.width);
    expect(typeBox.y).toBeLessThan(buttonBox.y + buttonBox.height);
    await expect(search.getByText("Type", { exact: true })).toHaveCount(0);
    await expect(search.getByText("Sort", { exact: true })).toHaveCount(0);
    await expect(search.getByText("Code60", { exact: true })).toHaveCount(0);
    const entryBox = await search.locator(".search-entry").boundingBox();
    const pageBox = await search.boundingBox();
    if (!entryBox || !pageBox) throw new Error("Missing search entry");
    expect(entryBox.width).toBeLessThanOrEqual(560);
    expect(Math.abs(entryBox.x + entryBox.width / 2 - pageBox.x - pageBox.width / 2)).toBeLessThan(
      2,
    );
    expect(entryBox.y + entryBox.height / 2).toBeGreaterThan(pageBox.y + pageBox.height / 2);
    await page.screenshot({ path: join(root, "test-results", "search-entry.png") });
    await sort.selectOption("newest");
    await query.fill("parser fixed");
    await expect(search.locator(".search-results li")).toHaveCount(0);
    const searchContent = search.locator(".search-content");
    await searchContent.evaluate((element) => {
      const recordFade = (event: Event) => {
        if (
          event instanceof TransitionEvent &&
          event.propertyName === "opacity" &&
          event.target instanceof HTMLElement &&
          event.target.matches(".search-placeholders[hidden]")
        ) {
          element.setAttribute("data-skeleton-faded", "");
          element.removeEventListener("transitionrun", recordFade);
        }
      };
      element.addEventListener("transitionrun", recordFade);
    });
    await query.press("Enter");
    await expect(query).toBeFocused();
    await expect(query).toHaveCSS("outline-color", "rgba(0, 0, 0, 0)");
    await expect(query).toHaveCSS("box-shadow", /4px/);
    await expect
      .poll(async () => (await query.boundingBox())?.y ?? Infinity)
      .toBeLessThan(entryBox.y - 40);
    expect((await query.boundingBox())?.y).toBeGreaterThan(pageBox.y + 70);
    const results = search.locator(".search-results li");
    await expect(results).toHaveCount(3);
    await expect(search.getByText(/^Results for /)).toHaveCount(0);
    await expect(search.getByText("All types · Newest", { exact: true })).toHaveCount(0);
    await expect(results.first().locator(".search-result-meta")).not.toContainText("Message");
    const submittedResults = await results.allTextContents();
    const overview = search.getByRole("region", { name: "AI overview", exact: true });
    await expect(overview).toContainText("The recorded sessions report");
    await expect(overview).toHaveCSS("animation-name", "search-result-reveal");
    await expect(searchContent).toHaveAttribute("data-skeleton-faded", "");
    const summaryBox = await overview.boundingBox();
    const resultsBox = await search.locator(".search-results").boundingBox();
    if (!summaryBox || !resultsBox) throw new Error("Missing results layout");
    expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(resultsBox.y);
    await expect(search.locator(".search-preview")).toHaveCount(0);
    await page.screenshot({ path: join(root, "test-results", "search-expanded.png") });
    const originalTheme = await page.locator("html").getAttribute("data-color-scheme");
    await page.evaluate(() => {
      document.documentElement.dataset.colorScheme = "dark";
    });
    await expect(search.locator(".search-page")).toHaveCSS("color", "rgb(255, 255, 255)");
    await page.screenshot({ path: join(root, "test-results", "search-dark.png") });
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setMinimumSize(0, 0);
      window?.setSize(680, 720);
    });
    const originalText = await page.evaluate(() => {
      const style = document.documentElement.style;
      const original = ["--text-size", "--title-size", "--button-size"].map((key) => [
        key,
        style.getPropertyValue(key),
      ]);
      style.setProperty("--text-size", "24px");
      style.setProperty("--title-size", "28px");
      style.setProperty("--button-size", "24px");
      return original;
    });
    await expect(search.locator(".search-overview-text")).toHaveCSS("font-size", "24px");
    expect(
      await search
        .locator(".search-page")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(
      await search
        .locator(".search-content")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: join(root, "test-results", "search-narrow-large-text.png") });
    await page.evaluate((properties) => {
      for (const [key, value] of properties) {
        if (key && value) document.documentElement.style.setProperty(key, value);
        else if (key) document.documentElement.style.removeProperty(key);
      }
    }, originalText);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 860),
    );
    await page.evaluate((theme) => {
      if (theme) document.documentElement.dataset.colorScheme = theme;
      else delete document.documentElement.dataset.colorScheme;
    }, originalTheme);
    await expect(
      search.getByText("2 transcripts unavailable. Results are incomplete."),
    ).toBeVisible();

    // Draft edits and filters leave the submitted result set and overview intact.
    await query.fill("not yet submitted");
    await expect(pending).toBeVisible();
    await expect(pendingTip).toHaveCount(0);
    await pending.hover();
    await expect(pendingTip).toHaveText(pendingLabel);
    await page.screenshot({ path: "test-results/search-unapplied-tooltip.png" });
    await sort.hover();
    await expect(pendingTip).toHaveCount(0);
    await sort.focus();
    await page.keyboard.press("Tab");
    await expect(pending).toBeFocused();
    await expect(pendingTip).toHaveText(pendingLabel);
    await page.keyboard.press("Escape");
    await expect(pendingTip).toHaveCount(0);
    await type.selectOption("thought");
    await sort.selectOption("relevance");
    await expect(overview).toContainText("The recorded sessions report");
    await expect(results).toHaveText(submittedResults);
    await query.fill("parser fixed");
    await type.selectOption("all");
    await sort.selectOption("newest");
    await expect(pending).toHaveCount(0);
    await expect(pendingTip).toHaveCount(0);
    await type.selectOption("thought");
    await sort.selectOption("relevance");
    await query.press("Enter");
    await expect(pending).toHaveCount(0);
    await expect(overview).toContainText("The recorded sessions report");
    await expect(search.locator(".search-results li")).toHaveCount(3);
    await type.selectOption("message");
    await search.getByRole("button", { name: "Search", exact: true }).click();
    await expect(pending).toHaveCount(0);
    await expect(overview).toContainText("The recorded sessions report");

    await expectActionFocus(page, [
      search.locator(".search-result-title").first(),
      overview.getByRole("button", { name: /^Source 1:/ }),
    ]);
    // A citation opens the exact captured source through existing event navigation.
    await overview.getByRole("button", { name: /^Source 1:/ }).click();
    await expect(page.locator(".event.search-match")).toContainText("Parser fixed");
    await selectSidebarPage(page, "Search");
    await expect(overview).toContainText("The recorded sessions report");

    // Simulate a provider failure once; Retry keeps the same results and then succeeds.
    await application.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
        }
      )._invokeHandlers;
      const original = handlers.get("desktop:search-summary");
      if (!original) throw new Error("Missing summary handler");
      handlers.set("desktop:search-summary", async () => {
        handlers.set("desktop:search-summary", original);
        throw new Error("Provider unavailable");
      });
    });
    await query.press("Enter");
    await expect(overview.getByRole("alert")).toContainText("Provider unavailable");
    await expect(search.locator(".search-results li")).toHaveCount(3);
    await type.selectOption("file");
    await overview.getByRole("button", { name: "Retry overview" }).click();
    await expect(overview).toContainText("The recorded sessions report");
    await expect(pending).toBeVisible();
    await type.selectOption("message");

    // The artwork takes the overview's place while Search is working.
    await query.fill("fixed");
    await query.press("Enter");
    const searchLoader = search.locator(".search-loading");
    const searchArt = searchLoader.locator(".search-loading-art");
    const artImage = () =>
      searchArt.evaluate((element) => getComputedStyle(element, "::before").backgroundImage);
    const searchLabel = searchLoader.getByText("Searching...", { exact: true });
    const skeleton = search.locator(".search-skeleton");
    const summarySkeleton = search.locator(".search-summary-skeleton");
    const skeletonBars = skeleton.locator("span");
    await expect(searchLoader).toBeVisible();
    await expect.poll(artImage).toMatch(/search-engine.*\.gif/);
    await expect(searchArt).toHaveCSS("width", "64px");
    await expect(searchLabel).toBeVisible();
    await expect(searchLabel).toHaveCSS("font-size", "18px");
    await expect(searchLabel).toHaveCSS("font-family", /D-DIN/);
    await expect(searchLabel).toHaveCSS("animation-name", "activity-spotlight");
    await expect(skeleton).toBeVisible();
    await expect(skeleton.locator("..")).toHaveAttribute("aria-hidden", "true");
    await expect(summarySkeleton).toBeVisible();
    await expect(summarySkeleton.locator(".search-skeleton-paragraph")).toHaveCount(2);
    await expect(summarySkeleton.locator(".search-skeleton-paragraph > span")).toHaveCount(5);
    const skeletonRows = skeleton.locator("li");
    await expect(skeletonRows).toHaveCount(2);
    for (const row of await skeletonRows.all()) {
      await expect(row.locator("span")).toHaveClass([
        "search-skeleton-timestamp",
        "search-skeleton-title",
        "search-skeleton-snippet",
      ]);
    }
    await expect(skeletonBars.first()).toHaveCSS("animation-name", "search-skeleton-shimmer");
    const [formBox, artBox, labelBox] = await Promise.all(
      [search.locator(".search-entry"), searchArt, searchLabel].map((element) =>
        element.boundingBox(),
      ),
    );
    if (!formBox || !artBox || !labelBox) throw new Error("Missing Search loading layout");
    expect(artBox.y - (formBox.y + formBox.height)).toBeGreaterThanOrEqual(47);
    expect(labelBox.y).toBeGreaterThan(artBox.y + artBox.height);
    expect(labelBox.x + labelBox.width / 2).toBeCloseTo(artBox.x + artBox.width / 2, 0);
    expect(Math.abs(labelBox.x + labelBox.width / 2 - formBox.x - formBox.width / 2)).toBeLessThan(
      8,
    );
    await expect(search.locator(".chat-loader")).toHaveCount(0);
    await expect(overview).toHaveCount(0);
    await expect(search.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await sort.selectOption("newest");
    await expect(pending).toBeVisible();
    await expect.poll(artImage).toMatch(/search-engine.*\.gif/);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(artImage).toBe("none");
    await expect(searchArt.locator(".carbon-icon")).toBeVisible();
    await expect(searchLabel).toHaveCSS("animation-name", "none");
    await expect(skeletonBars.first()).toHaveCSS("animation-name", "none");
    await expect(skeleton.locator("..")).toHaveCSS("transition-duration", "0s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(artImage).toMatch(/search-engine.*\.gif/);
    await expect(searchArt).toHaveCSS("background-color", "rgb(91, 159, 230)");
    await page.screenshot({ path: "test-results/search-loading-art.png" });
    await page.evaluate(() => {
      document.documentElement.dataset.colorScheme = "dark";
    });
    await expect(searchArt).toHaveCSS("background-color", "rgb(119, 183, 245)");
    await expect(searchArt).toHaveCSS("mix-blend-mode", "screen");
    await page.screenshot({ animations: "disabled", path: "test-results/search-loading-dark.png" });
    await page.evaluate((scheme) => {
      if (scheme) document.documentElement.dataset.colorScheme = scheme;
      else delete document.documentElement.dataset.colorScheme;
    }, originalTheme);
    await expect(search.locator(".search-results li")).toHaveCount(3);

    // Clearing an active query cancels it and keeps the selected filters.
    await query.fill("");
    await expect(searchLoader).toHaveCount(0);
    await expect(skeleton).toHaveCount(0);
    await expect(type).toBeVisible();
    await expect(type).toHaveValue("message");
    await expect(sort).toHaveValue("newest");
    await expect(pending).toHaveCount(0);
    await expect
      .poll(async () => (await search.locator(".search-entry").boundingBox())?.y ?? 0)
      .toBeGreaterThan(entryBox.y - 2);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await query.fill("parser fixed");
    await query.press("Enter");
    await expect(search.locator(".search-results li")).toHaveCount(3);
    expect(
      await search
        .locator(".search-page")
        .evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
    await expect(overview).toContainText("The recorded sessions report");
    await expect(searchLoader).toBeHidden();
    await expect(skeleton).toBeHidden();
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // Single-click titles and keyboard actions both open sources without a preview pane.
    await search.locator(".search-result-title").first().click();
    await expect(page.locator(".event.search-match")).toContainText("Parser fixed");
    await selectSidebarPage(page, "Search");
    await query.focus();
    await query.press("ArrowDown");
    await page.keyboard.press("End");
    await expect(search.locator(".search-result-title").last()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(".event.search-match")).toBeFocused();
    await expect(page.locator(".event.search-match")).toContainText("Parser fixed");
    await page.screenshot({
      animations: "disabled",
      path: join(root, "test-results", "theme-chat.png"),
    });
    await selectSidebarPage(page, "Messages");
    await expect(page.locator("#panel-messages .sessions-grid tbody [role='row']")).toHaveCount(9);
    await selectSidebarPage(page, "Events");
    const eventPanel = page.locator("#panel-events");
    await expect(eventPanel.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
    // Glide virtualizes columns; Details is beyond the viewport after the ACP update column.
    await eventPanel.locator(".dvn-scroller").evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(eventPanel.locator(".sessions-grid thead")).toContainText("Tool call ID");
    await expect(eventPanel.locator(".sessions-grid tbody")).toContainText("Parser fixed");
    await expect(
      eventPanel.getByText("2 transcripts unavailable. Results are incomplete."),
    ).toBeVisible();
    await eventPanel.getByRole("button", { name: "Search events", exact: true }).click();
    await expect(eventPanel.getByTestId("search-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Dashboard");
    await expect(page.getByRole("option", { name: "Dashboard", exact: true })).toHaveCount(0);
    await expect(page.locator("#panel-dashboard")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const reads = await application.evaluate(
      () => (globalThis as unknown as { transcriptReads: Record<string, number> }).transcriptReads,
    );
    expect(reads["record-b"]).toBe(1); // Source navigation reuses the shared cache.
    await selectSidebarPage(page, "Sessions");
    const sessions = page.locator("#panel-sessions");
    await sessions.getByRole("button", { name: "Settings", exact: true }).click();
    const tableSettings = page.getByRole("dialog", {
      name: "Sessions table settings",
      exact: true,
    });
    const rowLines = tableSettings.getByRole("switch", { name: "Row lines", exact: true });
    await expect(rowLines).not.toBeChecked();
    await expect(rowLines).toHaveCSS("border-radius", "0px");
    expect(
      await rowLines.evaluate((element) => getComputedStyle(element, "::before").borderRadius),
    ).toBe("0px");
    await tableSettings.getByLabel("Row density").focus();
    await page.keyboard.press("Tab");
    await expect(rowLines).toBeFocused();
    await expect(rowLines).toHaveCSS("outline-color", "rgba(0, 0, 0, 0)");
    await expect(rowLines).toHaveCSS("box-shadow", /1px/);
    await rowLines.check();
    await expect(rowLines).toHaveCSS("border-radius", "0px");
    expect(
      await rowLines.evaluate((element) => getComputedStyle(element, "::before").borderRadius),
    ).toBe("0px");
    const switchState = await rowLines.evaluate(
      (element) => getComputedStyle(element, "::after").content,
    );
    expect(switchState).toContain("ON");
    await rowLines.uncheck();
    await tableSettings.getByRole("button", { name: "Close table settings" }).click();
    await expect(sessions.locator(".data-table")).toHaveAttribute("data-heading-lines", "false");
    const menuCanvas = await sessions.getByTestId("data-grid-canvas").boundingBox();
    if (!menuCanvas) throw new Error("Missing sessions canvas");
    await page.mouse.click(menuCanvas.x + actionsColumnX, menuCanvas.y + 48);
    await expect(page.getByRole("menu")).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: join(root, "test-results", "theme-menu.png"),
    });
    await page.keyboard.press("Escape");

    await sessions.getByRole("button", { name: "Filters", exact: true }).click();
    const filters = page.getByRole("dialog", { name: "Filters", exact: true });
    await filters.getByRole("button", { name: "New filter", exact: true }).click();
    await filters.getByLabel("Filter name").fill("Codex runs");
    await filters.getByLabel("Condition 1 value").fill("codex");
    await expect(filters.getByText("3 matching rows")).toBeVisible();
    await filters.getByRole("button", { name: "Save filter", exact: true }).click();
    await filters.getByRole("button", { name: "Apply filter", exact: true }).click();
    await filters.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sessions.locator(".sessions-grid tbody [role='row']")).toHaveCount(3);
    await sessions.getByLabel("Column menu").selectOption("agent");
    const column = page.getByRole("dialog", { name: "Agent", exact: true });
    await column.getByLabel("Value").selectOption("claude");
    await column.getByRole("button", { name: "Apply filter", exact: true }).click();
    await expect(sessions.locator(".sessions-grid tbody [role='row']")).toHaveCount(0);
    await sessions.getByRole("button", { name: "Clear Agent filter" }).click();
    await expect(sessions.locator(".sessions-grid tbody [role='row']")).toHaveCount(3);
    await sessions.getByRole("button", { name: "Filters: Codex runs", exact: true }).click();
    await filters.getByRole("button", { name: "Edit filter", exact: true }).click();
    await filters.getByLabel("Condition 1 value").fill("claude");
    await filters.getByRole("button", { name: "Save filter", exact: true }).click();
    await expect(filters.getByText("2 matching rows")).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: join(root, "test-results", "theme-filter.png"),
    });
    await filters.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sessions.locator(".sessions-grid tbody [role='row']")).toHaveCount(2);
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await expect(
      sessions.getByRole("button", { name: "Filters: Codex runs", exact: true }),
    ).toBeVisible();
    await expect(sessions.locator(".sessions-grid tbody [role='row']")).toHaveCount(2);
    await sessions.getByRole("button", { name: "Unapply filter", exact: true }).click();
    await expect(sessions.locator(".sessions-grid tbody [role='row']")).toHaveCount(5);
    await sessions.getByRole("button", { name: "Filters", exact: true }).click();
    await filters.getByLabel("Filter definition").selectOption({ label: "Codex runs" });
    await filters.getByRole("button", { name: "Apply filter", exact: true }).click();
    await filters.getByRole("button", { name: "Delete filter", exact: true }).click();
    await filters.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sessions.locator(".sessions-grid tbody [role='row']")).toHaveCount(5);
    for (const tab of [
      "Sessions",
      "Events",
      "Messages",
      "Configurations",
      "Worktrees",
      "Polling",
    ]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(
        page
          .locator(".page-panel:not([hidden])")
          .getByRole("button", { name: "Filters", exact: true }),
      ).toBeVisible();
      const controls = page.locator(".page-panel:not([hidden]) .table-controls");
      await expect(controls.getByRole("group", { name: "Table controls" })).toHaveCount(1);
      await expect(controls).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(".page-panel:not([hidden]) .sessions-toolbar")).toHaveCount(0);
      await controls.screenshot({
        animations: "disabled",
        path: join(
          root,
          "test-results",
          `table-controls-${tab.toLowerCase().replaceAll(" ", "-")}.png`,
        ),
      });
    }
    await selectSidebarPage(page, "Sessions");
    await page.screenshot({ path: join(root, "test-results", "table-sidebar-layout.png") });
    // Table toolbars are borderless icon actions named by their accessible labels and tooltips.
    const slots = sessions.getByRole("group", { name: "Table controls" });
    await expect(
      slots.locator(":scope > button:not(.icon-button, .table-add-accessible, .filter-chip)"),
    ).toHaveCount(0);
    await expect(slots).toHaveCSS("border-top-width", "0px");
    const filtersTrigger = slots.getByRole("button", { name: "Filters", exact: true });
    await expect(filtersTrigger.locator("svg")).toHaveCount(1);
    await expect(filtersTrigger).toHaveText("");
    await filtersTrigger.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Filters");
    await slots.screenshot({ path: join(root, "test-results", "table-toolbar-icons.png") });
    // The focused native select carries the tooltip, so keyboard users see it too.
    const columnMenu = slots.getByLabel("Column menu");
    await columnMenu.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(columnMenu).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("Column filter and sort");
    await filtersTrigger.click();
    await expect(filters).toBeVisible();
    await filters.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(".sidebar-search").click();
    await search.getByLabel("Query", { exact: true }).fill("parser");
    await query.press("Enter");
    await expect(
      search.getByText("2 transcripts unavailable. Results are incomplete."),
    ).toBeVisible();
    await writeFile(join(records, "corrupt", "events.jsonl"), "");
    await writeFile(join(records, "missing", "events.jsonl"), "");
    await search.getByRole("button", { name: "Retry reads" }).click();
    await expect(search.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: join(root, "test-results", "theme-search.png"),
    });
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setMinimumSize(640, 480);
      window?.setSize(760, 650);
    });
    await page.screenshot({
      animations: "disabled",
      path: join(root, "test-results", "theme-search-narrow.png"),
    });
    await query.fill("");
    await expect(search.locator(".search-page")).toHaveAttribute("data-expanded", "false");
    await page.screenshot({
      animations: "disabled",
      path: join(root, "test-results", "search-entry-narrow.png"),
    });
    await query.fill("parser");
    await selectSidebarPage(page, "Sessions");
    await sessions.locator(".table-controls").screenshot({
      animations: "disabled",
      path: join(root, "test-results", "table-controls-narrow.png"),
    });
    await sessions.getByRole("button", { name: "Filters", exact: true }).click();
    await filters.getByRole("button", { name: "New filter", exact: true }).click();
    await page.screenshot({
      animations: "disabled",
      path: join(root, "test-results", "theme-filter-narrow.png"),
    });
    await filters.getByRole("button", { name: "Close", exact: true }).click();
    // Hold an old-project result after the validated read, then switch while it is pending.
    await application.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
        }
      )._invokeHandlers;
      const original = handlers.get("desktop:action");
      if (!original) throw new Error("Missing handler");
      handlers.set("desktop:action", async (...args: unknown[]) => {
        const result = await original(...args);
        if ((args[1] as { type: string }).type === "events")
          await new Promise((resolve) => setTimeout(resolve, 600));
        return result;
      });
    });
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await page.locator(".sidebar-search").click();
    await search.getByLabel("Query", { exact: true }).fill("parser");
    await search.getByLabel("Query", { exact: true }).press("Enter");
    await expect(search.getByText("Loading saved transcripts…")).toBeVisible();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, other);
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await expectSelectedProject(page, other);
    await search.getByLabel("Query", { exact: true }).fill("parser");
    await search.getByLabel("Query", { exact: true }).press("Enter");
    await expect(search.getByRole("region", { name: "AI overview" })).toContainText(
      "Only the project identity is available",
    );
    await page.waitForTimeout(700);
    await expect(search.locator(".search-results li")).toHaveCount(1);
    await expect(search.locator(".search-result-title")).toHaveText("other-project");
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: project questions use files without saved sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-project-question-"));
  const repo = join(directory, "palette-project");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "A color wheel for building accessible palettes.");
  application = await launch(directory, repo, join(directory, "projects.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    // Opening a project remounts Search; wait for the renderer to apply that workspace.
    await expectSelectedProject(page, repo);
    await selectSidebarPage(page, "Search");
    const search = page.locator("#panel-search");
    await search.getByLabel("Query", { exact: true }).fill("What is this project about?");
    await search.getByLabel("Query", { exact: true }).press("Enter");
    const overview = search.getByRole("region", { name: "AI overview", exact: true });
    await expect(overview).toContainText("accessible palettes");
    await expect(
      search.locator(".search-result-title").filter({ hasText: "README.md" }),
    ).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).runs).toHaveLength(0);
    await overview.getByRole("button", { name: /^Source \d+: README.md/ }).click();
    await expect(page.locator("#tab-chat")).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("complementary", { name: "File preview", exact: true }),
    ).toContainText("README.md");
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: MCP badges, saved attribution and Server table controls", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-mcp-ui-"));
  const repo = join(directory, "repo");
  const config = join(directory, "config", "code60");
  await mkdir(config, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "hello.txt"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  commitFixture(repo);
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      agents: {
        claude: { command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs")] },
      },
    }),
  );
  try {
    application = await launch(directory, repo, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1000, height: 650 });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    const [id] = await page.evaluate(() =>
      window.desktop.start({
        agents: ["claude"],
        allow: [],
        allowAll: false,
        prompt: JSON.stringify([
          {
            tool: {
              id: "docs",
              title: "Query docs",
              kind: "fetch",
              _meta: { claudeCode: { toolName: "mcp__context7__query-docs" } },
            },
          },
          { toolUpdate: { id: "docs", status: "completed" } },
          {
            tool: {
              id: "browser",
              title: "Snapshot",
              kind: "other",
              _meta: { claudeCode: { toolName: "mcp__playwright__browser_snapshot" } },
            },
          },
          { toolUpdate: { id: "browser", status: "completed" } },
          { tool: { id: "ordinary", title: "MCP playwright", kind: "read" } },
          { message: "done" },
        ]),
      }),
    );
    if (!id) throw new Error("Missing MCP fixture run");
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.snapshot()).runs[0]?.view?.status),
      )
      .toBe("idle");
    await selectSidebarPage(page, "Chat");
    await page.locator("#tab-chat").press("ArrowRight");
    await page.locator(`#conversation-${id}`).click();
    const chat = page.locator(".worker-chat-page:visible");
    for (const disclosure of await chat.locator(".chat-activity > summary").all())
      await disclosure.click();
    await expect(chat.locator(".mcp-badge")).toHaveCount(2);
    await expect(
      chat.getByRole("note", { name: "MCP server: context7", exact: true }),
    ).toBeVisible();
    await chat.screenshot({ path: test.info().outputPath("mcp-attribution.png") });
    // Keep this unowned worker idle, since finished unowned workers are hidden.
    await page.reload();
    await selectSidebarPage(page, "Chat");
    await page.locator("#tab-chat").press("ArrowRight");
    await page.locator(`#conversation-${id}`).click();
    await expect(page.locator(".worker-chat-page:visible .mcp-badge")).toHaveCount(2);
    await selectSidebarPage(page, "Events");
    const events = page.locator("#panel-events");
    await events.getByLabel("Column menu").selectOption("server");
    const column = page.getByRole("dialog", { name: "Server", exact: true });
    await column.getByLabel("Value").selectOption("context7");
    await column.getByRole("button", { name: "Apply filter", exact: true }).click();
    await expect(events.locator(".sessions-grid tbody [role='row']")).toHaveCount(2);
    await events.getByRole("button", { name: "Clear Server filter" }).click();
    await events.getByLabel("Column menu").selectOption("server");
    await column.getByRole("button", { name: "Sort descending", exact: true }).click();
    // Glide omits offscreen columns from its accessibility tree on small native CI displays.
    await scrollGrid(events, 850);
    await expect(events.locator(".sessions-grid thead")).toContainText("Server");
    await expect(events.locator(".sessions-grid tbody [role='row']").first()).toContainText(
      "playwright",
    );
    await events.getByLabel("Column menu").selectOption("server");
    await column.getByLabel("Value").selectOption("playwright");
    await column.getByRole("button", { name: "Apply filter", exact: true }).click();
    await expect(events.locator(".sessions-grid tbody [role='row']")).toHaveCount(2);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Chat landing, automatic ACP conversation, navigation, cancellation, and stopped startup", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-chat-page-"));
  const firstProject = join(directory, "first-project");
  const secondProject = join(directory, "second-project");
  const database = join(directory, "projects.sqlite");
  const workspace = join(directory, ".code60_workspace");
  const config = join(directory, "config", "code60", "config.json");
  await mkdir(firstProject);
  await mkdir(secondProject);
  await mkdir(dirname(config), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      agents: {
        claude: { command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs")] },
        broken: { command: [process.execPath, "-e", "process.exit(2)"] },
      },
    }),
  );
  try {
    application = await launch(directory, firstProject, database);
    let page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    const advanced = page.getByRole("button", { name: "Advanced", exact: true });
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    const advancedPages = page.locator("#advanced-pages");
    const experiments = page.getByRole("button", { name: "Experiments", exact: true });
    await expect(advancedPages).toBeHidden();
    await expect(page.getByRole("heading", { name: "Give Code60 a task." })).toBeVisible();
    await expect(page.locator("#panel-chat .wordmark")).toHaveCount(0);
    const settings = page.getByRole("tab", { name: "Settings", exact: true });
    const settingsPages = page.getByRole("tab", { name: "Settings", exact: true });
    await expect(settingsPages).toHaveAttribute("aria-expanded", "false");
    await expect(advanced).toBeHidden();
    const settingsHeading = page.locator(".sidebar-settings-heading");
    const settingsFills = await settings.evaluate((element) => {
      const probe = document.createElement("span");
      element.append(probe);
      probe.style.backgroundColor = "var(--hover-bg)";
      const hover = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = "var(--accent-bg)";
      const active = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = "var(--control-fill)";
      const resting = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { hover, active, resting };
    });
    // The drag strip can retain stale native hover, so reset the pointer into the footer.
    const resetPointer = async () => {
      const corner = await page.evaluate(() => ({ x: innerWidth - 2, y: innerHeight - 2 }));
      await page.mouse.move(corner.x, corner.y);
    };
    const expectSettingsHover = async (control: Locator) => {
      await expect(async () => {
        await page.bringToFront();
        await resetPointer();
        await control.hover();
        await expect(settingsHeading).toHaveCSS("background-color", settingsFills.hover, {
          timeout: 500,
        });
        await expect(settings).toHaveCSS("background-color", settingsFills.hover, {
          timeout: 500,
        });
      }).toPass({ timeout: 5_000 });
    };
    await expectSettingsHover(settings);
    await expectSettingsHover(settingsPages);
    await settings.click();
    await expect(settingsPages).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#tab-settings-agents")).toHaveAttribute("aria-selected", "true");
    await expectNavigationHighlight(page, page.locator("#tab-settings-agents").locator(".."));
    await expect(page.locator(".chat-sidebar-entry[aria-current='true']")).toHaveCount(0);
    await resetPointer();
    await expect(page.locator("#tab-settings-agents")).toHaveCSS(
      "background-color",
      settingsFills.active,
    );
    await expect(settingsPages).toHaveCSS("background-color", settingsFills.resting);
    await expectSettingsHover(settingsPages);
    await settings.click();
    await expect(settingsPages).toHaveAttribute("aria-expanded", "false");
    await expect(advanced).toBeHidden();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    await settings.press("ArrowRight");
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await settings.press("ArrowRight");
    await expect(page.locator("#tab-settings-agents")).toBeFocused();
    await page.locator("#tab-settings-agents").press("ArrowLeft");
    await expect(settingsPages).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#panel-settings-agents")).toBeVisible();
    await settings.press("ArrowRight");
    await advanced.focus();
    await advanced.press("ArrowRight");
    await expect(advancedPages).toHaveText("ExperimentsEpisodic MemoryRAGContributor Tools");
    await expect(advancedPages).toBeVisible();
    await expect(page.locator("#panel-settings-agents")).toBeVisible();
    await advanced.press("ArrowLeft");
    await expect(advancedPages).toBeHidden();
    await expect(advanced).toBeFocused();
    await advanced.press("Enter");
    await expect(advancedPages).toBeVisible();
    await advanced.press("Space");
    await expect(advancedPages).toBeHidden();
    await advanced.click();
    await advanced.press("ArrowDown");
    await expect(experiments).toBeFocused();
    await experiments.press("ArrowRight");
    await experiments.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Episodic Memory", exact: true })).toBeFocused();
    await expect(page.locator("#panel-episodic-memory")).toBeVisible();
    await expectNavigationHighlight(page, page.locator("#tab-episodic-memory").locator(".."));
    await expect(page.getByRole("tab", { name: "Episodic Memory", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(experiments).toBeFocused();
    await advanced.press("Home");
    await expect(page.getByRole("tab", { name: "Home", exact: true })).toBeFocused();
    await page.reload();
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(advancedPages).toBeVisible();
    await advanced.click();
    await settingsPages.press("ArrowLeft");
    await expect(advanced).toBeHidden();
    const tables = page.getByRole("button", { name: "Data Viewer", exact: true });
    await expect(tables).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("tab")).toHaveText([
      "Home",
      "Projects",
      "Automations",
      "Apps",
      "Command Builder",
      "Prompt Builder",
      "Settings",
    ]);
    await tables.press("ArrowRight");
    await expect(tables).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tab")).toHaveText([
      "Home",
      "Projects",
      "Automations",
      "Apps",
      "Command Builder",
      "Configurations",
      "Events",
      "Logs",
      "Memories",
      "Messages",
      "Polling",
      "Sessions",
      "Worktrees",
      "Prompt Builder",
      "Settings",
    ]);
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await page.keyboard.press("ArrowLeft");
    await expect(tables).toBeFocused();
    await expect(tables).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#panel-sessions")).toBeVisible();
    await expectNavigationHighlight(page, tables.locator(".."));
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Sessions");
    await page.keyboard.press("Enter");
    await expect(tables).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tab", { name: "Sessions", exact: true })).toBeFocused();
    await page.screenshot({ path: "test-results/sidebar-tables-expanded.png" });
    await tables.click();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    await selectProjectConversation(page);
    await expect(tables).toHaveAttribute("aria-expanded", "false");
    let chat = page.locator("#panel-chat .orchestration-chat-page:visible");
    await expect(chat.locator(".activity-display")).toHaveCount(0);
    const first = await page.evaluate(() => window.desktop.snapshot());
    const id = first.chat.run?.id as string;
    // This lifecycle scenario uses stable manual names; generated titles are covered separately.
    await page.evaluate(
      (id) => window.desktop.orchestrationChatAction({ type: "rename", id, title: "Chat 1" }),
      id,
    );
    expect(dirname(first.chat.directory as string).startsWith(join(workspace, "projects"))).toBe(
      true,
    );
    expect(first.runs).toEqual([]);
    const chatList = () => page.locator(".project-chat-group nav.chat-sidebar");
    await page.locator("#tab-chat").press("ArrowRight");
    await expect(chatList()).toBeVisible();
    await expect(chat.getByRole("heading", { name: "Give Code60 a task." })).toBeVisible();
    expect(
      await page
        .locator("body *")
        .evaluateAll((elements) =>
          elements
            .filter(
              (element) =>
                element.getClientRects().length > 0 &&
                Number(getComputedStyle(element).fontWeight) > 400,
            )
            .map((element) => element.tagName),
        ),
    ).toEqual([]);
    await expect(chat.locator(".wordmark")).toHaveCount(0);
    await page.screenshot({ path: "test-results/chat-empty.png" });
    await expect(chat.getByRole("combobox", { name: "Orchestrator chat" })).toHaveCount(0);
    const columns = await page.evaluate(() => {
      const rect = (selector: string) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        if (!box) throw new Error(`Missing layout column: ${selector}`);
        return { left: box.left, right: box.right };
      };
      return [rect(".sidebar"), rect(".chat-sidebar"), rect("#panel-chat")];
    });
    expect(columns[0]?.right).toBeGreaterThan(columns[1]?.right ?? 0);
    expect(columns[1]?.right).toBeLessThan(columns[2]?.left ?? 0);
    await expect(chatList().getByRole("button", { name: "Chat 1", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expectNavigationHighlight(
      page,
      chatList().getByRole("button", { name: "Chat 1", exact: true }).locator(".."),
    );
    await expect(page.locator(".chat-page-heading[data-nav-active='true']")).toHaveCount(0);
    const input = () =>
      chat.getByRole("combobox", { name: "Message to orchestrator", exact: true });
    await input().fill("hello from Chat");
    await input().press("Enter");
    await expect(chat.locator(".event.message .chat-markdown")).toHaveText("ok");
    await expect(chat.locator(".wordmark")).toHaveCount(0);
    await expect(chat.locator(".orchestration-chat-status")).not.toContainText("claude");
    const provider = chat.getByRole("img", { name: "Current provider: Claude", exact: true });
    await expect(provider.locator("img")).toHaveAttribute("width", "20");
    expect(await provider.evaluate((element) => element.closest(".composer") !== null)).toBe(true);
    await expect(chat.locator(".event.message .chat-message-speaker")).toHaveCount(0);
    await expect(chat.locator(".event.message")).toHaveCSS("border-top-width", "0px");
    await expect(input()).toHaveValue("");
    const script = JSON.stringify([
      { message: "alpha" },
      { sleep: 100 },
      { thought: "checking" },
      {
        tool: {
          id: "mcp-docs",
          title: "Query documentation",
          kind: "fetch",
          _meta: { claudeCode: { toolName: "mcp__context7__query-docs" } },
        },
      },
      { toolUpdate: { id: "mcp-docs", status: "completed" } },
      { permission: { id: "edit-1", title: "Edit workspace", kind: "edit" } },
      { write: { path: "marker.txt", content: "kept across launches" } },
      { message: "omega" },
    ]);
    await input().fill(script);
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input().press("Enter");
    await expect(chat.locator(".event.permission")).toContainText("allowed by policy");
    await expect(chat.locator(".activity-display")).toHaveCount(0);
    await expect(chat.locator(".event.thought pre")).not.toBeVisible();
    await chat.locator(".activity-history-toggle").last().click();
    await expect(chat.locator(".event.thought pre")).toBeVisible();
    await expect(chat.locator(".event.thought pre")).toHaveText("checking");
    await expect(
      chat.getByRole("note", { name: "MCP server: context7", exact: true }),
    ).toBeVisible();
    await expect(chat.locator(".mcp-badge")).toHaveText("MCP");
    await chat.locator(".activity-history-toggle").last().click();
    expect(await readFile(join(first.chat.directory as string, "marker.txt"), "utf8")).toBe(
      "kept across launches",
    );
    await input().fill("draft retained");
    const newChat = page.getByRole("button", { name: /^New chat in / });
    await expect(newChat).toHaveText("");
    await expect(newChat.locator("svg")).toHaveCount(1);
    await expect(chatList().getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
    const plus = await newChat.boundingBox();
    const projectToggle = newChat.locator("..").locator(".project-chat-name");
    const chevron = await projectToggle.boundingBox();
    expect((chevron?.x ?? 0) + (chevron?.width ?? 0)).toBeLessThanOrEqual(plus?.x ?? 0);
    expect((plus?.y ?? 0) + (plus?.height ?? 0) / 2).toBeCloseTo(
      (chevron?.y ?? 0) + (chevron?.height ?? 0) / 2,
      0,
    );
    await page.locator("#tab-chat").click();
    await expect(chatList()).toBeHidden();
    await expect(newChat).toBeHidden();
    await page.locator("#tab-chat").click();
    await projectToggle.click();
    await expect(chatList()).toBeHidden();
    await expect(newChat).toBeVisible();
    await newChat.click();
    await expect(chatList()).toBeVisible();
    await expect(chat.locator(".activity-display")).toHaveCount(0);
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.desktop.snapshot());
        return Boolean(snapshot.chat.run?.id && snapshot.chat.run.id !== id);
      })
      .toBe(true);
    const secondChat = await page.evaluate(() => window.desktop.snapshot());
    const secondId = secondChat.chat.run?.id as string;
    await page.evaluate(
      (id) => window.desktop.orchestrationChatAction({ type: "rename", id, title: "Chat 2" }),
      secondId,
    );
    expect(secondId).not.toBe(id);
    expect(secondChat.chat.directory).not.toBe(first.chat.directory);
    expect(secondChat.chats.filter((chat) => chat.kind === "project")).toHaveLength(2);
    await expect(chat.locator(".event.prompt, .event.message")).toHaveCount(0);
    await input().fill("second conversation");
    await input().press("Enter");
    await expect(chat.locator(".event.message .chat-markdown")).toHaveText("ok");
    await input().fill("second draft");
    await chatList().getByRole("button", { name: "Chat 1", exact: true }).click();
    await expect(input()).toHaveValue("draft retained");
    await expect(chat.locator(".event.prompt")).toHaveCount(2);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(chatList()).toBeVisible();
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    await expect(input()).toHaveValue("draft retained");
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, secondProject);
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.kind).toBe("relay");
    await page.evaluate(
      (projectId) => window.desktop.projectAction({ type: "select", projectId }),
      first.projectInstanceId as string,
    );
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(id);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(input()).toHaveValue("draft retained");
    await expect(chat.locator(".event.message .chat-markdown").first()).toHaveText("ok");
    await expect(chat.locator(".event.prompt")).toHaveCount(2);
    await chatList().getByRole("button", { name: "Chat 2", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(chatList().getByRole("button", { name: "Chat 2", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(input()).toHaveValue("second draft");
    await expect(chat.locator(".event.prompt")).toHaveCount(1);
    await chatList().getByRole("button", { name: "Chat 1", exact: true }).click();
    await expect(input()).toHaveValue("draft retained");
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(id);
    await input().fill(
      JSON.stringify([{ sleep: 1500 }, { message: "waiting" }, { hang: "cancellable" }]),
    );
    await input().press("Enter");
    await expect(chat.getByRole("status")).toHaveText("Working...");
    await expect(chat.locator(".chat-loader")).toHaveCount(0);
    const activeCard = chatList().getByRole("button", {
      name: "Chat 1",
      exact: true,
    });
    const idleCard = chatList().getByRole("button", {
      name: "Chat 2",
      exact: true,
    });
    await expect(chatList().locator(".chat-loader")).toHaveCount(0);
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    const activityName = chat.locator(".activity-name");
    await expect(activityName).toHaveCSS("font-weight", "400");
    await expect(activityName).toHaveCSS("font-size", "13px");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(activityName).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(chat.getByRole("status")).toHaveText("Responding...");
    const composer = chat.getByRole("region", { name: "Chat composer" });
    await expect(composer).toHaveCSS("border-radius", "0px");
    await idleCard.click();
    await expect(chatList().locator(".chat-loader")).toHaveCount(0);
    await activeCard.click();
    await expect(activityName).toBeVisible();

    for (const [theme, neutral, bubble, text] of [
      ["light", "rgb(255, 255, 255)", "rgb(91, 159, 230)", "rgb(0, 0, 0)"],
      ["dark", "rgb(15, 23, 42)", "rgb(119, 183, 245)", "rgb(255, 255, 255)"],
      ["system", "rgb(255, 255, 255)", "rgb(91, 159, 230)", "rgb(0, 0, 0)"],
      ["system", "rgb(15, 23, 42)", "rgb(119, 183, 245)", "rgb(255, 255, 255)"],
    ] as const) {
      await page.emulateMedia({ colorScheme: neutral === "rgb(255, 255, 255)" ? "light" : "dark" });
      await selectSettingsPage(page, "Appearance");
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await selectSidebarPage(page, "Chat");
      await expect(composer).toHaveCSS("border-top-width", "1px");
      await expect(composer).not.toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
      await expect(composer).toHaveCSS("background-color", neutral);
      await expect(page.locator(".sidebar")).toHaveCSS("background-color", neutral);
      await expectComposerShadow(composer);
      await expect(chat.locator(".event.prompt pre").first()).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(chat.locator(".event.prompt pre").first()).toHaveCSS("border-top-color", bubble);
      await expect(chat.locator(".event.prompt pre").first()).toHaveCSS("color", text);
      await expect(chat.locator(".event.message").first()).toHaveCSS("border-top-width", "0px");
      const beforeFocus = await composer.boundingBox();
      await input().focus();
      await expectChatBorder(composer);
      expect(await composer.boundingBox()).toEqual(beforeFocus);
      await expect(input()).toHaveCSS("outline-width", "0px");
      await expect(chat.locator(".chat-loader")).toHaveCount(0);
      await page.screenshot({ path: `test-results/chat-activity-${theme}.png` });
      await chat.getByRole("button", { name: "Stop", exact: true }).focus();
      await expectChatBorder(composer);
      await selectSidebarPage(page, "Chat");
      await expectComposerShadow(composer);
    }
    await page.emulateMedia({ forcedColors: "active" });
    await input().focus();
    await expectChatBorder(composer, "Highlight");
    await expect(chat.locator(".event.message").first()).toHaveCSS("border-top-width", "0px");
    await page.emulateMedia({ forcedColors: "none" });

    await expect(chat.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(chat.locator(".chat-progress")).toHaveText("Cancelled");
    await expect(chatList().locator(".chat-loader")).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.updates.paused).toBe(true);
    await expect(chat.getByText(/worker updates are paused/)).toHaveCount(0);
    await expect(chat.getByRole("button", { name: "Resume updates" })).toHaveCount(0);
    await expect(chat.locator(".chat-loader")).toHaveCount(0);
    await input().fill("after cancellation");
    await input().press("Enter");
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.updates.paused)
      .toBe(false);
    await expect(chat.locator(".activity-display")).toHaveCount(0);
    await expect(chat.locator(".event.prompt")).toHaveCount(4);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    await page.getByLabel("Theme", { exact: true }).selectOption("light");
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    await page.screenshot({ path: "test-results/orchestration-chat-light.png" });
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 600),
    );
    await expect
      .poll(() =>
        chat
          .locator(".transcript")
          .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
      )
      .toBeLessThan(2);
    await page.screenshot({ path: "test-results/orchestration-chat-dark-narrow.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const unchanged = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    await expect(
      page.evaluate(() => window.desktop.setOrchestrationProvider("broken")),
    ).rejects.toThrow("Use agent setup");
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(unchanged);
    const prior = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id as string;
    const priorPrompts = (await page.evaluate(() => window.desktop.snapshot())).chat.events.filter(
      ({ event }) => event.type === "prompt",
    ).length;
    const priorDirectory = (await page.evaluate(() => window.desktop.snapshot())).chat
      .directory as string;
    const recordFile = join(priorDirectory, ".code60", "runs", prior, "run.json");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    await application.close();
    expect(() => process.kill(record.agentPid, 0)).toThrow();
    application = await launch(directory, firstProject, database);
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await page.evaluate(
      (id) => window.desktop.orchestrationChatAction({ type: "select", id }),
      prior,
    );
    chat = page.locator("#panel-chat .orchestration-chat-page:visible");
    await expect(page.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(chat.locator(".activity-display")).toHaveCount(0);
    const restored = await page.evaluate(() => window.desktop.snapshot());
    expect(restored.chat.run?.id).toBe(prior);
    expect(restored.chat.restored).toBe(true);
    expect(restored.chat.workers).toEqual([]);
    expect(restored.chat.events.filter(({ event }) => event.type === "prompt")).toHaveLength(
      priorPrompts,
    );
    expect(await readFile(join(first.chat.directory as string, "marker.txt"), "utf8")).toBe(
      "kept across launches",
    );
    expect(errors).toEqual([]);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Memories data viewer is database-independent, paged and supports evidence and confirmed actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-memories-table-"));
  const project = join(directory, "memory-project");
  await mkdir(project);
  const store = new MemoryStore(join(directory, "state", "code60", "memory"));
  let projectId: string | null = null;
  try {
    const conversation = store.register("table-fixture", "Memory table fixture", project);
    projectId = conversation.projectId;
    const source: MemorySource = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: "human",
      at: new Date().toISOString(),
      ordinal: 0,
      start: 0,
      text: "User-stated table evidence.",
    };
    store.append(conversation.id, "fixture", [source], true);
    const citations = [
      { sourceId: source.id, start: 0, end: source.text.length, quote: source.text },
    ];
    const range = store.range(conversation.id);
    store.publish(
      conversation.id,
      range.cursor,
      range.boundary,
      {
        goal: "",
        constraints: [],
        decisions: [],
        attempts: [],
        questions: [],
        next: "",
        citations,
        memories: Array.from({ length: 28 }, (_, index) => ({
          type: index % 2 ? "semantic" : "episodic",
          text: `Table memory ${index}`,
          subject: `table-event-${index}`,
          condition: "",
          correction: false,
          citations,
        })),
      },
      "fixture",
    );
  } finally {
    store.close();
  }
  try {
    application = await launch(directory, project, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    expect((await page.evaluate(() => window.desktop.snapshot())).database).toBeNull();
    const apps = page.locator("#tab-apps");
    await apps.press("ArrowLeft");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Memories");
    await page.keyboard.press("Enter");
    const tab = page.getByRole("tab", { name: "Memories", exact: true });
    await expect(tab).toBeFocused();
    await expect(tab.locator("svg")).toHaveAttribute("data-icon", "grid-nine");
    await expect(apps).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#tables-toggle")).toHaveAttribute("aria-expanded", "true");
    const panel = page.locator("#panel-memories");
    const rows = panel.locator(".sessions-grid tbody [role='row']");
    await expect(panel.getByRole("heading", { name: "Memories", exact: true })).toBeVisible();
    await expect(panel.getByText("25 memories", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(rows).toHaveCount(3);
    await expect(panel.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "Home", exact: true }).click();
    await tab.click();
    await expect(panel.getByText("Page 2", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(3);
    const canvas = panel.getByTestId("data-grid-canvas");
    await canvas.focus();
    await canvas.press("ArrowDown");
    await canvas.press("Enter");
    const detail = page.getByRole("dialog", { name: "Memory details", exact: true });
    await expect(detail.getByRole("textbox", { name: "Memory text", exact: true })).toHaveValue(
      /Table memory/,
    );
    await expect(detail.getByText("User stated", { exact: true })).toBeVisible();
    await expect(detail.getByText("memory-project", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    expect((await detail.boundingBox())?.width).toBe(720);
    const originalScheme = await page.locator("html").getAttribute("data-color-scheme");
    for (const scheme of ["light", "dark"]) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-color-scheme", value),
        scheme,
      );
      await detail.screenshot({ path: test.info().outputPath(`memory-details-${scheme}.png`) });
    }
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-color-scheme", value ?? "light"),
      originalScheme,
    );
    await detail.getByText("Source messages (1)", { exact: true }).click();
    await expect(detail.locator("mark")).toHaveText("User-stated table evidence.");
    await detail.screenshot({ path: test.info().outputPath("memory-details-sources.png") });
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 520, height: 600 });
    expect(await detail.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await expect(
      detail.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeInViewport();
    await detail.screenshot({ path: test.info().outputPath("memory-details-narrow.png") });
    if (originalViewport) await page.setViewportSize(originalViewport);
    await expect(
      detail.getByText("User-stated table evidence.", { exact: true }).first(),
    ).toBeVisible();
    const edited = "<script>literal memory text</script>";
    await detail.getByRole("textbox", { name: "Memory text", exact: true }).fill(edited);
    await detail.getByLabel("Pinned", { exact: true }).check();
    await detail.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(rows).toContainText([edited]);
    await canvas.focus();
    await canvas.press("Enter");
    await expect(detail.getByRole("textbox", { name: "Memory text", exact: true })).toHaveValue(
      edited,
    );
    await expect(detail.locator("script")).toHaveCount(0);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await detail.getByRole("button", { name: "Promote to global", exact: true }).click();
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "Forget", exact: true }).click();
    await expect(detail).toBeVisible();
    await expect(rows).toHaveCount(3);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await detail.getByRole("button", { name: "Forget", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    await panel.getByRole("button", { name: "Previous page", exact: true }).click();
    await expect(panel.getByText("25 memories", { exact: true })).toBeVisible();
    await panel.getByLabel("Memory project", { exact: true }).selectOption(projectId ?? "");
    await panel.getByLabel("Memory type", { exact: true }).selectOption("semantic");
    // One edited/forgotten row may have been semantic.
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(13);
    await expect.poll(() => rows.count()).toBeLessThanOrEqual(14);
    await panel.getByLabel("Memory status", { exact: true }).selectOption("stale");
    await expect(panel.getByText("No memories in this view.", { exact: true })).toBeVisible();
    await panel.getByLabel("Memory status", { exact: true }).selectOption("active");
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(13);
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Memories table settings", exact: true });
    await expect(settings.locator(".table-preview-grid")).toBeVisible();
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByRole("button", { name: "Filters", exact: true }).click();
    const filters = page.getByRole("dialog", { name: "Filters", exact: true });
    await expect(filters).toBeVisible();
    await filters.getByRole("button", { name: "Close", exact: true }).click();
    await expect(filters).toBeHidden();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({ path: test.info().outputPath("memories-table.png") });
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: scoped memory settings, automatic capture, inspection and confirmed forgetting", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-scoped-memory-e2e-"));
  const project = join(directory, "project");
  await mkdir(project);
  try {
    application = await launch(directory, project, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const chat = page.locator(".orchestration-chat-page:visible");
    const composer = chat.getByRole("combobox", { name: "Message to orchestrator" });
    await expect(composer).toBeEnabled();
    await composer.fill("The cache service is Redis, running on this project only.");
    await composer.press("Enter");
    await expect(composer).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.memorySnapshot()).conversations.length),
      )
      .toBeGreaterThan(0);
    await selectSidebarPage(page, "Settings");
    await page.getByRole("tab", { name: "Memory", exact: true }).click();
    const memory = page.locator("#panel-settings-memory");
    await expect(memory.getByRole("switch", { name: "Memory on", exact: true })).toBeChecked();
    await expect(memory.getByText("Generation provider", { exact: true })).toBeVisible();
    const conversation = await page.evaluate(
      async () => (await window.desktop.memorySnapshot()).conversations[0]?.id,
    );
    await memory.getByLabel("Conversation", { exact: true }).selectOption(conversation ?? "");
    const threshold = memory.getByRole("spinbutton", {
      name: "Rollover threshold (%)",
      exact: true,
    });
    await threshold.fill("");
    await threshold.pressSequentially("50");
    await expect(threshold).toHaveValue("50");
    const capacity = memory.getByRole("spinbutton", {
      name: "Unknown model capacity (estimated tokens)",
      exact: true,
    });
    await capacity.fill("");
    await capacity.pressSequentially("4096");
    await expect(capacity).toHaveValue("4096");
    await memory.getByRole("button", { name: "Generate now", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.browseMemories({})).records.length),
      )
      .toBe(4);
    await expect(threshold).toHaveValue("50");
    await expect(capacity).toHaveValue("4096");
    await memory.getByRole("button", { name: "Rebuild search index", exact: true }).click();
    await expect(threshold).toHaveValue("50");
    await memory.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(memory.locator(".memory-list li")).toHaveCount(4);
    await memory.locator(".memory-list button").first().click();
    await expect(memory.getByText("Memory details", { exact: true })).toBeVisible();
    await expect(memory.getByRole("textbox", { name: "Memory text", exact: true })).toHaveValue(
      /cache service/,
    );
    await memory
      .getByRole("textbox", { name: "Memory text", exact: true })
      .fill("Human corrected cache evidence.");
    await memory.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(memory.locator(".memory-list")).toContainText("Human corrected cache evidence.");
    await memory.locator(".memory-list button").filter({ hasText: "Human corrected" }).click();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await memory.getByRole("button", { name: "Forget", exact: true }).click();
    await expect(memory.locator(".memory-list li")).toHaveCount(4);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await memory.getByRole("button", { name: "Forget", exact: true }).click();
    await expect(memory.locator(".memory-list li")).toHaveCount(3);
    await memory.getByRole("button", { name: "Generate now", exact: true }).click();
    await expect(memory.locator(".memory-list")).not.toContainText(
      "Human corrected cache evidence.",
    );
    await memory.getByRole("switch", { name: "Automatic generation", exact: true }).uncheck();
    await memory.getByRole("button", { name: "Save memory settings", exact: true }).click();
    expect(
      await page.evaluate(async () => (await window.desktop.memorySnapshot()).settings.generation),
    ).toBe(false);
    expect(
      await page.evaluate(
        async () => (await window.desktop.memorySnapshot()).settings.rolloverPercent,
      ),
    ).toBe(50);
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: memory browser reaches records older than 500 without unbounded rendering", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-memory-pages-e2e-"));
  const project = join(directory, "project");
  await mkdir(project);
  const store = new MemoryStore(join(directory, "state", "code60", "memory"));
  try {
    const conversation = store.register("paging-fixture", "Paging fixture", null);
    for (let offset = 0; offset < 525; offset += 32) {
      const source: MemorySource = {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "human",
        at: new Date().toISOString(),
        ordinal: offset,
        start: 0,
        text: "Paging evidence.",
      };
      store.append(conversation.id, String(offset), [source], true);
      const citations = [
        { sourceId: source.id, start: 0, end: source.text.length, quote: source.text },
      ];
      const value: MemoryGeneration = {
        goal: "",
        constraints: [],
        decisions: [],
        attempts: [],
        questions: [],
        next: "",
        citations,
        memories: Array.from({ length: Math.min(32, 525 - offset) }, (_, index) => ({
          type: "episodic",
          text: `Fixture memory ${offset + index}`,
          subject: `event-${offset + index}`,
          condition: "",
          correction: false,
          citations,
        })),
      };
      const range = store.range(conversation.id);
      store.publish(conversation.id, range.cursor, range.boundary, value, "fixture");
    }
  } finally {
    store.close();
  }
  try {
    application = await launch(directory, project, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSidebarPage(page, "Settings");
    await page.getByRole("tab", { name: "Memory", exact: true }).click();
    const memory = page.locator("#panel-settings-memory");
    for (let index = 0; index < 21; index++) {
      await expect(memory.locator(".memory-list li")).toHaveCount(25);
      await expect(memory.locator(".memory-list button").first()).toContainText(
        `Fixture memory ${524 - index * 25}`,
      );
      if (index < 20) await memory.getByRole("button", { name: "Load more", exact: true }).click();
    }
    await memory
      .locator(".memory-list button")
      .filter({ hasText: /Fixture memory 0$/ })
      .click();
    await expect(memory.getByRole("textbox", { name: "Memory text", exact: true })).toHaveValue(
      "Fixture memory 0",
    );
    await memory
      .getByRole("textbox", { name: "Memory text", exact: true })
      .fill("Edited oldest memory.");
    await memory.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(memory.locator(".memory-list")).toContainText("Edited oldest memory.");
    await memory.getByRole("button", { name: "Previous page", exact: true }).click();
    await expect(memory.locator(".memory-list button").first()).toContainText("Fixture memory 49");
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: RAG manually indexes, retrieves and retains its database snapshot", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-rag-e2e-"));
  const project = join(directory, "project");
  const database = join(directory, "projects.sqlite");
  execFileSync("git", ["init", "-q", project]);
  commitFixture(project);
  try {
    application = await launch(directory, project, database);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    const ids = await page.evaluate(() =>
      window.desktop.start({
        agents: ["claude"],
        allow: [],
        allowAll: false,
        prompt: JSON.stringify([
          { message: "Our private conversation index runs locally and is rebuilt manually." },
        ]),
      }),
    );
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.snapshot()).runs.find((run) => run.record.id === id)?.view
              ?.status,
          ids[0],
        ),
      )
      .toBe("idle");
    await page.evaluate((id) => window.desktop.action({ type: "finish", id }), ids[0] ?? "");
    await selectSidebarPage(page, "Settings");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByRole("button", { name: "Experiments", exact: true }).click();
    await page.getByRole("tab", { name: "RAG", exact: true }).click();
    const rag = page.locator("#panel-rag");
    await expect(rag.locator(".settings-card")).toHaveCount(2);
    for (const card of await rag.locator(".settings-card").all()) {
      await expect(card).toHaveCSS("padding", "12px 16px");
    }
    await expect(rag.locator('label[for="rag-message"]')).toHaveCount(0);
    await rag.getByRole("button", { name: "Index conversations", exact: true }).click();
    await expect(rag.getByRole("button", { name: "Rebuild index", exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    const message = rag.getByRole("textbox", { name: "Retrieval query", exact: true });
    await message.fill("How does our private conversation search get updated?");
    await message.press("Enter");
    await expect(rag.locator(".rag-results li")).not.toHaveCount(0, { timeout: 30_000 });
    await expect(rag.locator(".rag-results")).toContainText("rebuilt manually");
    const saved = await rag.locator(".rag-results").textContent();
    await selectSidebarPage(page, "Chat");
    await page.getByRole("tab", { name: "RAG", exact: true }).click();
    await expect(message).toHaveValue("How does our private conversation search get updated?");
    expect(await rag.locator(".rag-results").textContent()).toBe(saved);
    await message.fill("x".repeat(8193));
    await message.press("Enter");
    await expect(rag.getByRole("alert")).toContainText("8,192 characters");
    await expect(message).toHaveValue("x".repeat(8193));
    expect(await rag.locator(".rag-results").textContent()).toBe(saved);
    await message.fill(" token".repeat(511));
    await message.press("Enter");
    await expect(rag.getByRole("alert")).toContainText("512 tokens");
    expect(await rag.locator(".rag-results").textContent()).toBe(saved);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await rag.getByRole("button", { name: "Clear index", exact: true }).click();
    await expect(rag.getByRole("button", { name: "Rebuild index", exact: true })).toBeEnabled();
    expect(await rag.locator(".rag-results").textContent()).toBe(saved);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await rag.getByRole("button", { name: "Clear index", exact: true }).click();
    await expect(
      rag.getByRole("button", { name: "Index conversations", exact: true }),
    ).toBeEnabled();
    await expect(rag.locator(".rag-results")).toHaveCount(0);
    await expect(rag.getByRole("button", { name: "Retrieve", exact: true })).toBeDisabled();
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Episodic Memory extracts event statements, edits prompts, clears, and cancels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-memory-e2e-"));
  const project = join(directory, "project");
  const database = join(directory, "projects.sqlite");
  const config = join(directory, "config", "code60", "config.json");
  execFileSync("git", ["init", "-q", project]);
  commitFixture(project);
  await mkdir(dirname(config), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--memory"],
        },
      },
    }),
  );
  try {
    application = await launch(directory, project, database);
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByRole("button", { name: "Experiments", exact: true }).click();
    await page.getByRole("tab", { name: "Episodic Memory", exact: true }).click();
    const memory = page.locator("#panel-episodic-memory");
    const extract = memory.getByRole("button", { name: /^Extract from/ });
    await expect(extract).toHaveText("Extract from 0 events");
    await expect(extract).toBeDisabled();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop.start({
        agents: ["claude"],
        allow: [],
        allowAll: false,
        prompt: JSON.stringify([
          { message: "The project uses npm. The release requires passing tests." },
        ]),
      }),
    );
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.snapshot()).runs[0]?.view?.status),
      )
      .toBe("idle");
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    const id = snapshot.runs[0]?.record.id as string;
    await page.evaluate((id) => window.desktop.action({ type: "finish", id }), id);
    await expect
      .poll(() => page.evaluate(async () => (await window.desktop.snapshot()).active))
      .toBe(false);
    await expect(page.locator(".chat-head-close")).toHaveCount(0);
    const count = await page.evaluate(async (id) => {
      const events = await window.desktop.action({ type: "events", id });
      return Array.isArray(events) ? events.length : 0;
    }, id);
    expect(count).toBeGreaterThan(0);
    await expect(extract).toHaveText(`Extract from ${count} events`);
    await expect(extract).toBeEnabled();
    const limit = memory.getByRole("spinbutton", { name: "Maximum events", exact: true });
    await expect(limit).toHaveValue("10000");
    for (const value of ["0", "-1", "1.5", "10001", ""]) {
      await limit.fill(value);
      await expect(limit).toHaveAttribute("aria-invalid", "true");
      await expect(extract).toBeDisabled();
      await expect(memory.getByRole("alert")).toHaveText("Enter a whole number from 1 to 10,000.");
    }
    await limit.fill("3");
    await expect(extract).toHaveText("Extract from 3 events");
    await expect(extract).toBeEnabled();
    const box = await memory.locator(".memory-extraction-controls").boundingBox();
    const content = await memory.locator(".memory-content").boundingBox();
    expect(box).not.toBeNull();
    expect(content).not.toBeNull();
    if (box && content) {
      expect(Math.abs(box.x + box.width / 2 - content.x - content.width / 2)).toBeLessThan(2);
      expect(Math.abs(box.y + box.height / 2 - content.y - content.height / 2)).toBeLessThan(2);
    }
    await extract.click();
    const rows = memory.getByRole("list", { name: "Extracted statements" }).getByRole("listitem");
    await expect(rows).toHaveText(["The project uses npm.", "The release requires passing tests."]);
    await expect(memory.getByRole("status")).toHaveText(/^Extraction complete in \d+\.\ds\.$/);
    await expect(rows.first()).toHaveCSS("font-size", "16px");
    await expect(rows.first()).toHaveCSS("padding-left", "32px");
    await expect(rows.first().locator(".memory-cloud-light")).toBeVisible();
    await expect(rows.first().locator(".memory-cloud-dark")).toBeHidden();
    await page.screenshot({ path: "test-results/episodic-memory-statements.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(rows.first().locator(".memory-cloud-light")).toBeHidden();
    await expect(rows.first().locator(".memory-cloud-dark")).toBeVisible();
    await expect(rows.first()).toHaveCSS("color", "rgb(255, 255, 255)");
    await page.screenshot({ path: "test-results/episodic-memory-clouds-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await memory.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(rows).toHaveCount(0);
    await expect(memory.getByRole("status")).toHaveCount(0);
    await memory.getByRole("button", { name: "Edit prompt", exact: true }).click();
    const editor = memory.getByRole("textbox", { name: "Extraction prompt", exact: true });
    await expect(editor).toBeFocused();
    await editor.fill("Extract preferences only.");
    await extract.click();
    await expect(rows).toHaveText(["The user prefers concise responses."]);
    await page.screenshot({ path: "test-results/episodic-memory-prompt.png" });
    await memory.getByRole("button", { name: "Clear", exact: true }).click();
    await editor.fill("Wait for cancellation.");
    await extract.click();
    await expect(limit).toBeDisabled();
    await memory.getByRole("button", { name: "Cancel extraction", exact: true }).click();
    await expect(memory.getByRole("status")).toHaveText("Extraction cancelled.");
    await expect(rows).toHaveCount(0);
    await expect(editor).toBeEnabled();
    await editor.fill("Invalid response.");
    await extract.click();
    await expect(memory.getByRole("alert")).toContainText("did not return valid statements");
    await expect(rows).toHaveCount(0);
    await editor.fill("Extract preferences only.");
    await page.reload();
    await expect(page.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const settingsPages = page.getByRole("tab", { name: "Settings", exact: true });
    await settingsPages.press("ArrowLeft");
    await expect(settingsPages).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Episodic Memory");
    await page.keyboard.press("Enter");
    await expect(settingsPages).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tab", { name: "Episodic Memory", exact: true })).toBeFocused();
    await expect(memory).toBeVisible();
    await memory.getByRole("button", { name: "Edit prompt", exact: true }).click();
    await expect(editor).toHaveValue("Extract preferences only.");
    await expect(limit).toHaveValue("3");
    await expect(extract).toHaveText("Extract from 3 events");
    await limit.fill("10000");
    await expect(extract).toHaveText(`Extract from ${count} events`);
    await memory.getByRole("button", { name: "Reset prompt", exact: true }).click();
    await expect(editor).toHaveValue(/Extract important details/);
    await extract.click();
    await expect(rows).toHaveCount(2);
    await editor.fill("Wait for cancellation.");
    await extract.click();
    await expect(
      memory.getByRole("button", { name: "Cancel extraction", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("tab", { name: "Episodic Memory", exact: true }).click();
    await memory.getByRole("button", { name: "Edit prompt", exact: true }).click();
    await memory.getByRole("button", { name: "Reset prompt", exact: true }).click();
    await extract.click();
    await expect(rows).toHaveCount(2);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(620, 620),
    );
    await expect(memory.getByRole("button", { name: "Clear", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: "test-results/episodic-memory-narrow.png" });
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: table settings modal previews drafts, applies, resets, and discards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-table-settings-"));
  const database = join(directory, "projects.sqlite");
  const errors: string[] = [];
  try {
    execFileSync("git", ["init", "-q", directory]);
    execFileSync("git", [
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "Fixture",
    ]);
    application = await launch(directory, directory, database);
    const page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await selectSidebarPage(page, "Sessions");
    const panel = page.locator("#panel-sessions");
    const trigger = panel.getByRole("button", { name: "Settings", exact: true });
    const controlScroll = panel.locator(".table-control-scroll");
    const controlsOverflow = () =>
      controlScroll.evaluate((element) => element.scrollWidth > element.clientWidth);
    const clickSettingsBottom = async () => {
      const bottom = await trigger.evaluate((button) => {
        const group = button.closest(".table-control-group");
        if (!group) throw new Error("Missing table control group");
        const frame = group.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        const border = Number.parseFloat(getComputedStyle(group).borderBottomWidth);
        const x = (bounds.left + bounds.right) / 2;
        const y = frame.bottom - border - 1;
        return {
          x,
          y,
          aligned: Math.abs(bounds.bottom - frame.bottom + border) < 1,
          hit: button.contains(document.elementFromPoint(x, y)),
        };
      });
      expect(bottom.aligned).toBe(true);
      expect(bottom.hit).toBe(true);
      await page.mouse.click(bottom.x, bottom.y);
    };
    const actual = panel.locator(".sessions-grid");
    const modal = page.getByRole("dialog", { name: "Sessions table settings" });
    const preview = modal.locator(".table-preview-grid");
    const density = modal.getByLabel("Row density", { exact: true });
    const stored = () => page.evaluate(() => localStorage.getItem("code60.tableView.v1:sessions"));
    const columnsButton = modal.getByRole("button", { name: "Visible columns", exact: true });
    const openColumns = async () => {
      if ((await columnsButton.getAttribute("aria-expanded")) === "false")
        await columnsButton.click();
    };
    const original = await stored();
    await panel.getByRole("button", { name: "Search sessions", exact: true }).click();
    await expectIconAction(page.getByRole("button", { name: "Close Search", exact: true }));
    const previousResult = page.getByRole("button", { name: "Previous Result", exact: true });
    await expect(previousResult).toBeDisabled();
    await expect(previousResult).toHaveCSS("border-top-width", "0px");
    await expect(previousResult).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.getByRole("button", { name: "Close Search", exact: true }).click();
    await expect.poll(controlsOverflow).toBe(false);
    await clickSettingsBottom();
    await expect(modal).toBeVisible();
    await page.screenshot({ path: "test-results/table-settings-initial.png" });
    expect(errors).toEqual([]);
    await expect(density).toBeFocused();
    await expectIconAction(modal.getByRole("button", { name: "Close table settings" }));
    await expect(columnsButton).toHaveAttribute("aria-expanded", "false");
    await expect(modal.getByRole("group", { name: "Visible columns", exact: true })).toBeHidden();
    await expect(modal.getByRole("heading", { name: "Preview", exact: true })).toBeVisible();
    await expect(modal.getByText("— sample data", { exact: true })).toHaveCount(0);
    await expect(modal.locator(".table-preview-frame")).toHaveCSS("border-top-style", "dotted");
    await expect(modal.locator(".table-preview-frame")).toHaveCSS(
      "border-top-color",
      "rgb(229, 138, 43)",
    );
    await expect(modal.locator(".table-setting-row").first()).toHaveCSS(
      "border-bottom-width",
      "0px",
    );
    await openColumns();
    await expect(columnsButton).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    await expect(columnsButton).toBeFocused();
    await expect(columnsButton).toHaveAttribute("aria-expanded", "false");
    await expect(preview.locator("tbody [role='row']")).toHaveCount(4);
    await expect(actual).toHaveAttribute("data-row-height", "24");
    await density.selectOption("low");
    await modal.getByRole("switch", { name: "Row lines", exact: true }).check();
    await modal.getByRole("switch", { name: "Heading lines", exact: true }).check();
    await modal.getByRole("switch", { name: "Fit columns to width", exact: true }).check();
    await expect(preview).toHaveAttribute("data-row-height", "44");
    await expect(preview).toHaveAttribute("data-heading-lines", "true");
    await expect(preview).toHaveAttribute("data-fit", "true");
    await expect(actual).toHaveAttribute("data-row-height", "24");
    expect(await stored()).toBe(original);
    // The native modal keeps background controls inert and keyboard focus inside it.
    await page.keyboard.press("Tab");
    expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.mouse.click(1, 1);
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await stored()).toBe(original);
    for (const dismiss of ["escape", "escape-preview", "close"]) {
      await trigger.click();
      await density.selectOption("low");
      if (dismiss === "escape-preview") await preview.getByTestId("data-grid-canvas").focus();
      if (dismiss.startsWith("escape")) await page.keyboard.press("Escape");
      else await modal.getByRole("button", { name: "Close table settings", exact: true }).click();
      await expect(modal).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await stored()).toBe(original);
    }
    await trigger.click();
    await density.selectOption("medium");
    const charts = modal.getByRole("switch", { name: "Inline charts", exact: true });
    await charts.uncheck();
    await expect(preview.locator("th[role='columnheader']")).not.toContainText(["Turn time"]);
    await openColumns();
    await expect(modal.getByRole("switch", { name: "Turn time", exact: true })).toBeDisabled();
    await charts.check();
    await openColumns();
    await expect(modal.getByRole("switch", { name: "Turn time", exact: true })).toBeEnabled();
    const agent = modal.getByRole("switch", { name: "Agent", exact: true });
    await agent.uncheck();
    await expect(preview.locator("th[role='columnheader']")).not.toContainText(["Agent"]);
    await expect(actual.locator("th[role='columnheader']")).toContainText(["Agent"]);
    expect(await stored()).toBe(original);
    await modal.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(actual).toHaveAttribute("data-row-height", "32");
    await expect(actual.locator("th[role='columnheader']")).not.toContainText(["Agent"]);
    await expect.poll(async () => JSON.parse((await stored()) ?? "{}").density).toBe("medium");
    const applied = await stored();
    await trigger.click();
    await expect(density).toHaveValue("medium");
    await modal.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await expect(density).toHaveValue("high");
    expect(await stored()).toBe(applied);
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await stored()).toBe(applied);
    await trigger.click();
    await modal.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await charts.uncheck();
    await openColumns();
    const columns = modal.getByRole("group", { name: "Visible columns", exact: true });
    const checkboxes = columns.getByRole("switch");
    for (const checkbox of await checkboxes.all()) {
      if (
        (await checkbox.isChecked()) &&
        (await checkbox.getAttribute("type")) === "checkbox" &&
        (await checkbox.evaluate((element) => element.closest("label")?.textContent?.trim())) !==
          "Agent"
      )
        await checkbox.uncheck();
    }
    await expect(agent).toBeChecked();
    await expect(agent).toBeDisabled();
    // Chart-only drafts recover a normal data column when charts are switched off.
    await charts.check();
    await openColumns();
    await agent.uncheck();
    await charts.uncheck();
    await openColumns();
    await expect(agent).toBeChecked();
    await expect(preview.locator("th[role='columnheader']")).toContainText(["Agent"]);
    await modal.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await expect(columnsButton).toHaveAttribute("aria-expanded", "false");
    await page.screenshot({ path: "test-results/table-settings-light.png" });
    await openColumns();
    await page.screenshot({ path: "test-results/table-settings-columns.png" });
    await columnsButton.click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expectNeutralTheme(page);
    await expect(modal).toHaveCSS("background-color", "rgb(15, 23, 42)");
    await page.screenshot({ path: "test-results/table-settings-dark.png" });
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setMinimumSize(0, 0);
      window?.setSize(600, 620);
    });
    await expect(modal.locator(".table-display-choices")).toHaveCSS(
      "grid-template-columns",
      /^\S+px \S+px$/,
    );
    await expect(modal).toBeInViewport();
    expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await openColumns();
    await modal.getByRole("switch", { name: "Last 2 min", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/table-settings-columns-narrow.png" });
    await columnsButton.click();
    await expect(modal.getByRole("button", { name: "Apply", exact: true })).toBeInViewport();
    await page.screenshot({ path: "test-results/table-settings-narrow.png" });
    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const forced = await modal.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, text: style.color, border: style.borderColor };
    });
    expect(forced.text).not.toBe(forced.background);
    expect(forced.border).not.toBe(forced.background);
    await page.screenshot({ path: "test-results/table-settings-forced-colors.png" });
    await page.emulateMedia({ forcedColors: "none", colorScheme: "light" });
    await modal.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(stored).toBe(null);
    await expect(actual).toHaveAttribute("data-row-height", "24");
    await controlScroll.evaluate((element) => element.style.setProperty("max-width", "72px"));
    try {
      await expect.poll(controlsOverflow).toBe(true);
      await panel.getByRole("button", { name: "Search sessions", exact: true }).focus();
      await trigger.focus();
      await expect
        .poll(() => controlScroll.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
      await clickSettingsBottom();
      await expect(modal).toBeVisible();
    } finally {
      await controlScroll.evaluate((element) => element.style.removeProperty("max-width"));
    }
    await modal.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await density.selectOption("low");
    await modal.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(async () => JSON.parse((await stored()) ?? "{}").density).toBe("low");
    await page.reload();
    await selectSidebarPage(page, "Sessions");
    await expect(actual).toHaveAttribute("data-row-height", "44");
    // Every table uses the same dialog, without leaking the Sessions override or chart controls.
    for (const name of [
      "Messages",
      "Events",
      "Logs",
      "Memories",
      "Configurations",
      "Worktrees",
      "Polling",
    ]) {
      await selectSidebarPage(page, name);
      await page
        .locator(`#panel-${name.toLowerCase()}`)
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      const other = page.getByRole("dialog", { name: `${name} table settings`, exact: true });
      await expect(other.getByLabel("Row density", { exact: true })).toHaveValue("high");
      await expect(other.getByRole("switch", { name: "Inline charts", exact: true })).toHaveCount(
        0,
      );
      await expect(other.locator(".table-preview-grid tbody [role='row']")).toHaveCount(4);
      await other.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await selectSidebarPage(page, "Sessions");
    await trigger.click();
    await density.selectOption("medium");
    await application.evaluate(
      ({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      },
      join(directory, "other.sqlite"),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await expect(modal).toHaveCount(0);
    await expect(actual).toHaveAttribute("data-row-height", "44");
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: sidebar disclosure motion and stable pointer-pressed borders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-sidebar-motion-"));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const toggle = page.locator("#tables-toggle");
    const group = page.locator("#table-pages");
    if ((await toggle.getAttribute("aria-expanded")) === "true") {
      await toggle.click();
      await expect(group).toHaveCSS("display", "none");
    }
    const motion = await page.evaluate(async () => {
      const control = document.getElementById("tables-toggle");
      const contents = document.getElementById("table-pages");
      if (!control || !contents) throw new Error("Missing table disclosure");
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const heightTransition = () => {
        const transitions = contents.getAnimations();
        const height = transitions.find(
          (animation) =>
            animation instanceof CSSTransition && animation.transitionProperty === "height",
        );
        if (!height) throw new Error("Missing sidebar height transition");
        for (const animation of transitions) animation.pause();
        return { height, transitions };
      };
      control.click();
      await frame();
      const opening = heightTransition();
      const timing = opening.height.effect?.getTiming();
      if (!timing || typeof timing.duration !== "number" || typeof timing.delay !== "number")
        throw new Error("Missing timing");
      opening.height.currentTime = timing.delay / 2;
      const delayed = contents.getBoundingClientRect().height;
      opening.height.currentTime = timing.delay + timing.duration / 2;
      const openingMiddle = contents.getBoundingClientRect().height;
      for (const animation of opening.transitions) animation.finish();
      const full = contents.getBoundingClientRect().height;
      control.click();
      await frame();
      const closing = heightTransition();
      closing.height.currentTime = timing.delay / 2;
      const closingDelayed = contents.getBoundingClientRect().height;
      closing.height.currentTime = timing.delay + timing.duration / 2;
      const closingMiddle = contents.getBoundingClientRect().height;
      const closingInert = contents.inert && contents.getAttribute("aria-hidden") === "true";
      document.getElementById("tab-logs")?.focus();
      const closingFocusable = contents.contains(document.activeElement);
      // Reverse halfway through closing, without waiting for a timer or unmounting children.
      control.click();
      await frame();
      for (const animation of contents.getAnimations()) animation.finish();
      const reversed = contents.getBoundingClientRect().height;
      const reversedInert = contents.inert;
      // Focusing a revealed destination also settles its container immediately.
      control.click();
      await frame();
      control.click();
      await frame();
      document.getElementById("tab-logs")?.focus();
      const focused = contents.getBoundingClientRect().height;
      const focusTransition = getComputedStyle(contents).transitionProperty;
      control.focus();
      control.click();
      await frame();
      for (const animation of contents.getAnimations()) animation.finish();
      return {
        delay: timing.delay,
        duration: timing.duration,
        delayed,
        openingMiddle,
        full,
        closingDelayed,
        closingMiddle,
        closingInert,
        closingFocusable,
        reversed,
        reversedInert,
        focused,
        focusTransition,
        closed: contents.getBoundingClientRect().height,
      };
    });
    expect(motion.delay).toBe(20);
    expect(motion.duration).toBe(175);
    expect(motion.delayed).toBe(0);
    expect(motion.openingMiddle).toBeGreaterThan(0);
    expect(motion.openingMiddle).toBeLessThan(motion.full);
    expect(motion.closingDelayed).toBe(motion.full);
    expect(motion.closingMiddle).toBeGreaterThan(0);
    expect(motion.closingMiddle).toBeLessThan(motion.full);
    expect(motion.closingInert).toBe(true);
    expect(motion.closingFocusable).toBe(false);
    expect(motion.reversed).toBe(motion.full);
    expect(motion.reversedInert).toBe(false);
    expect(motion.focused).toBe(motion.full);
    expect(motion.focusTransition).toBe("none");
    expect(motion.closed).toBe(0);
    await expect(group).toHaveCSS("display", "none");
    for (const media of [
      { reducedMotion: "reduce" as const, forcedColors: "none" as const },
      { reducedMotion: "no-preference" as const, forcedColors: "active" as const },
    ]) {
      await page.emulateMedia(media);
      await toggle.click();
      await expect(group).toHaveCSS("transition-property", "none");
      await expect(group).toHaveAttribute("aria-hidden", "false");
      await toggle.click();
      await expect(group).toHaveCSS("display", "none");
      await expect(group).toHaveAttribute("inert", "");
    }
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "none" });
    await page.evaluate(() => {
      const probes = document.createElement("div");
      probes.id = "pointer-border-probes";
      probes.style.cssText = "position:fixed;right:20px;top:40px;z-index:9999";
      for (const kind of ["regular", "primary"]) {
        const button = document.createElement("button");
        button.id = `pointer-border-${kind}`;
        button.className = kind === "primary" ? "primary" : "";
        button.textContent = `Border ${kind}`;
        probes.append(button);
      }
      document.body.append(probes);
    });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorScheme = theme;
        document.documentElement.dataset.focusHighlight = "on";
      }, theme);
      for (const control of [
        toggle,
        page.locator("#pointer-border-regular"),
        page.locator("#pointer-border-primary"),
      ]) {
        await control.hover();
        const border = await control.evaluate((element) => getComputedStyle(element).borderColor);
        await page.mouse.down();
        try {
          await expect(control).toHaveCSS("border-color", border);
          // A `none` outline can retain the UA's computed medium width.
          await expect(control).toHaveCSS("outline-style", "none");
          await expect(control).toHaveCSS("box-shadow", "none");
        } finally {
          await page.mouse.up();
        }
      }
    }
    await page.evaluate(() => document.getElementById("pointer-border-probes")?.remove());
    await toggle.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS("outline-width", "2px");
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: transition preferences halve legacy values once and retain subsequent edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-halved-transitions-"));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    const labels = ["Reply entrance", "Scroll response", "Activity fade", "Activity dropdown"];
    for (const label of labels)
      await expect(page.getByLabel(`${label} in milliseconds`, { exact: true })).toHaveValue("175");
    await page.evaluate(() => {
      localStorage.setItem(
        "code60.transitionTimes",
        JSON.stringify({
          replyEntrance: 350,
          scrollResponse: 1000,
          activityFade: 0,
          activityDetails: 30_000,
        }),
      );
    });
    await page.reload();
    await selectSettingsPage(page, "Appearance");
    for (const [index, value] of [175, 500, 0, 15_000].entries())
      await expect(
        page.getByLabel(`${labels[index]} in milliseconds`, { exact: true }),
      ).toHaveValue(String(value));
    const entrance = page.getByLabel("Reply entrance in milliseconds", { exact: true });
    await entrance.fill("900");
    await expect(page.locator("html")).toHaveCSS("--chat-reply-duration", "900ms");
    await page.reload();
    await selectSettingsPage(page, "Appearance");
    await expect(entrance).toHaveValue("900");
    await expect(page.getByLabel("Scroll response in milliseconds", { exact: true })).toHaveValue(
      "500",
    );
    await page.getByRole("button", { name: "Reset transitions", exact: true }).click();
    for (const label of labels)
      await expect(page.getByLabel(`${label} in milliseconds`, { exact: true })).toHaveValue("175");
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: scrollbars keep content geometry stable across wrapping and overflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-stable-scrollbars-"));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    for (const [theme, forcedColors] of [
      ["light", "none"],
      ["dark", "none"],
      ["dark", "active"],
    ] as const) {
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await page.emulateMedia({ forcedColors });
      const measurements = await page.evaluate(() => {
        const vertical = [
          "page-tabs",
          "settings-page",
          "prompt-editor",
          "commands-scroll",
          "transcript",
          "table-settings-body",
          "project-list",
          "file-tree",
          "agent-setup-body",
          "harness-mode-menu",
          "revision-list",
          "review-panel",
          "review-files",
          "git-setup-body",
          "plan-document",
          "tactics-list",
          "tactic-content",
        ].map((name) => {
          // Use the shipped scroll-container styles, without changing live app content.
          const pane = document.createElement("div");
          pane.className = name;
          pane.style.cssText =
            "position:fixed;left:0;top:0;width:400px;height:80px;min-width:0;min-height:0;max-width:none;max-height:none;padding:0;margin:0;flex:none;box-sizing:border-box";
          const content = document.createElement("div");
          content.style.cssText =
            "display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));flex:none";
          for (let index = 0; index < 6; index++) {
            const cell = document.createElement("div");
            cell.style.height = "20px";
            content.append(cell);
          }
          pane.append(content);
          document.body.append(pane);
          try {
            const sample = () => ({
              reserved: pane.offsetWidth - pane.clientWidth,
              overflow: pane.scrollHeight > pane.clientHeight,
            });
            const wide = sample();
            pane.style.width = "180px";
            const narrow = sample();
            content.style.display = "none";
            const empty = sample();
            content.style.display = "grid";
            const restored = sample();
            return {
              name,
              gutter: getComputedStyle(pane).scrollbarGutter,
              wide,
              narrow,
              empty,
              restored,
            };
          } finally {
            pane.remove();
          }
        });
        const horizontal = ["file-tabs", "tactic-workflow", "code"].map((name) => {
          const host = document.createElement("div");
          host.className = "event message";
          host.style.position = "fixed";
          const markdown = document.createElement("div");
          markdown.className = "chat-markdown";
          const pane = document.createElement(name === "code" ? "pre" : "div");
          pane.className = name === "code" ? "" : name;
          pane.style.cssText =
            "position:fixed;left:0;top:0;width:400px;min-width:0;max-width:none;padding:0;margin:0;flex:none;box-sizing:border-box";
          const content = document.createElement("div");
          content.style.cssText = "width:300px;height:20px;flex:none";
          pane.append(content);
          markdown.append(pane);
          host.append(markdown);
          document.body.append(host);
          try {
            const sample = () => ({
              height: pane.getBoundingClientRect().height,
              overflow: pane.scrollWidth > pane.clientWidth,
            });
            const wide = sample();
            pane.style.width = "180px";
            return {
              name,
              overflowX: getComputedStyle(pane).overflowX,
              wide,
              narrow: sample(),
            };
          } finally {
            host.remove();
          }
        });
        return { vertical, horizontal };
      });
      for (const pane of measurements.vertical) {
        if (pane.name === "page-tabs") expect(pane.wide.reserved).toBe(0);
        else expect(pane.gutter, pane.name).toBe("stable");
        expect(pane.wide.overflow, pane.name).toBe(false);
        expect(pane.narrow.overflow, pane.name).toBe(true);
        expect(pane.empty.overflow, pane.name).toBe(false);
        expect(pane.restored.overflow, pane.name).toBe(true);
        for (const state of [pane.narrow, pane.empty, pane.restored])
          expect(state.reserved, pane.name).toBe(pane.wide.reserved);
      }
      for (const pane of measurements.horizontal) {
        expect(pane.overflowX, pane.name).toBe("scroll");
        expect(pane.wide.overflow, pane.name).toBe(false);
        expect(pane.narrow.overflow, pane.name).toBe(true);
        expect(pane.narrow.height, pane.name).toBe(pane.wide.height);
      }
      await expectNavigationHighlight(
        page,
        page.locator(".sidebar [data-nav-active='true']:visible"),
      );
    }
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: keyboard focus is visible and enhanced focus is persistent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-focus-highlight-"));
  const database = join(directory, "projects.sqlite");
  try {
    application = await launch(directory, directory, database);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    const toggle = page.getByRole("switch", { name: "Focus highlight border", exact: true });
    const keyboardFocus = async (control = toggle) => {
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      await control.focus();
      await expect(control).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(control).toBeFocused();
    };
    const themeSelect = page.getByLabel("Theme", { exact: true });
    const reset = page.getByRole("button", { name: "Reset transitions", exact: true });
    const expectStandardFocus = async (enhanced: boolean, forcedColors = false) => {
      for (const control of [reset, themeSelect, toggle]) {
        await keyboardFocus(control);
        await expect(control).toHaveCSS("outline-width", "2px");
        await expect(control).toHaveCSS("outline-offset", enhanced ? "3px" : "2px");
        if (enhanced || forcedColors)
          await expect(control).not.toHaveCSS("outline-color", "rgba(0, 0, 0, 0)");
        else await expect(control).toHaveCSS("outline-color", "rgba(0, 0, 0, 0)");
        if (!forcedColors) await expect(control).toHaveCSS("box-shadow", enhanced ? /3px/ : /4px/);
      }
    };
    await expect(toggle).not.toBeChecked();
    await expectIndustrialSurfaces(page);
    await expect(page.locator("html")).toHaveAttribute("data-focus-highlight", "off");
    await expectStandardFocus(false);
    await page.emulateMedia({ forcedColors: "active" });
    await expectStandardFocus(false, true);
    expect(
      await toggle.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--focus-line").trim(),
      ),
    ).toBe("Highlight");
    await page.emulateMedia({ forcedColors: "none" });
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-focus-highlight", "on");
    for (const theme of ["dark", "light", "system"]) {
      await themeSelect.selectOption(theme);
      await expectStandardFocus(true);
      await expectIndustrialSurfaces(page);
    }
    await page.reload();
    await selectSettingsPage(page, "Appearance");
    await expect(toggle).toBeChecked();
    await keyboardFocus();
    await expect(toggle).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toHaveCSS("outline-color", "rgba(0, 0, 0, 0)");
    await expect(toggle).toHaveCSS("box-shadow", /4px/);
    await page.reload();
    await selectSettingsPage(page, "Appearance");
    await expect(toggle).not.toBeChecked();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await selectSidebarPage(page, "Home");
    await expectActionFocus(page, [
      page.locator(".home-card").first(),
      page.locator(".poll-timestamp"),
    ]);
    const expectWrappedFocus = async (enhanced: boolean) => {
      await selectSettingsPage(page, "Table defaults");
      const density = page.getByRole("radio", { name: "High", exact: true });
      await keyboardFocus(density);
      await expect(density.locator("..")).toHaveCSS("outline-width", "2px");
      await selectSidebarPage(page, "Prompt Builder");
      const editor = page.locator(".prompt-editor-clause .prompt-editor-input").first();
      await keyboardFocus(editor.locator("textarea"));
      await expect(editor).toHaveCSS("outline-width", "2px");
      // The outer editor carries the highlight, with a halo only when enabled.
      await expect(editor.locator("textarea")).toHaveCSS("outline-width", "0px");
      await expect(editor).toHaveCSS("box-shadow", enhanced ? /5px inset/ : /4px.*inset/);
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
      await expect(palette.locator(".palette-input")).toHaveCSS("outline-width", "2px");
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
    };
    await expectWrappedFocus(false);
    await selectSettingsPage(page, "Appearance");
    await toggle.check();
    await expectWrappedFocus(true);
    await expectIconAction(page.getByRole("button", { name: /^New chat in / }));
    await page.locator(".prompt-editor-clause textarea").first().focus();
    await page.screenshot({ path: "test-results/focus-highlight-enabled.png" });
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Text settings preview each role, switch case and reset per role", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-text-settings-"));
  const database = join(directory, "projects.sqlite");
  try {
    application = await launch(directory, directory, database);
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSettingsPage(page, "Text");
    const panel = page.locator("#panel-settings-text");
    await expect(panel.locator(".text-style")).toHaveCount(6);
    await expect(panel.locator(".settings-group-reset")).toHaveCount(0);
    const group = panel.getByRole("group", { name: "Agent Chat Messages", exact: true });
    await expectIndustrialSurfaces(page);
    const preview = group.locator(".text-style-preview");
    await expect(preview).toHaveCSS("font-size", "14px");
    await expect(group.getByRole("button", { name: "Reset Agent Chat Messages" })).toHaveCount(0);
    await group.getByLabel("Font size").fill("22");
    await expect(preview).toHaveCSS("font-size", "22px");
    await group.getByLabel("Typeface").selectOption("georgia");
    await expect(preview).toHaveCSS("font-family", /^Georgia/);
    const asWritten = group.getByRole("radio", { name: "As written", exact: true });
    await expect(asWritten).toBeChecked();
    await asWritten.focus();
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "Uppercase", exact: true })).toBeChecked();
    await expect(preview).toHaveCSS("text-transform", "uppercase");
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "Lowercase", exact: true })).toBeChecked();
    await expect(preview).toHaveCSS("text-transform", "lowercase");
    // Other roles keep their own settings.
    await expect(
      panel.getByRole("group", { name: "Normal Text", exact: true }).locator(".text-style-preview"),
    ).toHaveCSS("font-size", "13px");
    await expect(panel.locator(".settings-group-reset")).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const heights = await group.evaluate((element) =>
      [".text-style-typeface select", ".segmented"].map(
        (selector) => element.querySelector(selector)?.getBoundingClientRect().bottom,
      ),
    );
    expect(heights[0]).toBe(heights[1]);
    await page.screenshot({ path: "test-results/text-settings-light.png" });
    await selectSettingsPage(page, "Appearance");
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await selectSettingsPage(page, "Text");
    await page.screenshot({ path: "test-results/text-settings-dark.png" });
    await group.getByRole("button", { name: "Reset Agent Chat Messages" }).click();
    await expect(preview).toHaveCSS("font-size", "14px");
    await expect(asWritten).toBeChecked();
    await expect(group.getByLabel("Font size")).toHaveValue("");
    await expect(panel.locator(".settings-group-reset")).toHaveCount(0);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(620, 620),
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: "test-results/text-settings-narrow.png" });
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Settings explanations sit behind information tooltips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-settings-tips-"));
  const database = join(directory, "projects.sqlite");
  try {
    application = await launch(directory, directory, database);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSettingsPage(page, "Appearance");
    const panel = page.locator("#panel-settings-appearance");
    await expect(panel.locator("p")).toHaveCount(0);
    const signals = panel.getByRole("switch", { name: "Signal colors", exact: true });
    await expect(signals).toHaveAccessibleDescription(/^Adds color to status labels/);
    const about = panel.getByRole("button", { name: "About Signal colors", exact: true });
    // Assert after the rendering step delivers focus's automatic scroll events,
    // not in the brief interval before they can dismiss a newly opened tooltip.
    await about.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.focus();
          requestAnimationFrame(() => resolve());
        }),
    );
    await expect(page.getByRole("tooltip")).toHaveText(/^Adds color to status labels/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    // Escape also cancels a reveal still waiting for the focus scroll to settle.
    await about.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.blur();
          element.focus();
          element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          requestAnimationFrame(() => resolve());
        }),
    );
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await about.hover();
    await expect(page.getByRole("tooltip")).toHaveText(/^Adds color to status labels/);
    // The information button sits inside the row's label without toggling its switch.
    await about.click();
    await expect(signals).not.toBeChecked();
    await expect(page.getByRole("tooltip")).toHaveText(/^Adds color to status labels/);
    await page.screenshot({ path: "test-results/settings-tooltip.png" });
    // Later user scrolling retains its normal dismissal behavior.
    await page.locator(".settings-page").evaluate((element) => {
      element.scrollTop = element.scrollTop ? 0 : 1;
    });
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    for (const [name, button] of [
      ["Table defaults", "About Table defaults"],
      ["Polling", "About Chart ticker"],
      ["Updates", "About Updates"],
    ] as const) {
      await selectSettingsPage(page, name);
      await expect(page.getByRole("button", { name: button, exact: true })).toBeVisible();
    }
    await selectSettingsPage(page, "Polling");
    await expect(
      page.getByRole("spinbutton", { name: "Chart ticker seconds", exact: true }),
    ).toBeVisible();
    for (const name of ["Table defaults", "Text", "Polling", "Updates"] as const) {
      await selectSettingsPage(page, name);
      const visible = page.locator(
        '[id^="panel-settings-"]:visible .settings-section > p:not([role])',
      );
      await expect(visible).toHaveCount(0);
    }
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Settings pages share one card layout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-settings-layout-"));
  const database = join(directory, "projects.sqlite");
  try {
    application = await launch(directory, directory, database);
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const pages = [
      "Agents",
      "Appearance",
      "Table defaults",
      "Text",
      "Polling",
      "Updates",
      "About",
    ] as const;
    const capture = async (suffix: string) => {
      for (const name of pages) {
        await selectSettingsPage(page, name);
        const panel = page.locator('[id^="panel-settings-"]:visible');
        await expect(panel.locator(".settings-section-header h2")).toHaveText(name);
        // Every row and field group sits in a bordered card.
        await expect(panel.locator(".settings-row:not(.settings-card .settings-row)")).toHaveCount(
          0,
        );
        expect(await panel.locator(".settings-card, .settings-group").count()).toBeGreaterThan(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `test-results/settings-${name.toLowerCase().replace(" ", "-")}-${suffix}.png`,
          fullPage: true,
        });
      }
    };
    await selectSettingsPage(page, "Agents");
    await expect(page.getByRole("group", { name: "Permissions", exact: true })).toBeVisible();
    await selectSettingsPage(page, "Table defaults");
    const low = page.getByRole("radio", { name: "Low", exact: true });
    await low.check();
    await expect(low).toBeChecked();
    await page.getByRole("radio", { name: "High", exact: true }).check();
    await selectSettingsPage(page, "Polling");
    const history = page.getByRole("group", { name: "Run history", exact: true });
    await expect(
      history.getByRole("button", { name: "Reset run history", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Chart ticker seconds" })).toHaveValue("5");
    await capture("light");
    await selectSettingsPage(page, "Appearance");
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await capture("dark");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(620, 620),
    );
    await capture("narrow");
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Chat file panel tabs, scoped reads, themes and responsive layout", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-files-ui-"));
  const folder = join(directory, "repo");
  await mkdir(join(folder, "src"), { recursive: true });
  await mkdir(join(folder, "test"));
  await writeFile(
    join(folder, "src", "main.ts"),
    Array.from({ length: 160 }, (_, i) => `export const row${i} = ${i};`).join("\n"),
  );
  await writeFile(join(folder, "test", "main.ts"), "export const other = 99;\n");
  await writeFile(join(folder, "empty.txt"), "");
  await writeFile(join(folder, ".hidden.txt"), "hidden fixture");
  await writeFile(join(folder, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(folder, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
  try {
    application = await launch(directory, folder, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
      await window.desktop.setPollingPaused(true);
    });
    await selectProjectConversation(page);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1500, 900),
    );
    const toggle = page.getByRole("button", { name: "Toggle files panel" });
    const panel = page.locator("#chat-file-panel");
    const tabs = page.getByRole("tablist", { name: "File tabs" });
    const open = page.getByRole("button", { name: "Open Files", exact: true });
    const add = page.getByRole("button", { name: "New file tab" });
    const files = panel.locator(".files-page");
    const inspector = page.getByRole("complementary", { name: "File preview", exact: true });
    const explorers = tabs.getByRole("tab", { name: "File Explorer", exact: true });
    const fileContext = () =>
      page.evaluate(async () => (await window.desktop.snapshot()).files?.context ?? null);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toHaveAttribute("data-minimized", "true");
    await expect(panel).toHaveCSS("width", "0px");
    await expect(panel).toHaveAttribute("inert", "");
    await expect(toggle).toBeVisible();
    expect(await toggle.evaluate((element) => element.closest(".file-panel") === null)).toBe(true);
    for (const edge of ["top", "right", "bottom", "left"]) {
      await expect(panel).toHaveCSS(`border-${edge}-width`, "0px");
      await expect(panel).toHaveCSS(`border-${edge}-style`, "solid");
      await expect(panel).toHaveCSS(`border-${edge}-color`, "rgb(208, 208, 208)");
    }
    await toggle.click();
    await expect(open).toBeVisible();
    await expectIconAction(toggle);
    await expectIconAction(add);
    await expectIconAction(page.getByRole("button", { name: /^New chat in / }));
    await expect(tabs.getByRole("tab")).toHaveCount(0);
    expect(await fileContext()).toBeNull();
    const empty = await panel.locator(".file-panel-empty").boundingBox();
    const link = await open.boundingBox();
    expect(
      Math.abs((empty?.x ?? 0) + (empty?.width ?? 0) / 2 - (link?.x ?? 0) - (link?.width ?? 0) / 2),
    ).toBeLessThan(2);
    await add.click();
    await expect(tabs.getByRole("tab", { name: "New tab", exact: true })).toBeFocused();
    await page.keyboard.press("Delete");
    await expect(add).toBeFocused();
    await expect(open).toBeVisible();
    await open.click();
    await expect(explorers).toHaveCount(1);
    const closeExplorer = tabs.getByRole("button", { name: "Close File Explorer", exact: true });
    await page.mouse.move(1, 1);
    const closeColor = await closeExplorer.evaluate((element) => getComputedStyle(element).color);
    await explorers.hover();
    await expect(closeExplorer).toHaveCSS("color", closeColor);
    await expect(explorers.locator("svg")).toHaveCSS(
      "color",
      await explorers.evaluate((element) => getComputedStyle(element).color),
    );
    await expectIconAction(closeExplorer);
    await expect(files).toBeVisible();
    await expect(files.getByLabel("File root")).toHaveValue(await realpath(folder));
    await expect(panel).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const divider = panel.getByRole("button", { name: "Resize files panel", exact: true });
    const chatWidth = (await page.locator(".chat-workspace-body").boundingBox())?.width ?? 0;
    await expect
      .poll(async () => Math.abs(((await panel.boundingBox())?.width ?? 0) - chatWidth * 0.2))
      .toBeLessThan(2);
    const initialWidth = (await panel.boundingBox())?.width ?? 0;
    await expect(divider).toHaveCSS("border-left-width", "0px");
    await expect(toggle).toHaveAttribute("title", "Close files panel");
    const lastTab = await tabs.locator(".file-tab").last().boundingBox();
    const plus = await add.boundingBox();
    const drawer = await toggle.boundingBox();
    expect(
      Math.abs((plus?.x ?? 0) - (lastTab?.x ?? 0) - (lastTab?.width ?? 0)),
    ).toBeLessThanOrEqual(5);
    expect(Math.abs((plus?.y ?? 0) - (drawer?.y ?? 0))).toBeLessThan(3);
    expect(Math.abs(initialWidth - chatWidth * 0.2)).toBeLessThan(2);
    await divider.focus();
    await divider.press("ArrowLeft");
    await expect.poll(async () => (await panel.boundingBox())?.width).toBe(initialWidth + 20);
    const grip = await divider.boundingBox();
    if (!grip) throw new Error("Missing panel divider");
    await page.mouse.move(grip.x + 3, grip.y + 100);
    await page.mouse.down();
    await page.mouse.move(grip.x - 47, grip.y + 100);
    await page.mouse.up();
    await expect
      .poll(async () => (await panel.boundingBox())?.width ?? 0)
      .toBeGreaterThan(initialWidth + 60);
    const resizedWidth = (await panel.boundingBox())?.width;
    const settings = files.getByRole("button", { name: "File Explorer settings", exact: true });
    const dialog = page.getByRole("dialog", { name: "File Explorer settings", exact: true });
    await expectIconAction(settings);
    await settings.click();
    await expectIconAction(dialog.getByRole("button", { name: "Close File Explorer settings" }));
    await dialog.getByRole("checkbox", { name: "Show hidden files" }).check();
    await expect(files.getByRole("treeitem", { name: ".hidden.txt", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    const src = files.getByRole("treeitem", { name: "src", exact: true });
    await src.focus();
    await src.press("ArrowRight");
    const main = files.getByRole("treeitem", { name: "main.ts", exact: true });
    await expect(main).toBeVisible();
    await main.focus();
    await main.press("Enter");
    const mainTab = tabs.getByRole("tab", { name: "main.ts", exact: true });
    await expect(mainTab).toHaveAttribute("aria-selected", "true");
    await expect(files).toHaveCount(0);
    await expect(inspector.locator(".view-lines")).toContainText("row0");
    await expect(inspector.locator("textarea")).toHaveAttribute("readonly", "true");
    // Monaco hides its find options in narrow panels. Exercise their focus styles at full width.
    for (let step = 0; step < 10; step++) {
      const target = ((await panel.boundingBox())?.width ?? 0) + 20;
      await divider.press("ArrowLeft");
      await expect.poll(async () => (await panel.boundingBox())?.width).toBe(target);
    }
    await inspector.getByRole("textbox", { name: "Read-only file content", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+f");
    const findClose = inspector.locator(".find-widget .codicon-widget-close");
    await expect(findClose).toBeVisible();
    await expect(inspector.locator(".find-widget .codicon-case-sensitive")).toBeVisible();
    // Test the hover style independently of native window cursor updates. Electron
    // can drop synthetic mouse moves over Monaco on both macOS and Windows.
    const devtools = await page.context().newCDPSession(page);
    await devtools.send("DOM.enable");
    await devtools.send("CSS.enable");
    try {
      const { root } = await devtools.send("DOM.getDocument");
      const originalTheme = await page.evaluate(() => document.documentElement.dataset.colorScheme);
      await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
      await page.getByRole("note", { name: "Running Code60 version" }).hover();
      const leftNavigation = page.locator("#tab-prompts");
      await expect(leftNavigation).toHaveCSS("transition-property", "background-color");
      await expect(leftNavigation).toHaveCSS("transition-duration", "0.175s");
      await expect(leftNavigation).toHaveCSS("transition-delay", "0.02s");
      try {
        for (const selected of [true, false]) {
          const selector = `.file-tabs .file-tab[data-selected="${selected}"]`;
          const row = tabs.locator(`.file-tab[data-selected="${selected}"]`).first();
          const label = row.getByRole("tab");
          const close = row.getByRole("button", { name: /^Close / });
          const { nodeId } = await devtools.send("DOM.querySelector", {
            nodeId: root.nodeId,
            selector,
          });
          const { nodeId: labelId } = await devtools.send("DOM.querySelector", {
            nodeId,
            selector: '[role="tab"]',
          });
          const { nodeId: closeId } = await devtools.send("DOM.querySelector", {
            nodeId,
            selector: ".file-tab-close",
          });
          await expect(row).toHaveCSS("transition-property", "background-color");
          await expect(row).toHaveCSS("transition-duration", "0.175s");
          await expect(row).toHaveCSS("transition-delay", "0.02s");
          for (const theme of ["light", "dark"]) {
            await page.evaluate((theme) => {
              document.documentElement.dataset.colorScheme = theme;
            }, theme);
            const colors = await row.evaluate((element) => {
              const probe = document.createElement("span");
              document.body.append(probe);
              const read = (token: string) => {
                probe.style.backgroundColor = `var(${token})`;
                return getComputedStyle(probe).backgroundColor;
              };
              const result = {
                selected: read("--accent-bg"),
                hover: read("--hover-bg"),
                active: element.getAttribute("data-selected") === "true",
              };
              probe.remove();
              return result;
            });
            const resting = colors.active ? colors.selected : "rgba(0, 0, 0, 0)";
            await expect(row).toHaveCSS("background-color", resting);
            await devtools.send("CSS.forcePseudoState", {
              nodeId,
              forcedPseudoClasses: ["hover"],
            });
            for (const target of [labelId, closeId]) {
              await devtools.send("CSS.forcePseudoState", {
                nodeId: target,
                forcedPseudoClasses: ["hover"],
              });
              await expect(row).toHaveCSS("background-color", colors.hover);
              await expect(label).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
              await expect(close).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
              await devtools.send("CSS.forcePseudoState", {
                nodeId: target,
                forcedPseudoClasses: [],
              });
            }
            await devtools.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
            await expect(row).toHaveCSS("background-color", resting);
            await expect(row).toHaveCSS("transition-delay", "0.02s");
          }
        }
        for (const media of [
          { reducedMotion: "reduce" as const, forcedColors: "none" as const },
          { reducedMotion: "no-preference" as const, forcedColors: "active" as const },
        ]) {
          await page.emulateMedia(media);
          await expect(leftNavigation).toHaveCSS("transition-property", "none");
          await expect(tabs.locator(".file-tab").first()).toHaveCSS("transition-property", "none");
        }
      } finally {
        await page.evaluate((theme) => {
          if (theme === undefined) delete document.documentElement.dataset.colorScheme;
          else document.documentElement.dataset.colorScheme = theme;
        }, originalTheme);
        await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
      }
      for (const icon of ["widget-close", "case-sensitive"]) {
        const selector = `.find-widget .codicon-${icon}`;
        const control = inspector.locator(selector);
        const { nodeId } = await devtools.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector,
        });
        const highlighted = await iconHighlight(control);
        await devtools.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
        try {
          await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
          await expect
            .poll(() => control.evaluate((element) => getComputedStyle(element, "::before").color))
            .toBe(highlighted);
        } finally {
          await devtools.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
        }
        await control.focus();
        await expect(control).toBeFocused();
        await expect
          .poll(() => control.evaluate((element) => getComputedStyle(element, "::before").color))
          .toBe(highlighted);
        await expect(control).toHaveCSS("outline-style", "none");
        await expect(control).toHaveCSS("border-top-width", "0px");
        await expect(control).toHaveCSS("box-shadow", "none");
      }
    } finally {
      await devtools.detach();
    }
    await findClose.click();
    for (let step = 0; step < 10; step++) {
      const target = ((await panel.boundingBox())?.width ?? 0) - 20;
      await divider.press("ArrowRight");
      await expect.poll(async () => (await panel.boundingBox())?.width).toBe(target);
    }
    await expect.poll(async () => (await panel.boundingBox())?.width).toBe(resizedWidth);
    await inspector.getByRole("textbox", { name: "Read-only file content", exact: true }).focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(inspector.locator(".selected-text")).toHaveCount(1);
    await explorers.first().click();
    await main.click();
    await expect(inspector.locator(".selected-text")).toHaveCount(1);
    await expect(inspector.locator(".monaco-editor-background")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await inspector.locator(".view-lines").hover();
    await page.mouse.wheel(0, 900);
    await expect(inspector.locator(".view-line").first()).not.toContainText("row0 ");
    const firstLine = await inspector.locator(".view-line").first().textContent();
    await explorers.first().click();
    await expect(main).toHaveAttribute("aria-selected", "true");
    await main.click();
    await expect(mainTab).toHaveCount(1);
    await expect(inspector.locator(".view-line").first()).toHaveText(firstLine ?? "");
    await add.click();
    await expect(open).toBeVisible();
    await expect.poll(fileContext).toBeNull();
    await open.click();
    await expect(explorers).toHaveCount(2);
    await expect(main).toBeVisible();
    await expect(files.getByRole("treeitem", { name: ".hidden.txt", exact: true })).toBeVisible();
    const secondExplorerId = await explorers.last().getAttribute("id");
    await explorers.last().press("Alt+ArrowLeft");
    await expect(explorers.last()).toBeFocused();
    await expect(tabs.getByRole("tab")).toHaveText(["File Explorer", "File Explorer", "main.ts"]);
    // Electron's native drag loop races macOS cursor events under automation.
    // Send the browser drag lifecycle with a real DataTransfer deterministically.
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    try {
      await mainTab.locator("..").dispatchEvent("dragstart", { dataTransfer: transfer });
      await explorers.first().locator("..").dispatchEvent("dragover", { dataTransfer: transfer });
      await explorers.first().locator("..").dispatchEvent("drop", { dataTransfer: transfer });
      await mainTab.locator("..").dispatchEvent("dragend", { dataTransfer: transfer });
    } finally {
      await transfer.dispose();
    }
    await expect(tabs.getByRole("tab")).toHaveText(["main.ts", "File Explorer", "File Explorer"]);
    await mainTab.focus();
    await mainTab.press("End");
    await expect(tabs.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(mainTab).toBeFocused();
    await mainTab.press("ArrowRight");
    await expect(explorers.first()).toBeFocused();
    await explorers.first().press("Delete");
    await expect(explorers).toHaveCount(1);
    await expect(explorers).toHaveAttribute("id", secondExplorerId ?? "");
    await expect(explorers).toBeFocused();
    await files.getByRole("treeitem", { name: "test", exact: true }).click();
    await expect(files.getByRole("treeitem", { name: "main.ts", exact: true })).toHaveCount(2);
    await files.getByRole("treeitem", { name: "main.ts", exact: true }).last().click();
    await expect(tabs.getByRole("tab", { name: "src/main.ts", exact: true })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "test/main.ts", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(inspector.locator(".view-lines")).toContainText("other = 99");
    await toggle.click();
    await expect(panel).toHaveAttribute("data-minimized", "true");
    await expect(panel).toHaveCSS("width", "0px");
    await expect(panel).toHaveAttribute("inert", "");
    await expect(toggle).toBeVisible();
    expect(await toggle.evaluate((element) => element.closest(".file-panel") === null)).toBe(true);
    await expect.poll(fileContext).toBeNull();
    await toggle.click();
    await expect.poll(async () => (await panel.boundingBox())?.width).toBe(resizedWidth);
    await expect(panel).toHaveCSS("transition-property", "width");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(panel).toHaveCSS("transition-duration", "0s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(inspector.locator(".view-lines")).toContainText("other = 99");
    await selectSettingsPage(page, "Appearance");
    await expect(panel).toBeHidden();
    await expect.poll(fileContext).toBeNull();
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await selectSidebarPage(page, "Chat");
    await expect(panel).toHaveCSS("background-color", "rgb(15, 23, 42)");
    await expect(panel).toHaveCSS("border-color", "rgb(42, 58, 85)");
    await expectIconAction(toggle);
    await expectIconAction(add);
    await expect(inspector.locator(".monaco-editor")).toHaveClass(/vs-dark/);
    await expect(inspector.locator(".monaco-editor-background")).toHaveCSS(
      "background-color",
      "rgb(15, 23, 42)",
    );
    await page.screenshot({ path: "test-results/file-panel-dark.png" });
    await selectSettingsPage(page, "Appearance");
    await page.getByLabel("Theme", { exact: true }).selectOption("system");
    await selectSidebarPage(page, "Chat");
    await expect(panel).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(panel).toHaveCSS("border-color", "rgb(208, 208, 208)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(panel).toHaveCSS("border-color", "rgb(42, 58, 85)");
    await expect(inspector.locator(".monaco-editor-background")).toHaveCSS(
      "background-color",
      "rgb(15, 23, 42)",
    );
    await expectIconAction(toggle);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(panel).toHaveCSS("border-color", "rgb(208, 208, 208)");
    await expectIconAction(toggle);
    await page.screenshot({ path: "test-results/file-panel-light.png" });
    // Explicit file switches update the existing reader even while automatic polling is paused.
    await writeFile(join(folder, "test", "main.ts"), "export const updated = 100;\n");
    await page.evaluate(() =>
      window.desktop.snapshot().then((snapshot) =>
        window.desktop.poll(["files"], {
          projectId: snapshot.projectInstanceId ?? undefined,
          databaseEpoch: snapshot.databaseEpoch,
        }),
      ),
    );
    await expect(inspector.locator(".view-lines")).toContainText("updated = 100");
    await rm(join(folder, "test", "main.ts"), { recursive: true, force: true });
    await page.evaluate(() =>
      window.desktop.snapshot().then((snapshot) =>
        window.desktop.poll(["files"], {
          projectId: snapshot.projectInstanceId ?? undefined,
          databaseEpoch: snapshot.databaseEpoch,
        }),
      ),
    );
    await expect(inspector.getByRole("alert")).toContainText("ENOENT");
    await writeFile(join(folder, "test", "main.ts"), "export const updated = 100;\n");
    await page.getByRole("button", { name: /^New chat in / }).click();
    await expect(tabs.getByRole("tab", { name: "test/main.ts", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: "Chat 1", exact: true }).click();
    await expect(tabs.getByRole("tab", { name: "test/main.ts", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Overflow scrolls only the tab strip; the new-tab action stays reachable.
    for (let i = 0; i < 8; i++) await add.click();
    const overflow = await tabs.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(true);
    await expect(add).toBeInViewport();
    for (let i = 0; i < 8; i++)
      await tabs.getByRole("button", { name: "Close New tab", exact: true }).last().click();

    await selectSidebarPage(page, "Files");
    for (const [name, error] of [
      ["binary.bin", "binary"],
      ["large.txt", "1 MiB"],
    ] as const) {
      await files.getByRole("treeitem", { name, exact: true }).click();
      await expect(inspector.getByRole("alert")).toContainText(error);
      await tabs.getByRole("button", { name: `Close ${name}`, exact: true }).click();
      await explorers.click();
    }
    await files.getByRole("treeitem", { name: "empty.txt", exact: true }).click();
    await expect(inspector.locator(".monaco-editor")).toBeVisible();
    for (const width of [1201, 1200]) {
      await application.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 650),
        width,
      );
      await expect(page.locator(".chat-workspace-body")).toHaveCSS(
        "flex-direction",
        width === 1201 ? "row" : "column",
      );
    }
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 650),
    );
    await page.evaluate(() => {
      for (const role of ["button", "human", "agent", "text"])
        document.documentElement.style.setProperty(`--${role}-size`, "32px");
    });
    const chat = page.locator(".orchestration-chat-page:visible");
    const draft = chat.getByRole("combobox", { name: "Message to orchestrator" });
    const multiline = "A multiline orchestrator draft.\nKeep the entire composer visible.";
    await draft.fill(multiline);
    await expectStackedComposer(chat);
    const layout = await page.evaluate(() => ({
      chat: document.querySelector(".chat-conversations")?.getBoundingClientRect().bottom,
      panel: document.querySelector("#chat-file-panel")?.getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    expect(layout.chat).toBeLessThanOrEqual(layout.panel ?? 0);
    expect(layout.overflow).toBe(false);
    await expect(panel).toHaveCSS("border-width", "0px 0px 0px 1px");
    await expect(divider).toBeHidden();
    await expect(add).toBeVisible();
    await page.screenshot({ path: "test-results/file-panel-narrow.png" });
    await page.evaluate(() => {
      for (const role of ["button", "human", "agent", "text"])
        document.documentElement.style.removeProperty(`--${role}-size`);
    });
    await toggle.click();
    await expect(panel).toHaveCSS("width", "0px");
    await expect(panel).toHaveCSS("height", "0px");
    await expect(toggle).toBeFocused();
    await toggle.press("Space");
    await expect(panel).toHaveAttribute("data-minimized", "false");
    await expect(add).toBeVisible();
    await expect(draft).toHaveValue(multiline);
    await page.evaluate(() => window.desktop.stopAll());
    const plain = join(directory, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "note.txt"), "plain folder");
    await selectSidebarPage(page, "Files");
    const retainedTabs = await tabs.getByRole("tab").allTextContents();
    await settings.click();
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, plain);
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await expect(dialog).toHaveCount(0);
    await expect(tabs.getByRole("tab")).toHaveCount(0);
    await selectSidebarPage(page, "Files");
    await files.getByRole("treeitem", { name: "note.txt", exact: true }).click();
    await expect(inspector.locator(".view-lines")).toContainText("plain folder");
    await page.evaluate(
      (project) =>
        window.desktop
          .snapshot()
          .then(({ databaseEpoch }) => window.desktop.openProject(project, databaseEpoch)),
      await realpath(folder),
    );
    await selectSidebarPage(page, "Chat");
    await expect(tabs.getByRole("tab")).toHaveText(retainedTabs);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Browse project files from sessions and worktrees", async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), "code60-browse-actions-"));
  const folder = join(directory, "repo");
  const external = join(directory, "external");
  await mkdir(folder);
  await writeFile(join(folder, "marker.txt"), "project marker");
  execFileSync("git", ["init", "-b", "main", folder]);
  execFileSync("git", ["-C", folder, "add", "."]);
  execFileSync("git", [
    "-C",
    folder,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  execFileSync("git", ["-C", folder, "worktree", "add", "-b", "external", external]);
  await writeFile(join(external, "marker.txt"), "external marker");
  try {
    application = await launch(directory, folder, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await page.evaluate(() => window.desktop.setPollingPaused(true));
    const [id] = await page.evaluate(() =>
      window.desktop.start({ agents: ["claude"], allow: [], allowAll: false }),
    );
    const initial = await page.evaluate(() => window.desktop.snapshot());
    const run = initial.runs.find((run) => run.record.id === id);
    expect(run).toBeTruthy();
    expect(initial.worktrees).toBeNull();
    await selectSidebarPage(page, "Sessions");
    const sessionCanvas = page.locator("#panel-sessions").getByTestId("data-grid-canvas");
    const openSessionActions = async () => {
      await selectSidebarPage(page, "Sessions");
      const box = await sessionCanvas.boundingBox();
      if (!box) throw new Error("Missing sessions grid");
      await page.mouse.click(box.x + actionsColumnX, box.y + 44);
    };
    await openSessionActions();
    await page.getByRole("menuitem", { name: "Browse project files", exact: true }).click();
    const files = page.locator("#panel-chat .files-page");
    await expect(files).toBeVisible();
    await expect(files.getByLabel("File root")).toHaveValue(await realpath(folder));
    await files.getByRole("treeitem", { name: "marker.txt", exact: true }).click();
    const inspector = page.getByRole("complementary", { name: "File preview" });
    await expect(inspector.locator(".view-lines")).toContainText("project marker");

    await selectSidebarPage(page, "Worktrees");
    // Explorer no longer scans worktree roots. Explicit refresh still works while paused.
    await refreshProjectData(page);
    const grid = page.locator("#panel-worktrees .sessions-grid");
    await expect(
      grid.locator("[data-testid^='glide-cell-1-']").filter({ hasText: /[\\/]external$/ }),
    ).toHaveCount(1);
    const paths = await grid.locator("[data-testid^='glide-cell-1-']").allTextContents();
    const index = paths.findIndex((path) => /[\\/]external$/.test(path));
    expect(index).toBeGreaterThanOrEqual(0);
    const canvas = grid.getByTestId("data-grid-canvas");
    const worktreeBox = await canvas.boundingBox();
    if (!worktreeBox) throw new Error("Missing worktrees grid");
    await page.mouse.click(worktreeBox.x + 70, worktreeBox.y + 32 + 24 * (index + 0.5));
    await canvas.press("Shift+F10");
    const browse = page.getByRole("menuitem", { name: "Browse project files", exact: true });
    await expect(browse).toBeFocused();
    await browse.press("Enter");
    await expect(files).toBeVisible();
    await expect(files.getByLabel("File root")).toHaveValue(await realpath(folder));
    await expect(inspector).toHaveCount(0);
    await files.getByRole("treeitem", { name: "marker.txt", exact: true }).click();
    await expect(inspector.locator(".view-lines")).toContainText("project marker");

    await page.evaluate(() => window.desktop.stopAll());
    await page.evaluate((id) => window.desktop.action({ type: "discard", id }), id as string);
    await selectSidebarPage(page, "Sessions");
    await openSessionActions();
    await expect(browse).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    const plain = join(directory, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "plain.txt"), "plain marker");
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, plain);
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await expect(
      page.evaluate(() => window.desktop.start({ agents: ["claude"], allow: [], allowAll: false })),
    ).rejects.toThrow("Set up Git");
    const current = await page.evaluate(() => window.desktop.snapshot());
    expect(current.runs).toHaveLength(0);
    expect(current.directory).toBe(await realpath(plain));
    // chooseFolder resolves before the batched snapshot reaches the renderer.
    // Wait for the new workspace and its tab reset, not the old Explorer tab.
    await expect(page.locator(".project-sidebar-open")).toHaveAttribute("title", "Open Project");
    await expectSelectedProject(page, current.directory as string);
    await expect(page.locator(".file-tabs").getByRole("tab")).toHaveCount(0);
    await selectSidebarPage(page, "Files");
    await expect(files).toBeVisible();
    await expect(files.getByLabel("File root")).toHaveValue(current.directory as string);
    await expect(files.getByRole("treeitem", { name: "plain.txt", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Projects plus opens projects, cancels, and confirms selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-project-card-"));
  const folder = join(directory, "project-one");
  const second = join(directory, "project-two");
  execFileSync("git", ["init", "-q", folder]);
  commitFixture(folder);
  await mkdir(second);
  try {
    application = await launch(directory, folder, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const card = page.locator(".project-sidebar-open");
    const modal = page.getByRole("dialog", { name: "Open Project", exact: true });
    const done = page.getByRole("group", { name: "Done notification", exact: true });
    await expect(card).toHaveAttribute("aria-label", "Connect to database");
    const databaseAction = page
      .locator(".app-footer")
      .getByRole("button", { name: "Select or create database", exact: true });
    const returnAction = page.getByRole("button", { name: "return to splash page", exact: true });
    await expect(returnAction).toHaveAttribute("title", "return to splash page");
    await expect(returnAction.locator("svg")).toHaveCount(1);
    await expect(card).toHaveCSS("height", "40px");
    await expect(card).toHaveCSS("justify-content", "center");
    await expect(card).toHaveCSS("text-align", "center");
    await expect(card).toHaveCSS("padding-left", "0px");
    await expect(card).toHaveCSS("padding-right", "0px");
    const sidebarGaps = await page
      .locator(
        ".sidebar-content, .sidebar .page-tab-list, .chat-sidebar-list, .chat-sidebar-group, .chat-worker-children",
      )
      .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).rowGap));
    expect(sidebarGaps.length).toBeGreaterThan(0);
    expect(sidebarGaps.every((gap) => gap === "0px")).toBe(true);
    await expect(page.locator("#tab-chat")).toHaveCSS("height", "40px");
    // The label keeps its minimum inset at the default 15px size.
    await expect(page.locator("#tab-chat")).toHaveCSS("padding-left", "40px");
    await expect(databaseAction).toHaveCSS("height", "20px");
    await expect(returnAction).toHaveCSS("height", "20px");
    await expect(page.locator(".app-footer")).toHaveCSS("padding-bottom", "4px");
    const timestampOpacity = await page
      .locator(".poll-timestamp")
      .evaluate((element) => getComputedStyle(element).opacity);
    // The disabled Last Message indicator is dimmed; the available database action is not.
    expect(timestampOpacity).toBe("0.6");
    await expect(databaseAction).toHaveCSS("opacity", "1");
    for (const selector of [".poll-timestamp", ".app-version"])
      await expect(page.locator(selector)).toHaveCSS("font-variant-numeric", "tabular-nums");
    const bottomSpace = await page.evaluate(() =>
      [".poll-timestamp", ".footer-splash", ".footer-database", ".app-version"].map((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error("Missing footer item");
        return innerHeight - element.getBoundingClientRect().bottom;
      }),
    );
    for (const space of bottomSpace) expect(space).toBeGreaterThanOrEqual(4);
    await expect(
      page
        .getByRole("navigation", { name: "Sidebar" })
        .getByRole("button", { name: "Select or create database", exact: true }),
    ).toHaveCount(0);
    const actionBounds = await databaseAction.boundingBox();
    const returnBounds = await returnAction.boundingBox();
    const sidebarBounds = await page.locator(".sidebar").boundingBox();
    const timestampBounds = await page.locator(".poll-timestamp").boundingBox();
    expect(actionBounds && sidebarBounds && timestampBounds).toBeTruthy();
    if (!actionBounds || !returnBounds || !sidebarBounds || !timestampBounds)
      throw new Error("Footer database action or Last Message indicator is missing");
    expect(returnBounds.x + returnBounds.width).toBeLessThan(actionBounds.x);
    expect(returnBounds.x).toBeGreaterThanOrEqual(timestampBounds.x + timestampBounds.width);
    expect(
      Math.abs(
        actionBounds.y + actionBounds.height / 2 - timestampBounds.y - timestampBounds.height / 2,
      ),
    ).toBeLessThanOrEqual(1);
    expect(actionBounds.x).toBeGreaterThanOrEqual(timestampBounds.x + timestampBounds.width);
    expect(
      Math.abs(actionBounds.x + actionBounds.width - sidebarBounds.x - sidebarBounds.width),
    ).toBeLessThanOrEqual(10);
    const resizeSidebar = page.getByRole("button", {
      name: "Resize navigation sidebar",
      exact: true,
    });
    await resizeSidebar.press("ArrowRight");
    await expect
      .poll(async () => (await databaseAction.boundingBox())?.x)
      .toBe(actionBounds.x + 20);
    await resizeSidebar.press("ArrowLeft");
    await expect.poll(() => databaseAction.boundingBox()).toEqual(actionBounds);
    await page.locator(".page-tabs").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await databaseAction.boundingBox()).toEqual(actionBounds);
    await databaseAction.focus();
    await databaseAction.press("Enter");
    const databaseModal = page.getByRole("dialog", { name: "Select database", exact: true });
    await expect(
      databaseModal.getByRole("button", { name: "Open existing database…", exact: true }),
    ).toBeVisible();
    await databaseModal.getByRole("button", { name: "Create database…", exact: true }).click();
    await expect(databaseModal).toHaveCount(0);
    await databaseAction.click();
    await expect(databaseModal).toContainText("Connected to");
    await databaseModal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(databaseModal).toHaveCount(0);
    await expect(databaseAction).toBeFocused();
    await expect(card).toHaveAttribute("aria-label", "Open Project");
    await expect(card).toHaveCSS("border-top-width", "0px");
    await expect(card).toHaveCSS("background-image", "none");
    await page.mouse.move(1, 1);
    const sidebarFill = "rgba(0, 0, 0, 0)";
    await expect(card).toHaveCSS("background-color", sidebarFill);
    await expect(card.locator("svg")).toHaveCount(1);
    await expect(page.locator(".chat-page-heading .project-sidebar-open")).toHaveCount(1);
    await expect(page.locator("#tab-chat [data-icon='clipboard']")).toHaveCount(1);
    await expect(page.locator(".sidebar-header")).toHaveCount(0);
    await page.screenshot({ path: "test-results/project-card-empty.png" });
    await card.focus();
    await card.press("Enter");
    await expect(modal).toBeVisible();
    await expect(modal.getByText("No recent projects.")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Clear history", exact: true })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Close Open Project" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(card).toBeFocused();
    await card.click();
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await modal.getByRole("button", { name: "Open Folder", exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(card).toHaveAttribute("aria-label", "Open Project");
    await expect(done).toHaveCount(0);
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, folder);
    // Cancelling the native confirmation also leaves the current project/history untouched.
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await modal.getByRole("button", { name: "Open Folder", exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(card).toHaveAttribute("aria-label", "Open Project");
    await expect(modal.getByText("No recent projects.")).toBeVisible();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await modal.getByRole("button", { name: "Open Folder", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expectSelectedProject(page, folder);
    await expect(card).toHaveCSS("border-top-width", "0px");
    await expect(card).toHaveCSS("background-image", "none");
    await page.mouse.move(1, 1);
    await expect(card).toHaveCSS("background-color", sidebarFill);
    await expect(done).toContainText("Opened project-one.");
    await page.screenshot({ path: "test-results/project-card-open.png" });
    await done.getByRole("button", { name: "Dismiss notification" }).click();
    await card.click();
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, second);
    await modal.getByRole("button", { name: "Open Folder", exact: true }).click();
    await expectSelectedProject(page, second);
    await done.getByRole("button", { name: "Dismiss notification" }).click();
    await card.click();
    await modal.locator(".project-item").filter({ hasText: "project-one" }).click();
    const projectConfirmation = page.getByRole("dialog", { name: "Open project?", exact: true });
    await expect(projectConfirmation).toContainText(folder);
    await projectConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectSelectedProject(page, second);
    await expect(modal).toBeVisible();
    await modal.locator(".project-item").filter({ hasText: "project-one" }).click();
    const temporarilyMissing = `${folder}-missing`;
    await rename(folder, temporarilyMissing);
    await projectConfirmation.getByRole("button", { name: "Open project", exact: true }).click();
    await expect(projectConfirmation.getByRole("alert")).toBeVisible();
    await expectSelectedProject(page, second);
    await rename(temporarilyMissing, folder);
    await projectConfirmation.getByRole("button", { name: "Open project", exact: true }).click();
    await expectSelectedProject(page, folder);
    await expect(done).toContainText("Opened project-one.");
    await done.getByRole("button", { name: "Dismiss notification" }).click();
    const beforeReturn = await page.evaluate(() => window.desktop.snapshot());
    await returnAction.click();
    await expect(page.locator(".splash-enter")).toBeVisible();
    await expect(page.locator(".splash .project-list")).toHaveCount(0);
    const afterReturn = await page.evaluate(() => window.desktop.snapshot());
    expect(afterReturn.directory).toBe(beforeReturn.directory);
    expect(afterReturn.chats.map((chat) => chat.directory)).toEqual(
      beforeReturn.chats.map((chat) => chat.directory),
    );
    // Start re-enters without changing the open project.
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".splash")).toHaveCount(0);
    await expectSelectedProject(page, folder);
    await returnAction.click();
    // The open project and reload marker must not immediately dismiss an explicit return.
    await page.reload();
    await expect(page.locator(".splash-enter")).toBeVisible();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".splash")).toHaveCount(0);
    await expectSelectedProject(page, folder);
    await page.getByRole("button", { name: "Data Viewer", exact: true }).click();
    await expect(page.locator("#tab-sessions")).toHaveCSS("padding-left", "88px");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page.locator("#tab-settings-appearance")).toHaveCSS("padding-left", "64px");
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(page.getByRole("button", { name: "Experiments", exact: true })).toHaveCSS(
      "padding-left",
      "88px",
    );
    await page.getByRole("button", { name: "Experiments", exact: true }).click();
    await expect(page.locator("#tab-episodic-memory")).toHaveCSS("padding-left", "112px");
    await page.evaluate(() =>
      window.desktop.start({ agents: ["claude"], allow: [], allowAll: false }),
    );
    await expect(card).toBeEnabled();
    await expect(databaseAction).toBeDisabled();
    await expect(returnAction).toBeEnabled();
    await returnAction.click();
    const activeSplash = page.locator(".splash");
    await expect(activeSplash.locator(".project-item")).toHaveCount(0);
    await expect(activeSplash.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
    await activeSplash.getByRole("button", { name: "Start", exact: true }).click();
    await card.click();
    await modal.locator(".project-item").filter({ hasText: "project-two" }).click();
    await expect(projectConfirmation).toBeVisible();
    await expect(projectConfirmation).toContainText(second);
    await expect(
      projectConfirmation.getByRole("button", { name: "Open project", exact: true }),
    ).toBeEnabled();
    await projectConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await modal.getByRole("button", { name: "Remove project-two from history" }).click();
    await expect(modal.locator(".project-item")).toHaveCount(1);
    await expect(modal.locator(".project-item")).toContainText("project-one");
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    const activeAfterWelcomeActions = await page.evaluate(() => window.desktop.snapshot());
    expect(activeAfterWelcomeActions.active).toBe(true);
    expect(activeAfterWelcomeActions.directory).toBe(beforeReturn.directory);
    await card.hover();
    await expect(card).toHaveCSS("background-color", sidebarFill);
    await expect(card).toHaveCSS("background-image", "none");
    await expect(card).toHaveCSS("border-top-width", "0px");
    await page.evaluate(() => window.desktop.stopAll());
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: agent setup wizard handles missing agents, authentication, timeout, cancellation and retry", async () => {
  test.setTimeout(75_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-setup-failures-"));
  const configFile = join(directory, "config/code60/config.json");
  const command = [process.execPath, join(root, "test/fixtures/fake-agent.mjs")];
  const agents = {
    antigravity: { command: [join(directory, "missing-executable")] },
    claude: { command: [...command, "--auth"] },
    codex: { command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] },
  };
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ agents }));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"), false);
    const page = await application.firstWindow();
    const wizard = page.locator(".agent-setup-dialog");
    const connect = async (name: string) => {
      await wizard.getByRole("button", { name, exact: true }).click();
    };
    await connect("Antigravity");
    await expect(wizard.getByRole("alert")).toContainText("not found");
    await wizard.getByRole("button", { name: "Choose another agent", exact: true }).click();
    await connect("Claude");
    await expect(wizard.getByRole("alert")).toContainText("log in");
    await expect(wizard.getByText("Detected", { exact: true })).toBeVisible();
    expect(
      (await page.evaluate(() => window.desktop.snapshot())).agentSetup?.session?.verified,
    ).toEqual([]);
    await wizard.getByRole("button", { name: "Choose another agent", exact: true }).click();
    await connect("Codex");
    await expect(wizard.getByRole("status")).toHaveText("Connecting to Codex…");
    await wizard.getByRole("button", { name: "Cancel attempt", exact: true }).click();
    await expect(wizard.getByRole("button", { name: "Codex", exact: true })).toBeVisible();
    await connect("Codex");
    await expect(wizard.getByRole("status")).toHaveText("Connecting to Codex…");
    await page.reload();
    await expect(wizard.getByRole("button", { name: "Codex", exact: true })).toBeVisible();
    expect(
      (await page.evaluate(() => window.desktop.snapshot())).agentSetup?.session?.verified,
    ).toEqual([]);
    await connect("Codex");
    await expect(wizard.getByRole("alert")).toContainText("timed out", { timeout: 25_000 });
    agents.codex.command = command;
    await writeFile(configFile, JSON.stringify({ agents }));
    await wizard.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(wizard.getByRole("status")).toHaveText("Codex connected");
    expect((await page.evaluate(() => window.desktop.snapshot())).agents).toEqual(["codex"]);
    await wizard.getByRole("button", { name: "Add another agent", exact: true }).click();
    await connect("Claude");
    await expect(wizard.getByRole("alert")).toContainText("log in");
    await wizard.getByRole("button", { name: "Close", exact: true }).click();
    await expect(wizard).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).agents).toEqual(["codex"]);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: ACP session information and idle-only harness modes", async () => {
  const testInfo = test.info();
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-session-info-"));
  execFileSync("git", ["init", "-q", directory]);
  commitFixture(directory);
  const configFile = join(directory, "config", "code60", "config.json");
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--session-info"],
        },
      },
    }),
  );
  application = await launch(directory, directory, join(directory, "projects.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectProjectConversation(page);
    const chatId = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    const chat = page.locator(`.orchestration-chat-page[data-chat-id="${chatId}"]`);
    const info = chat.getByLabel("Session information", { exact: true });
    await expect(info).toContainText("Fixture Model");
    const context = info.locator(".context-donut");
    await expect(context).toHaveAttribute("data-tooltip", /26.5%/);
    const selector = info.getByLabel("Harness mode", { exact: true });
    await expect(selector).toHaveAttribute("data-tooltip", /Code60 auto-approval: On/);
    await expect(selector).toHaveText("Ask for approval");
    await expect(selector).toHaveAttribute("aria-disabled", "false");
    await expect(info.locator(".composer-harness img")).toHaveCSS("width", "20px");
    await selector.click();
    await chat.getByLabel("Message to orchestrator", { exact: true }).click();
    await expect(page.getByRole("menu", { name: "Harness modes", exact: true })).toHaveCount(0);
    await selector.focus();
    await selector.press("ArrowDown");
    const menu = page.getByRole("menu", { name: "Harness modes", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Standard", { exact: true })).toBeVisible();
    const menuBox = await menu.boundingBox();
    const modeBox = await selector.boundingBox();
    expect(menuBox && modeBox && menuBox.y + menuBox.height <= modeBox.y).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("harness-mode-menu.png") });

    await expect(
      menu.getByRole("menuitemradio", { name: "Ask for approval", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      menu.getByRole("menuitemradio", { name: "Full Access", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(selector).toBeFocused();
    await expect(menu).toHaveCount(0);
    const choose = async (trigger: Locator, option: string) => {
      await trigger.click();
      await page.getByRole("menuitemradio", { name: option, exact: true }).click();
      await expect(trigger).toHaveText(option);
    };
    await choose(selector, "Full Access");
    const order = await info
      .locator(".composer-session-summary")
      .evaluate((element) => [...element.children].map((child) => child.className));
    expect(order).toEqual([
      "context-donut",
      "composer-model",
      "composer-harness",
      "primary composer-send",
    ]);
    await context.focus();
    await expect(page.getByRole("tooltip")).toContainText("53,000 / 200,000 tokens (26.5%)");
    await page.keyboard.press("Escape");
    const composer = chat.getByLabel("Message to orchestrator", { exact: true });
    await composer.fill(
      JSON.stringify([{ usage: { used: 20000, size: 200000 } }, { hang: "cancellable" }]),
    );
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(selector).toHaveAttribute("aria-disabled", "true");
    await expect(context).toHaveAttribute("data-tooltip", /10.0%/);
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(selector).toHaveAttribute("aria-disabled", "false");
    await choose(selector, "Ask for approval");
    await composer.fill("Keep my draft");
    await page.reload();
    await expect(composer).toHaveValue("Keep my draft");
    await expect(selector).toHaveText("Ask for approval");
    await expect(context).toHaveAttribute("data-tooltip", /10.0%/);

    const [id] = await page.evaluate(() =>
      window.desktop.start({ agents: ["claude"], allow: [], allowAll: false }),
    );
    if (!id) throw new Error("Missing worker");
    await page.locator(`#conversation-${id}`).click();
    const worker = page.locator(`#chat-${id}`);
    await expect(worker.getByLabel("Message", { exact: true })).toBeEnabled();
    const workerInfo = worker.getByLabel("Session information", { exact: true });
    await expect(workerInfo).toContainText("Fixture Model");
    const workerMode = workerInfo.getByLabel("Harness mode", { exact: true });
    await choose(workerMode, "Full Access");
    await expect(workerMode).toHaveText("Full Access");
    await expect(selector).toHaveText("Ask for approval");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 700),
    );
    expect(await workerInfo.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath("session-info-light.png"),
      animations: "disabled",
    });
    await page.evaluate(() => {
      document.documentElement.dataset.colorScheme = "dark";
    });
    await page.screenshot({
      path: testInfo.outputPath("session-info-dark.png"),
      animations: "disabled",
    });
    await page.emulateMedia({ forcedColors: "active" });
    await expect(workerInfo.locator(".context-track")).not.toHaveCSS("stroke", "none");
    await expect(workerInfo.locator(".context-used")).not.toHaveCSS("stroke", "none");
    await page.screenshot({ path: testInfo.outputPath("session-info-forced-colors.png") });
    await page.emulateMedia({ forcedColors: "none" });
    await page.evaluate(async (id) => {
      await window.desktop.action({ type: "finish", id });
    }, id);
    await expect(workerMode).toHaveAttribute("data-tooltip", /Last reported/);
    await expect(workerInfo).toContainText("Full Access");
    await expect(workerInfo.locator("select")).toHaveCount(0);
    await page.reload();
    await selectSidebarPage(page, "Sessions");
    const grid = page.locator("#panel-sessions .sessions-grid").getByTestId("data-grid-canvas");
    await expect(grid).toBeVisible();
    const box = await grid.boundingBox();
    if (!box) throw new Error("Missing sessions grid");
    await page.mouse.click(box.x + 20, box.y + 48);
    await expect(workerMode).toHaveAttribute("data-tooltip", /Last reported/);
    await expect(workerInfo).toContainText("Full Access");
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: review failures, retry, cancellation and late responses", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-diff-ui-"));
  const repo = join(directory, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "hello.txt"), "before\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  commitFixture(repo);
  try {
    application = await launch(directory, repo, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
      await window.desktop.start({ agents: ["claude"], allow: [], allowAll: false });
    });
    await selectSidebarPage(page, "Sessions");
    // The queued record contains its future path before Git creates the worktree.
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.snapshot()).runs[0]?.view?.status),
      )
      .toBe("idle");
    const worktree = await page.evaluate(
      async () => (await window.desktop.snapshot()).runs[0]?.record.worktree,
    );
    if (!worktree) throw new Error("Missing worktree");
    await writeFile(join(worktree, "hello.txt"), "after review refactor\n");
    const open = async () => {
      await selectSidebarPage(page, "Sessions");
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("combobox", { name: "Search commands" }).fill("Review changes");
      await page.keyboard.press("Enter");
      await page.getByRole("tab", { name: "Changes", exact: true }).click();
      await page
        .getByRole("navigation", { name: "Task revisions" })
        .getByRole("button")
        .last()
        .click();
    };
    const close = () => page.getByRole("button", { name: /^Close Revision \d+ ·/ }).click();
    const panel = page.locator(".review-panel");
    await open();
    await expect(panel.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "after review refactor",
    );
    const content = await page.evaluate(async () => {
      const snapshot = await window.desktop.snapshot();
      const summary = snapshot.reviews?.[0];
      if (!summary || !snapshot.directory) throw new Error("Missing review");
      const identity = {
        project: snapshot.directory,
        projectId: summary.projectId,
        databaseEpoch: summary.databaseEpoch,
        reviewId: summary.id,
        requestId: crypto.randomUUID(),
      };
      const review = await window.desktop.readReview(identity);
      const revision = review.revisions.at(-1);
      if (!revision?.files[0]) throw new Error("Missing captured file");
      return window.desktop.readReviewFile({
        ...identity,
        revisionId: revision.id,
        fileKey: revision.files[0].key,
      });
    });
    await close();
    await application.evaluate(({ ipcMain }, content) => {
      const state = {
        mode: "error",
        content,
        requests: [] as string[],
        cancelled: [] as string[],
        resolve: undefined as undefined | ((value: typeof content) => void),
      };
      Object.assign(globalThis, { reviewTest: state });
      ipcMain.removeHandler("desktop:review-file");
      ipcMain.removeHandler("desktop:diff-cancel");
      ipcMain.handle("desktop:review-file", (_event, request: { requestId: string }) => {
        state.requests.push(request.requestId);
        if (state.mode === "error") throw new Error("Review fixture failed");
        if (state.mode === "slow")
          return new Promise((resolve) => {
            state.resolve = resolve;
          });
        return { ...state.content, modified: "fresh response" };
      });
      ipcMain.handle("desktop:diff-cancel", (_event, request: { requestId: string }) => {
        state.cancelled.push(request.requestId);
      });
    }, content);
    const mode = (value: string) =>
      application.evaluate((_electron, value) => {
        (globalThis as unknown as { reviewTest: { mode: string } }).reviewTest.mode = value;
      }, value);
    await open();
    await expect(panel.getByRole("alert")).toContainText("Review fixture failed");
    await expect(panel.getByText("No changes.", { exact: true })).toHaveCount(0);
    await mode("success");
    await panel.getByRole("button", { name: "Retry file", exact: true }).click();
    await expect(panel.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "fresh response",
    );
    await expect(panel.getByRole("button", { name: "Refresh changes", exact: true })).toHaveCount(
      0,
    );
    await close();
    await mode("slow");
    await open();
    await expect(panel.getByText("Loading file…", { exact: true })).toBeVisible();
    const lastRequest = () =>
      application.evaluate(() =>
        (globalThis as unknown as { reviewTest: { requests: string[] } }).reviewTest.requests.at(
          -1,
        ),
      );
    const cancelled = (id: string | undefined) =>
      application.evaluate(
        (_electron, id) =>
          (
            globalThis as unknown as { reviewTest: { cancelled: string[] } }
          ).reviewTest.cancelled.includes(id ?? ""),
        id,
      );
    const resolve = () =>
      application.evaluate(() => {
        const state = (
          globalThis as unknown as {
            reviewTest: {
              content: { file: unknown; original: string; modified: string };
              resolve?: (value: unknown) => void;
            };
          }
        ).reviewTest;
        state.resolve?.({ ...state.content, modified: "stale response" });
      });
    const request = await lastRequest();
    await close();
    await expect.poll(() => cancelled(request)).toBe(true);
    await mode("success");
    await open();
    await expect(panel.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "fresh response",
    );
    await resolve();
    await expect(panel.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "fresh response",
    );
    await page.evaluate(() => window.desktop.stopAll());
    await close();
    await mode("slow");
    await open();
    await expect(panel.getByText("Loading file…", { exact: true })).toBeVisible();
    const workspaceRequest = await lastRequest();
    const other = join(directory, "other");
    await mkdir(other);
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, other);
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch)),
    );
    await expect(panel).toBeHidden();
    await expect.poll(() => cancelled(workspaceRequest)).toBe(true);
    await resolve();
    await expect(panel).toBeHidden();
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: read-only revisions span workers and preserve saved diffs after restart", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-chat-review-"));
  const repo = join(directory, "repo");
  const config = join(directory, "config", "code60");
  await mkdir(config, { recursive: true });
  await mkdir(repo);
  await writeFile(join(repo, "same.ts"), "export const optional = false;\n");
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      defaultAgent: "claude",
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--review"],
        },
      },
    }),
  );
  const database = join(directory, "projects.sqlite");
  try {
    application = await launch(directory, repo, database);
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectProjectConversation(page);
    const composer = page.getByRole("combobox", { name: "Message to orchestrator" });
    await expect(page.locator(".activity-display")).toHaveCount(0);
    await composer.fill("Draft preserved through setup");
    await expect(page.getByRole("region", { name: "Project Git setup" })).toBeVisible();
    await page.getByRole("button", { name: "Set up Git", exact: true }).click();
    const setup = page.getByRole("dialog", { name: "Set up Git", exact: true });
    await expect(setup.getByLabel("same.ts", { exact: true })).toBeChecked();
    await setup.getByRole("button", { name: "Preview same.ts" }).click();
    await expect(setup.getByRole("region", { name: "Git setup file preview" })).toContainText(
      "optional = false",
    );
    const name = setup.getByRole("textbox", { name: "Git author name" });
    const email = setup.getByRole("textbox", { name: "Git author email" });
    if (await name.isEnabled()) await name.fill("Desktop Test");
    if (await email.isEnabled()) await email.fill("desktop@example.invalid");
    await page.screenshot({ path: "test-results/git-setup-preview.png" });
    await setup.getByRole("button", { name: "Create initial commit", exact: true }).click();
    // Owned Git processes on Windows runners can take several seconds to commit.
    await expect(setup.getByRole("button", { name: "Return to Chat" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Ready for isolated workers", { exact: true })).toHaveCount(0);
    await setup.getByRole("button", { name: "Return to Chat" }).click();
    await expect(composer).toHaveValue("Draft preserved through setup");
    expect((await page.evaluate(() => window.desktop.snapshot())).runs).toHaveLength(0);
    await composer.fill("Implement validation");
    await composer.press("Enter");
    await expect(page.getByRole("button", { name: "Review changes", exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.desktop.snapshot()).runs.filter((run) => run.view?.status === "idle")
              .length,
        ),
      )
      .toBe(2);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const snapshot = await window.desktop.snapshot();
          const summary = snapshot.reviews?.[0];
          if (!summary || !snapshot.directory) return 0;
          const review = await window.desktop.readReview({
            project: snapshot.directory,
            projectId: summary.projectId,
            databaseEpoch: summary.databaseEpoch,
            reviewId: summary.id,
            requestId: crypto.randomUUID(),
          });
          return review.revisions.at(-1)?.files.length ?? 0;
        }),
      )
      .toBe(2);
    await page.getByRole("button", { name: "Review changes", exact: true }).click();
    let review = page.getByRole("region", { name: "Revision diff", exact: true });
    await expect(review).toBeVisible();
    const files = review.getByRole("navigation", { name: "Changed files" }).getByRole("button");
    await expect(files).toHaveCount(2);
    await expect(review.locator(".monaco-diff-editor")).toBeVisible();
    const pinned = await page.getByRole("tab", { name: /^Revision \d+ ·/ }).textContent();
    if (!pinned) throw new Error("Missing pinned revision tab");
    const saved = await page.evaluate(async () => {
      const snapshot = await window.desktop.snapshot();
      const summary = snapshot.reviews?.[0];
      if (!summary || !snapshot.directory) throw new Error("Missing review");
      const identity = {
        project: snapshot.directory,
        projectId: summary.projectId,
        databaseEpoch: summary.databaseEpoch,
        reviewId: summary.id,
      };
      const review = await window.desktop.readReview({
        ...identity,
        requestId: crypto.randomUUID(),
      });
      const revision = review.revisions.at(-1);
      if (!revision) throw new Error("Missing revision");
      for (const file of revision.files)
        await window.desktop.reviewAction({
          ...identity,
          type: "reviewed",
          revisionId: revision.id,
          fileKey: file.key,
          reviewed: true,
        });
      const file = revision.files[0];
      if (!file) throw new Error("Missing revision file");
      return {
        identity,
        revisionId: revision.id,
        fileKey: file.key,
        worktree: snapshot.runs.find((run) => run.record.id === file.runId)?.record.worktree,
      };
    });
    // Existing reviewed state must never hide saved file versions in this read-only browser.
    await expect(files).toHaveCount(2);
    await files.last().click();
    await expect(files.last()).toHaveAttribute("aria-current", "true");
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "Regression",
    );
    const modified = review.getByRole("textbox", { name: "Modified review version" });
    await modified.focus();
    await modified.press("ControlOrMeta+Home");
    // Monaco virtualizes horizontally. Wait for the complete fixture after revealing its start.
    const beforeTyping = "export const source = 'Regression tests';export const optional = false;";
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toHaveText(
      beforeTyping,
    );
    await modified.press("x");
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toHaveText(
      beforeTyping,
    );
    await expect(
      review.locator("form, .review-feedback, .task-actions, .review-heading"),
    ).toHaveCount(0);
    await expect(
      review.getByRole("button", {
        name: /Refresh|Expand review|Use these changes|Undo|Mark file|feedback|Reconnect/i,
      }),
    ).toHaveCount(0);
    await expect(review.getByRole("combobox")).toHaveCount(0);
    await expect(review.locator(".review-diff-actions")).toHaveCount(0);
    await expect(
      review.getByRole("button", { name: /Previous change|Next change|Find/ }),
    ).toHaveCount(0);
    await expect(review.getByRole("checkbox", { name: "Side by side" })).toHaveCount(0);
    await expect(review.getByRole("checkbox", { name: "Hide Reviewed" })).toHaveCount(0);
    if (!saved.worktree) throw new Error("Missing worker worktree");
    await writeFile(join(saved.worktree, "same.ts"), "export const readonlyMarker = true;\n");
    await page.evaluate(
      (identity) => window.desktop.captureReview({ ...identity, requestId: crypto.randomUUID() }),
      saved.identity,
    );
    const captured = await page.evaluate(
      (identity) => window.desktop.readReview({ ...identity, requestId: crypto.randomUUID() }),
      saved.identity,
    );
    await expect(page.getByRole("tab", { name: pinned, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toHaveText(
      beforeTyping,
    );
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    const revisions = page.getByRole("navigation", { name: "Task revisions" }).getByRole("button");
    await expect(revisions).toHaveCount(captured.revisions.length);
    await revisions.last().click();
    const latest = captured.revisions.at(-1)?.id;
    if (!latest || latest === saved.revisionId) throw new Error("Missing new revision");
    const latestTab = `Revision ${captured.revisions.length} · Implement validation`;
    await expect(page.getByRole("tab", { name: /^Revision \d+ ·/ })).toHaveCount(2);
    const changedFile = captured.revisions
      .at(-1)
      ?.files.findIndex((file) => file.key === saved.fileKey);
    if (changedFile === undefined || changedFile < 0) throw new Error("Missing changed file");
    await files.nth(changedFile).click();
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "readonlyMarker",
    );
    await page.getByRole("tab", { name: pinned, exact: true }).click();
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toHaveText(
      beforeTyping ?? "",
    );
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await revisions.last().click();
    await expect(page.getByRole("tab", { name: /^Revision \d+ ·/ })).toHaveCount(2);
    await page.getByRole("tab", { name: latestTab, exact: true }).focus();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("tab", { name: latestTab, exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await revisions.last().click();
    await expect(page.getByRole("tab", { name: latestTab, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.reload();
    await page.getByRole("button", { name: "Toggle files panel", exact: true }).click();
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Task revisions" })
      .getByRole("button")
      .nth(captured.revisions.findIndex((revision) => revision.id === saved.revisionId))
      .click();
    review = page.getByRole("region", { name: "Revision diff", exact: true });
    await expect(page.getByRole("tab", { name: pinned, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toHaveText(
      beforeTyping ?? "",
    );
    await page.evaluate(() => window.desktop.stopAll());
    await application.close();
    application = await launch(directory, repo, database);
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.locator(".project-sidebar-open").click();
    await page
      .getByRole("dialog", { name: "Open Project", exact: true })
      .locator(".project-item")
      .filter({ hasText: repo })
      .click();
    await page
      .getByRole("dialog", { name: "Open project?", exact: true })
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await selectProjectConversation(page);
    const changesTab = page.getByRole("tab", { name: "Changes", exact: true });
    if (!(await changesTab.isVisible()))
      await page.getByRole("button", { name: "Toggle files panel" }).first().click();
    await changesTab.click();
    await page
      .getByRole("navigation", { name: "Task revisions" })
      .getByRole("button")
      .last()
      .click();
    review = page.getByRole("region", { name: "Revision diff", exact: true });
    await expect(page.getByRole("tab", { name: latestTab, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      review.getByRole("navigation", { name: "Changed files" }).getByRole("button"),
    ).toHaveCount(2);
    await review
      .getByRole("navigation", { name: "Changed files" })
      .getByRole("button")
      .nth(changedFile)
      .click();
    await expect(review.locator(".modified .view-lines:not([monaco-view-zone])")).toContainText(
      "readonlyMarker",
    );
    await expect(review.locator("form, .review-feedback, .task-actions")).toHaveCount(0);
    await expect(
      page.evaluate(
        (identity) => window.desktop.readReview({ ...identity, requestId: crypto.randomUUID() }),
        saved.identity,
      ),
    ).rejects.toThrow("no longer open");
    const unchanged = await page.evaluate(async (reviewId) => {
      const snapshot = await window.desktop.snapshot();
      const summary = snapshot.reviews?.find((review) => review.id === reviewId);
      if (!summary) throw new Error("Missing saved review");
      return window.desktop.readReview({
        project: summary.project,
        projectId: summary.projectId,
        databaseEpoch: summary.databaseEpoch,
        reviewId,
        requestId: crypto.randomUUID(),
      });
    }, saved.identity.reviewId);
    expect(unchanged.projectId).not.toBe(saved.identity.projectId);
    expect(unchanged.comments).toEqual([]);
    expect(unchanged.submissions).toEqual([]);
    expect(await readFile(join(repo, "same.ts"), "utf8")).toBe("export const optional = false;\n");
    await page.screenshot({ path: "test-results/chat-review-readonly.png" });
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: incoming message height moves status smoothly and keeps it anchored while following", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-status-motion-"));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1000, height: 850 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    const chat = page.locator("#panel-chat .orchestration-chat-page:visible");
    const input = chat.getByRole("combobox", { name: "Message to orchestrator", exact: true });
    for (const overflowing of [false, true]) {
      const message = overflowing
        ? Array.from({ length: 100 }, (_, index) => `Result line ${index} shows progress.`).join(
            "\n",
          )
        : "Short reply stays below the message.";
      await input.fill(
        JSON.stringify([
          { activity: { activityType: "verifying", label: "Checking motion" } },
          { sleep: 1200 },
          { message },
          { hang: "cancellable" },
        ]),
      );
      const count = await chat.locator(".event.message").count();
      const [motion] = await Promise.all([
        page.evaluate(
          (previousMessages) =>
            new Promise<{ before: number; overflow: boolean; rows: number[] }>(
              (resolve, reject) => {
                const started = performance.now();
                let entered: number | undefined;
                let before: number | undefined;
                let overflow = false;
                const rows: number[] = [];
                const sample = () => {
                  const chat = document.querySelector(".orchestration-chat-page:not([hidden])");
                  const status = chat?.querySelector(".activity-display");
                  const viewport = chat?.querySelector(".transcript");
                  if (status && viewport) {
                    const top = status.getBoundingClientRect().top;
                    if (
                      (chat?.querySelectorAll(".event.message").length ?? 0) <= previousMessages
                    ) {
                      before = top;
                      overflow = viewport.scrollHeight > viewport.clientHeight + 1;
                    } else {
                      entered ??= performance.now();
                      rows.push(top);
                      if (performance.now() - entered > 600 && before !== undefined) {
                        resolve({ before, overflow, rows });
                        return;
                      }
                    }
                  }
                  if (performance.now() - started > 6000) {
                    reject(new Error("Could not sample status movement around the incoming reply"));
                    return;
                  }
                  // Sample after layout observers have synchronized scrolling for the painted frame.
                  requestAnimationFrame(() => setTimeout(sample, 0));
                };
                sample();
              },
            ),
          count,
        ),
        input.press("Enter"),
      ]);
      expect(motion.overflow).toBe(overflowing);
      if (overflowing) {
        expect(Math.max(...motion.rows.map((top) => Math.abs(top - motion.before)))).toBeLessThan(
          2,
        );
      } else {
        const distance = (motion.rows.at(-1) ?? motion.before) - motion.before;
        expect(distance).toBeGreaterThan(40);
        expect(new Set(motion.rows.map((top) => Math.round(top))).size).toBeGreaterThan(3);
        const positions = [motion.before, ...motion.rows];
        const steps = positions
          .slice(1)
          .map((top, index) => Math.abs(top - (positions[index] ?? top)));
        expect(Math.max(...steps)).toBeLessThan(distance * 0.95);
      }
      await chat.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(chat.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    }
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: main Chat eases new replies once and preserves streaming, history and reduced motion", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-chat-motion-"));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1000, height: 650 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    const chat = page.locator("#panel-chat .orchestration-chat-page");
    const input = chat.getByRole("combobox", { name: "Message to orchestrator", exact: true });
    const messages = chat.locator(".event.message");
    await page.evaluate(() => {
      document.body.dataset.chatEntries = "0";
      document.addEventListener("animationstart", (event) => {
        if (event.animationName === "chat-reply-enter")
          document.body.dataset.chatEntries = String(Number(document.body.dataset.chatEntries) + 1);
      });
    });
    const chunks = [
      "## A smoother reply\n\n**Stream",
      "ing** stays readable.\n\n",
      ...Array.from({ length: 25 }, (_, index) => `Paragraph ${index} arrives intact.\n\n`),
      "End marker.",
    ];
    await input.fill(
      JSON.stringify([
        { sleep: 600 },
        ...chunks.flatMap((message) => [{ message }, { sleep: 80 }]),
      ]),
    );
    const entrance = page.waitForFunction(() => {
      const reply = document.querySelector(".orchestration-chat-page .event.message");
      if (!reply?.getAnimations().length) return false;
      const style = getComputedStyle(reply);
      const opacity = Number(style.opacity);
      return opacity > 0 && opacity < 1
        ? { opacity, transform: style.transform, animation: style.animationName }
        : false;
    });
    await input.press("Enter");
    const entry = await (await entrance).jsonValue();
    if (!entry) throw new Error("Reply entrance was not observed");
    expect(entry).toMatchObject({ animation: "chat-reply-enter" });
    expect(entry.transform).not.toBe("none");
    await expect(messages).toHaveCount(1);
    await expect(messages.last()).toContainText("End marker.");
    await expect(messages.last().locator("strong")).toHaveText("Streaming");
    await expect(messages.last()).toHaveCSS("opacity", "1");
    await expect(messages.last()).toHaveCSS("animation-name", "none");
    await expect(chat.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.body.dataset.chatEntries)).toBe("1");
    await messages.last().getByRole("button", { name: "Copy message", exact: true }).click();
    await expect(page.locator(".toast-stack").getByRole("status")).toHaveText("Done: Copied.");
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      chunks.join("").replaceAll("\n", process.platform === "win32" ? "\r\n" : "\n"),
    );
    await selectSidebarPage(page, "Settings");
    await selectSidebarPage(page, "Chat");
    expect(await page.evaluate(() => document.body.dataset.chatEntries)).toBe("1");
    await expect(messages.last()).toHaveCSS("animation-name", "none");
    // A reply received off-screen must not replay an entrance when its chat is reopened.
    await input.fill(JSON.stringify([{ sleep: 1200 }, { message: "Background reply." }]));
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await selectSidebarPage(page, "Settings");
    await expect(messages).toHaveCount(2);
    await selectSidebarPage(page, "Chat");
    await expect(messages.last()).toHaveCSS("animation-name", "none");
    expect(await page.evaluate(() => document.body.dataset.chatEntries)).toBe("1");
    await expect(chat.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await input.fill(JSON.stringify([{ message: "Reduced-motion reply." }]));
    await input.press("Enter");
    await expect(messages).toHaveCount(3);
    await expect(messages.last()).toHaveCSS("animation-name", "none");
    expect(await page.evaluate(() => document.body.dataset.chatEntries)).toBe("1");
    const gap = await chat.locator(".transcript").evaluate(async (element) => {
      const spacer = document.createElement("div");
      spacer.style.height = "300px";
      element.querySelector(".chat-transcript-content")?.append(spacer);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const gap = element.scrollHeight - element.clientHeight - element.scrollTop;
      spacer.remove();
      return gap;
    });
    expect(gap).toBeLessThanOrEqual(1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();
    await expect(messages).toHaveCount(3);
    await expect(chat.locator("[data-entering='true']")).toHaveCount(0);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: semantic activity preserves provenance, reload state and reduced motion", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-activity-"));
  try {
    application = await launch(directory, directory, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1000, height: 650 });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() =>
      window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch)),
    );
    const chat = page.locator("#panel-chat .orchestration-chat-page:visible");
    const status = chat.locator(".activity-display");
    await expect(status).toHaveCount(0);
    const input = chat.getByRole("combobox", { name: "Message to orchestrator", exact: true });
    const waitForFadeOut = () =>
      status.evaluate(
        (element) =>
          new Promise<{ state: string; collapsing: boolean; height: number }>((resolve, reject) => {
            const timeout = setTimeout(() => {
              observer.disconnect();
              reject(new Error("Activity did not fade out"));
            }, 5000);
            const observer = new MutationObserver(() => {
              if (element.getAttribute("data-exiting") !== "true") return;
              observer.disconnect();
              const state = element.getAttribute("data-activity") ?? "";
              const collapsing = element.getAttribute("data-collapsing") === "true";
              const sample = () => {
                const height = element.getBoundingClientRect().height;
                if (
                  collapsing &&
                  height >=
                    Number.parseFloat(getComputedStyle(element).getPropertyValue("--activity-size"))
                ) {
                  requestAnimationFrame(sample);
                  return;
                }
                clearTimeout(timeout);
                resolve({ state, collapsing, height });
              };
              requestAnimationFrame(sample);
            });
            observer.observe(element, { attributes: true, attributeFilter: ["data-exiting"] });
          }),
      );
    await input.fill(
      JSON.stringify([
        {
          activity: {
            activityType: "verifying",
            label: "Checking cancellation <script>plain text</script>",
          },
        },
        {
          message: "Reviewing cancellation behavior",
        },
        {
          thought: Array.from({ length: 60 }, (_, index) => `Checking evidence line ${index}`).join(
            "\n",
          ),
        },
        { hang: "cancellable" },
      ]),
    );
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(status).toHaveAttribute("data-source", "declared");
    await expect(status).toHaveText(/^Verifying\.\.\. \d+s$/);
    const activityTimer = status.getByRole("timer");
    await expect(activityTimer).not.toHaveText("0s");
    await expect(activityTimer).toHaveAttribute("aria-live", "off");
    await expect(status.getByRole("status")).toHaveText("Verifying...");
    await expect(status.locator(".activity-name")).toHaveCSS("font-weight", "400");
    await expect(status.locator(".activity-name")).toHaveCSS("font-size", "13px");
    await expect(chat.locator(".chat-loader")).toHaveCount(0);
    await expect(page.locator(".chat-sidebar-entry .chat-loader")).toHaveCount(0);
    await expect(status).toHaveAttribute(
      "data-tooltip",
      /Agent-reported purpose: Checking cancellation/,
    );
    await expect(status.locator("script")).toHaveCount(0);
    const artwork = status.locator("img");
    await expect(artwork).toHaveAttribute("src", /verifying.*\.gif$/);
    await expect
      .poll(() => artwork.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    // Sample the layout together after the opening transition. The scroll offset can round to
    // a whole pixel while the message and composer positions have fractional coordinates.
    await expect
      .poll(() =>
        chat.evaluate((element) => {
          const activity = element.querySelector(".activity-display")?.getBoundingClientRect();
          const composer = element.querySelector(".composer")?.getBoundingClientRect();
          const message = Array.from(element.querySelectorAll(".event.prompt, .event.message"))
            .at(-1)
            ?.getBoundingClientRect();
          return {
            expanded:
              activity?.height === (window.matchMedia("(max-height: 700px)").matches ? 32 : 48),
            aboveComposer: !!(activity && composer && activity.bottom <= composer.top + 1),
            belowMessage: !!(
              activity &&
              message &&
              activity.top >= message.bottom &&
              activity.top - message.bottom < 100
            ),
          };
        }),
      )
      .toEqual({ expanded: true, aboveComposer: true, belowMessage: true })
      .catch(async (error) => {
        const geometry = await chat.evaluate((element) => {
          const box = (selector: string) =>
            element.querySelector(selector)?.getBoundingClientRect().toJSON();
          const viewport = element.querySelector(".transcript");
          return {
            activity: box(".activity-display"),
            composer: box(".composer"),
            transcript: box(".transcript"),
            content: box(".chat-transcript-content"),
            scrollTop: viewport?.scrollTop,
            scrollHeight: viewport?.scrollHeight,
            clientHeight: viewport?.clientHeight,
          };
        });
        await test.info().attach("activity-layout", {
          body: JSON.stringify(geometry, null, 2),
          contentType: "application/json",
        });
        await page.screenshot({ path: test.info().outputPath("activity-layout-failure.png") });
        throw error;
      });
    // An older programmatic scroll event may arrive after streamed content grows but before
    // ResizeObserver runs. It must keep following, while a deliberate scroll still pauses it.
    const viewport = chat.locator(".transcript");
    const race = await viewport.evaluate(async (element) => {
      const content = element.querySelector(".chat-transcript-content") as HTMLElement;
      const grow = () => {
        const spacer = document.createElement("div");
        spacer.style.height = "300px";
        content.append(spacer);
        return spacer;
      };
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
      const first = grow();
      element.dispatchEvent(new Event("scroll"));
      const initialGap = element.scrollHeight - element.scrollTop - element.clientHeight;
      const samples = [element.scrollTop];
      await new Promise<void>((resolve, reject) => {
        const sample = () => {
          samples.push(element.scrollTop);
          if (element.scrollHeight - element.scrollTop - element.clientHeight <= 1) resolve();
          else if (samples.length > 240) reject(new Error("Chat did not settle at the bottom"));
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const followedGrowth = element.scrollHeight - element.scrollTop - element.clientHeight;
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
      const second = grow();
      element.dispatchEvent(new Event("scroll"));
      const preservedReadingPosition = element.scrollTop;
      first.remove();
      second.remove();
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
      return { initialGap, samples, followedGrowth, preservedReadingPosition };
    });
    expect(race.initialGap).toBeGreaterThan(250);
    expect(new Set(race.samples).size).toBeGreaterThan(3);
    expect(
      Math.max(...race.samples.slice(1).map((top, index) => top - (race.samples[index] ?? top))),
    ).toBeLessThan(250);
    expect(race.followedGrowth).toBeLessThanOrEqual(1);
    expect(race.preservedReadingPosition).toBe(0);
    expect(
      await status.evaluate(
        (element) =>
          element.closest(".transcript") !== null &&
          element.nextElementSibling?.id === element.getAttribute("aria-controls"),
      ),
    ).toBe(true);
    const activitySize = await page.evaluate(() =>
      window.matchMedia("(max-height: 700px)").matches ? 32 : 48,
    );
    await expect(artwork).toHaveCSS("width", `${activitySize}px`);
    await expect(artwork).toHaveCSS("height", `${activitySize}px`);
    const imageBox = await artwork.boundingBox();
    const textBox = await status.locator(".activity-name").boundingBox();
    const replyBox = await chat.locator(".event.message .chat-markdown").last().boundingBox();
    expect(replyBox && textBox && Math.abs(replyBox.x - textBox.x) < 1).toBe(true);
    expect(imageBox && textBox && textBox.x >= imageBox.x + imageBox.width).toBe(true);
    expect(
      imageBox && textBox && textBox.y >= imageBox.y && textBox.y < imageBox.y + imageBox.height,
    ).toBe(true);
    await expect(status.locator(".activity-name")).toHaveCSS(
      "animation-name",
      "activity-spotlight",
    );
    await expect(chat.locator(".chat-activity")).toHaveCount(0);
    await expect(status).toHaveAttribute("aria-expanded", "false");
    await status.locator(".activity-visual").click();
    await expect(status).toHaveAttribute("aria-expanded", "true");
    const activityDetails = chat.getByRole("region", { name: "Activity details", exact: true });
    await expect(activityDetails).toHaveCSS("transition-duration", "0.175s, 0.175s, 0s");
    await expect(activityDetails).toContainText("Checking evidence line 59");
    await expect(activityDetails).toHaveCSS("overflow-y", "visible");
    await expect(activityDetails).toHaveCSS("max-height", "none");
    await expect(activityDetails.locator(".event.thought pre")).toHaveCSS("overflow-y", "visible");
    await expect
      .poll(() => activityDetails.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(320);
    await page.screenshot({ path: test.info().outputPath("activity-dropdown.png") });
    await status.press("Escape");
    await expect(status).toHaveAttribute("aria-expanded", "false");
    const closedDetails = chat.locator(".activity-details[data-expanded='false']").last();
    await expect(closedDetails).toHaveAttribute("inert", "");
    await expect
      .poll(() => closedDetails.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(0);
    await status.locator(".activity-name").click();
    await expect(status).toHaveAttribute("aria-expanded", "true");
    await status.press("Space");
    await expect(status).toHaveAttribute("aria-expanded", "false");
    await status.press("Enter");
    await expect(status).toHaveAttribute("aria-expanded", "true");
    await status.press("Escape");
    // The collapse scrolls the transcript, which dismisses tooltips. Hover only after it settles.
    await expect
      .poll(() => closedDetails.evaluate((element) => element.getBoundingClientRect().height))
      .toBe(0);
    const tooltip = page.getByRole("tooltip");
    await expect(async () => {
      await input.hover();
      await status.locator(".activity-name").hover();
      await expect(tooltip).toContainText(
        "Agent-reported purpose: Checking cancellation <script>plain text</script>",
        { timeout: 1000 },
      );
    }).toPass({ timeout: 5000 });
    await expect(tooltip.locator("script")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await input.focus();
    await status.focus();
    await expect(tooltip).toContainText("Agent-reported purpose:");
    await page.keyboard.press("Escape");
    await input.focus();
    await page.screenshot({ path: test.info().outputPath("activity-light.png") });
    await page.evaluate(() => (document.documentElement.dataset.colorScheme = "dark"));
    await expect(artwork).toHaveCSS("mix-blend-mode", "screen");
    await page.screenshot({ path: test.info().outputPath("activity-dark.png") });
    await page.evaluate(() => (document.documentElement.dataset.colorScheme = "light"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(chat.locator(".activity-details").last()).toHaveCSS("transition-duration", "0s");
    await expect(status.locator(".activity-name")).toHaveCSS("animation-name", "none");
    await expect(artwork).toHaveCount(0);
    await expect(status.locator("svg")).toHaveCount(1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(artwork).toHaveCount(1);
    await artwork.evaluate((image: HTMLImageElement) => (image.src = "missing-activity.gif"));
    await expect(artwork).toHaveCount(0);
    await expect(status).toHaveText(/^Verifying\.\.\. \d+s$/);
    await selectSidebarPage(page, "Settings");
    await expect(page.locator("#panel-chat .activity-display").first()).toHaveAttribute(
      "data-animate",
      "false",
    );
    await selectSidebarPage(page, "Chat");
    await page.reload();
    await expect(status).toHaveAttribute("data-source", "declared");
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toHaveText("Cancelled");
    await expect(status.getByRole("timer")).toHaveCount(0);
    await expect(status).toHaveAttribute("data-animate", "false");
    await input.fill(
      JSON.stringify([
        { activity: { activityType: "testing", label: "Checking cancellation" } },
        { tool: { id: "search", title: "Search", kind: "search", status: "in_progress" } },
        { tool: { id: "command", title: "Tests passed", kind: "execute", status: "in_progress" } },
        { sleep: 3000 },
        { toolUpdate: { id: "command", status: "completed" } },
        { hang: "cancellable" },
      ]),
    );
    await input.press("Enter");
    await expect(status).toHaveAttribute("data-activity", "executing");
    await expect(status).toHaveText(/^Executing\.\.\. \d+s$/);
    await expect(status.locator(".activity-name")).toHaveCSS("text-align", "left");
    await expect(status).toHaveCSS("transition-duration", "0.175s");
    const labelLeft = await status
      .locator(".activity-name")
      .evaluate((element) => element.getBoundingClientRect().left);
    await expect(status.locator("img")).toHaveAttribute("src", /executing.*\.gif$/);
    await expect(status).toHaveAttribute("data-tooltip", /1 other operation/);
    await expect(status).toHaveAttribute(
      "data-tooltip",
      /Agent-reported purpose: Checking cancellation/,
    );
    await status.focus();
    await expect(tooltip).toContainText("Observed activity: Executing");
    await expect(status).not.toContainText("Tests passed");
    expect((await waitForFadeOut()).state).toBe("executing");
    await expect(status).toHaveAttribute("data-activity", "searching");
    expect(
      await status
        .locator(".activity-name")
        .evaluate((element) => element.getBoundingClientRect().left),
    ).toBe(labelLeft);
    await expect(activityTimer).toHaveText("0s");
    await expect(status).not.toHaveAttribute("data-tooltip", /other operation/);
    // A layout/scroll change may dismiss the old tooltip; inspect the new activity via focus.
    await input.focus();
    await status.focus();
    await expect(tooltip).toContainText("Observed activity: Searching");
    await expect(tooltip).not.toContainText("other operation");
    await page.reload();
    await expect(status).toHaveAttribute("data-activity", "searching");
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toHaveText("Cancelled");
    await expect(status.getByRole("timer")).toHaveCount(0);
    await input.fill(
      JSON.stringify([
        { activity: { activityType: "waiting_for_workers", label: "Monitoring worker replies" } },
        { sleep: 1200 },
      ]),
    );
    await input.press("Enter");
    await expect(status).toHaveAttribute("data-activity", "waiting_for_workers");
    await expect(status).toHaveText(/^Monitoring subagents\.\.\. \d+s$/);
    await expect(status.locator("img")).toHaveAttribute("src", /waiting_for_workers.*\.gif$/);
    await expect(status).toHaveCSS("opacity", "1");
    await page.screenshot({ path: test.info().outputPath("monitoring-subagents.png") });
    await status.focus();
    await expect(tooltip).toContainText("Monitoring worker replies");
    const closing = await waitForFadeOut();
    expect(closing.state).toBe("waiting_for_workers");
    expect(closing.collapsing).toBe(true);
    expect(closing.height).toBeGreaterThan(0);
    expect(closing.height).toBeLessThan(activitySize);
    await expect(status).toHaveCount(0);
    await expect(tooltip).toHaveCount(0);
    // Expansion follows the latest message without pulling readers out of older history.
    await input.fill(
      JSON.stringify([
        { message: Array.from({ length: 70 }, (_, index) => `Result line ${index}`).join("\n") },
        { activity: { activityType: "waiting_for_workers", label: "Monitoring replies" } },
        { sleep: 5000 },
        { activity: { activityType: "reading", label: "Reading replies" } },
        { sleep: 1200 },
      ]),
    );
    await input.press("Enter");
    await expect(status).toHaveAttribute("data-activity", "waiting_for_workers");
    // Send completion resets follow-bottom; start the reading scenario after that settles.
    await expect(input).toHaveValue("");
    await expect(status).toBeInViewport();
    const transcript = chat.getByRole("log", { name: "Orchestration conversation" });
    expect(await transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    // Real wheel input waits for the scroll handler to leave follow-bottom mode.
    await transcript.hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(status).toHaveAttribute("data-activity", "reading");
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(status).toHaveCount(0);
    expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: accepted plans show task progress outside their Markdown document", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-planning-"));
  const repo = join(directory, "repo");
  const config = join(directory, "config", "code60");
  await mkdir(config, { recursive: true });
  await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitFixture(repo);
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      defaultAgent: "claude",
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--plan"],
        },
      },
    }),
  );
  try {
    application = await launch(directory, repo, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectProjectConversation(page);
    const composer = page.getByRole("combobox", { name: "Message to orchestrator" });
    await composer.fill("Plan a change");
    await composer.press("Enter");
    const panel = page.getByRole("region", { name: "Plan", exact: true });
    await expect(
      page.getByRole("tab", { name: "Plan · Planned change", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".orchestration-chat-heading .chat-plans")).toHaveCount(0);
    await expect(
      page.locator(".orchestration-chat-heading").getByRole("button", { name: /^Plan · / }),
    ).toHaveCount(0);
    await expect(panel.getByRole("progressbar", { name: "Tasks completed" })).toHaveAttribute(
      "value",
      "0",
    );
    await expect(panel.getByText("0 out of 2", { exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).runs).toHaveLength(0);
    await expect(composer).toBeEnabled();
    const originalChat = (await page.evaluate(() => window.desktop.snapshot())).chat.run
      ?.id as string;
    await page.getByRole("tab", { name: "Plan · Planned change", exact: true }).focus();
    await page.keyboard.press("Delete");
    await page.evaluate(() => window.desktop.orchestrationChatAction({ type: "new" }));
    const backgroundChat = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    await page.evaluate(
      (id) => window.desktop.orchestrationChatAction({ type: "send", id, text: "Revise the plan" }),
      originalChat,
    );
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.snapshot()).chats.find((chat) => chat.run?.id === id)?.plans?.[0]
              ?.proposalRevision,
          originalChat,
        ),
      )
      .toBe(2);
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(
      backgroundChat,
    );
    await expect(page.getByRole("tab", { name: "Plan · Revised change", exact: true })).toHaveCount(
      0,
    );
    await page.evaluate(
      (id) => window.desktop.orchestrationChatAction({ type: "select", id }),
      originalChat,
    );
    await expect(
      page.getByRole("tab", { name: "Plan · Revised change", exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Revised change" })).toBeVisible();
    await panel.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(panel.getByText("2 out of 2", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "2");
    await expect(panel.getByRole("progressbar")).toHaveAttribute("max", "2");
    await expect(panel.locator(".plan-document input:checked")).toHaveCount(2);
    await expect(panel.locator(".plan-document")).not.toContainText("out of");
    const snapshot = await page.evaluate(() => window.desktop.snapshot());
    const plan = snapshot.chat.plans?.[0];
    expect(plan?.state).toBe("completed");
    const markdown = await readFile(
      join(snapshot.chat.directory as string, "plans", `${plan?.id}.md`),
      "utf8",
    );
    expect(markdown).toContain("- [x] Create result");
    expect(markdown).toContain("- [x] Verify result");
    expect(markdown).not.toContain("out of");
    await page.screenshot({ path: "test-results/orchestrator-plan.png" });
    await page.evaluate(() => {
      document.documentElement.dataset.colorScheme = "dark";
    });
    await expect(panel.getByText("2 out of 2", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/orchestrator-plan-dark.png" });
    await page.emulateMedia({ forcedColors: "active" });
    await expect(panel.getByRole("progressbar")).toBeVisible();
    await page.emulateMedia({ forcedColors: "none" });
    await page.getByRole("tab", { name: "Plan · Revised change", exact: true }).focus();
    await page.keyboard.press("Delete");
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".chat-plans")).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.plans?.[0]?.state).toBe(
      "completed",
    );
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: safe Markdown replies, source Copy, confirmed links and streaming scroll", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-markdown-ui-"));
  execFileSync("git", ["init", "-q", directory]);
  commitFixture(directory);
  application = await launch(directory, directory, join(directory, "markdown.sqlite"));
  try {
    const page = await application.firstWindow();
    const requests: string[] = [];
    page.on("request", (request) => {
      requests.push(request.url());
    });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectSidebarPage(page, "Chat");
    await application.evaluate(({ dialog, shell }) => {
      const state = {
        confirm: false,
        fail: false,
        opened: [] as string[],
        destinations: [] as string[],
      };
      (globalThis as typeof globalThis & { markdownLinks?: typeof state }).markdownLinks = state;
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as { detail?: string };
        state.destinations.push(options.detail ?? "");
        return { response: state.confirm ? 1 : 0, checkboxChecked: false };
      };
      shell.openExternal = async (url: string) => {
        if (state.fail) throw new Error("fixture open failure");
        state.opened.push(url);
      };
    });
    const linkState = () =>
      application.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              markdownLinks?: { opened: string[]; destinations: string[] };
            }
          ).markdownLinks,
      );
    const chat = page.locator(".orchestration-chat-page:visible");
    const composer = chat.getByRole("combobox", { name: "Message to orchestrator", exact: true });
    const source = [
      "# Report",
      "",
      "**Ready** and *careful* with ~~removed~~ text.",
      "",
      "- [x] Done",
      "- [ ] Next",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| One | Two |",
      "",
      "```ts",
      `const Value = '${"x".repeat(240)}';`,
      "```",
      "",
      "[Docs](https://example.com/docs)",
      "",
      "[Unsafe](javascript:alert%281%29) [Local](file:///tmp/test)",
      "",
      "![No remote load](https://example.invalid/beacon.png)",
      "",
      "<script>window.markdownUnsafe = true</script>",
    ].join("\n");
    const split = source.indexOf("careful") + 3;
    await composer.fill(
      JSON.stringify([
        { message: source.slice(0, split) },
        { sleep: 500 },
        { message: source.slice(split) },
      ]),
    );
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    const markdown = chat.locator(".event.message .chat-markdown").first();
    await expect(markdown.getByRole("heading", { name: "Report", level: 1 })).toBeVisible();
    await expect(markdown.locator("strong")).toHaveText("Ready");
    await expect(markdown.locator("em")).toHaveText("careful");
    await expect(markdown.locator("table td")).toHaveText(["One", "Two"]);
    await expect(markdown.getByRole("checkbox").first()).toBeChecked();
    await expect(markdown.getByRole("checkbox").first()).toBeDisabled();
    await expect(markdown.locator("pre code")).toHaveText(`const Value = '${"x".repeat(240)}';\n`);
    await expect(markdown.locator("script, img, iframe")).toHaveCount(0);
    expect(requests.some((url) => url.includes("example.invalid"))).toBe(false);
    expect(
      await page.evaluate(async () => {
        for (const url of [
          "file:///tmp/test",
          "javascript:alert(1)",
          "https://user:pass@example.com",
        ]) {
          try {
            await window.desktop.openWebLink({ url });
            return false;
          } catch {
            /* Invalid destinations must not reach confirmation or shell. */
          }
        }
        return true;
      }),
    ).toBe(true);
    expect(await linkState()).toEqual({
      opened: [],
      destinations: [],
      confirm: false,
      fail: false,
    });
    const link = markdown.getByRole("link");
    await expect(link).toHaveCount(1);
    const originalUrl = page.url();
    await link.click();
    expect((await linkState())?.opened).toEqual([]);
    expect((await linkState())?.destinations).toEqual(["https://example.com/docs"]);
    await application.evaluate(() => {
      const state = (globalThis as typeof globalThis & { markdownLinks?: { confirm: boolean } })
        .markdownLinks;
      if (state) state.confirm = true;
    });
    await link.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await linkState())?.opened)
      .toEqual(["https://example.com/docs"]);
    expect(page.url()).toBe(originalUrl);
    await application.evaluate(() => {
      const state = (globalThis as typeof globalThis & { markdownLinks?: { fail: boolean } })
        .markdownLinks;
      if (state) state.fail = true;
    });
    await link.click();
    await expect(markdown.getByRole("alert")).toContainText("Could not open link");
    expect((await linkState())?.opened).toEqual(["https://example.com/docs"]);
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => {
          (window as unknown as { markdownCopy: string }).markdownCopy = text;
        },
      });
    });
    await chat
      .locator(".event.message")
      .first()
      .getByRole("button", { name: "Copy message" })
      .click();
    expect(
      await page.evaluate(() => (window as unknown as { markdownCopy: string }).markdownCopy),
    ).toBe(source);
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    const long = `# Long reply\n\n${"Paragraph **with emphasis** and `code`.\n\n".repeat(100)}`;
    await composer.fill(
      JSON.stringify([
        { message: long },
        { sleep: 3000 },
        { message: "\n\n## Finished\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" },
      ]),
    );
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    const scroller = chat.locator(".transcript");
    await expect(chat.locator(".chat-markdown h1").last()).toHaveText("Long reply");
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(2);
    await scroller.hover();
    // A streamed render can interrupt Chromium's animated wheel scroll just short of the top.
    await expect(async () => {
      await page.mouse.wheel(0, -100_000);
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollTop), { timeout: 1_000 })
        .toBe(0);
    }).toPass({ timeout: 5_000 });
    await expect(chat.locator(".chat-markdown h2").last()).toHaveText("Finished");
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
    expect(
      await scroller.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 820, height: 640 });
    expect(
      await scroller.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    if (originalViewport) await page.setViewportSize(originalViewport);
    await expect(composer).toBeEnabled();
    const [workerId] = await page.evaluate(() =>
      window.desktop.start({
        agents: ["claude"],
        allow: [],
        allowAll: false,
        prompt: JSON.stringify([{ message: "# Worker result\n\n**Saved** with `Code`." }]),
      }),
    );
    if (!workerId) throw new Error("Missing Markdown worker");
    await page.locator(`#conversation-${workerId}`).click();
    const worker = page.locator(`#chat-${workerId}`);
    await expect(worker.locator(".chat-markdown h1")).toHaveText("Worker result");
    await expect(worker.locator(".chat-markdown strong")).toHaveText("Saved");
    await page.reload();
    await page.locator(`#conversation-${workerId}`).click();
    await expect(worker.locator(".chat-markdown h1")).toHaveText("Worker result");
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Command Builder drafts, keyboard picker and send-time expansion", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-commands-ui-"));
  const repo = join(directory, "repo");
  await mkdir(repo);
  try {
    application = await launch(directory, repo, join(directory, "commands.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const tab = page.getByRole("tab", { name: "Command Builder", exact: true });
    await expect(tab).toBeDisabled();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectProjectConversation(page);
    await tab.click();
    const editor = page.locator("#panel-commands");
    await editor.getByLabel("Title", { exact: true }).fill("Fixture review");
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("fixture-review");
    await editor.getByLabel("Description", { exact: true }).fill("Inspect saved changes");
    await editor.getByLabel("Prompt", { exact: true }).fill("Inspect the selected files.");
    const originalViewport = page.viewportSize();
    const heading = editor.getByRole("heading", { name: "Command Builder", level: 1, exact: true });
    const newCommand = editor.getByRole("button", { name: "New command", exact: true });
    const scroll = editor.locator(".commands-scroll");
    for (const size of [
      { width: 1200, height: 600 },
      { width: 760, height: 600 },
    ]) {
      await page.setViewportSize(size);
      await scroll.evaluate((element) => {
        element.scrollTop = 0;
      });
      const before = await heading.boundingBox();
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(heading).toBeInViewport();
      await expect(newCommand).toBeInViewport();
      expect(await heading.boundingBox()).toEqual(before);
      await newCommand.click();
      await expect(editor.getByLabel("Title", { exact: true })).toHaveValue("Fixture review");
    }
    if (originalViewport) await page.setViewportSize(originalViewport);
    await selectSidebarPage(page, "Search");
    await tab.click();
    await expect(editor.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Inspect the selected files.",
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const list = editor.getByRole("navigation", { name: "Commands", exact: true });
    await expect(
      list.getByRole("button", { name: "/fixture-review Fixture review", exact: true }),
    ).toBeVisible();
    await editor.getByLabel("Prompt", { exact: true }).fill("Unsaved edit.");
    await editor.getByRole("button", { name: "New command", exact: true }).click();
    await editor.getByLabel("Title", { exact: true }).fill("Fixture audit");
    await editor.getByLabel("Prompt", { exact: true }).fill("Audit changes.");
    await list.getByRole("button", { name: /\/fixture-review/ }).click();
    await expect(editor.getByLabel("Prompt", { exact: true })).toHaveValue("Unsaved edit.");
    await editor.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(editor.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Inspect the selected files.",
    );
    await list.getByRole("button", { name: "New command (unsaved)", exact: true }).click();
    await expect(editor.getByLabel("Title", { exact: true })).toHaveValue("Fixture audit");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(list.getByRole("button")).toHaveCount(2);

    await selectSidebarPage(page, "Chat");
    const chat = page.locator(".orchestration-chat-page:visible");
    const composer = chat.getByRole("combobox", { name: "Message to orchestrator", exact: true });
    await expect(composer).toBeEnabled();
    for (const name of ["plan", "business-evaluation"]) {
      await composer.fill(`/${name}`);
      await expect(chat.getByRole("option")).toHaveCount(1);
      await expect(chat.getByRole("option")).toContainText(`/${name}`);
      await composer.press("Enter");
      await expect(composer).toHaveValue(`/${name} `);
      await expect(chat.locator(".event.prompt")).toHaveCount(0);
    }
    await composer.fill("/create");
    await expect(chat.getByRole("option")).toHaveCount(1);
    await expect(chat.getByRole("option")).toContainText("/create-command");
    await composer.press("Tab");
    await expect(composer).toHaveValue("/create-command ");
    await expect(chat.locator(".event.prompt")).toHaveCount(0);
    await composer.fill("/");
    await expect(composer).toHaveAttribute("aria-expanded", "true");
    await expect(chat.getByRole("option")).toHaveCount(5);
    await composer.press("ArrowDown");
    await composer.press("ArrowUp");
    await composer.press("Tab");
    await expect(composer).toHaveValue("/fixture-audit ");
    await expect(chat.locator(".event.prompt")).toHaveCount(0);
    await composer.fill("/review");
    await expect(chat.getByRole("option")).toHaveCount(1);
    await composer.press("Escape");
    await expect(composer).toHaveAttribute("aria-expanded", "false");
    await composer.fill("/rev");
    await composer.press("Enter");
    await expect(composer).toHaveValue("/fixture-review ");
    await expect(chat.locator(".event.prompt")).toHaveCount(0);
    await composer.fill("/fixture-review  Focus on errors.\n");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chat.locator(".event.message .chat-markdown")).toHaveText(
      "Received command:\nCommand /fixture-review: Fixture review\nInspect the selected files.\n\nAdditional instructions:\nFocus on errors.",
    );
    await expect(chat.locator(".event.prompt pre")).toHaveText(
      "/fixture-review  Focus on errors.\n",
    );
    await expect(chat.locator(".event.prompt mark")).toHaveText("/fixture-review");
    await composer.fill("/fixture-review");
    await composer.press("Escape");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(chat.locator(".event.message .chat-markdown").last()).toHaveText(
      "Received command:\nCommand /fixture-review: Fixture review\nInspect the selected files.",
    );
    await composer.fill("/tmp is full");
    await expect(
      chat.getByText("No matching command. This message will be sent as plain text."),
    ).toBeVisible();
    await expect(composer).toHaveAttribute("aria-expanded", "false");
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Enter");
    await expect(chat.locator(".event.prompt pre").last()).toHaveText("/tmp is full");
    await expect(chat.locator(".event.message .chat-markdown").last()).toHaveText("ok");

    await tab.click();
    await list.getByRole("button", { name: /\/fixture-review/ }).click();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await editor.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(list.getByRole("button")).toHaveCount(2);
    await expect(editor.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await editor.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(list.getByRole("button")).toHaveCount(1);
    await page.reload();
    await tab.click();
    await expect(
      list.getByRole("button", { name: "/fixture-audit Fixture audit", exact: true }),
    ).toBeVisible();
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: plan task rows align checkboxes with their first line of text", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-plan-layout-"));
  const repo = join(directory, "repo");
  const config = join(directory, "config", "code60");
  await mkdir(config, { recursive: true });
  await mkdir(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  commitFixture(repo);
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      defaultAgent: "claude",
      agents: {
        claude: {
          command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs"), "--plan"],
        },
      },
    }),
  );
  const measure = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".plan-task")].map((task) => {
        const box = task.querySelector("input[type=checkbox]")?.getBoundingClientRect();
        const text = task.querySelector<HTMLElement>(".plan-task-text");
        const note = task.querySelector<HTMLElement>(".plan-task-note");
        if (!box || !text) throw new Error("Missing task parts");
        const range = document.createRange();
        range.selectNodeContents(text);
        const first = range.getClientRects()[0];
        if (!first) throw new Error("Missing task text line");
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        return {
          offset: box.top + box.height / 2 - (first.top + first.height / 2),
          lines: lines.size,
          textLeft: text.getBoundingClientRect().left,
          noteLeft: note?.getBoundingClientRect().left,
          overflow: task.scrollWidth - task.clientWidth,
        };
      }),
    );
  try {
    application = await launch(directory, repo, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1400, 900),
    );
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(async () => {
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.connectDatabase("create", databaseEpoch));
      await window.desktop
        .snapshot()
        .then(({ databaseEpoch }) => window.desktop.chooseFolder(databaseEpoch));
    });
    await selectProjectConversation(page);
    const composer = page.getByRole("combobox", { name: "Message to orchestrator" });
    await composer.fill("Plan a layout check");
    await composer.press("Enter");
    const panel = page.getByRole("region", { name: "Plan", exact: true });
    await expect(panel.getByRole("heading", { name: "Layout check" })).toBeVisible();
    await panel.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(panel.getByText("1 out of 4", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Paused", { exact: true })).toBeVisible();
    const resize = page.getByRole("button", { name: "Resize files panel", exact: true });
    const drag = async (width: number) => {
      const grip = await resize.boundingBox();
      const aside = await page.locator("#chat-file-panel").boundingBox();
      if (!grip || !aside) throw new Error("Missing panel resize grip");
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(aside.x + aside.width - width, grip.y + grip.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect
        .poll(async () =>
          Math.abs(((await page.locator("#chat-file-panel").boundingBox())?.width ?? 0) - width),
        )
        .toBeLessThanOrEqual(2);
    };
    const check = async (name: string) => {
      const rows = await measure(page);
      expect(rows[1]?.lines).toBeGreaterThan(1);
      expect(rows[2]?.lines).toBeGreaterThanOrEqual(3);
      for (const row of rows) {
        expect(Math.abs(row.offset), name).toBeLessThanOrEqual(1);
        if (row.noteLeft !== undefined)
          expect(Math.abs(row.noteLeft - row.textLeft), name).toBeLessThan(1);
        expect(row.overflow, name).toBeLessThanOrEqual(0);
      }
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
        name,
      ).toBe(true);
      return rows;
    };
    await check("wide");
    await page.screenshot({ path: "test-results/plan-styling/wide.png" });
    await drag(300);
    await check("narrow");
    expect(await panel.evaluate((element) => element.clientWidth)).toBeLessThanOrEqual(300);
    await page.screenshot({ path: "test-results/plan-styling/narrow.png" });
    await page.evaluate(() => document.documentElement.style.setProperty("--text-size", "22px"));
    await check("large text");
    await page.screenshot({ path: "test-results/plan-styling/large-text.png" });
    await page.evaluate(() => document.documentElement.style.removeProperty("--text-size"));
    await page.evaluate(() => {
      document.documentElement.dataset.colorScheme = "dark";
    });
    await check("dark");
    await page.screenshot({ path: "test-results/plan-styling/dark.png" });
    await page.emulateMedia({ forcedColors: "active" });
    await check("forced colors");
    await expect(panel.getByRole("progressbar")).toBeVisible();
    await page.screenshot({ path: "test-results/plan-styling/forced-colors.png" });
    await page.emulateMedia({ forcedColors: "none" });
    await expect(panel.getByRole("radiogroup")).toHaveCount(0);
    await expect(panel.getByRole("checkbox", { name: "Short task" })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: "Short task" })).toBeDisabled();
    await expect(panel.getByText("Blocked", { exact: true })).toBeVisible();
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

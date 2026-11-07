import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type _electron, expect, type Locator, type Page, test } from "@playwright/test";
import { privateDirectory } from "../src/platform/index.js";
import { launchDesktop, removeDesktopFixture as rm } from "./electron-launcher.js";
import { commitFixture } from "./fixtures/git-repository.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const windowTitle = () =>
  application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle());
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

async function selectSidebarPage(page: Page, name: string) {
  if (name === "Files") {
    await selectSidebarPage(page, "Chat");
    const toggle = page
      .locator("#panel-chat .orchestration-chat-page:visible")
      .getByRole("button", { name: "File Explorer", exact: true });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    return;
  }
  if (
    name === "Chat" &&
    (await page.locator("#tab-chat").getAttribute("aria-selected")) === "true"
  ) {
    await page.locator("#tab-chat").focus();
    return;
  }
  if (["Configurations", "Events", "Messages", "Polling", "Sessions", "Worktrees"].includes(name)) {
    const tables = page.getByRole("button", { name: "Tables", exact: true });
    if ((await tables.getAttribute("aria-expanded")) === "false") await tables.click();
  }
  await page.getByRole("tab", { name, exact: true }).click();
}

async function expectSplashLayout(page: Page) {
  await page.mouse.move(1, 1);
  const title = await page.locator(".splash-title").boundingBox();
  const prompt = await page.locator(".splash-prompt").boundingBox();
  const height = await page.evaluate(() => window.innerHeight);
  expect(title).not.toBeNull();
  expect(prompt).not.toBeNull();
  if (title && prompt) {
    expect(Math.abs(title.y + title.height / 2 - height / 2)).toBeLessThan(2);
    expect(Math.abs(prompt.y + prompt.height / 2 - height * 0.75)).toBeLessThan(2);
  }
  // Primary actions use teal in Light and the existing warm fill in Dark.
  const dark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  await expect(page.locator(".splash .primary")).toHaveCSS(
    "background-color",
    dark ? "rgb(197, 177, 125)" : "rgb(67, 179, 174)",
  );
  await expect(page.locator(".splash-card, .project-preview")).toHaveCount(0);
}

async function expectIndustrialSurfaces(page: Page) {
  const surfaces = await page
    .locator(
      "button, input, select, textarea, .setup-dialog, .composer, .event.toolCall, .approval, .chat-popup, .actions-menu",
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const style = getComputedStyle(element);
          const grouped = element.parentElement?.matches(".button-group");
          const chamfered = element.matches(".orchestration-chat-body .composer");
          const controls = grouped
            ? [...(element.parentElement?.children ?? [])].filter(
                (child) =>
                  child.matches("button, select") &&
                  !child.matches(".table-add-accessible:not(:focus-visible)"),
              )
            : [];
          const end = controls[0] === element || controls.at(-1) === element;
          return {
            expectedRadius: chamfered
              ? 24
              : grouped
                ? end
                  ? 5
                  : 0
                : element.tagName === "BUTTON"
                  ? 5
                  : 0,
            chamfered,
            radius: Math.max(
              ...[
                style.borderTopLeftRadius,
                style.borderTopRightRadius,
                style.borderBottomLeftRadius,
                style.borderBottomRightRadius,
              ].map(Number.parseFloat),
            ),
            corner: style.getPropertyValue("corner-top-right-shape"),
            shadow: style.boxShadow,
            overlay: element.matches(".setup-dialog, .chat-popup, .actions-menu"),
            baseline: element.matches(
              "input:not([type=checkbox], [type=radio]), select, textarea, .composer",
            ),
            focused: element.matches(":focus-visible"),
            image: style.backgroundImage,
            disabled: element.matches(":disabled, [aria-disabled='true']"),
            emptyProject: element.matches(".project-card[data-empty=true]"),
            selectedProject: element.matches(".project-card[data-empty=false]"),
            animation: style.animationName,
            height: element.tagName === "BUTTON" ? element.getBoundingClientRect().height : 36,
            minHeight: element.matches(".table-add-accessible:not(:focus-visible)")
              ? 0
              : grouped
                ? 28
                : element.matches("[role='tab']")
                  ? 24
                  : 36,
          };
        }),
    );
  expect(surfaces.length).toBeGreaterThan(0);
  for (const surface of surfaces) {
    expect(surface.radius).toBe(surface.expectedRadius);
    if (surface.chamfered) expect(surface.corner).toBe("superellipse(0)");
    if (!surface.focused && !surface.overlay && !surface.baseline)
      expect(surface.shadow).toBe("none");
    if ((surface.disabled && !surface.selectedProject) || surface.emptyProject)
      expect(surface.image).toContain("repeating-linear-gradient");
    else expect(surface.image).toBe("none");
    expect(surface.animation).toBe("none");
    expect(surface.height).toBeGreaterThanOrEqual(surface.minHeight);
  }
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
    expect(fill, token).toBe(palette.dark ? "rgb(36, 43, 51)" : "rgb(255, 255, 255)");
  expect(palette.colors).toEqual(
    palette.dark
      ? {
          "--text": "rgb(255, 255, 255)",
          "--muted": "rgb(170, 170, 170)",
          "--border": "rgb(65, 75, 86)",
          "--control-border": "rgb(136, 136, 136)",
          "--accent-bg": "rgb(50, 60, 70)",
          "--surface-edge": "rgb(65, 75, 86)",
          "--disabled-stripe": "rgba(0, 0, 0, 0)",
          "--primary": "rgb(197, 177, 125)",
          "--hover-bg": "rgb(32, 62, 59)",
          "--human-text": "rgb(181, 200, 211)",
        }
      : {
          "--text": "rgb(0, 0, 0)",
          "--muted": "rgb(85, 85, 85)",
          "--border": "rgb(208, 208, 208)",
          "--control-border": "rgb(119, 119, 119)",
          "--accent-bg": "rgb(237, 237, 237)",
          "--surface-edge": "rgb(208, 208, 208)",
          "--disabled-stripe": "rgba(0, 0, 0, 0)",
          "--primary": "rgb(67, 179, 174)",
          "--hover-bg": "rgb(226, 243, 241)",
          "--human-text": "rgb(20, 108, 103)",
        },
  );
}

async function expectTabAppearance(page: Page) {
  // Hovering an inactive tab gives it the active text color, so measure with the pointer clear.
  await page.mouse.move(1, 1);
  const appearance = await page.evaluate(() => {
    const active = document.querySelector<HTMLElement>("[role='tab'][aria-selected='true']");
    const inactive = document.querySelector<HTMLElement>("[role='tab'][aria-selected='false']");
    const bar = document.querySelector(".sidebar");
    const panel = document.getElementById(active?.getAttribute("aria-controls") ?? "");
    if (!active || !inactive || !bar || !panel) throw new Error("Missing page tabs");
    return {
      activeId: active.id,
      activeBackground: getComputedStyle(active).backgroundColor,
      panelBackground: getComputedStyle(panel).backgroundColor,
      leftBorders: [active, inactive, document.querySelector(".sidebar-header")].map((element) =>
        element ? getComputedStyle(element).borderLeftWidth : "",
      ),
      hoverBackground: (() => {
        const probe = document.createElement("span");
        probe.style.background = "var(--hover-bg)";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      })(),
      accentBackground: (() => {
        const probe = document.createElement("span");
        probe.style.background = "var(--accent-bg)";
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      })(),
      activeRight: active.getBoundingClientRect().right,
      panelLeft: panel.getBoundingClientRect().left,
      barTop: bar.getBoundingClientRect().top,
      panelTop: panel.getBoundingClientRect().top,
      barWidth: bar.getBoundingClientRect().width,
      tabTops: [...bar.querySelectorAll("[role='tab']")]
        .filter((tab) => tab.getClientRects().length > 0)
        .map((tab) => tab.getBoundingClientRect().top),
      inactiveBackground: getComputedStyle(inactive).backgroundColor,
    };
  });
  // Sidebar items carry no side rule; the selected tab has a neutral fill.
  expect(appearance.leftBorders).toEqual(["1px", "1px", "1px"]);
  expect(appearance.activeBackground).toBe(appearance.accentBackground);
  expect(appearance.activeBackground).not.toBe(appearance.hoverBackground);
  expect(appearance.barWidth).toBe(220);
  expect(appearance.activeRight).toBeLessThan(appearance.panelLeft);
  expect(appearance.barTop).toBe(appearance.panelTop);
  expect(appearance.tabTops.every((top, i, tops) => i === 0 || top > (tops[i - 1] ?? 0))).toBe(
    true,
  );
  await expect(page.getByRole("tablist", { name: "Pages", exact: true })).toHaveAttribute(
    "aria-orientation",
    "vertical",
  );
  expect(appearance.inactiveBackground).not.toBe(appearance.activeBackground);
  await expect(page.locator(".sidebar")).toHaveCSS("border-top-width", "0px");
  const inactive = page.locator('[role="tab"][aria-selected="false"]:visible').first();
  const border = await inactive.evaluate((element) => getComputedStyle(element).borderColor);
  await expect(async () => {
    await inactive.hover();
    await expect(inactive).toHaveCSS("background-color", appearance.hoverBackground, {
      timeout: 500,
    });
  }).toPass({ timeout: 5_000 });
  await expect(inactive).toHaveCSS("border-color", border);
  await expect(inactive).toHaveCSS("outline-style", "none");
  await page.locator(`#${appearance.activeId}`).hover();
  await expect(page.locator(`#${appearance.activeId}`)).toHaveCSS(
    "background-color",
    appearance.activeBackground,
  );
  await page.mouse.move(1, 1);

  await expect(page.getByRole("button", { name: "Close Settings tab" })).toHaveCount(0);
}

async function appendRow(page: Page, table: "sessions" | "configurations" = "sessions") {
  // Success toasts from the previous action can cover the sticky row.
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
  for (let count = 0; count < 3 && (await dismiss.count()); count++) await dismiss.first().click();
  const grid = page.locator(`#panel-${table} .sessions-grid`);
  const canvas = grid.getByTestId("data-grid-canvas");
  // The add row ignores clicks while it is disabled, such as while a project opens.
  await expect(page.locator(`#panel-${table} .table-add-accessible`)).toBeEnabled();
  // The canvas is resized after layout; wait until it matches the grid before aiming at it.
  await expect
    .poll(async () => {
      const [outer, inner] = await Promise.all([grid.boundingBox(), canvas.boundingBox()]);
      return !!outer && !!inner && Math.abs(outer.width - inner.width) < 1;
    })
    .toBe(true);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing table canvas");
  const row = Number(await grid.getAttribute("data-row-height"));
  // The sticky add row is pinned to the bottom of the canvas, whatever the row count.
  await page.mouse.click(box.x + 70, box.y + box.height - row / 2);
}

async function launch(directory: string, folder: string, database: string, configured = true) {
  // Every automatic orchestration session uses the local ACP fixture, never a live provider.
  const configFile = join(directory, "config", "code60", "config.json");
  try {
    await stat(configFile);
  } catch {
    await mkdir(dirname(configFile), { recursive: true });
    await writeFile(
      configFile,
      JSON.stringify({
        agents: {
          claude: { command: [process.execPath, join(root, "test/fixtures/fake-agent.mjs")] },
        },
      }),
    );
  }
  // Most scenarios start with an existing provider; setup is covered without this fixture below.
  if (configured) {
    const file = join(directory, "state", "code60", "desktop.json");
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    if (!Object.hasOwn(saved, "orchestrationProvider")) {
      let provider = "claude";
      try {
        const config = JSON.parse(
          await readFile(join(directory, "config", "code60", "config.json"), "utf8"),
        );
        provider = config.defaultAgent ?? provider;
      } catch {}
      await privateDirectory(dirname(file));
      await writeFile(file, JSON.stringify({ ...saved, orchestrationProvider: provider }));
    }
  }
  return launchDesktop(directory, folder, database);
}

test("desktop: scoped message ages, turn timers, Copy, and minimized lifecycle", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-qol-"));
  application = await launch(directory, directory, join(directory, "projects.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSidebarPage(page, "Files");
    await page
      .locator(".files-page")
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "Open Project", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .locator("#panel-chat")
      .getByRole("button", { name: "File Explorer", exact: true })
      .click();
    await page.evaluate(async () => {
      await window.desktop.connectDatabase("create");
      await window.desktop.chooseFolder();
      await window.desktop.setPollingPaused(true);
    });
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
    await expect(chat.locator(".event.message pre")).toHaveText(source);
    await expect(chat.locator(".turn-timer")).toContainText("Working for");
    await expect(age).toHaveText(/Last message \d+s ago/);
    await expect(age).toHaveAttribute("aria-label", /selected orchestration conversation/);
    await expect(page.getByRole("button", { name: "Start polling", exact: true })).toBeVisible();
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
    await composer.focus();
    const selectedText = await chat.locator(".event.message pre").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString();
    });
    const beforeScroll = await chat.locator(".transcript").evaluate((element) => element.scrollTop);
    await agentCopy.click();
    await expect(composer).toBeFocused();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(selectedText);
    await expect(agentCopy).toHaveAttribute("aria-disabled", "true");
    await expect(chat.getByText("Copied.", { exact: true })).toHaveCount(0);
    await expect(chat.locator(".event.message pre")).toHaveText(`${source}later chunk`);
    const clipboardValues = () =>
      page.evaluate(
        () => (window as unknown as { copyHarness: { values: string[] } }).copyHarness.values,
      );
    expect(await clipboardValues()).toEqual([source]);
    await page.evaluate(() =>
      (window as unknown as { copyHarness: { reject(): void } }).copyHarness.reject(),
    );
    const retry = chat.getByRole("button", { name: "Retry Copy message", exact: true });
    await expect(retry).toBeVisible();
    await expect(chat.getByRole("status").filter({ hasText: "Copy failed." })).toBeVisible();
    await retry.focus();
    await page.keyboard.press("Enter");
    expect(await clipboardValues()).toEqual([source, `${source}later chunk`]);
    await page.evaluate(() =>
      (window as unknown as { copyHarness: { resolve(): void } }).copyHarness.resolve(),
    );
    await expect(chat.getByRole("status").filter({ hasText: "Copied." })).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(composer).toHaveValue("untouched draft");
    // Feedback is overlaid, not inserted into the transcript's scrolling layout.
    expect(await chat.locator(".transcript").evaluate((element) => element.scrollTop)).toBe(
      beforeScroll,
    );
    const userCopy = chat.locator(".event.prompt").getByRole("button", { name: "Copy message" });
    await userCopy.click();
    expect((await clipboardValues()).at(-1)).toBe(prompt);
    await page.evaluate(() =>
      (window as unknown as { copyHarness: { resolve(): void } }).copyHarness.resolve(),
    );
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(chat.locator(".turn-timer")).toContainText(/Worked for .+ \(cancelled\)/);
    const frozen = await chat.locator(".turn-timer").textContent();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
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
    await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("button", { name: "Chat 1", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("#tab-chat")).toBeFocused();
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
    const head = page.locator(`[data-chat-id="${id}"] > .chat-head`);
    await expect(head).toContainText("Approval needed");
    await expect(head).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".chat-popup:visible")).toHaveCount(0);
    // A manual session must not become delegated activity for the orchestrator.
    await expect(chat.locator(".chat-loader")).toHaveCount(0);
    await head.click();
    const popup = page.locator(`#chat-${id}`);
    await expect(popup).toHaveCSS("width", "400px");
    await expect(popup.locator(".turn-timer")).toContainText("Working for");
    await popup.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(head).toContainText("Awaiting input");
    await expect(popup.locator(".turn-timer")).toContainText(/Worked for .+ \(finished\)/);
    const worked = await popup.locator(".turn-timer").textContent();
    await page.reload();
    await expect(head).toHaveAttribute("aria-pressed", "false");
    await head.click();
    await expect(popup.locator(".turn-timer")).toHaveText(worked ?? "");
    const historical = popup.locator(".event.message");
    await historical.getByRole("button", { name: "Copy message" }).click();
    await expect(historical.getByRole("status")).toHaveText("Copied.");
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "permission qol-approval: opt-allow_once  historical\n```code```\n",
    );
    await selectSidebarPage(page, "Sessions");
    await expect(age).toHaveAttribute("aria-label", /current project sessions/);
    await expect(age).toHaveText(/Last message/);
    await expect(page.locator(".app-footer")).toHaveCSS("height", "40px");
    await page.evaluate(() => document.documentElement.style.setProperty("--button-size", "32px"));
    expect(
      await page.locator(".app-footer").evaluate((element) => element.clientHeight),
    ).toBeGreaterThan(40);
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
    await selectSidebarPage(page, "Sessions");
    return page;
  };
  try {
    application = await launch(directory, directory, database);
    let page = await enter();
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
    await expect(page.locator(".sidebar")).toHaveCSS("width", "220px");
    // The project card and navigation items have 5px corners.
    const sidebarHeader = page.locator(".sidebar-header");
    await expect(sidebarHeader).toHaveText("Open a project");
    await expect(sidebarHeader).toHaveCSS("border-top-right-radius", "5px");

    const tabs = page.locator(".page-tabs [role='tab']");
    await expect(tabs).toHaveCount(11);
    const tabCorners = await tabs.evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return [style.borderTopRightRadius, style.getPropertyValue("corner-shape")];
      }),
    );
    for (const [radius, shape] of tabCorners) {
      expect(radius).toBe("5px");
      expect(shape).not.toMatch(/^(bevel|superellipse\(0\))$/);
    }
    const tabGaps = await page.locator("#table-pages button:visible").evaluateAll((elements) =>
      elements.slice(1).map((element, index) => {
        const previous = elements[index];
        if (!previous) throw new Error("Missing previous tab");
        return element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
      }),
    );
    expect(tabGaps).toEqual(Array(5).fill(4));
    await expect(page.locator(".page-tabs")).toHaveCSS("gap", "4px");
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
    await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveCSS(
      "border-top-right-radius",
      "5px",
    );
    await expectTabAppearance(page);
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
    // The sidebar stays fixed while the page shrinks, without overflowing the window.
    const originalSize = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getSize(),
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 600),
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
    await expect(toggle()).toBeChecked();
    await expect(page.locator(".app")).toHaveCSS("background-image", "none");
    await application.close();

    application = await launch(directory, directory, database);
    page = await enter();
    await expect(page.locator("html")).toHaveAttribute("data-transparent", "true");
    await selectSidebarPage(page, "Settings");
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await selectSidebarPage(page, "Sessions");
    await expectNeutralTheme(page);
    for (const selector of [".sidebar", "#panel-sessions", ".app-footer"])
      await expect(page.locator(selector)).toHaveCSS("background-color", "rgb(36, 43, 51)");
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
    await move(4, 200);
    await expect.poll(ignored).toBe(mac);
    // Passive page corners are square and remain clickable.
    const width = await page.evaluate(() => window.innerWidth);
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
    await expect(page.locator(".app-footer")).toHaveCSS("border-top-width", "1px");
    await expect(
      page.locator(".sidebar .footer-polling, .page-panel .chat-dock-region"),
    ).toHaveCount(0);
    await move(4, appFooter.y + 10);
    await expect.poll(ignored).toBe(false);
    // The enclosing sidebar stays opaque and interactive between its buttons.
    await move(firstTab.x + firstTab.width / 2, firstTab.y + firstTab.height + 2);
    await expect.poll(ignored).toBe(false);
    await move(4, 200);
    await expect.poll(ignored).toBe(mac);
    await move(30, 14);
    await expect.poll(ignored).toBe(false);

    await page.getByRole("tab", { name: "Settings", exact: true }).click();
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
    // Without a previous project, the splash waits for the yellow Start button.
    const splash = page.locator(".splash");
    await expect(splash).toHaveText("Code60Start");
    await expect(splash.locator(".splash-title")).toHaveCSS("font-family", /^"?D-DIN"?/);
    await expect(splash.getByRole("button", { name: "Start", exact: true })).toBeFocused();
    await expect(splash.getByRole("button")).toHaveCount(1);
    await expectSplashLayout(page);
    await expectIndustrialSurfaces(page);
    await page.waitForTimeout(1500);
    await expect(splash).toBeVisible();
    await splash.getByRole("button", { name: "Start", exact: true }).click();
    await selectSidebarPage(page, "Sessions");
    await expect(splash).toHaveCount(0);
    // The Sessions tab contains the start screen until a database is connected.
    await expect(page.locator(".topbar")).toHaveCount(0);
    await expect(
      page.locator("#panel-sessions .welcome").getByRole("button", { name: "Connect to database" }),
    ).toBeVisible();
    // Settings is a permanent sidebar tab, not a start-screen gear.
    await expect(page.locator("#panel-sessions").getByRole("button")).toHaveCount(1);
    const sessionsTab = page.getByRole("tab", { name: "Sessions", exact: true });
    const messagesTab = page.getByRole("tab", { name: "Messages", exact: true });
    const worktreesTab = page.getByRole("tab", { name: "Worktrees", exact: true });
    const settingsTab = page.getByRole("tab", { name: "Settings", exact: true });
    await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab")).toHaveCount(10);
    await settingsTab.click();
    await expect(settingsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Settings" })).toBeVisible();
    const about = page.getByRole("region", { name: "About", exact: true });
    await expect(about.getByText(version, { exact: true })).toBeVisible();
    const versions = (await page.evaluate(() => window.desktop.snapshot())).versions;
    expect(versions).toMatchObject({
      code60: version,
      databaseSchema: 3,
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
    await expectTabAppearance(page);
    await sessionsTab.click();
    await expectTabAppearance(page);
    await sessionsTab.click();
    await expect(settingsTab).toHaveCount(1);
    await expect(sessionsTab).toBeFocused();
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
    const connect = page.getByRole("button", { name: "Connect to database", exact: true });
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
    await expect(newSession).toBeDisabled();
    await expect(newSession).toHaveText("New agent session");
    await expect(page.getByText(/code60\.sqlite|Database:|Project:/)).toHaveCount(0);
    await expect.poll(async () => (await menuItem("open-project"))?.enabled).toBe(true);
    await clickMenu("open-project");
    await expect(page.getByRole("heading", { name: "Open Project" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Open Project" })).toBeHidden();
    await clickMenu("open-project");
    await page.getByRole("button", { name: "Create new project…" }).click();
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
    await expect.poll(async () => (await menuItem("open-project"))?.enabled).toBe(false);
    // Starting a batch expands the right-aligned chat head into a flush chat with subtle depth.
    const chatPopup = page.getByRole("dialog", { name: /^fake \/ / });
    await expect(page.locator(".chat-head")).toHaveAttribute("aria-pressed", "false");
    await page.locator(".chat-head").click();
    await expect(chatPopup).toBeVisible();
    const chatHead = page.locator(".app-footer .chat-head");
    await expect(chatHead).toHaveCount(1);
    await expect(chatHead).toHaveAttribute("aria-pressed", "true");
    await expect(chatPopup).not.toHaveCSS("box-shadow", "none");
    await expect(chatPopup).toHaveCSS("border-top-right-radius", "0px");
    const popupBox = await chatPopup.boundingBox();
    const headBox = await chatHead.boundingBox();
    const footerBox = await page.locator(".app-footer").boundingBox();
    if (!popupBox || !headBox || !footerBox) throw new Error("Missing chat layout");
    expect(popupBox.x).toBe(headBox.x);
    expect(popupBox.width).toBe(headBox.width);
    expect(popupBox.y + popupBox.height).toBeCloseTo(headBox.y, 1);
    expect(headBox.height).toBe(footerBox.height);
    expect(headBox.y).toBe(footerBox.y);
    expect(headBox.y + headBox.height).toBe(footerBox.y + footerBox.height);
    // Chat heads keep the application footer's 12px right inset.
    expect(headBox.x + headBox.width).toBeCloseTo(footerBox.x + footerBox.width - 12, 1);
    const expectChatFooterLayout = async () => {
      const head = await chatHead.boundingBox();
      const footer = await page.locator(".app-footer").boundingBox();
      if (!head || !footer) throw new Error("Missing chat footer");
      expect(head.height).toBe(footer.height);
      expect(head.y).toBe(footer.y);
    };
    const expectDistinctChatSurfaces = async () => {
      const colors = await page.evaluate(() => {
        const style = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Missing ${selector}`);
          return getComputedStyle(element);
        };
        const popup = style(".chat-popup");
        const grid = style(".sessions");
        const header = style(".chat-header");
        const composer = style(".chat-popup .composer");
        const footer = style(".chat-head[aria-pressed='true']");
        return {
          dark: getComputedStyle(document.documentElement).colorScheme === "dark",
          headerFrame: header.borderBottomColor,
          shadow: popup.boxShadow,
          popup: popup.backgroundColor,
          grid: grid.backgroundColor,
          frame: popup.borderLeftColor,
          frameWidth: popup.borderLeftWidth,
          header: header.backgroundColor,
          composer: composer.backgroundColor,
          composerFrame: composer.borderTopColor,
          composerFrameWidth: composer.borderTopWidth,
          footer: footer.backgroundColor,
          footerFrame: footer.borderLeftColor,
          footerFrameWidth: footer.borderLeftWidth,
          gridBorder: style("#panel-sessions .table-controls").borderBottomColor,
        };
      });
      expect(colors.frame).not.toBe("rgba(0, 0, 0, 0)");
      expect(colors.frameWidth).toBe("1px");
      expect(colors.composerFrameWidth).toBe("1px");
      expect(colors.footerFrameWidth).toBe("1px");
      expect(colors.shadow).not.toBe("none");
      for (const fill of [colors.popup, colors.grid, colors.header, colors.composer])
        expect(fill).toBe(colors.dark ? "rgb(36, 43, 51)" : "rgb(255, 255, 255)");
      expect(colors.footer).toBe(colors.dark ? "rgb(50, 60, 70)" : "rgb(237, 237, 237)");
      expect(colors.composerFrame).not.toBe("rgba(0, 0, 0, 0)");
      expect(colors.headerFrame).not.toBe("rgba(0, 0, 0, 0)");
      expect(colors.footerFrame).toBe("rgba(0, 0, 0, 0)");
    };
    await expectDistinctChatSurfaces();
    await expect(chatPopup.getByLabel("Message", { exact: true })).toBeEnabled();
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
    await expect(page.locator(".sidebar-title")).toHaveText("repo");
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
      left: 244,
      right: 12,
      bottom: 52,
      clip: "none",
      barRule: ["0px", "none"],
      toolbarPadding: ["16px", "16px"],
      tabClear: true,
    });
    await page.getByRole("button", { name: "Refresh project data" }).click();
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
    await pollingWidget.getByRole("button", { name: "Pause polling" }).click();
    await expect(historySource).toContainText("Paused");
    await pollingWidget.getByRole("button", { name: "Refresh project data" }).click();
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
    await expect(pollingWidget.getByRole("img")).toHaveAttribute(
      "aria-label",
      /Agent text in current project sessions:/,
    );
    const stamp = await pollingWidget.locator(".poll-timestamp").boundingBox();
    const footer = await page.locator(".app-footer").boundingBox();
    if (!stamp || !footer) throw new Error("Missing polling timestamp");
    expect(stamp.y + stamp.height).toBeLessThan(footer.y);
    await pollingWidget.screenshot({
      path: join(root, "test-results", "footer-polling-paused.png"),
    });
    await pollingWidget.getByRole("button", { name: "Start polling" }).click();
    await expect(historySource).not.toContainText("Paused");
    await worktreesTab.click();
    await sessionsTab.click();
    await expect(
      page
        .locator("#panel-sessions .table-controls")
        .getByRole("button", { name: "Stop all runs" }),
    ).toBeVisible();
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
    await expect(chatHead).toHaveAttribute("aria-label", /1 approval/);
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
    await sessionsTab.click();
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
    await expect(page.locator(".event.prompt").last()).toContainText("follow up");
    // The splash shows once per launch, not on renderer reloads.
    await expect(page.locator(".splash")).toHaveCount(0);
    expect(await windowTitle()).toBe(`Code60 - ${version}`);
    await expect(chatHead).toHaveAttribute("aria-pressed", "false");
    await chatHead.click();
    await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
    await chatPopup.getByRole("button", { name: "Minimize chat" }).click();
    await expect(chatPopup).toBeHidden();
    await expect(chatHead).toHaveAttribute("aria-pressed", "false");
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
    const changes = page.getByRole("dialog", { name: "Changes" });
    await expect(changes.locator(".diff")).toContainText("+after");
    await page.keyboard.press("Escape");
    await expect(changes).toBeHidden();
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
    await expect(page.getByRole("tab")).toHaveCount(10);
    // Tab switching preserves Settings scroll, session selection, and the open chat draft.
    const settingsPage = page.locator(".settings-page");
    await settingsPage.evaluate((element) => {
      element.scrollTop = 180;
    });
    const settingsScroll = await settingsPage.evaluate((element) => element.scrollTop);
    expect(settingsScroll).toBeGreaterThan(0);
    await sessionsTab.click();
    await expect(appearance).toBeHidden();
    await expect(settingsTab).toHaveCount(1);
    await expect(chatPopup).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "draft retained across tabs",
    );
    await expect(
      page.locator("#panel-sessions .sessions-grid tbody [role='row'][aria-selected='true']"),
    ).toHaveCount(1);
    await page.getByLabel("Message", { exact: true }).fill("");
    // Keyboard navigation follows the alphabetized visual order, including wraparound.
    const alphabeticalPages = [
      "Chat",
      "Experiments",
      "Prompt Editor",
      "Search",
      "Settings",
      "Tables",
      "Configurations",
      "Events",
      "Messages",
      "Polling",
      "Sessions",
      "Worktrees",
    ] as const;
    await expect(page.getByRole("tab")).toHaveText(
      alphabeticalPages.filter((name) => name !== "Tables" && name !== "Experiments"),
    );
    await sessionsTab.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: alphabeticalPages[0], exact: true })).toBeFocused();
    for (const name of alphabeticalPages.slice(1)) {
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole(name === "Tables" || name === "Experiments" ? "button" : "tab", {
          name,
          exact: true,
        }),
      ).toBeFocused();
    }
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(worktreesTab).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect(worktreesTab).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeFocused();
    await settingsTab.click();
    await expect(page.getByRole("tab")).toHaveCount(10);
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
    await expect(page.locator("#panel-settings").getByRole("heading", { level: 2 })).toHaveText([
      "Orchestration",
      "Appearance",
      "Table defaults",
      "Text",
      "Polling",
      "About",
    ]);
    // The settings content is centered in the page, excluding the sidebar.
    const centered = await page.evaluate(() => {
      const box = document.querySelector(".settings-page-heading")?.getBoundingClientRect();
      const panel = document.querySelector("#panel-settings")?.getBoundingClientRect();
      return box && panel
        ? Math.abs(box.left + box.width / 2 - panel.left - panel.width / 2)
        : Infinity;
    });
    expect(centered).toBeLessThan(10);
    for (const theme of ["dark", "light", "system"]) {
      await page.getByLabel("Theme").selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expectThemeContrast(page);
      await expectNeutralTheme(page);
      const chatVisible = await chatPopup.isVisible();
      if (chatVisible) {
        await chatPopup.getByRole("button", { name: "Minimize chat" }).click();
        await expect(chatPopup).toBeHidden();
      }
      await page.screenshot({ path: `test-results/neutral-theme-settings-${theme}.png` });
      if (chatVisible) await chatHead.click();
      await expectIndustrialSurfaces(page);
      await sessionsTab.click();
      await expectTabAppearance(page);
      await expectChatFooterLayout();
      await expectDistinctChatSurfaces();
      await expect(page.locator(".event.prompt pre").first()).toHaveCSS(
        "font-family",
        /^"?D-DIN"?/,
      );
      await expect(page.locator(".event.message pre").first()).toHaveCSS(
        "font-family",
        /^"?D-DIN"?/,
      );
      // Human messages use the theme’s accent text, with no side rule.
      const darkTheme =
        theme === "dark" ||
        (theme === "system" &&
          (await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)));
      await expect(page.locator(".event.prompt pre").first()).toHaveCSS(
        "color",
        darkTheme ? "rgb(181, 200, 211)" : "rgb(20, 108, 103)",
      );
      await expect(page.locator(".event.prompt").first()).toHaveCSS("border-left-width", "0px");
      if (theme === "dark") {
        await expect(chatHead).toHaveCSS("background-color", "rgb(50, 60, 70)");
        await expect(chatHead).toHaveCSS("color", "rgb(255, 255, 255)");
        await expect(chatPopup).toHaveCSS("background-color", "rgb(36, 43, 51)");
        // Primary buttons stay filled in dark mode.
        const primary = await page.evaluate(() => {
          const probe = document.createElement("button");
          probe.className = "primary";
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        });
        expect(primary).toBe("rgb(197, 177, 125)");
        await page.screenshot({ path: "test-results/steel-gray-theme-sessions-chat.png" });
      }
      await settingsTab.click();
    }
    const typeface = page
      .getByRole("group", { name: "Normal Text", exact: true })
      .getByLabel("Typeface");
    await expect(typeface).toHaveValue("");
    const headingCase = page
      .getByRole("group", { name: "Table Headings", exact: true })
      .getByRole("switch", { name: "Uppercase", exact: true });
    await expect(headingCase).not.toBeChecked();
    await expect(headingCase).toBeEnabled();
    await page
      .getByRole("group", { name: "Table Headings", exact: true })
      .getByLabel("Typeface")
      .selectOption("d-din");
    await headingCase.uncheck();
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
      "Shantell Sans",
      "OCR-A",
      "Roboto",
      "Tahoma",
      "Verdana",
    ]);
    // Each bundled typeface must load under the Content Security Policy once it is in use.
    for (const [value, family] of [
      ["computer-modern", "CMU Serif"],
      ["ibm-plex-sans", "IBM Plex Sans"],
      ["ibm-plex-serif", "IBM Plex Serif"],
      ["shantell-sans", "Shantell Sans"],
      ["ocr-a", "OCR-A"],
      ["roboto", "Roboto"],
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
    // Renderer reload reconstructs the dock minimized, without covering Settings.
    await expect(chatHead).toHaveAttribute("aria-pressed", "false");
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
      await group.getByRole("switch", { name: "Uppercase", exact: true }).check();
      await group.getByRole("switch", { name: "Lowercase", exact: true }).check();
      await expect(group.getByRole("switch", { name: "Uppercase", exact: true })).not.toBeChecked();
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
    for (const [index, name] of roles.entries()) {
      const group = page.getByRole("group", { name, exact: true });
      await expect(group.getByLabel("Font size")).toHaveValue(String(16 + index));
      await expect(group.getByLabel("Typeface")).toHaveValue("georgia");
      await expect(group.getByRole("switch", { name: "Lowercase", exact: true })).toBeChecked();
    }
    await sessionsTab.click();
    if (!(await chatPopup.isVisible())) await chatHead.click();
    await expectChatFooterLayout();
    await expect(page.locator(".event.message pre").first()).toHaveCSS("font-size", "18px");
    await expect(page.locator(".event.prompt pre").first()).toHaveCSS("font-size", "19px");
    await expect(page.locator(".event.message pre").first()).toHaveCSS(
      "text-transform",
      "lowercase",
    );
    await chatPopup.getByRole("button", { name: "Minimize chat" }).click();
    await settingsTab.click();
    await page.getByRole("button", { name: "Reset text", exact: true }).click();
    for (const name of roles) {
      const group = page.getByRole("group", { name, exact: true });
      await expect(group.getByLabel("Font size")).toHaveValue("");
      await expect(group.getByLabel("Typeface")).toHaveValue("");
      await expect(group.getByRole("switch", { name: "Lowercase", exact: true })).not.toBeChecked();
    }
    await expect(page.locator(".settings-page-heading h1")).toHaveCSS("text-transform", "none");
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
    await expect(chatHead).toHaveCSS("background-color", "rgb(50, 60, 70)");
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
    // A restart reconnects to the remembered database, and the splash offers the last project.
    application = await launch(directory, join(directory, "unused"), database);
    const again = await application.firstWindow();
    await expect
      .poll(async () => (await stat(workspaceDirectory).catch(() => null))?.isDirectory())
      .toBe(true);
    again.on("pageerror", (error) => errors.push(error.message));
    again.on("console", (entry) => {
      if (entry.type() === "error") errors.push(entry.text());
    });
    const offer = again.locator(".splash-prompt");
    await expect(offer.getByRole("heading")).toHaveText("Continue repo?");
    await expect(offer).toHaveText("Continue repo?NoYes");
    const splashButtons = await offer.locator(".splash-actions button").evaluateAll((buttons) =>
      buttons.map((button) => ({
        label: button.textContent,
        width: button.getBoundingClientRect().width,
        x: button.getBoundingClientRect().x,
      })),
    );
    expect(splashButtons.map((button) => button.label)).toEqual(["No", "Yes"]);
    expect(splashButtons[0]?.width).toBe(splashButtons[1]?.width);
    expect(splashButtons[0]?.width).toBeGreaterThanOrEqual(160);
    expect(splashButtons[0]?.x).toBeLessThan(splashButtons[1]?.x ?? 0);
    await again.screenshot({ path: "test-results/splash-equal-actions.png" });
    await expectSplashLayout(again);
    await expect(offer.getByRole("button", { name: "Yes", exact: true })).toBeFocused();
    // The splash waits for an answer instead of closing by itself.
    await again.waitForTimeout(1500);
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Yes", exact: true }).click();
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
      const buttons = [...document.querySelectorAll(".page-tabs button")]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => button.getBoundingClientRect());
      return {
        visible: overlay.visible,
        clear: buttons.every((box) => box.top >= area.bottom),
        drag: bar ? getComputedStyle(bar).getPropertyValue("app-region") : "",
      };
    });
    expect(titlebar).toEqual({ visible: true, clear: true, drag: "drag" });
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
    ).toBe("low"); // An ended session does not reopen its chat on startup, so the footer has no chat heads.
    const restoredChat = again.getByRole("dialog", { name: /^fake \/ / });
    await expect(restoredChat).toBeHidden();
    await expect(again.locator(".chat-head")).toHaveCount(0);
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
    await expect(again.getByRole("dialog", { name: "Changes" }).locator(".diff")).toContainText(
      "+after",
    );
    await again.keyboard.press("Escape");
    await expect(again.getByRole("dialog", { name: "Changes" })).toBeHidden();
    // The grid's scroll layer sits above the canvas and receives pointer input.
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Missing sessions grid");
    // Clicking the row number opens the chat, like clicking any other cell in the row.
    await again.mouse.click(box.x + 20, box.y + 48);
    await expect(restoredChat).toBeVisible();
    await restoredChat.getByRole("button", { name: "Minimize chat" }).click();
    await again.mouse.click(box.x + 80, box.y + 48);
    await expect(restoredChat).toBeVisible();
    await expect(restoredChat.locator(".event.prompt").last()).toContainText("follow up");
    await expect(again.locator(".chat-head")).toHaveAttribute("aria-pressed", "true");
    await restoredChat.getByRole("button", { name: "Minimize chat" }).click();
    await expect(restoredChat).toBeHidden();
    await canvas.press("Enter");
    await expect(restoredChat).toBeVisible();
    await expect(again.locator("#panel-sessions .table-add-accessible")).toBeEnabled();
    // Fit columns to width fills the grid with the columns and follows window resizes.
    await restoredChat.getByRole("button", { name: "Minimize chat" }).click();
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
    // Answering No (here with Escape) closes the splash and leaves the project closed.
    await application.close();
    application = await launch(directory, join(directory, "unused"), database);
    const third = await application.firstWindow();
    const declined = third.locator(".splash-prompt");
    await expect(declined.getByRole("button", { name: "No", exact: true })).toBeVisible();
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

test("desktop: splash requires an orchestrator and opens provider setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-onboarding-"));
  const database = join(directory, "projects.sqlite");
  const file = join(directory, "state", "code60", "desktop.json");
  try {
    application = await launch(directory, directory, database, false);
    let page = await application.firstWindow();
    let setup = page.getByRole("dialog", { name: "Set orchestration provider", exact: true });
    await expect(setup).toBeVisible();
    await expect(setup.getByLabel("Orchestration provider", { exact: true })).toHaveValue("");
    await expect(setup.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
    await expect(
      setup.getByRole("switch", { name: "Allow all actions without asking", exact: true }),
    ).toBeChecked();
    expect(await page.evaluate(() => sessionStorage.getItem("code60.splashShown"))).toBeNull();
    await page.keyboard.press("Escape");
    await expect(setup).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".splash")).toBeVisible();
    await expect(page.locator(".page-tabs")).toHaveCount(0);
    await page.getByRole("button", { name: "Set orchestration provider", exact: true }).click();
    await expect(setup).toBeVisible();
    // Even a stale reload marker cannot bypass the missing provider.
    await page.evaluate(() => {
      sessionStorage.setItem("code60.splashShown", "1");
      localStorage.setItem("code60.theme", "light");
    });
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await expect(setup).toBeVisible();
    await page.screenshot({ path: "test-results/orchestration-setup-light.png" });

    // A failed preference write must not unlock entry.
    await privateDirectory(dirname(file));
    const temporary = file;
    await mkdir(temporary, { recursive: true });
    await setup.getByLabel("Orchestration provider", { exact: true }).selectOption("claude");
    await expect(setup.getByRole("alert")).toBeVisible();
    await expect(setup.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
    await expect(setup.getByLabel("Orchestration provider", { exact: true })).toHaveValue("");
    await rm(temporary, { recursive: true });
    await setup.getByLabel("Orchestration provider", { exact: true }).selectOption("claude");
    await expect(setup.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
    await setup.getByRole("button", { name: "Done", exact: true }).click();
    await expect(setup).toHaveCount(0);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSidebarPage(page, "Sessions");
    await expect(page.locator(".splash")).toHaveCount(0);
    expect(JSON.parse(await readFile(file, "utf8")).orchestrationProvider).toBe("claude");

    // An already open project cannot bypass the gate on reload either.
    await page.evaluate(async () => {
      await window.desktop.connectDatabase("create");
      await window.desktop.chooseFolder();
      await window.desktop.setOrchestrationProvider(null);
    });
    await page.reload();
    if (
      await page.evaluate(async () => {
        const s = await window.desktop.snapshot();
        return s.orchestration.provider !== null && s.agents.includes(s.orchestration.provider);
      })
    )
      await selectSidebarPage(page, "Sessions");
    await expect(setup).toBeVisible();
    await expect(page.locator(".page-tabs")).toHaveCount(0);
    await setup.getByLabel("Orchestration provider", { exact: true }).selectOption("claude");
    await expect(page.locator(".splash")).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem("code60.theme", "dark"));
    await application.close();

    const saved = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...saved, orchestrationProvider: "removed" }));
    application = await launch(directory, directory, database, false);
    page = await application.firstWindow();
    setup = page.getByRole("dialog", { name: "Set orchestration provider", exact: true });
    await expect(setup).toBeVisible();
    await expect(setup.getByLabel("Orchestration provider", { exact: true })).toHaveValue(
      "removed",
    );
    await expect(setup.getByRole("alert")).toHaveText("Unavailable provider: removed");
    await expect(setup.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 600),
    );
    await page.screenshot({ path: "test-results/orchestration-setup-dark-narrow.png" });
    await setup.getByLabel("Orchestration provider", { exact: true }).selectOption("claude");
    await expect(setup.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(setup).toHaveCount(0);
    await expect(page.locator(".splash")).toBeVisible();
    await expect(page.locator(".splash-prompt h2")).toHaveText(`Continue ${basename(directory)}?`);
    await page.keyboard.press("Escape");
    await expect(page.locator(".splash")).toHaveCount(0);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: orchestration provider persistence, ACP probe, failure, and cancellation", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "code60-orchestration-"));
  const config = join(directory, "config", "code60");
  const database = join(directory, "projects.sqlite");
  await mkdir(config, { recursive: true });
  const agent = join(root, "test/fixtures/fake-agent.mjs");
  await writeFile(
    join(config, "config.json"),
    JSON.stringify({
      defaultAgent: "fake",
      agents: {
        fake: { command: [process.execPath, agent] },
        broken: { command: [process.execPath, "-e", "process.exit(2)"] },
        hanging: { command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] },
        auth: { command: [process.execPath, agent, "--auth"] },
      },
    }),
  );
  try {
    application = await launch(directory, directory, database);
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSidebarPage(page, "Sessions");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    let provider = page.getByLabel("Orchestration provider", { exact: true });
    await expect(provider).toHaveValue("fake");
    const allowAll = page.getByRole("switch", {
      name: "Allow all actions without asking",
      exact: true,
    });
    await expect(allowAll).toBeChecked();
    await expect(allowAll).toBeDisabled();
    await expect(page.getByRole("button", { name: "Test connection", exact: true })).toBeDisabled();
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await provider.selectOption("fake");
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "ACP connection successful" }),
    ).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).runs).toEqual([]);
    await page.getByLabel("Theme", { exact: true }).selectOption("light");
    await page.screenshot({ path: "test-results/orchestration-settings-light.png" });
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(760, 650),
    );
    await page.screenshot({ path: "test-results/orchestration-settings-dark-narrow.png" });
    const row = await page
      .locator(".orchestration-provider-row")
      .evaluate((element) => ({ scroll: element.scrollWidth, width: element.clientWidth }));
    expect(row.scroll).toBeLessThanOrEqual(row.width);
    await application.close();

    application = await launch(directory, directory, database);
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSidebarPage(page, "Sessions");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    provider = page.getByLabel("Orchestration provider", { exact: true });
    await expect(provider).toHaveValue("fake");
    expect((await page.evaluate(() => window.desktop.snapshot())).orchestration).toEqual({
      provider: "fake",
      allowAll: true,
      connection: "idle",
      error: null,
    });

    await provider.selectOption("broken");
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(/agent exited|ACP connection closed/);
    await provider.selectOption("auth");
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("log in");
    await provider.selectOption("hanging");
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await expect(provider).toBeDisabled();
    await page.getByRole("button", { name: "Cancel test", exact: true }).click();
    await expect(provider).toBeEnabled();
    expect((await page.evaluate(() => window.desktop.snapshot())).orchestration.connection).toBe(
      "idle",
    );
    await provider.selectOption("");
    await expect(page.getByRole("button", { name: "Test connection", exact: true })).toBeDisabled();
    await expect
      .poll(
        async () => (await page.evaluate(() => window.desktop.snapshot())).orchestration.provider,
      )
      .toBeNull();
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: prompt template editing and persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-prompts-"));
  application = await launch(directory, directory, join(directory, "code60.sqlite"));
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const tab = page.getByRole("tab", { name: "Prompt Editor", exact: true });
    await tab.click();
    await expect(page.getByText("Connect to a database to edit prompt templates.")).toBeVisible();
    await page.getByRole("button", { name: "Connect to database" }).click();
    await page.getByRole("button", { name: "Create database…" }).click();
    const panel = page.locator("#panel-prompts");
    const template = panel.getByLabel("Template", { exact: true });
    const save = panel.getByRole("button", { name: "Save", exact: true });
    const fields = panel.getByRole("combobox", { name: "Insert merge field" });
    const preview = panel.locator(".prompt-editor-main .prompt-editor-preview");
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
        document.documentElement.dataset.theme = theme;
        await document.fonts.ready;
      }, theme);
      // Late layout updates can move the item beneath the native Electron pointer.
      await expect(async () => {
        await otherPrompt.hover();
        await expect(otherPrompt).toHaveCSS(
          "background-color",
          theme === "light" ? "rgb(226, 243, 241)" : "rgb(32, 62, 59)",
          { timeout: 500 },
        );
      }).toPass({ timeout: 5_000 });
      await expect(otherPrompt).toHaveCSS("border-top-width", "0px");
      await expect(otherPrompt).toHaveCSS("outline-style", "none");
      await expect(selectedPrompt).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(237, 237, 237)" : "rgb(50, 60, 70)",
      );
      await panel.locator(".prompt-editor").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: join(tmpdir(), `wow-prompts-${theme}.png`) });
      await selectedPrompt.hover();
      await expect(selectedPrompt).toHaveCSS(
        "background-color",
        theme === "light" ? "rgb(237, 237, 237)" : "rgb(50, 60, 70)",
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
    await template.fill("You are controlled by Code60.");
    await system.click();
    await expect(system).toHaveAttribute("aria-expanded", "false");
    await expect(promptList).toBeHidden();
    await expect(template).toHaveValue("You are controlled by Code60.");
    await system.focus();
    await page.keyboard.press("Space");
    await expect(promptList).toBeVisible();
    await expect(promptList.getByRole("button", { name: /Operating Contract/ })).toContainText(
      "Unsaved changes",
    );
    await save.click();
    await expect(panel.getByRole("status")).toHaveText("Source: Saved edit.");
    await expect(
      panel.getByRole("heading", { name: "MCP tool descriptions", exact: true }),
    ).toBeVisible();
    await expect(panel.locator(".prompt-editor-mcp-tool")).toHaveCount(21);
    await expect(panel.locator(".prompt-editor-mcp")).toContainText("never accept SQL");
    await expect(panel.locator(".prompt-editor-mcp")).toContainText("changes worker state");
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
    await expect(preview).toHaveText("Agent: claude");
    // The first-prompt preview merges the summary draft, so switching templates changes it.
    await panel.getByRole("button", { name: /^Handoff first prompt/ }).click();
    await expect(preview).toContainText("Agent: claude\n\nThe user's new message follows.");
    await expect(preview).toContainText("Please finish the failing test.");
    await panel.getByRole("button", { name: /^Handoff summary/ }).click();
    await expect(preview).toHaveText("Agent: claude");
    await selectSidebarPage(page, "Sessions");
    await tab.click();
    await expect(template).toHaveValue("Agent: {{agent}}");
    await save.click();
    await expect(panel.getByRole("status")).toHaveText("Source: Saved edit.");
    await page.reload();
    await tab.click();
    await expect(template).toHaveValue("You are controlled by Code60.");
    await panel.getByRole("button", { name: "Reset to default", exact: true }).click();
    await expect(template).toHaveValue(/Code60's orchestration assistant/);
    await panel.getByRole("button", { name: /^Handoff summary/ }).click();
    await expect(template).toHaveValue("Agent: {{agent}}");
    await expect(panel.getByRole("status")).toHaveText("Source: Saved edit.");
    await template.fill("{{unknown}}");
    await expect(template).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    await panel.getByRole("button", { name: "Discard changes", exact: true }).click();
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
  await mkdir(repo);
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
    await selectSidebarPage(page, "Sessions");
    const configurationsTab = page.getByRole("tab", {
      name: "Configurations",
      exact: true,
    });
    const sessionsTab = page.getByRole("tab", { name: "Sessions", exact: true });
    await configurationsTab.click();
    await expect(
      page.getByText("Connect to a database to manage run configurations."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Connect to database" }).click();
    await page.getByRole("button", { name: "Create database…" }).click();
    const panel = page.locator("#panel-configurations");
    await expect(panel.getByText(/No run configurations yet/)).toBeVisible();
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
    await page.getByRole("button", { name: "Create new project…" }).click();
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
    // Starting the batch leaves both chats minimized and table actions unobscured.
    await expect(page.locator(".chat-head")).toHaveCount(2);
    await expect(page.locator(".chat-head[aria-pressed=true]")).toHaveCount(0);
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

test("desktop: independent chats, close, minimize, scrolling, and footer ordering", async () => {
  test.setTimeout(60_000);
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
  const database = join(directory, "code60.sqlite");
  application = await launch(directory, repo, database);
  try {
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1400, 800),
    );
    const page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const settled = () =>
      expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSidebarPage(page, "Sessions");
    await clickMenu("database");
    await page.getByRole("button", { name: "Create database…" }).click();
    await expect.poll(async () => (await menuItem("open-project"))?.enabled).toBe(true);
    await clickMenu("open-project");
    await page.getByRole("button", { name: "Create new project…" }).click();
    await appendRow(page);
    await page.getByRole("button", { name: "Do not use a run configuration" }).click();
    await page.getByRole("button", { name: "Start agents", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".chat-head")).toHaveCount(1);
    const earlier = (await page.evaluate(() => window.desktop.snapshot())).liveIds[0] as string;
    const earlierPopup = page.getByRole("dialog", {
      name: `fake / ${earlier.slice(-6)}`,
      exact: true,
    });
    await expect(page.locator(".chat-head")).toHaveAttribute("aria-pressed", "false");
    await page.locator(".chat-head").click();
    await expect(earlierPopup.getByLabel("Message", { exact: true })).toBeEnabled();
    await earlierPopup.getByLabel("Message", { exact: true }).fill("draft A");
    await expect(page.locator("#panel-sessions .table-add-accessible")).toBeEnabled();
    await appendRow(page);
    await page.getByRole("button", { name: "Do not use a run configuration" }).click();
    await page.getByLabel("Parallel copies").fill("2");
    await page.getByRole("button", { name: "Start agents", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".chat-head")).toHaveCount(3);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const snapshot = await window.desktop.snapshot();
          return snapshot.runs.filter((run) => run.view?.status === "idle").length;
        }),
      )
      .toBe(3);
    const initial = await page.evaluate(() => window.desktop.snapshot());
    const [a, b, c] = initial.liveIds as [string, string, string];
    expect(a).toBe(earlier);
    const popup = (id: string) =>
      page.getByRole("dialog", { name: `fake / ${id.slice(-6)}`, exact: true });
    const head = (id: string) => page.locator(`[data-chat-id="${id}"] > .chat-head`);
    const order = () =>
      page
        .locator(".chat-slot")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-chat-id")));
    const reopen = async (id: string) => {
      await expect(
        page.locator("#panel-sessions .sessions-grid tbody [role='row']").filter({
          hasText: id.slice(-6),
        }),
      ).toHaveCount(1);
      const rows = await page
        .locator("#panel-sessions .sessions-grid tbody [role='row']")
        .allTextContents();
      const row = rows.findIndex((text) => text.includes(id.slice(-6)));
      const box = await page.getByTestId("data-grid-canvas").boundingBox();
      if (!box || row < 0) throw new Error("Missing session row");
      await page.mouse.click(box.x + 80, box.y + 32 + row * 24 + 12);
      await expect(popup(id)).toBeVisible();
    };
    await expect(popup(a)).toBeVisible();
    await expect(popup(a).getByLabel("Message", { exact: true })).toHaveValue("draft A");
    for (const tab of [
      "Messages",
      "Search",
      "Configurations",
      "Worktrees",
      "Polling",
      "Settings",
      "Sessions",
    ]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(page.locator(".app-footer")).toBeVisible();
      await expect(popup(a)).toBeVisible();
      await expect(popup(a).getByLabel("Message", { exact: true })).toHaveValue("draft A");
      if (tab === "Messages") {
        await popup(a).getByRole("button", { name: "Minimize chat" }).click();
        await expect(popup(a)).toBeHidden();
        await head(a).click();
        await expect(popup(a)).toBeVisible();
        await page.screenshot({ path: join(root, "test-results", "chat-dock-messages.png") });
      }
    }
    // New batches never open a popup automatically.
    await expect(head(b)).toHaveAttribute("aria-pressed", "false");
    await expect(popup(b)).toBeHidden();
    await head(b).click();
    await expect(popup(b)).toBeVisible();
    await expect(popup(b).locator(".event")).toHaveCount(0);
    await expect(popup(a)).toBeVisible();
    await expect(popup(b)).toBeVisible();
    await popup(a).getByLabel("Message", { exact: true }).fill("draft A");
    await popup(b)
      .getByLabel("Message", { exact: true })
      .fill(JSON.stringify([{ message: "only chat B" }]));
    await popup(b).getByRole("button", { name: "Send", exact: true }).click();
    await expect(popup(b).locator(".event.message")).toContainText("only chat B");
    await expect(popup(a).getByLabel("Message", { exact: true })).toHaveValue("draft A");
    await expect(popup(a)).not.toContainText("only chat B");
    // Full screen uses the same chat instance, without losing drafts or transcript state.
    const message = popup(a).getByLabel("Message", { exact: true });
    await message.evaluate((element) => {
      element.dataset.fullScreenIdentity = "preserved";
    });
    const expand = () => popup(a).getByRole("button", { name: "View chat full screen" });
    const restore = () => popup(a).getByRole("button", { name: "Exit full screen" });
    // The overlay follows the panel through a resize observer, so wait for layout to settle.
    const expectFullScreenBounds = () =>
      expect
        .poll(async () => {
          const panel = await page.locator("#panel-sessions").boundingBox();
          const chat = await popup(a).boundingBox();
          if (!panel || !chat) return "missing";
          return [
            chat.x - panel.x,
            chat.y - panel.y,
            panel.width - chat.width,
            panel.height - chat.height,
          ].map(Math.round);
        })
        .toEqual([8, 8, 16, 16]);
    const viewport = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    await expand().click();
    await expect(restore()).toBeFocused();
    await expectFullScreenBounds();
    await expect(message).toHaveValue("draft A");
    await expect(message).toHaveAttribute("data-full-screen-identity", "preserved");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1100, 700),
    );
    await expectFullScreenBounds();
    await message.fill("full-screen draft A");
    await page.keyboard.press("Escape");
    await expect(expand()).toBeFocused();
    await expect(message).toHaveValue("full-screen draft A");
    await expand().click();
    await restore().click();
    await expect(expand()).toBeVisible();
    await expand().click();
    // Switching pages light-dismisses the overlay, leaving the chat docked on return.
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page.locator(".chat-popup:popover-open")).toHaveCount(0);
    await selectSidebarPage(page, "Sessions");
    await expect(expand()).toBeVisible();
    await expect(message).toHaveAttribute("data-full-screen-identity", "preserved");
    await message.fill("draft A");
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1400, 800),
    );
    // Later dock overflow checks depend on the original width, so wait for the resize to land.
    await expect
      .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
      .toEqual(viewport);
    // Playwright clicks bypass native drag regions, so check the overlay opts out of them.
    await expand().click();
    const regions = await popup(a).evaluate((element) => ({
      overlay: getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      buttons: [...element.querySelectorAll(".chat-window-actions button")].map((button) =>
        getComputedStyle(button).getPropertyValue("-webkit-app-region"),
      ),
    }));
    expect(regions.overlay).toBe("no-drag");
    expect(regions.buttons).toHaveLength(3);
    for (const region of regions.buttons) expect(region).not.toBe("drag");
    await popup(a).getByRole("button", { name: "Minimize chat" }).click();
    await expect(head(a)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".chat-popup:popover-open")).toHaveCount(0);
    await head(a).click();
    await expect(expand()).toBeVisible();
    await expand().click();
    await popup(a).getByRole("button", { name: "Close chat", exact: true }).click();
    await expect(head(a)).toHaveCount(0);
    await expect(page.locator(".chat-popup:popover-open")).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh project data" }).click();
    await expect(head(a)).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).liveIds).toContain(a);
    await reopen(a);
    await expect(popup(a).getByLabel("Message", { exact: true })).toHaveValue("draft A");
    await popup(a)
      .getByLabel("Message", { exact: true })
      .fill(
        JSON.stringify([
          { message: "only chat A" },
          { permission: { id: "chat-a-exec", title: "Chat A approval", kind: "execute" } },
        ]),
      );
    await popup(a).getByRole("button", { name: "Send", exact: true }).click();
    await expect(popup(a).getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await popup(a).getByRole("button", { name: "Close chat", exact: true }).click();
    await expect(page.locator(".footer-note")).toHaveText("1 approval waiting");
    await expect(popup(b).getByLabel("Message", { exact: true })).toBeEnabled();
    await reopen(a);
    await popup(a).getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(popup(a).getByLabel("Message", { exact: true })).toBeEnabled();
    // The chat has no Finish control; reopening selected the session, so finish it from the palette.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("finish run");
    await expect(page.getByRole("option", { name: /^Finish run/ })).toContainText(a.slice(-6));
    await page.keyboard.press("Enter");
    await expect(head(a)).toContainText("Finished");
    await expect(popup(a).getByLabel("Message", { exact: true })).toBeEnabled();
    await expect(popup(a)).not.toContainText("Sending a message resumes this session.");
    // Resume is just a shortcut to the composer, not an agent-start action.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("resume");
    await page.keyboard.press("Enter");
    await expect(popup(a).getByLabel("Message", { exact: true })).toBeFocused();
    await expect(head(a)).toContainText("Finished");
    await popup(a).getByLabel("Message", { exact: true }).fill("Continue with tests");
    await popup(a).getByRole("button", { name: "Send", exact: true }).click();
    await expect(head(a)).toContainText("Awaiting input");
    await expect(popup(a).getByLabel("Message", { exact: true })).toHaveValue("");
    await expect(popup(a).getByText("Loading…", { exact: true })).toHaveCount(0);
    await expect(popup(a).locator(".event.prompt pre").last()).toHaveText("Continue with tests");
    const handoff = popup(a).locator(".event.note").filter({ hasText: "Started a fresh session" });
    await expect(handoff).toContainText("could not be restored");
    await expect(handoff.locator("details")).not.toHaveAttribute("open", "");
    await handoff.getByText("Handoff summary", { exact: true }).click();
    await expect(handoff.locator("details")).toHaveAttribute("open", "");
    await expect(handoff.locator("details pre")).toContainText("Inspect the worktree");
    await popup(a).getByRole("button", { name: "Minimize chat" }).click();
    await expect(head(a)).toHaveAttribute("aria-pressed", "false");
    await head(a).click();
    await expect(popup(a).locator(".event.message").filter({ hasText: "only chat A" })).toHaveCount(
      1,
    );
    await head(c).click();
    await expect(page.getByRole("dialog", { name: /^fake \/ / })).toHaveCount(3);
    await settled();
    const boxes = await page.locator(".chat-slot.open").evaluateAll((elements) =>
      elements.map((element) => {
        const footer = element.querySelector(".chat-head")?.getBoundingClientRect();
        const popup = element.querySelector(".chat-popup")?.getBoundingClientRect();
        return { footer: footer?.toJSON(), popup: popup?.toJSON() };
      }),
    );
    for (const box of boxes) {
      expect(box.footer.height).toBe(40);
      expect(box.popup.width).toBe(box.footer.width);
      expect(box.popup.bottom).toBe(box.footer.top);
    }
    expect(boxes[1]?.popup.left).toBeGreaterThanOrEqual(boxes[0]?.popup.right);
    expect(boxes[2]?.popup.left).toBeGreaterThanOrEqual(boxes[1]?.popup.right);
    await expect(page.getByRole("button", { name: "Scroll chats left" })).toBeVisible();
    await page.getByRole("button", { name: "Scroll chats left" }).click();
    await expect
      .poll(() => page.locator(".chat-dock").evaluate((element) => element.scrollLeft))
      .toBe(0);
    await page.getByRole("button", { name: "Scroll chats right" }).click();
    await expect
      .poll(() => page.locator(".chat-dock").evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    const beforeKeyboard = await order();
    await head(a).focus();
    await head(a).press("Alt+ArrowLeft");
    expect(await order()).not.toEqual(beforeKeyboard);
    await expect(head(a)).toHaveAttribute("aria-pressed", "true");
    await head(a).press("Alt+ArrowRight");
    expect(await order()).toEqual(beforeKeyboard);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await selectSidebarPage(page, "Sessions");
    await expect(page.getByRole("dialog", { name: /^fake \/ / })).toHaveCount(3);
    for (const id of [a, b, c])
      await popup(id).getByRole("button", { name: "Minimize chat" }).click();
    await settled();
    const beforeDrag = await order();
    const source = head(beforeDrag[0] as string);
    const last = head(beforeDrag[2] as string);
    const grip = (id: string) => page.locator(`[data-chat-id="${id}"] > .chat-drag-handle`);
    // Swiping the chat button itself cannot start a reorder.
    await source.scrollIntoViewIfNeeded();
    const headBox = await source.boundingBox();
    const tailBox = await last.boundingBox();
    if (!headBox || !tailBox) throw new Error("Missing chat targets");
    await page.mouse.move(headBox.x + 60, headBox.y + 24);
    await page.mouse.down();
    await page.mouse.move(tailBox.x + tailBox.width - 20, tailBox.y + 24, { steps: 10 });
    await expect(page.locator(".chat-slot[data-drop]")).toHaveCount(0);
    await page.mouse.up();
    expect(await order()).toEqual(beforeDrag);
    await grip(beforeDrag[0] as string).scrollIntoViewIfNeeded();
    await settled();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: "test-results/sidebar-tables-chat-drag.png" });
    const sourceBox = await grip(beforeDrag[0] as string).boundingBox();
    const lastBox = await last.boundingBox();
    if (!sourceBox || !lastBox) throw new Error("Missing drag targets");
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(lastBox.x + lastBox.width - 20, lastBox.y + 24, { steps: 10 });
    await expect(page.locator(".chat-slot[data-drop]")).toHaveCount(1);
    await page.mouse.up();
    await expect.poll(order).toEqual([beforeDrag[1], beforeDrag[2], beforeDrag[0]]);
    await expect(page.locator(".chat-head[aria-pressed='true']")).toHaveCount(0);
    const beforeCancel = await order();
    await settled();
    await grip(beforeCancel[0] as string).scrollIntoViewIfNeeded();
    const cancelBox = await grip(beforeCancel[0] as string).boundingBox();
    if (!cancelBox) throw new Error("Missing cancel target");
    await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cancelBox.x + 350, cancelBox.y + 24, { steps: 5 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await order()).toEqual(beforeCancel);
    await expect(page.locator(".chat-head[aria-pressed='true']")).toHaveCount(0);
    await head(b).click();
    await expect(popup(b)).toBeVisible();
    await page.getByRole("button", { name: "Refresh project data" }).click();
    expect(await order()).toEqual(beforeCancel);

    // Observe running motion in the same browser task as the action, before its short duration ends.
    const motion = async (id: string, action: "toggle" | "close" | "move") => {
      await settled();
      return page.evaluate(
        async ({ id, action }) => {
          const slot = document.querySelector<HTMLElement>(`[data-chat-id="${id}"]`);
          const head = slot?.querySelector<HTMLButtonElement>(".chat-head");
          if (!slot || !head) throw new Error("Missing chat motion target");
          if (action === "toggle") head.click();
          else if (action === "close")
            slot.querySelector<HTMLButtonElement>("[aria-label='Close chat']")?.click();
          else {
            const index = [...(slot.parentElement?.children ?? [])].indexOf(slot);
            head.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: index > 0 ? "ArrowLeft" : "ArrowRight",
                altKey: true,
                bubbles: true,
              }),
            );
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          return document.getAnimations().map((animation) => ({
            duration: animation.effect?.getTiming().duration,
            frames: (animation.effect as KeyframeEffect).getKeyframes(),
          }));
        },
        { id, action },
      );
    };
    const minimize = await motion(b, "toggle");
    expect(
      minimize.some(
        (animation) =>
          animation.duration === 160 && animation.frames.some((frame) => frame.clipPath),
      ),
    ).toBe(true);
    await expect(head(b)).toHaveAttribute("aria-pressed", "false");
    const open = await motion(b, "toggle");
    expect(open.some((animation) => animation.duration === 160)).toBe(true);
    await expect(popup(b)).toBeVisible();
    const rearrange = await motion(b, "move");
    expect(
      rearrange.some(
        (animation) =>
          animation.duration === 180 && animation.frames.some((frame) => frame.transform),
      ),
    ).toBe(true);
    const closing = await motion(b, "close");
    expect(closing.some((animation) => animation.duration === 140)).toBe(true);
    await expect(head(b)).toHaveCount(0);
    await reopen(b);
    await settled();

    // Reduced motion keeps the same actions, but applies their final states immediately.
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await motion(b, "toggle")).toEqual([]);
    await expect(popup(b)).toBeHidden();
    expect(await motion(b, "toggle")).toEqual([]);
    await expect(popup(b)).toBeVisible();
    const reducedOrder = await order();
    expect(await motion(b, "move")).toEqual([]);
    expect(await order()).not.toEqual(reducedOrder);
    expect(await motion(b, "close")).toEqual([]);
    await expect(head(b)).toHaveCount(0);
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
    await selectSidebarPage(page, "Sessions");
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
      await window.desktop.connectDatabase("create");
      await window.desktop.chooseFolder();
    });
    await expect(page.locator("#panel-sessions .sessions-grid tbody [role='row']")).toHaveCount(5);
    await page.getByRole("tab", { name: "Search", exact: true }).click();
    const search = page.locator("#panel-search");
    const query = search.getByLabel("Query", { exact: true });
    const wordmark = search.locator(".search-wordmark");
    await expect(wordmark).toBeVisible();
    await expect(search.getByLabel("Type", { exact: true })).toBeHidden();
    const entryBox = await query.boundingBox();
    const pageBox = await search.boundingBox();
    if (!entryBox || !pageBox) throw new Error("Missing search entry");
    expect(entryBox.width).toBeLessThanOrEqual(560);
    expect(Math.abs(entryBox.x + entryBox.width / 2 - pageBox.x - pageBox.width / 2)).toBeLessThan(
      2,
    );
    await page.screenshot({ path: join(root, "test-results", "search-entry.png") });
    await query.fill("parser fixed");
    expect(
      await search
        .locator(".search-page")
        .evaluate((element) =>
          element
            .getAnimations()
            .some(
              (animation) =>
                animation.effect instanceof KeyframeEffect &&
                animation.effect.getKeyframes().some((frame) => "gridTemplateRows" in frame),
            ),
        ),
    ).toBe(true);
    await expect(query).toBeFocused();
    await expect
      .poll(async () => (await query.boundingBox())?.y ?? Infinity)
      .toBeLessThan(entryBox.y - 40);
    await page.screenshot({ path: join(root, "test-results", "search-expanded.png") });
    await query.fill("");
    await expect(search.getByLabel("Type", { exact: true })).toBeHidden();
    await expect
      .poll(async () => (await query.boundingBox())?.y ?? 0)
      .toBeGreaterThan(entryBox.y - 2);
    await expect(query).toBeFocused();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await query.fill("parser fixed");
    expect(
      await search
        .locator(".search-page")
        .evaluate((element) => element.getAnimations({ subtree: true }).length),
    ).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(search.locator(".search-results [role=option]")).toHaveCount(3);
    await expect(
      search.getByText("2 transcripts unavailable. Results are incomplete."),
    ).toBeVisible();
    await search.getByLabel("Type", { exact: true }).selectOption("thought");
    await expect(search.getByText("No matching results.")).toBeVisible();
    await search.getByLabel("Type", { exact: true }).selectOption("message");
    await search.getByRole("listbox").focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Sessions", exact: true })).toHaveAttribute(
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
    await page.getByRole("button", { name: "Minimize chat", exact: true }).click();
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
    expect(reads["record-b"]).toBe(1); // shared by Search, Messages and Events
    await selectSidebarPage(page, "Sessions");
    const sessions = page.locator("#panel-sessions");
    await sessions.getByRole("button", { name: "Settings", exact: true }).click();
    const tableSettings = page.getByRole("dialog", {
      name: "Sessions table settings",
      exact: true,
    });
    const rowLines = tableSettings.getByRole("switch", { name: "Row lines", exact: true });
    await expect(rowLines).not.toBeChecked();
    await expect(rowLines).toHaveCSS("border-top-right-radius", "0px");
    await tableSettings.getByLabel("Row density").focus();
    await page.keyboard.press("Tab");
    await expect(rowLines).toBeFocused();
    await expect(rowLines).toHaveCSS("outline-width", "0px");
    await rowLines.check();
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
    const slots = sessions.getByRole("group", { name: "Table controls" });
    const seam = await slots.evaluate((group) => {
      const [previous, next] = group.querySelectorAll(":scope > button");
      if (!previous || !next) throw new Error("Missing adjacent group controls");
      const box = previous.getBoundingClientRect();
      return {
        x: box.right + 2,
        y: box.top + 2,
        rightIsNext: document.elementFromPoint(box.right + 2, box.top + 2) === next,
        bodyIsPrevious: document.elementFromPoint(box.right - 2, box.bottom - 2) === previous,
      };
    });
    expect(seam.rightIsNext).toBe(true);
    expect(seam.bodyIsPrevious).toBe(true);
    await page.mouse.move(seam.x, seam.y);
    await slots.screenshot({ path: join(root, "test-results", "button-group-straight-hover.png") });
    await page.mouse.click(seam.x, seam.y);
    await expect(filters).toBeVisible();
    await filters.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("tab", { name: "Search", exact: true }).click();
    await search.getByLabel("Query", { exact: true }).fill("parser");
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
    await expect(wordmark).toBeVisible();
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
    await page.getByRole("tab", { name: "Search", exact: true }).click();
    await search.getByLabel("Query", { exact: true }).fill("parser");
    await expect(search.getByText("Loading saved transcripts…")).toBeVisible();
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, other);
    await page.evaluate(() => window.desktop.chooseFolder());
    await expect(page.locator(".sidebar-title")).toHaveText("other-project");
    await search.getByLabel("Query", { exact: true }).fill("parser");
    await expect(search.getByText("No matching results.")).toBeVisible();
    await page.waitForTimeout(700);
    await expect(search.locator(".search-results [role=option]")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Chat landing, automatic ACP conversation, navigation, cancellation, and fresh startup", async () => {
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
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const experiments = page.getByRole("button", { name: "Experiments", exact: true });
    const experimentPages = page.getByRole("tablist", { name: "Experiments", exact: true });
    await expect(experiments).toHaveAttribute("aria-expanded", "false");
    await expect(experimentPages).toBeHidden();
    await page.getByRole("tab", { name: "Chat", exact: true }).press("ArrowLeft");
    await page.getByRole("tab", { name: "Chat", exact: true }).press("ArrowDown");
    await expect(experiments).toBeFocused();
    await experiments.press("ArrowRight");
    await expect(experimentPages).toHaveText("Episodic Memory");
    await expect(experimentPages).toBeVisible();
    await expect(page.locator("#panel-chat")).toBeVisible();
    await experiments.press("ArrowLeft");
    await expect(experimentPages).toBeHidden();
    await expect(experiments).toBeFocused();
    await experiments.press("Enter");
    await expect(experimentPages).toBeVisible();
    await experiments.press("Space");
    await expect(experimentPages).toBeHidden();
    await experiments.click();
    await experiments.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Episodic Memory", exact: true })).toBeFocused();
    await expect(page.locator("#panel-episodic-memory")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Episodic Memory", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(experiments).toBeFocused();
    await experiments.press("Home");
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toBeFocused();
    await page.reload();
    await expect(experiments).toHaveAttribute("aria-expanded", "true");
    await expect(experimentPages).toBeVisible();
    await experiments.click();
    const tables = page.getByRole("button", { name: "Tables", exact: true });
    await expect(tables).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("tab")).toHaveText(["Chat", "Prompt Editor", "Search", "Settings"]);
    await tables.press("ArrowRight");
    await expect(tables).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tab")).toHaveText([
      "Chat",
      "Prompt Editor",
      "Search",
      "Settings",
      "Configurations",
      "Events",
      "Messages",
      "Polling",
      "Sessions",
      "Worktrees",
    ]);
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await page.keyboard.press("ArrowLeft");
    await expect(tables).toBeFocused();
    await expect(tables).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#panel-sessions")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Sessions");
    await page.keyboard.press("Enter");
    await expect(tables).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tab", { name: "Sessions", exact: true })).toBeFocused();
    await page.screenshot({ path: "test-results/sidebar-tables-expanded.png" });
    await tables.click();
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await expect(tables).toHaveAttribute("aria-expanded", "false");
    let chat = page.locator("#panel-chat .orchestration-chat-page:visible");
    await expect(
      chat.getByRole("button", { name: "Connect to database", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await expect(chat.getByRole("status")).toHaveText("Ready");
    const first = await page.evaluate(() => window.desktop.snapshot());
    const id = first.chat.run?.id as string;
    expect(dirname(first.chat.directory as string)).toBe(workspace);
    expect(first.runs).toEqual([]);
    const chatList = () =>
      page.getByRole("navigation", { name: "Orchestrator chats", exact: true });
    await page.locator("#tab-chat").press("ArrowRight");
    await expect(chatList()).toBeVisible();
    await expect(chat.locator(".chat-empty .wordmark")).toHaveText("Code60");
    await expect(chat.locator(".chat-empty .wordmark")).toHaveCSS("font-size", "48px");
    await expect(chat.locator(".chat-empty .wordmark")).toHaveCSS("font-family", /^"?D-DIN"?/);
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
    await expect(chat.locator(".orchestration-chat-heading .wordmark")).toHaveCount(0);
    await page.screenshot({ path: "test-results/chat-empty-wordmark.png" });
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
    const input = () => chat.getByRole("textbox", { name: "Message to orchestrator", exact: true });
    await input().fill("hello from Chat");
    await input().press("Enter");
    await expect(chat.locator(".event.message pre")).toHaveText("ok");
    await expect(chat.locator(".wordmark")).toHaveCount(0);
    await expect(chat.locator(".orchestration-chat-status")).toContainText("claude");
    await expect(chat.locator(".event.message .chat-message-speaker")).toHaveCount(0);
    await expect(chat.locator(".event.message")).toHaveCSS("border-top-width", "1px");
    await expect(input()).toHaveValue("");
    const script = JSON.stringify([
      { message: "alpha" },
      { sleep: 100 },
      { thought: "checking" },
      { permission: { id: "edit-1", title: "Edit workspace", kind: "edit" } },
      { write: { path: "marker.txt", content: "kept across launches" } },
      { message: "omega" },
    ]);
    await input().fill(script);
    await expect(chat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input().press("Enter");
    await expect(chat.locator(".event.permission")).toContainText("allowed by policy");
    await expect(chat.getByRole("status")).toHaveText("Ready");
    await expect(chat.locator(".event.thought pre")).not.toBeVisible();
    await chat.locator(".chat-activity summary").click();
    await expect(chat.locator(".event.thought pre")).toBeVisible();
    await expect(chat.locator(".event.thought pre")).toHaveText("checking");
    await chat.locator(".chat-activity summary").click();
    expect(await readFile(join(first.chat.directory as string, "marker.txt"), "utf8")).toBe(
      "kept across launches",
    );
    await input().fill("draft retained");
    await chatList().getByRole("button", { name: "New chat", exact: true }).click();
    await expect(chat.getByRole("status")).toHaveText("Ready");
    const secondChat = await page.evaluate(() => window.desktop.snapshot());
    const secondId = secondChat.chat.run?.id as string;
    expect(secondId).not.toBe(id);
    expect(secondChat.chat.directory).not.toBe(first.chat.directory);
    expect(secondChat.chats).toHaveLength(2);
    await expect(chat.locator(".event.prompt, .event.message")).toHaveCount(0);
    await input().fill("second conversation");
    await input().press("Enter");
    await expect(chat.locator(".event.message pre")).toHaveText("ok");
    await input().fill("second draft");
    await chatList().getByRole("button", { name: "Chat 1", exact: true }).click();
    await expect(input()).toHaveValue("draft retained");
    await expect(chat.locator(".event.prompt")).toHaveCount(2);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(chatList()).toBeVisible();
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await expect(input()).toHaveValue("draft retained");
    await page.evaluate(() => window.desktop.chooseFolder());
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, secondProject);
    await page.evaluate(() => window.desktop.chooseFolder());
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).toBe(id);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(input()).toHaveValue("draft retained");
    await expect(chat.locator(".event.message pre").first()).toHaveText("ok");
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
    await expect(chat.getByRole("status")).toHaveText("Thinking");
    await expect(chat.locator(".chat-loader")).toBeVisible();
    const activeCard = chatList().getByRole("button", {
      name: "Chat 1",
      exact: true,
    });
    const idleCard = chatList().getByRole("button", {
      name: "Chat 2",
      exact: true,
    });
    const sidebarLoader = activeCard.locator(".chat-loader");
    await expect(sidebarLoader).toBeVisible();
    await expect(sidebarLoader).toHaveCSS("height", "6px");
    await expect(chatList().locator(".chat-loader")).toHaveCount(1);

    await expect(chat.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    await page.screenshot({ path: "test-results/orchestration-chat-loading.png" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(chat.locator(".chat-loader")).toHaveCSS("animation-name", "none");
    await expect(sidebarLoader).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(chat.getByRole("status")).toHaveText("Responding");
    const loader = chat.locator(".chat-loader");
    const composer = chat.getByRole("region", { name: "Chat composer" });
    await expect(composer).toHaveCSS("corner-top-right-shape", "superellipse(0)");
    await expect(composer).toHaveCSS("border-top-right-radius", "24px");
    const lineBox = await loader.boundingBox();
    const composerBox = await composer.boundingBox();
    if (!lineBox || !composerBox) throw new Error("Missing chat loading line");
    expect(lineBox.x).toBeCloseTo(composerBox.x + 2, 0);
    expect(lineBox.y).toBeCloseTo(composerBox.y + 2, 0);
    expect(lineBox.width).toBeCloseTo(composerBox.width - 4, 0);
    await expect(loader).toHaveCSS("height", "12px");
    await expect(loader).toHaveCSS("animation-name", "chat-bar-stripe");
    const sidebarLineBox = await sidebarLoader.boundingBox();
    const cardBox = await activeCard.boundingBox();
    if (!sidebarLineBox || !cardBox) throw new Error("Missing sidebar loading line");
    expect(sidebarLineBox.x).toBeCloseTo(cardBox.x, 0);
    expect(sidebarLineBox.y).toBeCloseTo(cardBox.y, 0);
    expect(sidebarLineBox.width).toBeCloseTo(cardBox.width, 0);
    await idleCard.click();
    await expect(sidebarLoader).toBeVisible();
    await expect(chat.locator(".chat-loader")).toHaveCount(0);
    await activeCard.click();
    await expect(loader).toBeVisible();

    for (const [theme, background, stripe] of [
      ["light", "rgb(226, 243, 241)", "rgb(20, 108, 103)"],
      ["dark", "rgb(32, 62, 59)", "rgb(208, 188, 131)"],
    ] as const) {
      await selectSidebarPage(page, "Settings");
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await selectSidebarPage(page, "Chat");
      await expect(composer).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
      const restingShadow = await composer.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      await input().focus();
      await expect(composer).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
      await expect(composer).toHaveCSS("outline-style", "none");
      await expect(composer).toHaveCSS("box-shadow", /0px 0px 12px 0px/);
      const focusedShadow = await composer.evaluate(
        (element) => getComputedStyle(element).boxShadow,
      );
      expect(focusedShadow).not.toBe(restingShadow);
      await expect(loader).toHaveCSS("background-color", background);
      await expect(sidebarLoader).toHaveCSS("background-color", background);
      expect(
        await loader.evaluate((element) => getComputedStyle(element).backgroundImage),
      ).toContain(stripe);
      await page.screenshot({ path: `test-results/chat-loader-${theme}.png` });
      await chat.getByRole("button", { name: "Stop", exact: true }).focus();
      await expect(composer).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
      await expect(composer).toHaveCSS("box-shadow", focusedShadow);
      await selectSidebarPage(page, "Chat");
      await expect(composer).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
      await expect(composer).toHaveCSS("box-shadow", restingShadow);
    }

    await expect(chat.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(chat.locator(".chat-progress")).toHaveText("Ready");
    await expect(sidebarLoader).toHaveCount(0);
    const resumeUpdates = chat.getByRole("button", { name: "Resume updates", exact: true });
    await expect(resumeUpdates).toBeVisible();
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.updates.paused).toBe(true);
    await resumeUpdates.click();
    await expect(resumeUpdates).toHaveCount(0);
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.updates.paused).toBe(false);
    await expect(chat.locator(".chat-loader")).toHaveCount(0);
    await input().fill("after cancellation");
    await input().press("Enter");
    await expect(chat.getByRole("status")).toHaveText("Ready");
    await expect(chat.locator(".event.prompt")).toHaveCount(4);
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.getByLabel("Theme", { exact: true }).selectOption("light");
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
    await page.screenshot({ path: "test-results/orchestration-chat-light.png" });
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
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
    await page.evaluate(() => window.desktop.setOrchestrationProvider("broken"));
    await expect(chat.getByRole("alert")).toBeVisible();
    const failed = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id;
    await chat.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id)
      .not.toBe(failed);
    await page.evaluate(() => window.desktop.setOrchestrationProvider("claude"));
    await expect(chat.getByRole("status")).toHaveText("Ready");
    const prior = (await page.evaluate(() => window.desktop.snapshot())).chat.run?.id as string;
    const priorDirectory = (await page.evaluate(() => window.desktop.snapshot())).chat
      .directory as string;
    const recordFile = join(priorDirectory, ".code60", "runs", prior, "run.json");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    await application.close();
    expect(() => process.kill(record.agentPid, 0)).toThrow();
    application = await launch(directory, firstProject, database);
    page = await application.firstWindow();
    await page.getByRole("button", { name: "No", exact: true }).click();
    chat = page.locator("#panel-chat .orchestration-chat-page:visible");
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(chat.getByRole("status")).toHaveText("Ready");
    expect((await page.evaluate(() => window.desktop.snapshot())).chat.run?.id).not.toBe(prior);
    await expect(chat.locator(".event.prompt, .event.message")).toHaveCount(0);
    expect(await readFile(join(first.chat.directory as string, "marker.txt"), "utf8")).toBe(
      "kept across launches",
    );
    expect(errors).toEqual([]);
  } finally {
    await application.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Episodic Memory extracts event statements, edits prompts, clears, and cancels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-memory-e2e-"));
  const project = join(directory, "project");
  const database = join(directory, "projects.sqlite");
  const config = join(directory, "config", "code60", "config.json");
  await mkdir(project);
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
    await page.getByRole("button", { name: "Experiments", exact: true }).click();
    await page.getByRole("tab", { name: "Episodic Memory", exact: true }).click();
    const memory = page.locator("#panel-episodic-memory");
    const extract = memory.getByRole("button", { name: /^Extract from/ });
    await expect(extract).toHaveText("Extract from 0 events");
    await expect(extract).toBeDisabled();
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await page.evaluate(() => window.desktop.chooseFolder());
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
    await page.locator(".chat-head-close").click();
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
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("Episodic Memory");
    await page.keyboard.press("Enter");
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
    await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute(
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
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await page.evaluate(() => window.desktop.chooseFolder());
    await selectSidebarPage(page, "Sessions");
    const panel = page.locator("#panel-sessions");
    const trigger = panel.getByRole("button", { name: "Settings", exact: true });
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
    await trigger.click();
    await expect(modal).toBeVisible();
    await page.screenshot({ path: "test-results/table-settings-initial.png" });
    expect(errors).toEqual([]);
    await expect(density).toBeFocused();
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
    await expect(modal).toHaveCSS("background-color", "rgb(36, 43, 51)");
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
    await trigger.click();
    await modal.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    await density.selectOption("low");
    await modal.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(async () => JSON.parse((await stored()) ?? "{}").density).toBe("low");
    await page.reload();
    await selectSidebarPage(page, "Sessions");
    await expect(actual).toHaveAttribute("data-row-height", "44");
    // Every table uses the same dialog, without leaking the Sessions override or chart controls.
    for (const name of ["Messages", "Events", "Configurations", "Worktrees", "Polling"]) {
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
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await expect(modal).toHaveCount(0);
    await expect(actual).toHaveAttribute("data-row-height", "44");
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: focus highlight is opt-in, immediate, and persistent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-focus-highlight-"));
  const database = join(directory, "projects.sqlite");
  try {
    application = await launch(directory, directory, database);
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await selectSidebarPage(page, "Settings");
    const toggle = page.getByRole("switch", { name: "Focus highlight border", exact: true });
    const keyboardFocus = async () => {
      await toggle.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(toggle).toBeFocused();
    };
    await expect(toggle).not.toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-focus-highlight", "off");
    await keyboardFocus();
    await expect(toggle).toHaveCSS("outline-width", "0px");
    await expect(toggle).toHaveCSS("box-shadow", "none");
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveCSS("outline-width", "2px");
    await expect(page.locator("html")).toHaveAttribute("data-focus-highlight", "on");
    for (const theme of ["dark", "light", "system"]) {
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await keyboardFocus();
      await expect(toggle).toHaveCSS("outline-width", "2px");
    }
    await page.reload();
    await selectSidebarPage(page, "Settings");
    await expect(toggle).toBeChecked();
    await keyboardFocus();
    await expect(toggle).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toHaveCSS("outline-width", "0px");
    await expect(toggle).toHaveCSS("box-shadow", "none");
    await page.reload();
    await selectSidebarPage(page, "Settings");
    await expect(toggle).not.toBeChecked();
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await page.evaluate(() => window.desktop.chooseFolder());
    await selectSidebarPage(page, "Prompt Editor");
    const editor = page.locator(".prompt-editor-input");
    await editor.locator("textarea").focus();
    await expect(editor).toHaveCSS("outline-style", "none");
    await selectSidebarPage(page, "Settings");
    await toggle.check();
    await selectSidebarPage(page, "Prompt Editor");
    await editor.locator("textarea").focus();
    await expect(editor).toHaveCSS("outline-width", "2px");
    // The outer editor carries the highlight, never a second ring around the textarea.
    await expect(editor.locator("textarea")).toHaveCSS("outline-width", "0px");
    await page.screenshot({ path: "test-results/focus-highlight-enabled.png" });
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: Files tree and shared read-only preview", async () => {
  test.setTimeout(60000);
  const directory = await mkdtemp(join(tmpdir(), "code60-files-ui-"));
  const folder = join(directory, "repo");
  const worktree = join(directory, "worker");
  await mkdir(join(folder, "src"), { recursive: true });
  await writeFile(join(folder, "src", "main.ts"), "export const answer = 42;\n");
  await writeFile(join(folder, "empty.txt"), "");
  await writeFile(join(folder, "binary.bin"), Buffer.from([0, 1, 2]));
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
  execFileSync("git", ["-C", folder, "worktree", "add", "-b", "worker", worktree]);
  await writeFile(join(worktree, "src", "main.ts"), "export const answer = 99;\n");
  try {
    application = await launch(directory, folder, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.emulateMedia({ colorScheme: "light" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await page.evaluate(() => window.desktop.chooseFolder());
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1500, 900),
    );
    await selectSidebarPage(page, "Files");
    const files = page.locator("#panel-chat .files-page");
    const src = files.getByRole("treeitem", { name: "src", exact: true });
    await expect(src).toBeVisible();
    await expect(files.getByRole("treeitem", { name: "main.ts", exact: true })).toHaveCount(0);
    await src.click();
    const file = files.getByRole("treeitem", { name: "main.ts", exact: true });
    await expect(file).toBeVisible();
    await file.focus();
    await file.press("Enter");
    const inspector = page.getByRole("complementary", { name: "File preview" });
    await expect(inspector).toBeVisible();
    await expect(inspector.locator(".view-lines")).toContainText("42");
    await expect(inspector.locator("textarea")).toHaveAttribute("readonly", "true");
    await expect(files).toHaveCSS("border-top-width", "0px");
    await expect(inspector).toHaveCSS("border-top-width", "0px");
    await expect(files.getByRole("heading", { name: "File Explorer", exact: true })).toHaveCSS(
      "font-family",
      /D-DIN/,
    );
    await expect(inspector.locator(".monaco-editor-background")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await expect(file).toHaveCSS("background-color", "rgb(237, 237, 237)");
    await file.hover();
    await expect(file).toHaveCSS("background-color", "rgb(237, 237, 237)");
    await src.hover();
    await expect(src).toHaveCSS("background-color", "rgb(226, 243, 241)");
    await page.screenshot({ path: "test-results/files-preview-light.png" });
    await selectSidebarPage(page, "Settings");
    await expect(inspector).toHaveCount(0);
    await selectSidebarPage(page, "Chat");
    await expect(inspector.locator(".view-lines")).toContainText("42");
    await writeFile(join(folder, "src", "main.ts"), "export const answer = 43;\n");
    await page.evaluate(() => window.desktop.poll(["files"]));
    await expect(inspector.locator(".view-lines")).toContainText("43");
    await selectSidebarPage(page, "Files");
    await src.click();
    await expect(file).toHaveCount(0);
    await selectSidebarPage(page, "Chat");
    await inspector.getByRole("button", { name: "Reveal in Files" }).click();
    await expect(files).toBeVisible();
    await expect(file).toBeVisible();
    await expect(file).toHaveAttribute("aria-selected", "true");
    const options = await files
      .getByLabel("File root")
      .locator("option")
      .evaluateAll((elements) => elements.map((element) => (element as HTMLOptionElement).value));
    expect(options).toEqual([await realpath(folder)]);
    await expect(files.getByLabel("File root")).toHaveValue(await realpath(folder));
    await expect(inspector.locator(".view-lines")).toContainText("43");
    await selectSidebarPage(page, "Settings");
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await selectSidebarPage(page, "Files");
    await expect(inspector.locator(".monaco-editor")).toHaveClass(/vs-dark/);
    await expect(inspector.locator(".monaco-editor-background")).toHaveCSS(
      "background-color",
      "rgb(36, 43, 51)",
    );
    await expect(file).toHaveCSS("background-color", "rgb(50, 60, 70)");
    await page.screenshot({ path: "test-results/files-preview-dark.png" });
    await selectSidebarPage(page, "Settings");
    await page.getByLabel("Theme", { exact: true }).selectOption("system");
    await selectSidebarPage(page, "Files");
    await expect(inspector.locator(".monaco-editor-background")).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(inspector.locator(".monaco-editor-background")).toHaveCSS(
      "background-color",
      "rgb(36, 43, 51)",
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(820, 650),
    );
    await expect(inspector).toBeVisible();
    await page.screenshot({ path: "test-results/files-preview-narrow.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await inspector.getByRole("button", { name: "Close file preview" }).click();
    await files.getByRole("treeitem", { name: "binary.bin", exact: true }).click();
    await expect(inspector.getByRole("alert")).toContainText("binary");
    await inspector.getByRole("button", { name: "Close file preview" }).click();
    await files.getByRole("treeitem", { name: "empty.txt", exact: true }).click();
    await expect(inspector.locator(".monaco-editor")).toBeVisible();
    await page.evaluate(() => window.desktop.stopAll());
    const plain = join(directory, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "note.txt"), "plain folder");
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, plain);
    await page.evaluate(() => window.desktop.chooseFolder());
    await expect(inspector).toHaveCount(0);
    await expect(files.getByRole("treeitem", { name: "note.txt", exact: true })).toBeVisible();
    await files.getByRole("treeitem", { name: "note.txt", exact: true }).click();
    await expect(inspector.locator(".view-lines")).toContainText("plain folder");
    await page.evaluate((project) => window.desktop.openProject(project), options[0] as string);
    await expect(inspector).toHaveCount(0);
    await expect(files.getByRole("treeitem", { name: "src", exact: true })).toBeVisible();
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
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await page.evaluate(() => window.desktop.chooseFolder());
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
      const minimize = page.getByRole("button", { name: "Minimize chat", exact: true });
      if (await minimize.isVisible()) await minimize.click();
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
    await page.getByRole("button", { name: "Refresh project data", exact: true }).click();
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
    await page.evaluate(() => window.desktop.chooseFolder());
    await page.evaluate(() =>
      window.desktop.start({ agents: ["claude"], allow: [], allowAll: false }),
    );
    const current = await page.evaluate(() => window.desktop.snapshot());
    await expect(page.locator("#panel-sessions").getByTestId("glide-cell-6-0")).toHaveText(
      current.runs[0]?.record.id.slice(-6) as string,
    );
    await openSessionActions();
    await expect(browse).not.toHaveAttribute("aria-disabled", "true");
    await browse.click();
    await expect(files).toBeVisible();
    await expect(files.getByLabel("File root")).toHaveValue(current.directory as string);
    await expect(files.getByRole("treeitem", { name: "plain.txt", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop: project header card opens projects, cancels, and confirms selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-project-card-"));
  const folder = join(directory, "project-one");
  const second = join(directory, "project-two");
  await mkdir(folder);
  await mkdir(second);
  try {
    application = await launch(directory, folder, join(directory, "projects.sqlite"));
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const card = page.locator(".project-card");
    const modal = page.getByRole("dialog", { name: "Open Project", exact: true });
    const done = page.getByRole("group", { name: "Done notification", exact: true });
    await expect(card).toHaveText("Open a project");
    await expect(card).toHaveCSS("border-top-style", "dotted");
    expect(await card.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
      "repeating-linear-gradient",
    );
    await expect(card.locator("svg")).toHaveCount(1);
    await page.screenshot({ path: "test-results/project-card-empty.png" });
    await card.focus();
    await card.press("Enter");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Create database…", exact: true }).click();
    await expect(modal.getByText("No recent projects.")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Close Open Project" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(card).toBeFocused();
    await card.click();
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await modal.getByRole("button", { name: "Create new project…", exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(card).toHaveText("Open a project");
    await expect(done).toHaveCount(0);
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, folder);
    await modal.getByRole("button", { name: "Create new project…", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(card).toHaveText("project-one");
    await expect(card).toHaveCSS("border-top-style", "solid");
    await expect(card).toHaveCSS("background-image", "none");
    await expect(done).toContainText("Opened project-one.");
    await page.screenshot({ path: "test-results/project-card-open.png" });
    await done.getByRole("button", { name: "Dismiss notification" }).click();
    await card.click();
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, second);
    await modal.getByRole("button", { name: "Create new project…", exact: true }).click();
    await expect(card).toHaveText("project-two");
    await done.getByRole("button", { name: "Dismiss notification" }).click();
    await card.click();
    await modal.locator(".project-item").filter({ hasText: "project-one" }).click();
    await expect(card).toHaveText("project-one");
    await expect(done).toContainText("Opened project-one.");
    await page.evaluate(() =>
      window.desktop.start({ agents: ["claude"], allow: [], allowAll: false }),
    );
    await expect(card).toBeDisabled();
    await expect(card).toHaveCSS("background-image", "none");
    await expect(card).toHaveCSS("border-top-style", "solid");
    await page.evaluate(() => window.desktop.stopAll());
  } finally {
    await application?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { privateDirectory } from "../src/platform/index.js";
import { launchDesktop, removeDesktopFixture as rm } from "./electron-launcher.js";
import { commitFixture } from "./fixtures/git-repository.js";

const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
};
if (!process.env.CODE60_PACKAGED_EXECUTABLE)
  throw new Error("Set CODE60_PACKAGED_EXECUTABLE to the installed application executable");

test("installed app launches with a minimal PATH and isolated data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-minimal-"));
  const app = await launchDesktop(directory, directory, join(directory, "code60.sqlite"), true);
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version);
    await expect(readFile(join(directory, "unexpected-runtime"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const page = await app.firstWindow();
    await expect(page.locator(".splash-title")).toHaveText("Code60");
    expect(await page.evaluate(() => typeof window.desktop.snapshot)).toBe("function");
    expect(await page.evaluate(() => "require" in window)).toBe(false);
    const security = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Packaged window is missing");
      const prefs = (
        window.webContents as unknown as {
          getLastWebPreferences(): {
            sandbox: boolean;
            contextIsolation: boolean;
            nodeIntegration: boolean;
          };
        }
      ).getLastWebPreferences();
      return {
        sandbox: prefs?.sandbox,
        contextIsolation: prefs?.contextIsolation,
        nodeIntegration: prefs?.nodeIntegration,
      };
    });
    expect(security).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(await app.evaluate(({ app }) => app.commandLine.hasSwitch("no-sandbox"))).toBe(false);
    expect(await page.evaluate(() => document.fonts.check('400 16px "D-DIN"'))).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed app persists projects and runs agents, MCP and cancellation", async () => {
  const directory = await mkdtemp(
    join(process.env.CODE60_PACKAGED_DATA_ROOT ?? tmpdir(), "code60-package-"),
  );
  const repo = join(directory, "project");
  const database = join(directory, "code60.sqlite");
  const probe = join(directory, "mcp-ok");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commitFixture(repo);
  await mkdir(join(directory, "config", "code60"), { recursive: true });
  await writeFile(
    join(directory, "config", "code60", "config.json"),
    JSON.stringify({
      defaultAgent: "fake",
      agents: {
        fake: {
          command: [process.execPath, join(root, "test/fixtures/packaged-agent.mjs"), probe],
        },
      },
    }),
  );
  await privateDirectory(join(directory, "state", "code60"));
  await writeFile(
    join(directory, "state", "code60", "desktop.json"),
    JSON.stringify({ orchestrationProvider: "fake" }),
  );
  let app = await launchDesktop(directory, repo, database);
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("note", { name: "Running Code60 version" })).toHaveText(
      `Code60 ${version}`,
    );
    await expect(page.locator(".app-footer")).toHaveCSS("height", "40px");
    await page.evaluate(() => window.desktop.connectDatabase("create"));
    await page.evaluate(() => window.desktop.chooseFolder());
    await page.evaluate(() => window.desktop.setOrchestrationProvider("fake"));
    await expect
      .poll(async () => readFile(probe, "utf8").catch(() => ""), { timeout: 30_000 })
      .toBe("ok\n");
    await expect
      .poll(() => page.evaluate(async () => (await window.desktop.snapshot()).chat.run?.status))
      .toBe("idle");
    expect((await stat(database)).size).toBeGreaterThan(0);
    const ids = await page.evaluate(() =>
      window.desktop.start({
        agents: ["fake"],
        allow: [],
        allowAll: false,
        prompt: JSON.stringify([
          { write: { path: "installer-marker.txt", content: "kept" } },
          { message: "installer-ok" },
        ]),
      }),
    );
    const id = ids[0];
    if (!id) throw new Error("Agent did not start");
    const status = () =>
      page.evaluate(
        async (id) =>
          (await window.desktop.snapshot()).runs.find((run) => run.record.id === id)?.view
            ?.status ??
          (await window.desktop.snapshot()).runs.find((run) => run.record.id === id)?.record.status,
        id,
      );
    await expect.poll(status).toBe("idle");
    await expect(page.locator(".chat-head").first()).toHaveAttribute("aria-pressed", "false");
    await page.evaluate((id) => window.desktop.action({ type: "finish", id }), id);
    await expect.poll(status).toBe("finished");
    const cancelledIds = await page.evaluate(() =>
      window.desktop.start({
        agents: ["fake"],
        allow: [],
        allowAll: false,
        prompt: JSON.stringify([{ message: "cancel-ready" }, { hang: "cancellable" }]),
      }),
    );
    const cancelled = cancelledIds[0];
    if (!cancelled) throw new Error("Cancellation agent did not start");
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.snapshot()).runs.find((run) => run.record.id === id)?.view
              ?.status,
          cancelled,
        ),
      )
      .toBe("running");
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const events = await window.desktop.action({ type: "events", id });
          return (
            Array.isArray(events) &&
            events.some((event) => event.type === "message" && event.text === "cancel-ready")
          );
        }, cancelled),
      )
      .toBe(true);
    await page.evaluate((id) => window.desktop.action({ type: "cancel", id }), cancelled);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.snapshot()).runs.find((run) => run.record.id === id)?.view
              ?.status,
          cancelled,
        ),
      )
      .toBe("idle");
    await page.evaluate((id) => window.desktop.action({ type: "finish", id }), cancelled);
    await app.close();
    app = await launchDesktop(directory, repo, database);
    page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(async () => (await window.desktop.snapshot()).database))
      .toBe(database);
    await expect(page.locator(".splash-prompt").getByRole("heading")).toHaveText(
      "Continue project?",
    );
    await page.locator(".splash-prompt").getByRole("button", { name: "Yes", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.desktop.snapshot()).runs.some((run) => run.record.id === id),
          id,
        ),
      )
      .toBe(true);
    expect((await stat(database)).size).toBeGreaterThan(0);
  } finally {
    await app.close().catch(() => {});
    if (!process.env.CODE60_PACKAGED_DATA_ROOT)
      await rm(directory, { recursive: true, force: true });
  }
});

test("installed app refuses a launcher that disables the sandbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code60-sandbox-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_STATE_HOME: join(directory, "state"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await expect(
      promisify(execFile)(
        process.env.CODE60_PACKAGED_EXECUTABLE as string,
        ["--no-sandbox", `--user-data-dir=${join(directory, "user-data")}`],
        { cwd: directory, env, timeout: 15_000 },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Code60 requires the Chromium sandbox"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

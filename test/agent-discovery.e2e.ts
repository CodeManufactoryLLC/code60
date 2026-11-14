import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveCommand } from "../src/platform/index.js";
import { launchDesktop, removeDesktopFixture as rm } from "./electron-launcher.js";

import { commitFixture } from "./fixtures/git-repository.js";

const fixture = resolve(import.meta.dirname, "fixtures/packaged-agent.mjs");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const location of process.platform === "win32"
  ? ["fallback", "inherited"]
  : ["fallback", "shell"]) {
  const windowsFallback = process.platform === "win32" && location === "fallback";
  test(`discovers default Droid and npx workers from ${location} PATH${windowsFallback ? " (npx inherited)" : ""}`, async () => {
    test.setTimeout(60_000);
    const directory = await mkdtemp(join(tmpdir(), "code60-discovery-"));
    const project = join(directory, "project");
    execFileSync("git", ["init", "-q", project]);
    commitFixture(project);
    const home = join(directory, "home");
    const bin =
      location === "fallback" ? join(home, ".local/bin") : join(directory, "custom tools");
    // Registry PATH precedes fallback folders on Windows and may contain real npx.
    // Keep Droid in the fallback folder, but give only the fake npx inherited priority.
    const npxBin = windowsFallback ? join(directory, "worker tools") : bin;
    await mkdir(bin, { recursive: true });
    const probe = join(directory, "mcp-ok");
    // The host Node path is explicit only inside the fake executable. Application
    // configuration is absent: Code60 must resolve its shipped Droid/npx commands.
    for (const name of ["droid", "npx"]) {
      if (process.platform === "win32") {
        const commandBin = name === "npx" ? npxBin : bin;
        const entry =
          name === "npx"
            ? join(commandBin, "node_modules", "npm", "bin", "npx-cli.js")
            : join(commandBin, "droid.cjs");
        await mkdir(join(commandBin, "node_modules", "npm", "bin"), { recursive: true });
        await copyFile(process.execPath, join(commandBin, "node.exe"));
        const expected =
          name === "droid"
            ? ["exec", "--output-format", "acp"]
            : ["-y", "@agentclientprotocol/codex-acp"];
        await writeFile(
          entry,
          `
          require("node:assert/strict").deepEqual(process.argv.slice(2), ${JSON.stringify(expected)});
          process.env.CODE60_TEST_DISPATCH = "1";
          process.argv = [process.execPath, __filename, ${JSON.stringify(probe)}];
          import(${JSON.stringify(pathToFileURL(fixture).href)});
        `,
        );
        await writeFile(
          join(commandBin, `${name}.cmd`),
          `@echo off\r\n"${join(commandBin, "node.exe")}" "${entry}" %*\r\n`,
        );
        continue;
      }
      const check =
        name === "droid"
          ? '[ "$1" = exec ] && [ "$2" = --output-format ] && [ "$3" = acp ]'
          : '[ "$1" = -y ] && [ "$2" = @agentclientprotocol/codex-acp ]';
      await writeFile(
        join(bin, name),
        `#!/bin/sh\n${check} || exit 91\nexport CODE60_TEST_DISPATCH=1\nexec ${quote(process.execPath)} ${quote(fixture)} ${quote(probe)}\n`,
        { mode: 0o700 },
      );
    }
    // A provider prerequisite must exist; npx alone must not count as detection.
    await writeFile(join(bin, process.platform === "win32" ? "codex.exe" : "codex"), "", {
      mode: 0o700,
    });
    const shell = join(directory, "login-shell");
    if (location === "shell") {
      await writeFile(
        shell,
        '#!/bin/sh\necho "shell greeting"\nexport PATH="$CODE60_TEST_AGENT_BIN:$PATH"\nexec /bin/sh -c "$2"\n',
        { mode: 0o700 },
      );
    }
    const app = await launchDesktop(directory, project, join(directory, "db.sqlite"), true, {
      SHELL: shell, // Missing shell deliberately exercises the fallback branch.
      CODE60_TEST_AGENT_BIN: bin,
      ...(process.platform === "win32"
        ? { PATH: `${npxBin};${process.env.SystemRoot}\\System32` }
        : {}),
    });
    try {
      const page = await app.firstWindow();
      if (process.platform === "win32") {
        // Fail before selecting a project/provider if host discovery shadows a fixture.
        const env = await app.evaluate(() => ({ ...process.env }));
        for (const [name, commandBin] of [
          ["droid", bin],
          ["npx", npxBin],
        ] as const) {
          expect(await resolveCommand([name], env)).toEqual(
            await resolveCommand([join(commandBin, `${name}.cmd`)], env),
          );
        }
      }
      await expect(page.locator(".splash-title")).toHaveText("Code60");
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
      await page.evaluate(async () => {
        let session = (await window.desktop.snapshot()).agentSetup?.session;
        if (!session) {
          await window.desktop.beginAgentSetup({ mode: "primary" });
          session = (await window.desktop.snapshot()).agentSetup?.session;
        }
        if (!session) throw new Error("Missing setup session");
        for (const provider of ["droid", "codex"])
          await window.desktop.attemptAgentSetup({ sessionId: session.id, provider });
        await window.desktop.finishAgentSetup({ sessionId: session.id });
      });
      await expect.poll(() => readFile(probe, "utf8").catch(() => "")).toBe("ok\n");
      // The probe is written during session/new, before Relay's session is ready.
      await expect
        .poll(() => page.evaluate(async () => (await window.desktop.snapshot()).chat.run?.status))
        .toBe("idle");
      const idle = await page.evaluate(() => window.desktop.snapshot());
      expect(idle.chat.run?.turns).toBe(0);
      expect(idle.runs).toEqual([]);
      await page.evaluate(async (cwd) => {
        const relay = (await window.desktop.snapshot()).chat.run;
        if (!relay) throw new Error("Missing Relay");
        await window.desktop.orchestrationChatAction({
          type: "send",
          id: relay.id,
          text: `Relay target: ${JSON.stringify({ cwd, workspaceMode: "worktree", provider: "codex" })}`,
        });
      }, project);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const snapshot = await window.desktop.snapshot();
            return snapshot.runs.find((run) => run.record.agent === "codex")?.view?.status;
          }),
        )
        .toBe("idle");
      await page.evaluate(() => window.desktop.testOrchestrationProvider());
      expect(
        await page.evaluate(async () => (await window.desktop.snapshot()).orchestration.connection),
      ).toBe("connected");
      await expect(readFile(join(directory, "config/code60/config.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(directory, "unexpected-runtime"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

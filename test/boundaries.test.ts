import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  cli: ["core", "automation"],
  desktop: ["core", "bridge", "platform", "automation"],
  automation: ["core", "contracts", "platform"],
  renderer: ["bridge", "core"],
  bridge: ["core", "contracts"],
  core: ["agents", "git", "contracts", "platform"],
  agents: ["contracts", "platform"],
  contracts: [],
  git: ["platform"],
  platform: [],
};

/** Packages only one module may import, so integrations stay in their module. */
const PACKAGE_OWNERS: Readonly<Record<string, string>> = {
  "@agentclientprotocol/sdk": "agents",
  electron: "desktop",
  "electron-updater": "desktop",
  react: "renderer",
  "react-dom": "renderer",
  "react-markdown": "renderer",
  "remark-gfm": "renderer",
  "@glideapps/glide-data-grid": "renderer",
  "@headless-tree/core": "renderer",
  "@headless-tree/react": "renderer",
  "monaco-editor": "renderer",
};

const IMPORT_RE =
  /(?:import|export)\s+(?:[^"'`]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

interface SourceFile {
  path: string;
  text: string;
}

function moduleOf(path: string): string | undefined {
  const [first, second] = relative(SRC, path).split(sep);
  return second === undefined ? undefined : first;
}

function findViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const from = moduleOf(file.path);
    if (from === undefined) {
      violations.push(`${file.path}: files must live inside a module directory`);
      continue;
    }
    for (const match of file.text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (spec === undefined) continue;
      const where = `${relative(SRC, file.path).split(sep).join("/")} imports "${spec}"`;
      if (
        (from === "renderer" || from === "bridge" || from === "contracts") &&
        spec.startsWith("node:")
      )
        violations.push(`${where}: renderer contracts may not import Node.js`);
      if (!spec.startsWith(".")) {
        if (from === "contracts" && spec !== "zod") {
          violations.push(`${where}: contracts may only import zod`);
        }
        const pkg = Object.keys(PACKAGE_OWNERS).find((p) => spec === p || spec.startsWith(`${p}/`));
        if (pkg !== undefined && PACKAGE_OWNERS[pkg] !== from) {
          violations.push(`${where}: only ${PACKAGE_OWNERS[pkg]} may import ${pkg}`);
        }
        continue;
      }
      if (
        (from === "renderer" || from === "bridge") &&
        spec.includes("core/") &&
        !match[0].match(/^(?:import|export)\s+type\b/)
      ) {
        violations.push(`${where}: core imports must be type-only`);
      }
      const target = resolve(dirname(file.path), spec);
      const to = moduleOf(target);
      if (to === undefined) {
        violations.push(`${where}: imports outside src modules are not allowed`);
      } else if (to !== from) {
        if (!ALLOWED[from]?.includes(to)) {
          violations.push(`${where}: ${from} may not depend on ${to}`);
        } else if (target !== join(SRC, to, "index.js")) {
          violations.push(`${where}: import ${to} through its index.js`);
        }
      }
    }
  }
  return violations;
}

function readSources(dir: string): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(?:tsx?|cts)$/.test(e.name))
    .map((e) => {
      const path = join(e.parentPath, e.name);
      return { path, text: readFileSync(path, "utf8") };
    });
}

describe("module boundaries", () => {
  it("src follows the dependency rules in ARCHITECTURE.md", () => {
    expect(findViolations(readSources(SRC))).toEqual([]);
  });

  it("keeps contracts browser-safe and independent of application modules", () => {
    const f = (text: string) => ({ path: join(SRC, "contracts", "x.ts"), text });
    expect(findViolations([f('import { z } from "zod";')])).toEqual([]);
    expect(findViolations([f('import { readFile } from "node:fs";')])).not.toEqual([]);
    expect(findViolations([f('import type { Config } from "../core/index.js";')])).not.toEqual([]);
    expect(findViolations([f('import { app } from "electron";')])).not.toEqual([]);
  });

  it("keeps native capabilities out of browser modules and platform independent", () => {
    for (const module of ["renderer", "bridge", "contracts"]) {
      expect(
        findViolations([
          {
            path: join(SRC, module, "x.ts"),
            text: 'import { spawnOwnedProcess } from "../platform/index.js";',
          },
        ]),
      ).not.toEqual([]);
    }
    expect(
      findViolations([
        {
          path: join(SRC, "platform", "x.ts"),
          text: 'import { defaultDeps } from "../core/index.js";',
        },
      ]),
    ).not.toEqual([]);
  });

  it("detects forbidden dependencies, deep imports, and owned packages", () => {
    const f = (module: string, text: string) => ({ path: join(SRC, module, "x.ts"), text });
    expect(
      findViolations([
        f("cli", 'import { x } from "../agents/index.js";'),
        f("agents", 'import type { X } from "../core/index.js";'),
        f("git", 'export * from "../agents/index.js";'),
        f("cli", 'import { y } from "../core/exit-code.js";'),
        f("core", 'import { ClientSideConnection } from "@agentclientprotocol/sdk";'),
        f("core", 'const m = await import("../git/index.js");'),
        f("core", 'import { createRoot } from "react-dom";'),
        f("renderer", 'import { useState } from "react";'),
        f("renderer", 'import { app } from "electron";'),
        f("desktop", 'import { render } from "react-dom";'),
        f("renderer", 'import { defaultDeps } from "../core/index.js";'),
      ]),
    ).toEqual([
      'cli/x.ts imports "../agents/index.js": cli may not depend on agents',
      'agents/x.ts imports "../core/index.js": agents may not depend on core',
      'git/x.ts imports "../agents/index.js": git may not depend on agents',
      'cli/x.ts imports "../core/exit-code.js": import core through its index.js',
      'core/x.ts imports "@agentclientprotocol/sdk": only agents may import @agentclientprotocol/sdk',
      'core/x.ts imports "react-dom": only renderer may import react-dom',
      'renderer/x.ts imports "electron": only desktop may import electron',
      'desktop/x.ts imports "react-dom": only renderer may import react-dom',
      'renderer/x.ts imports "../core/index.js": core imports must be type-only',
    ]);
  });
});

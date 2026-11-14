import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  CODE60_VERSION,
  type CoreDeps,
  commandDeps,
  defaultDeps,
  diagnosticMessage,
  diagnosticText,
  diffRun,
  discardRun,
  ExitCode,
  exitCodeFor,
  listRuns,
  type NoWorktreeReason,
  openWorkspace,
  prepareRuns,
  RefusedError,
  stopRun,
  UsageError,
} from "../core/index.js";
import { automationCommand } from "./automation.js";
import { formatList } from "./commands.js";
import { formatResultsJson, formatResultsTable, reportProgress } from "./headless.js";
import { readPrompt } from "./prompt.js";
import { type SignalSource, watchSignals } from "./signals.js";
import { oneLine } from "./text.js";

export interface CliIo {
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown; isTTY?: boolean };
  stdin?: AsyncIterable<Buffer | string> & { isTTY?: boolean };
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: () => string;
  signals?: SignalSource;
  /** Core dependencies; tests replace them with fakes. */
  deps?: CoreDeps;
}

export const HELP = `Usage:
  code60 run [prompt] [--prompt-file <path>] [--agent <name>]... [--base <rev>]
             [--turn-timeout <duration>] [--parallel <n>] [--allow <kind>]... [--allow-all]
             [--headless] [--json]
  code60 list [--json]
  code60 diff <run-id>
  code60 discard <run-id> [--yes]
  code60 stop <run-id>
  code60 automation --help
  code60 scheduler --help
  code60 --version

Commands:
  run       Run agents in parallel, each in its own worktree. Outside a Git repository, or
            in one with no commits, agents work directly in the current directory instead.
            The prompt comes from the argument, --prompt-file, or standard input. Always
            runs headless; use the Code60 desktop app for interactive runs.
  list      List runs in this repository, including runs left behind by a crash.
  diff      Show a run's changes against its base, including untracked files.
  discard   Remove a run's worktree and its code60/<run-id> branch.
  stop      Stop a leftover agent process from an ended run.

Run options:
  --agent <name>            Agent to run; repeat to start several runs (default: config).
  --base <rev>              Commit the worktrees start from (default: HEAD).
  --turn-timeout <d>        Time limit per turn, e.g. 30m, 90s, 1h30m (default: config).
  --parallel <n>            With one agent, start n runs of it at once (at most 32). With
                            several --agent flags, the maximum active runs at once
                            (default: config).
  --allow <kind>            Allow a tool-call kind without asking; repeatable.
  --allow-all               Allow every tool call.
  --headless                Compatibility flag; CLI runs are always headless. "ask" is denied.
  --json                    Write the result as JSON to standard output (implies --headless).

Options:
  -y, --yes    Discard without asking.
  -h, --help   Show this help.
  --version    Show the Code60 version.
`;

type OptionSpec = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

interface CommandSpec {
  options: OptionSpec;
  positionals: { min: number; max: number };
}

const help = { help: { type: "boolean", short: "h" } } as const;

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  run: {
    options: {
      ...help,
      "prompt-file": { type: "string" },
      agent: { type: "string", multiple: true },
      base: { type: "string" },
      "turn-timeout": { type: "string" },
      parallel: { type: "string" },
      allow: { type: "string", multiple: true },
      "allow-all": { type: "boolean" },
      headless: { type: "boolean" },
      json: { type: "boolean" },
    },
    positionals: { min: 0, max: 1 },
  },
  list: { options: { ...help, json: { type: "boolean" } }, positionals: { min: 0, max: 0 } },
  diff: { options: { ...help }, positionals: { min: 1, max: 1 } },
  discard: {
    options: { ...help, yes: { type: "boolean", short: "y" } },
    positionals: { min: 1, max: 1 },
  },
  stop: { options: { ...help }, positionals: { min: 1, max: 1 } },
};

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

function usageError(io: CliIo, message: string): number {
  io.stderr.write(`code60: ${diagnosticText(message)}\n\n${HELP}`);
  return ExitCode.usage;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version") {
    if (rest.length > 0) return usageError(io, "--version takes no arguments");
    io.stdout.write(`code60 ${CODE60_VERSION}\n`);
    return ExitCode.ok;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    io.stdout.write(HELP);
    return ExitCode.ok;
  }
  if (command === undefined) return usageError(io, "missing command");
  if (command === "automation" || command === "scheduler") {
    try {
      return await automationCommand(command, rest, io);
    } catch (error) {
      io.stderr.write(`code60: ${diagnosticMessage(error)}\n`);
      return error instanceof UsageError || (error as Error).name === "TypeError"
        ? ExitCode.usage
        : ExitCode.failed;
    }
  }

  const spec = COMMANDS[command];
  if (spec === undefined) return usageError(io, `unknown command '${command}'`);

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...rest],
      options: spec.options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(io, error instanceof Error ? error.message : String(error));
  }

  if (parsed.values.help === true) {
    io.stdout.write(HELP);
    return ExitCode.ok;
  }
  const count = parsed.positionals.length;
  if (count < spec.positionals.min || count > spec.positionals.max) {
    return usageError(io, `wrong number of arguments for '${command}'`);
  }

  const values = parsed.values as Values;
  const [arg] = parsed.positionals;
  try {
    switch (command) {
      case "run":
        return await runCommand(io, values, arg);
      case "list":
        return await listCommand(io, values.json === true);
      case "diff":
        return await diffCommand(io, arg as string);
      case "discard":
        return await discardCommand(io, arg as string, values.yes === true);
      default:
        return await stopCommand(io, arg as string);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`code60: ${diagnosticMessage(error)}\n`);
      return ExitCode.usage;
    }
    const message = diagnosticMessage(error);
    io.stderr.write(`code60: ${message}\n`);
    return ExitCode.failed;
  }
}

const strings = (value: Values[string]): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const optional = (value: Values[string]): string | undefined =>
  typeof value === "string" ? value : undefined;

async function runCommand(io: CliIo, values: Values, arg: string | undefined): Promise<number> {
  const deps = io.deps ?? defaultDeps();
  const promptFile = optional(values["prompt-file"]);
  const json = values.json === true;
  const prompt = await readPrompt({
    ...(arg === undefined ? {} : { arg }),
    ...(promptFile === undefined ? {} : { file: promptFile }),
    stdin: io.stdin,
    readFile: (path) => readFile(path, "utf8"),
  });
  const base = optional(values.base);
  const turnTimeout = optional(values["turn-timeout"]);
  const parallel = optional(values.parallel);
  const { orchestrator, interrupted, noWorktree, workspace } = await prepareRuns(deps, {
    cwd: io.cwd?.() ?? process.cwd(),
    env: io.env ?? process.env,
    mode: "headless",
    ...(prompt === undefined ? {} : { prompt }),
    agents: strings(values.agent),
    ...(base === undefined ? {} : { base }),
    ...(turnTimeout === undefined ? {} : { turnTimeout }),
    ...(parallel === undefined ? {} : { parallel }),
    allow: strings(values.allow),
    allowAll: values["allow-all"] === true,
  });
  if (noWorktree !== undefined) {
    io.stderr.write(noWorktreeNotice(noWorktree, workspace.dir, orchestrator.runs().length));
  }
  if (interrupted > 0) {
    io.stderr.write(
      `code60: marked ${interrupted} run${interrupted === 1 ? "" : "s"} from an earlier process as interrupted; see 'code60 list'\n`,
    );
  }

  const signals = watchSignals(io.signals, {
    first: () => {
      io.stderr.write("code60: interrupted; stopping every run (signal again to force)\n");
      void orchestrator.shutdown();
    },
    second: () => void orchestrator.shutdown(true),
  });
  try {
    const stop = reportProgress(orchestrator, io.stderr);
    orchestrator.start();
    await orchestrator.done;
    stop();
    const results = await orchestrator.results();
    io.stdout.write(json ? formatResultsJson(results) : formatResultsTable(results));
    return exitCodeFor(
      results.map((r) => r.status),
      { signal: signals.received },
    );
  } finally {
    signals.dispose();
  }
}

function noWorktreeNotice(reason: NoWorktreeReason, dir: string, runs: number): string {
  const where =
    reason === "not_a_repository"
      ? "is not in a Git repository"
      : "is in a Git repository with no commits yet";
  let out = `code60: ${oneLine(dir)} ${where}, so agents work directly in it, without worktrees. 'diff' and 'discard' are not available for these runs.\n`;
  if (runs > 1) {
    out += `code60: warning: all ${runs} runs share this directory and can overwrite each other's changes.\n`;
  }
  return out;
}

async function repoFor(io: CliIo) {
  const deps = io.deps ?? defaultDeps();
  const workspace = await openWorkspace(deps, io.cwd?.() ?? process.cwd(), io.env ?? process.env);
  return { deps, workspace, cmd: commandDeps(deps, workspace) };
}

async function listCommand(io: CliIo, json: boolean): Promise<number> {
  const { cmd } = await repoFor(io);
  const runs = await listRuns(cmd);
  if (json) {
    const out = runs.map(
      ({ record: { sessionState: _sessionState, ...record }, agentAlive, agentCommandLine }) => ({
        ...record,
        agentAlive,
        ...(agentCommandLine === undefined ? {} : { liveAgentCommandLine: agentCommandLine }),
      }),
    );
    io.stdout.write(`${JSON.stringify({ runs: out }, null, 2)}\n`);
  } else {
    io.stdout.write(formatList(runs));
  }
  return ExitCode.ok;
}

async function diffCommand(io: CliIo, id: string): Promise<number> {
  const { cmd } = await repoFor(io);
  io.stdout.write(await diffRun(cmd, id));
  return ExitCode.ok;
}

async function confirmInTerminal(io: CliIo, question: string): Promise<boolean> {
  const rl = createInterface({
    input: io.stdin as NodeJS.ReadableStream,
    output: io.stderr as NodeJS.WritableStream,
  });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function discardCommand(io: CliIo, id: string, yes: boolean): Promise<number> {
  const { cmd, workspace } = await repoFor(io);
  const canAsk = io.stdin?.isTTY === true && io.stderr.isTTY === true;
  const result = await discardRun(
    cmd,
    workspace.repo?.topLevel ?? workspace.dir,
    id,
    async (files, record) => {
      if (files.length === 0) {
        io.stderr.write(`Run ${id} has no changes.\n`);
      } else {
        io.stderr.write(
          `Run ${id} has ${files.length} changed file${files.length === 1 ? "" : "s"} that will be lost:\n`,
        );
        for (const f of files) io.stderr.write(`  ${f.status.padEnd(9)} ${oneLine(f.path)}\n`);
      }
      if (yes) return true;
      if (!canAsk) {
        throw new UsageError(
          "not discarding without confirmation; pass --yes to discard non-interactively",
        );
      }
      return confirmInTerminal(
        io,
        `Remove worktree ${record.worktree} and branch ${record.branch}? [y/N] `,
      );
    },
  );
  if (!result.discarded) {
    io.stderr.write("Not discarded.\n");
    return ExitCode.failed;
  }
  io.stdout.write(
    `Discarded run ${id}: removed worktree ${result.record.worktree} and branch ${result.record.branch}.\n`,
  );
  return ExitCode.ok;
}

async function stopCommand(io: CliIo, id: string): Promise<number> {
  const { cmd } = await repoFor(io);
  try {
    const result = await stopRun(cmd, id);
    io.stdout.write(`${result.message}\n`);
    return ExitCode.ok;
  } catch (error) {
    if (error instanceof RefusedError) {
      io.stderr.write(`code60: ${error.message}\n`);
      return ExitCode.failed;
    }
    throw error;
  }
}

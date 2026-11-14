import * as fsPromises from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type AgentMcpServer, type Agents, createAgents } from "../agents/index.js";
import type { LogSink, PromptTemplates } from "../contracts/index.js";
import { createGit, type Git } from "../git/index.js";
import {
  appendPrivateFile,
  environmentValue,
  privateDirectory,
  renameFile,
  userHome,
  writePrivateFile,
} from "../platform/index.js";
import { type Clock, systemClock } from "./clock.js";
import { type CommandDeps, markInterrupted } from "./commands.js";
import { type ConfigFs, configuredMcpServers, loadConfig, parseDuration } from "./config.js";
import { withDirectoryHistory } from "./desktop-history.js";
import { createOrchestrator, type Orchestrator } from "./orchestrator.js";
import { type PolicyOverrides, parseToolKinds } from "./policy.js";
import { createProcesses, type Processes, recordedAgentAlive } from "./processes.js";
import {
  createRecordStore,
  directoryRunsDir,
  type RecordFs,
  type RecordStore,
  runsDir,
} from "./records.js";
import {
  ACTIVE_STATUSES,
  type Config,
  type Mode,
  RefusedError,
  type RunRecord,
  UsageError,
} from "./types.js";
import { CODE60_VERSION } from "./version.js";

export type { AgentMcpServer } from "../agents/index.js";
export { ACP_PROTOCOL_VERSION } from "../agents/index.js";
export type {
  GitReadiness,
  GitSetupFile,
  GitSetupOps,
  GitWorktree,
  ReviewSnapshotFile,
} from "../git/index.js";
export { diagnosticMessage, diagnosticText } from "../platform/index.js";
export * from "./agent-memory.js";
export {
  diffRun,
  discardRun,
  executeDiff,
  type ListedRun,
  listRuns,
  prepareDiff,
  stopRun,
} from "./commands.js";
export { DEFAULT_CONFIG, loadConfig, parseConfig } from "./config.js";
export { ExitCode, exitCodeFor } from "./exit-code.js";
export type { Orchestrator } from "./orchestrator.js";
export { recordedAgentAlive } from "./processes.js";
export { buildHandoffPrompt } from "./recovery.js";
export * from "./recurrence.js";
export { TaskLoop, type TaskProposal, type TaskSource } from "./task-loop.js";
export type * from "./types.js";
export { ACTIVE_STATUSES, RefusedError, UsageError } from "./types.js";
export { CODE60_VERSION, RUN_RECORD_FORMAT } from "./version.js";

export interface CoreDeps {
  /** Internal deterministic identity allocation, including preclaimed automation runs. */
  newRunId?: () => string;
  memory?: import("./agent-memory.js").MemoryFactory;
  log?: LogSink;
  agents: Agents;
  git: Git;
  fs: RecordFs & ConfigFs;
  clock: Clock;
  processes: Processes;
  /** PID recorded as each run's owner. */
  ownerPid: number;
}

const recordStoreScope = {};

export function defaultDeps(log?: LogSink): CoreDeps {
  return {
    ...(log ? { log } : {}),
    agents: createAgents({ clientVersion: CODE60_VERSION, ...(log ? { log } : {}) }),
    git: createGit(),
    fs: {
      ...fsPromises,
      recordStoreScope,
      mkdir: async (path: string) => privateDirectory(path),
      rename: renameFile,
      writeFile: writePrivateFile,
      appendFile: appendPrivateFile,
    } as unknown as RecordFs & ConfigFs,
    clock: systemClock,
    processes: createProcesses(),
    ownerPid: process.pid,
  };
}

/** A dedicated desktop conversation, always rooted directly in its supplied directory. */
export async function prepareOrchestrationChat(
  deps: CoreDeps,
  directory: string,
  name: string,
  config: Config,
  options: {
    mcpServers?: readonly AgentMcpServer[];
    promptContext?: () => string;
    recovery?: RunRecord;
  } = {},
): Promise<Orchestrator> {
  const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  if (!agent) throw new UsageError(`Unavailable orchestration provider: ${name}`);
  await deps.fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32")
    await deps.fs.mkdir(join(directory, ".code60"), { recursive: true, mode: 0o700 });
  return createOrchestrator(
    { ...deps, store: createRecordStore(deps.fs, join(directory, ".code60", "runs")) },
    {
      mode: "interactive",
      agents: [{ name, config: agent }],
      directory,
      ...(options.recovery ? { recovery: options.recovery } : {}),
      base: "",
      repoDir: directory,
      worktreeRoot: directory,
      turnTimeoutMs: parseDuration(config.turnTimeout),
      maxParallel: 1,
      policy: config.permissions,
      overrides: { allow: [], allowAll: true },
      prompts: config.prompts,
      mcpServers: [...configuredMcpServers(config), ...(options.mcpServers ?? [])],
      ...(options.promptContext === undefined ? {} : { promptContext: options.promptContext }),
    },
  );
}

/** Reads desktop chat history without starting an agent or restoring execution authority. */
export async function readOrchestrationChat(
  deps: CoreDeps,
  directory: string,
  id: string,
  includeEvents = true,
  options: { readOnly?: boolean } = {},
) {
  const store = createRecordStore(deps.fs, join(directory, ".code60", "runs"));
  const record = await store.read(id);
  if (record.branch !== null || record.base !== null || record.worktree !== directory)
    throw new RefusedError("The saved orchestration directory does not match its run");
  if (!options.readOnly)
    await markInterrupted({ store, processes: deps.processes, clock: deps.clock }, [record]);
  return {
    record,
    events: includeEvents ? await store.readEvents(id) : [],
    agentAlive: await recordedAgentAlive(deps.processes, record),
  };
}

export interface Workspace {
  /** The directory the command ran in. Runs without a worktree use it directly. */
  dir: string;
  /** The Git repository containing `dir`, or null when there is none (or no `git`). */
  repo: { topLevel: string; commonDir: string } | null;
  store: RecordStore;
}

/** Lists worktrees registered to the workspace's repository, or none for a non-Git folder. */
export function listWorktrees(
  deps: CoreDeps,
  workspace: Workspace,
  options?: Parameters<CoreDeps["git"]["listWorktrees"]>[1],
) {
  if (!workspace.repo) return Promise.resolve([]);
  return options
    ? deps.git.listWorktrees(workspace.repo.topLevel, options)
    : deps.git.listWorktrees(workspace.repo.topLevel);
}

type Env = Readonly<Record<string, string | undefined>>;

/** The base directory for state files: `$XDG_STATE_HOME`, or `~/.local/state`. */
export function stateHome(env: Env): string {
  const xdg = environmentValue(env, "XDG_STATE_HOME");
  if (xdg !== undefined && isAbsolute(xdg)) return xdg;
  return join(userHome(env), ".local", "state");
}

/**
 * Finds where `cwd`'s run records live: inside its Git repository when there is one, otherwise
 * in the user's state directory, keyed by `cwd`.
 */
export async function openWorkspace(
  deps: CoreDeps,
  cwd: string,
  env: Env,
  includeDirectoryHistory = false,
): Promise<Workspace> {
  let dir = resolve(cwd);
  if (process.platform === "win32" && deps.fs.realpath) {
    try {
      dir = await deps.fs.realpath(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const repo = await deps.git.repoInfo(dir).catch(() => null);
  const store = createRecordStore(
    deps.fs,
    repo === null ? directoryRunsDir(stateHome(env), dir) : runsDir(repo.commonDir),
  );
  return {
    dir,
    repo,
    store:
      includeDirectoryHistory && repo !== null
        ? withDirectoryHistory(
            store,
            createRecordStore(deps.fs, directoryRunsDir(stateHome(env), dir)),
          )
        : store,
  };
}

export function commandDeps(deps: CoreDeps, workspace: Workspace): CommandDeps {
  return { git: deps.git, store: workspace.store, clock: deps.clock, processes: deps.processes };
}

export interface RunRequest {
  /** Explicit desktop execution policy. Omitted preserves CLI auto-detection. */
  workspaceMode?: "direct" | "worktree";
  /** Desktop workers must never fall back to editing the shared directory. */
  requireIsolation?: boolean;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  mode: Mode;
  /** The first prompt. Only the desktop app may leave it out; each run then waits for one. */
  prompt?: string;
  /** Agent names, one per run. Empty means the default agent. See `prepareRuns` for `parallel`. */
  agents: readonly string[];
  base?: string;
  turnTimeout?: string;
  parallel?: string;
  allow?: readonly string[];
  allowAll?: boolean;
  /** Internal desktop marker for Relay-owned workers. */
  owner?: "relay";
}

/** Why runs go directly into the workspace directory instead of worktrees. */
export type NoWorktreeReason = "not_a_repository" | "no_commits";

export interface PreparedRuns {
  orchestrator: Orchestrator;
  workspace: Workspace;
  config: Config;
  /** Set when the runs have no worktrees and work directly in `workspace.dir`. */
  noWorktree?: NoWorktreeReason;
  /** Runs from earlier processes that were just marked interrupted. */
  interrupted: number;
}

function worktreeRoot(
  config: Config,
  repo: { topLevel: string; commonDir: string },
  env: RunRequest["env"],
): string {
  const mainRoot = basename(repo.commonDir) === ".git" ? dirname(repo.commonDir) : repo.topLevel;
  if (config.worktreeDir === null) {
    return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`);
  }
  const dir = config.worktreeDir.replace(
    process.platform === "win32" ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/,
    userHome(env),
  );
  return isAbsolute(dir) ? dir : resolve(mainRoot, dir);
}

/** Upper bound on the runs `--parallel` starts for a single agent, to catch typos. */
const MAX_COPIES = 32;

/**
 * Validates a `run` request, then creates the queued runs. Invalid input throws `UsageError`.
 * With one agent, `parallel` is the number of runs of it to start; with several, the limit on
 * active runs.
 */
export async function prepareRuns(
  deps: CoreDeps,
  request: RunRequest,
  configuration?: Config,
): Promise<PreparedRuns> {
  if (
    request.workspaceMode === "direct" &&
    (request.requireIsolation || request.base !== undefined)
  )
    throw new RefusedError("Direct execution cannot use isolation or a Git base.");
  const config = configuration ?? (await loadConfig(deps.fs, request.env));
  const mcpServers = configuredMcpServers(config);
  let maxParallel = config.maxParallel;
  if (request.parallel !== undefined) {
    if (!/^[1-9]\d*$/.test(request.parallel)) {
      throw new UsageError(`--parallel must be a positive integer, not '${request.parallel}'`);
    }
    maxParallel = Number(request.parallel);
  }
  let names = request.agents.length > 0 ? request.agents : [config.defaultAgent];
  if (names.length === 1 && request.parallel !== undefined) {
    if (maxParallel > MAX_COPIES) {
      throw new UsageError(`--parallel can start at most ${MAX_COPIES} runs of one agent`);
    }
    names = Array.from({ length: maxParallel }, () => names[0] as string);
  }
  const agents = names.map((name) => {
    const agent = config.agents[name];
    if (agent === undefined) {
      const known = Object.keys(config.agents).join(", ");
      throw new UsageError(`unknown agent '${name}' (configured agents: ${known})`);
    }
    return { name, config: agent };
  });
  const turnTimeoutMs = parseDuration(request.turnTimeout ?? config.turnTimeout);
  const allow = parseToolKinds(request.allow ?? []);
  if (request.prompt === undefined) {
    if (request.mode === "headless") {
      throw new UsageError("missing prompt: a headless run needs a prompt");
    }
  } else if (request.prompt.trim() === "") {
    throw new UsageError("the prompt is empty");
  }

  const workspace = await openWorkspace(deps, request.cwd, request.env);
  const { repo } = workspace;
  let base = "";
  let noWorktree: NoWorktreeReason | undefined;
  if (request.workspaceMode === "direct") {
    // Explicit direct execution must also stay direct inside a committed repository.
  } else if (repo === null) {
    if (request.base !== undefined) {
      throw new UsageError(`--base needs a Git repository, and ${workspace.dir} is not in one`);
    }
    noWorktree = "not_a_repository";
  } else {
    try {
      base = await deps.git.resolveCommit(repo.topLevel, request.base ?? "HEAD");
    } catch (error) {
      if (request.base !== undefined) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
      // HEAD resolves to no commit only in a repository that has none yet.
      noWorktree = "no_commits";
    }
  }
  if ((request.requireIsolation || request.workspaceMode === "worktree") && noWorktree)
    throw new RefusedError("Set up Git with an initial commit before starting desktop workers.");
  await preparePrivateRecords(deps, workspace, request.env);
  const interrupted = await markInterrupted(
    commandDeps(deps, workspace),
    await workspace.store.list(),
  );

  const orchestrator = await createOrchestrator(
    { ...deps, store: workspace.store },
    {
      mode: request.mode,
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      agents,
      base,
      repoDir: repo?.topLevel ?? workspace.dir,
      worktreeRoot: repo === null ? workspace.dir : worktreeRoot(config, repo, request.env),
      ...(noWorktree === undefined && request.workspaceMode !== "direct"
        ? {}
        : { directory: workspace.dir }),
      turnTimeoutMs,
      maxParallel,
      policy: config.permissions,
      overrides: { allow, allowAll: request.allowAll === true },
      prompts: config.prompts,
      ...(mcpServers.length ? { mcpServers } : {}),
      ...(request.owner === undefined ? {} : { owner: request.owner }),
    },
  );
  return {
    orchestrator,
    workspace,
    config,
    interrupted,
    ...(noWorktree === undefined ? {} : { noWorktree }),
  };
}

export interface PreparedRecovery {
  orchestrator: Orchestrator;
  config: Config;
}

/** Creates an orchestrator around an existing ended run, without creating a worktree. */
export async function prepareRecovery(
  deps: CoreDeps,
  workspace: Workspace,
  record: RunRecord,
  env: Env,
  /** Template overrides applied over the config file's templates, such as desktop edits. */
  prompts: Partial<PromptTemplates> = {},
  /** Permission overrides, such as the fixed allow-all policy of orchestrated workers. */
  overrides?: PolicyOverrides,
  configuration?: Config,
): Promise<PreparedRecovery> {
  if (ACTIVE_STATUSES.has(record.status)) {
    throw new RefusedError(
      `run ${record.id} is ${record.status}; only ended runs can be recovered`,
    );
  }
  if (await recordedAgentAlive(deps.processes, record)) {
    throw new RefusedError(
      `the leftover agent for run ${record.id} is still alive (process group ${record.agentPid}); stop it before retrying`,
    );
  }
  const config = configuration ?? (await loadConfig(deps.fs, env));
  const mcpServers = configuredMcpServers(config);
  const agent = config.agents[record.agent];
  if (!agent) throw new RefusedError(`the configured agent '${record.agent}' is unavailable`);
  await preparePrivateRecords(deps, workspace, env);
  const orchestrator = await createOrchestrator(
    { ...deps, store: workspace.store },
    {
      mode: "interactive",
      agents: [{ name: record.agent, config: agent }],
      recovery: record,
      base: record.base ?? "",
      repoDir: workspace.repo?.topLevel ?? workspace.dir,
      worktreeRoot: record.worktree,
      turnTimeoutMs: parseDuration(config.turnTimeout),
      maxParallel: 1,
      policy: config.permissions,
      ...(overrides === undefined ? {} : { overrides }),
      prompts: { ...config.prompts, ...prompts },
      ...(mcpServers.length ? { mcpServers } : {}),
    },
  );
  return { orchestrator, config };
}

export { generateChatTitle } from "./chat-title.js";
export { extractEpisodicMemory } from "./episodic-memory.js";
export {
  checkedVector,
  chunkText,
  conversationMessages,
  embedMessages,
  RAG_CHUNKER,
  type RagEmbedder,
  type RagSource,
  topMatches,
} from "./rag.js";
export { summarizeSearch } from "./search-summary.js";

async function preparePrivateRecords(
  deps: CoreDeps,
  workspace: Workspace,
  env: Env,
): Promise<void> {
  if (process.platform !== "win32") return;
  await deps.fs.mkdir(join(workspace.repo?.commonDir ?? stateHome(env), "code60"), {
    recursive: true,
    mode: 0o700,
  });
  await deps.fs.mkdir(workspace.store.dir, { recursive: true, mode: 0o700 });
}

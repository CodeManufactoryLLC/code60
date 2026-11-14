import { createHash } from "node:crypto";
import { realpath, stat, statfs } from "node:fs/promises";
import type {
  Automation,
  AutomationDraft,
  AutomationEvidence,
  Execution,
  ExecutionReason,
} from "../contracts/index.js";
import {
  type Config,
  type CoreDeps,
  DEFAULT_CONFIG,
  loadConfig,
  type Orchestrator,
  openWorkspace,
  prepareRuns,
  recordedAgentAlive,
  UsageError,
} from "../core/index.js";
import { fileCode } from "../platform/index.js";
import { AutomationError } from "./errors.js";

export class ExecutionRefused extends Error {
  constructor(readonly reason: ExecutionReason) {
    super(reason);
  }
}

export type ExecutionOutcome = Pick<Execution, "status" | "reason" | "denials" | "changedFiles">;
export interface Executor {
  validate(draft: AutomationDraft): Promise<Pick<Automation, "repository" | "providerHash">>;
  execute(
    automation: Automation,
    execution: Execution,
    signal: AbortSignal,
    pin: (evidence: AutomationEvidence) => Promise<void>,
  ): Promise<ExecutionOutcome>;
  inspect(execution: Execution): Promise<"gone" | "blocked">;
}

function providerHash(config: Config, name: string): string {
  const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  if (!agent) throw new ExecutionRefused("provider_missing");
  return createHash("sha256").update(JSON.stringify(agent.command)).digest("hex");
}

async function repositoryIdentity(path: string) {
  const canonical = await realpath(path);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new ExecutionRefused("repository_missing");
  return { path: canonical, dev: String(info.dev), ino: String(info.ino) };
}

export async function verifyRepository(repository: Automation["repository"]): Promise<void> {
  let current: Automation["repository"];
  try {
    current = await repositoryIdentity(repository.path);
  } catch {
    throw new ExecutionRefused("repository_missing");
  }
  if (
    current.path !== repository.path ||
    current.dev !== repository.dev ||
    current.ino !== repository.ino
  )
    throw new ExecutionRefused("repository_replaced");
}

/** Never inherit global permissions, MCP integrations, prompts or memory. */
export function executionConfig(config: Config, automation: Automation): Config {
  const agent = config.agents[automation.agent];
  if (!agent || providerHash(config, automation.agent) !== automation.providerHash)
    throw new ExecutionRefused("provider_changed");
  return {
    ...DEFAULT_CONFIG,
    agents: { [automation.agent]: { command: [...agent.command] } },
    defaultAgent: automation.agent,
    maxParallel: 1,
    turnTimeout: automation.turnTimeout,
    permissions: {
      default: "deny",
      ...Object.fromEntries(automation.allow.map((kind) => [kind, "allow"])),
    },
    mcpServers: {},
    prompts: { ...DEFAULT_CONFIG.prompts },
    worktreeDir: null,
  };
}

export function createExecutor(deps: CoreDeps, env: Readonly<NodeJS.ProcessEnv>): Executor {
  const configuration = () => loadConfig(deps.fs, env);
  return {
    async validate(draft) {
      const repository = await repositoryIdentity(draft.repository);
      const repo = await deps.git.repoInfo(repository.path);
      if (!repo)
        throw new AutomationError("refused", "Choose a Git repository with a local base branch.");
      await deps.git.resolveCommit(repository.path, `refs/heads/${draft.baseBranch}`);
      return { repository, providerHash: providerHash(await configuration(), draft.agent) };
    },
    async inspect(execution) {
      try {
        await verifyRepository(execution.repository);
        const workspace = await openWorkspace(deps, execution.repository.path, env);
        if (!execution.runId) return "blocked";
        // The record store reports a missing run as a UsageError rather than ENOENT.
        const record = await workspace.store.read(execution.runId).catch((error) => {
          if (!(error instanceof UsageError) && fileCode(error) !== "ENOENT") throw error;
          return null;
        });
        if (!record) {
          // Only a durable prelaunch claim (or a known prelaunch refusal) proves no process started.
          return execution.status === "claimed" ||
            [
              "low_disk",
              "provider_missing",
              "provider_changed",
              "repository_missing",
              "repository_replaced",
              "base_missing",
            ].includes(execution.reason ?? "")
            ? "gone"
            : "blocked";
        }
        if (
          record.agentPid === undefined &&
          ["running", "waiting", "idle", "interrupted"].includes(record.status)
        )
          return "blocked"; // Crash between spawn and publication of process identity.
        return (await recordedAgentAlive(deps.processes, record)) ? "blocked" : "gone";
      } catch {
        return "blocked";
      }
    },
    async execute(automation, execution, signal, pin) {
      await verifyRepository(automation.repository);
      const disk = await statfs(automation.repository.path, { bigint: true });
      if (disk.bavail * disk.bsize < 2n * 1024n * 1024n * 1024n)
        throw new ExecutionRefused("low_disk");
      let base: string;
      try {
        base = await deps.git.resolveCommit(
          automation.repository.path,
          `refs/heads/${automation.baseBranch}`,
        );
      } catch {
        throw new ExecutionRefused("base_missing");
      }
      const config = executionConfig(await configuration(), automation);
      if (signal.aborted)
        return { status: "cancelled", reason: "cancelled_by_user", denials: 0, changedFiles: null };
      let orchestrator: Orchestrator | undefined;
      const cancel = () => {
        void orchestrator?.shutdown().catch(() => {});
      };
      signal.addEventListener("abort", cancel);
      let denials = 0;
      let persistenceFailed = false;
      let unsubscribe = () => {};
      let unwarn = () => {};
      try {
        if (!execution.runId) throw new Error("Missing preclaimed run");
        const runId = execution.runId;
        const { memory: _memory, ...headlessDeps } = deps;
        const git = Object.create(deps.git) as CoreDeps["git"];
        git.addWorktree = async (spec) => {
          await verifyRepository(automation.repository);
          await deps.git.addWorktree(spec);
          await pin({
            worktree: await repositoryIdentity(spec.path),
            base: spec.base,
            branch: spec.branch,
          });
        };
        const preparationDeps: CoreDeps = {
          ...headlessDeps,
          newRunId: () => runId,
          git,
          fs: {
            ...deps.fs,
            async writeFile(...args) {
              try {
                await deps.fs.writeFile(...args);
              } catch (error) {
                persistenceFailed = true;
                cancel();
                throw error;
              }
            },
            async appendFile(...args) {
              try {
                await deps.fs.appendFile(...args);
              } catch (error) {
                persistenceFailed = true;
                cancel();
                throw error;
              }
            },
            async rename(...args) {
              try {
                await deps.fs.rename(...args);
              } catch (error) {
                persistenceFailed = true;
                cancel();
                throw error;
              }
            },
          },
        };
        const prepared = await prepareRuns(
          preparationDeps,
          {
            cwd: automation.repository.path,
            env,
            mode: "headless",
            prompt: automation.prompt,
            agents: [automation.agent],
            base,
            workspaceMode: "worktree",
            requireIsolation: true,
          },
          config,
        );
        orchestrator = prepared.orchestrator;
        unsubscribe = orchestrator.onEvent((event) => {
          if (event.type === "permission" && event.decision === "denied") denials++;
        });
        unwarn = orchestrator.onWarning(() => {
          persistenceFailed = true;
          cancel();
        });
        await verifyRepository(automation.repository);
        if (signal.aborted || persistenceFailed) await orchestrator.shutdown();
        else orchestrator.start();
        await orchestrator.done;
        const [result] = await orchestrator.results();
        if (!result) throw new Error("Missing result");
        const status =
          result.status === "timed_out"
            ? "timed_out"
            : result.status === "finished"
              ? "finished"
              : result.status === "cancelled"
                ? "cancelled"
                : "failed";
        return {
          status,
          denials,
          changedFiles: result.changedFiles,
          reason: persistenceFailed
            ? "persistence_failed"
            : status === "timed_out"
              ? "timed_out"
              : status === "cancelled"
                ? "cancelled_by_user"
                : status === "failed"
                  ? "agent_failed"
                  : null,
        };
      } finally {
        signal.removeEventListener("abort", cancel);
        unsubscribe();
        unwarn();
        await orchestrator?.shutdown();
      }
    },
  };
}

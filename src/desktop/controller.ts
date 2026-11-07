import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Action,
  ActionResult,
  DesktopRun,
  FileContext,
  FileSnapshot,
  McpTable,
  MemoryExtractionRequest,
  MemoryExtractionResult,
  OrchestrationChatAction,
  OrchestrationProvider,
  PollKey,
  PollSettingsPatch,
  PollVisibility,
  ProjectEntry,
  PromptId,
  PromptTemplates,
  RecoveryActionResult,
  RunConfiguration,
  RunSettings,
  SaveConfiguration,
  SavePromptTemplate,
  SequencedEvent,
  Snapshot,
  StartRequest,
  WorktreeListing,
} from "../bridge/index.js";
import {
  DEFAULT_PROMPT_TEMPLATES,
  isMcpControlTool,
  MCP_CONTROL_LIMITS,
  MCP_PROTOCOL_VERSION,
  type McpControlTool,
  parseFileContext,
  parseMemoryExtraction,
  parseMemoryRequestId,
  parseOrchestrationChatAction,
  parseOrchestrationProvider,
  parsePollKeys,
  parsePollSettings,
  parsePollVisibility,
  parsePromptTemplateId,
  parseRunSettings,
  parseSaveConfiguration,
  parseSavePromptTemplate,
  renderPrompt,
} from "../bridge/index.js";
import {
  ACP_PROTOCOL_VERSION,
  ACTIVE_STATUSES,
  type AgentMcpServer,
  buildHandoffPrompt,
  CODE60_VERSION,
  type CoreDeps,
  commandDeps,
  diffRun,
  discardRun,
  extractEpisodicMemory,
  listRuns,
  loadConfig,
  type Orchestrator,
  openWorkspace,
  prepareOrchestrationChat,
  prepareRecovery,
  prepareRuns,
  type RecoveryResult,
  RefusedError,
  RUN_RECORD_FORMAT,
  type RunEvent,
  type RunView,
  listWorktrees as readWorktrees,
  stopRun,
  type Workspace,
} from "../core/index.js";
import { privateDirectory, samePath } from "../platform/index.js";
import { testAgentConnection } from "./agent-connection.js";
import { readFiles } from "./files.js";
import {
  type ControlArgs,
  formatWorkerUpdate,
  parseControlArgs,
  type WorkerUpdate,
  workerTranscript,
} from "./mcp-control.js";
import { createMcpGateway, type McpGateway } from "./mcp-gateway.js";
import { type McpTableRow, readMcpTool } from "./mcp-tables.js";
import { Poller } from "./poller.js";
import type { DesktopPreferences } from "./preferences.js";
import { type OpenProjectDatabase, type ProjectDatabase, SCHEMA } from "./projects.js";
import { effectivePrompts, promptStates } from "./prompt-templates.js";

export interface DesktopDialogs {
  confirm(title: string, detail: string): Promise<boolean>;
}

export interface DesktopStorage {
  openDatabase: OpenProjectDatabase;
  preferences: DesktopPreferences;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function mcpSessionMetrics(events: readonly RunEvent[], now: number) {
  const completed: number[] = [];
  let prompt: { at: number; turn: number } | undefined;
  const statuses: { status: string; at: number }[] = [];
  const buckets = Array<number>(10).fill(0);
  const bucketStart = now - 5 * 60_000;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    if (event.type === "prompt") prompt = { at, turn: event.turn };
    else if (event.type === "status") {
      if (!["running", "waiting"].includes(event.status) && prompt && at >= prompt.at) {
        completed.push((at - prompt.at) / 1000);
        prompt = undefined;
      }
      statuses.push({ status: event.status, at });
    }
    // Raw ACP copies and turn-end records would double-count the activity they describe.
    if (
      event.type !== "status" &&
      event.type !== "acp" &&
      event.type !== "turnEnd" &&
      at >= bucketStart &&
      at < now
    ) {
      const index = Math.floor((at - bucketStart) / 30_000);
      if (index >= 0 && index < buckets.length) buckets[index] = (buckets[index] ?? 0) + 1;
    }
  }
  const recent = completed.slice(-6);
  const spans: string[] = [];
  for (let index = 0; index < statuses.length; index++) {
    const current = statuses[index];
    if (!current) continue;
    const start = Math.max(now - 120_000, current.at);
    const end = Math.min(now, statuses[index + 1]?.at ?? now);
    if (end <= start) continue;
    spans.push(`${current.status} ${Math.round((end - start) / 1000)}s`);
  }
  return {
    turnTime: recent.length
      ? `Last ${recent.length} completed turns (seconds): ${recent.map(Math.round).join(", ")}`
      : "Turn time unavailable",
    events5m:
      events.length > 0
        ? `Events in ten 30-second buckets, oldest first: ${buckets.join(", ")}`
        : "Events unavailable",
    last2m: spans.length ? spans.join(", ") : "Unavailable",
  };
}

const pollSourceLabels: Record<PollKey, string> = {
  history: "Run history",
  config: "Agent config",
  configurations: "Run configurations",
  worktrees: "Worktrees",
  files: "Files",
};

const timeSetting = (milliseconds: number | null) =>
  milliseconds === null ? "Off" : `${milliseconds / 1000}s`;

interface Batch {
  active: boolean;
  disposers: (() => void)[];
}

/** A worker run dispatched by the orchestration chat. Ownership is held only in memory. */
interface Worker {
  /** The chat generation that dispatched it; only that chat may control it. */
  generation: number;
  directory: string;
  provider: string;
  /** The last turn already reported to the chat, so each turn wakes it at most once. */
  reportedTurn: number;
  /** The tail of the reply in the current turn. */
  reply: string;
}

/** Automatic updates sent to the chat in one prompt, at most. */
const UPDATE_BATCH = 20;
const STALE_CONTRACT = "Do not start or control agent runs";

/** All mutable state and capabilities belong to one orchestration conversation. */
class ChatSession {
  revoked = false;
  chat: Orchestrator | undefined;
  chatDirectory: string | null = null;
  chatError: string | null = null;
  chatEvents: SequencedEvent[] = [];
  chatPending: SequencedEvent[] = [];
  chatDisposers: (() => void)[] = [];
  mcpGateway: McpGateway | undefined;
  dispatches = new Map<string, { key: string; result: Promise<unknown> }>();
  workerScope = randomUUID();
  inbox: WorkerUpdate[] = [];
  updatesPaused = false;

  constructor(readonly chatGeneration: number) {}
}
/** Owns one workspace and independent batches. All history mutations are serialized. */
export class DesktopController {
  private workspace: Workspace | undefined;
  private batches = new Map<Orchestrator, Batch>();
  private history: DesktopRun[] = [];
  private config: Awaited<ReturnType<typeof loadConfig>> | undefined;
  private revision = 0;
  private events: SequencedEvent[] = [];
  private pending: SequencedEvent[] = [];
  private warnings: string[] = [];
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private forceClosing = false;
  private database: ProjectDatabase | undefined;
  private databaseError: string | null = null;
  private projects: ProjectEntry[] = [];
  private configurations: RunConfiguration[] = [];
  /** Template edits saved in the connected database. */
  private savedPrompts: Partial<PromptTemplates> = {};
  private launches = new Map<string, { settings: RunSettings; at: string; saved: boolean }>();
  private worktrees: WorktreeListing | null = null;
  private fileContext: FileContext | null = null;
  private files: FileSnapshot | null = null;
  private pollOverrides: PollSettingsPatch = {};
  private readonly poller: Poller;
  private orchestration: OrchestrationProvider = {
    provider: null,
    allowAll: true,
    connection: "idle",
    error: null,
  };
  private memoryExtraction:
    | { requestId: string; abort: AbortController; done: Promise<MemoryExtractionResult> }
    | undefined;
  private connectionTest: { abort: AbortController; done: Promise<void> } | undefined;
  private chatKey = "";
  private chatGeneration = 0;
  private currentChat = new ChatSession(0);
  private chats = [this.currentChat];
  private workers = new Map<string, Worker>();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: CoreDeps,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly dialogs: DesktopDialogs,
    private readonly storage: DesktopStorage,
  ) {
    this.poller = new Poller(
      (key, current) => this.readSource(key, current),
      (key) =>
        key === "config" ||
        (key === "files"
          ? this.fileContext !== null
          : key === "configurations"
            ? this.connected
            : this.workspace !== undefined),
      () => this.changed(),
    );
  }

  private async readSource(key: PollKey, current: () => boolean): Promise<void> {
    if (key === "files") {
      const context = this.fileContext;
      if (!context) return;
      await this.validateFileRoot(context);
      const files = await readFiles(context, () => current() && this.fileContext === context);
      if (current() && this.fileContext === context) this.files = files;
      return;
    }
    if (key === "worktrees") {
      const workspace = this.requireWorkspace();
      const worktrees = await readWorktrees(this.deps, workspace);
      if (current() && this.workspace === workspace) {
        this.worktrees = {
          repository: workspace.repo ? basename(workspace.repo.topLevel) : null,
          worktrees,
        };
      }
      return;
    }
    await this.exclusive(async () => {
      if (!current()) return;
      if (key === "history") {
        const workspace = this.requireWorkspace();
        const history = await listRuns(commandDeps(this.deps, workspace));
        if (current() && this.workspace === workspace) {
          this.history = history;
          for (const [batch, state] of this.batches) if (!state.active) this.batches.delete(batch);
        }
      } else if (key === "config") {
        const config = await loadConfig(this.deps.fs, this.env);
        if (current()) {
          const provider = this.orchestration.provider;
          if (
            provider &&
            JSON.stringify(this.config?.agents[provider]) !==
              JSON.stringify(config.agents[provider])
          ) {
            await this.cancelOrchestrationTest();
            await this.stopMemoryExtraction();
            this.orchestration = { ...this.orchestration, connection: "idle", error: null };
          }
          this.config = config;
          await this.syncOrchestrationChat();
        }
      } else {
        const database = this.requireDatabase();
        this.configurations = database.configurations();
        this.savedPrompts = this.readPrompts(database);
      }
    });
  }

  private async validateFileRoot(context: FileContext): Promise<void> {
    const workspace = this.requireWorkspace();
    if (!(await samePath(context.project, workspace.dir)))
      throw new Error("The open project has changed.");
    if (await samePath(context.root, workspace.dir)) return;
    for (const worktree of this.worktrees?.worktrees ?? []) {
      if (await samePath(worktree.path, context.root)) return;
    }
    throw new Error("This file root is not in the open project.");
  }

  async setFileContext(value: FileContext | null): Promise<void> {
    const context = parseFileContext(value);
    const workspace = this.workspace;
    if (context) await this.validateFileRoot(context);
    if (this.workspace !== workspace) throw new Error("The open project has changed.");
    if (JSON.stringify(context) === JSON.stringify(this.fileContext)) return;
    this.fileContext = context;
    if (
      !context ||
      this.files?.context.root !== context.root ||
      this.files.context.project !== context.project
    )
      this.files = null;
    this.poller.invalidate(["files"]);
    this.changed();
    if (context) await this.poller.poll("files", "change");
  }

  async poll(keys: PollKey[]): Promise<void> {
    const results = await Promise.allSettled(
      parsePollKeys(keys).map((key) => this.poller.poll(key)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  setPollSettings(patch: PollSettingsPatch): Promise<void> {
    patch = parsePollSettings(patch);
    return this.exclusive(async () => {
      // Persist only explicit overrides so built-in defaults can change later.
      const overrides = { ...this.pollOverrides };
      for (const [key, setting] of Object.entries(patch)) {
        if (setting === null) delete overrides[key as PollKey];
        else overrides[key as PollKey] = setting;
      }
      await this.storage.preferences.setPolling?.(overrides);
      this.pollOverrides = overrides;
      this.poller.configure(patch);
    });
  }

  setPollingPaused(paused: boolean): void {
    if (typeof paused !== "boolean") throw new Error("Expected a boolean");
    this.poller.pause(paused);
  }

  setVisibility(visibility: PollVisibility): void {
    this.poller.context(this.active, parsePollVisibility(visibility));
  }

  setOrchestrationProvider(value: string | null): Promise<void> {
    const provider = parseOrchestrationProvider(value);
    return this.exclusive(async () => {
      if (provider !== null && !Object.hasOwn(this.config?.agents ?? {}, provider))
        throw new Error(`Unavailable provider: ${provider}`);
      await this.cancelOrchestrationTest();
      await this.stopMemoryExtraction();
      if (!this.storage.preferences.setOrchestrationProvider)
        throw new Error("Orchestration settings cannot be saved");
      await this.storage.preferences.setOrchestrationProvider(provider);
      this.orchestration = { provider, allowAll: true, connection: "idle", error: null };
      await this.syncOrchestrationChat();
      this.changed();
    });
  }

  async testOrchestrationProvider(): Promise<void> {
    const { done } = await this.exclusive(async () => {
      if (this.connectionTest) return { done: this.connectionTest.done };
      const provider = this.orchestration.provider;
      const agent = provider === null ? undefined : this.config?.agents[provider];
      if (!provider || !agent || !Object.hasOwn(this.config?.agents ?? {}, provider))
        throw new Error("Select an available orchestration provider");
      const database = this.requireDatabase();
      const abort = new AbortController();
      this.orchestration = { ...this.orchestration, connection: "testing", error: null };
      this.changed();
      const done = testAgentConnection(
        this.deps.agents,
        {
          name: provider,
          command: agent.command,
          cwd: join(dirname(database.path), ".code60_workspace"),
        },
        abort.signal,
      )
        .then(
          () => {
            this.orchestration = { ...this.orchestration, connection: "connected", error: null };
          },
          (error: unknown) => {
            this.orchestration = {
              ...this.orchestration,
              connection: abort.signal.aborted ? "idle" : "failed",
              error: abort.signal.aborted ? null : message(error),
            };
          },
        )
        .finally(() => {
          this.connectionTest = undefined;
          this.changed();
        });
      this.connectionTest = { abort, done };
      return { done };
    });
    await done;
  }

  async cancelOrchestrationTest(): Promise<void> {
    const test = this.connectionTest;
    test?.abort.abort();
    await test?.done;
  }

  async extractMemory(value: MemoryExtractionRequest): Promise<MemoryExtractionResult> {
    const request = parseMemoryExtraction(value);
    const { done } = await this.exclusive(async () => {
      if (this.memoryExtraction) throw new Error("An extraction is already running");
      const workspace = this.requireWorkspace();
      if (workspace.dir !== request.directory)
        throw new Error("The project changed. Run extraction again.");
      const provider = this.orchestration.provider;
      const agent =
        provider && Object.hasOwn(this.config?.agents ?? {}, provider)
          ? this.config?.agents[provider]
          : undefined;
      if (!provider || !agent)
        throw new Error("Select an available orchestration provider in Settings");
      const known = new Set(this.history.map((run) => run.record.id));
      if (request.runs.some((run) => !known.has(run.id)))
        throw new Error("A session is no longer in the open project");
      const abort = new AbortController();
      const live = [...this.events];
      const operation = async (): Promise<MemoryExtractionResult> => {
        const events: RunEvent[] = [];
        for (const run of request.runs) {
          abort.signal.throwIfAborted();
          const saved = await this.mergedEvents(workspace, run.id, live);
          if (saved.length < run.count)
            throw new Error("Events changed or are unavailable. Reload the page and try again.");
          events.push(...saved.slice(0, run.count));
        }
        abort.signal.throwIfAborted();
        const temporary = await mkdtemp(join(tmpdir(), "code60-memory-"));
        const cwd = join(temporary, "private");
        await privateDirectory(cwd);
        try {
          const statements = await extractEpisodicMemory(
            this.deps.agents,
            {
              name: provider,
              command: agent.command,
              cwd,
            },
            events,
            request.prompt,
            abort.signal,
          );
          if (this.workspace !== workspace)
            throw new Error("The project changed during extraction");
          return { statements, eventCount: events.length };
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      };
      const done = operation()
        .catch((error: unknown) => {
          if (abort.signal.aborted) throw new Error("Extraction cancelled");
          throw error;
        })
        .finally(() => {
          this.memoryExtraction = undefined;
        });
      // The IPC caller receives the rejection; also handle it while the exclusive queue yields.
      void done.catch(() => {});
      this.memoryExtraction = { requestId: request.requestId, abort, done };
      return { done };
    });
    return done;
  }

  cancelMemoryExtraction(requestId: string): Promise<void> {
    const id = parseMemoryRequestId(requestId);
    return this.exclusive(() => this.stopMemoryExtraction(id));
  }

  private async stopMemoryExtraction(requestId?: string): Promise<void> {
    const task = this.memoryExtraction;
    if (!task || (requestId !== undefined && task.requestId !== requestId)) return;
    task.abort.abort();
    await task.done.catch(() => {});
  }

  private async mcpAgentServer(session: ChatSession): Promise<AgentMcpServer[]> {
    if (!session.mcpGateway) {
      session.mcpGateway = await createMcpGateway((name, args) =>
        this.closing
          ? Promise.reject(new Error("Code60 is shutting down"))
          : session.revoked
            ? Promise.reject(new Error("This orchestration chat is no longer current"))
            : isMcpControlTool(name)
              ? this.controlTool(name, args, session)
              : readMcpTool(name, args, (table) => this.readMcpTable(table)),
      );
    }
    return [
      {
        name: "code60",
        command: process.execPath,
        args: [fileURLToPath(new URL("./mcp-server.js", import.meta.url))],
        env: [
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          { name: "CODE60_MCP_GATEWAY_URL", value: session.mcpGateway.url },
          { name: "CODE60_MCP_GATEWAY_TOKEN", value: session.mcpGateway.token },
        ],
      },
    ];
  }

  private async closeMcpGateway(session: ChatSession): Promise<void> {
    const gateway = session.mcpGateway;
    session.mcpGateway = undefined;
    await gateway?.close();
  }

  private async readMcpTable(table: McpTable): Promise<readonly McpTableRow[]> {
    const snapshot = this.snapshot(false);
    if (table === "sessions" || table === "messages" || table === "events") {
      const workspace = this.workspace;
      if (!workspace) return [];
      const runs = snapshot.runs;
      const events: [string, RunEvent[]][] = [];
      const live = [...this.events];
      // Limit filesystem concurrency just as the UI transcript reader does.
      for (let offset = 0; offset < runs.length; offset += 4) {
        events.push(
          ...(await Promise.all(
            runs
              .slice(offset, offset + 4)
              .map(
                async (run): Promise<[string, RunEvent[]]> => [
                  run.record.id,
                  await this.mergedEvents(workspace, run.record.id, live),
                ],
              ),
          )),
        );
      }
      if (this.workspace !== workspace)
        throw new Error("Code60 project changed; retry the table read");
      const eventsByRun = new Map(events);
      if (table === "events") {
        return runs.flatMap(({ record }) =>
          (eventsByRun.get(record.id) ?? []).map((event, index) => {
            const { runId: _, at, type, ...details } = event;
            return {
              id: `${record.id}:${index}`,
              at,
              agent: record.agent,
              session: record.id,
              type,
              status:
                event.type === "status" || event.type === "toolCall"
                  ? event.status
                  : event.type === "permission"
                    ? event.decision
                    : event.type === "turnEnd"
                      ? event.stopReason
                      : "",
              update: event.type === "acp" ? event.update : "",
              kind: "kind" in event ? event.kind : "",
              toolCallId: "toolCallId" in event ? event.toolCallId : "",
              // Raw ACP updates keep their own JSON text; MCP clips long text with a marker.
              details:
                event.type === "acp"
                  ? `${event.payload}${event.truncated ? `… [truncated; ${event.size} bytes in full]` : ""}`
                  : JSON.stringify(details),
              ...(event.type === "acp" ? { size: event.size } : {}),
            };
          }),
        );
      }
      if (table === "messages") {
        const rows: McpTableRow[] = [];
        for (const run of runs) {
          let open: McpTableRow | undefined;
          for (const [index, event] of (eventsByRun.get(run.record.id) ?? []).entries()) {
            if (event.type === "message" || event.type === "thought") {
              const kind = event.type === "message" ? "Message" : "Thought";
              if (open?.kind === kind) {
                open.text = `${String(open.text)}${event.text}`;
              } else {
                open = {
                  id: `${run.record.id}:${index}`,
                  at: event.at,
                  agent: run.record.agent,
                  session: run.record.id.slice(-6),
                  kind,
                  text: event.text,
                };
                rows.push(open);
              }
              continue;
            }
            open = undefined;
            if (event.type === "prompt") {
              rows.push({
                id: `${run.record.id}:${index}`,
                at: event.at,
                agent: run.record.agent,
                session: run.record.id.slice(-6),
                kind: "Prompt",
                text: event.text,
              });
            }
          }
        }
        return rows.toSorted((a, b) => String(b.at).localeCompare(String(a.at)));
      }
      return runs.map((run) => {
        const view = run.view;
        return {
          agent: run.record.agent,
          status: view?.status ?? run.record.status,
          turns: view?.turns ?? run.record.turns,
          approvals: view?.pending.length ?? 0,
          id: run.record.id,
          shortId: run.record.id.slice(-6),
          pid: run.record.agentPid ?? null,
          branch: run.record.branch ?? "none",
          startedAt: run.record.startedAt,
          discarded: run.record.discardedAt !== undefined,
          ...mcpSessionMetrics(
            eventsByRun.get(run.record.id) ?? [],
            this.deps.clock.now().getTime(),
          ),
        };
      });
    }
    if (table === "configurations") {
      return this.configurations
        .map((entry) => ({
          name: entry.name,
          provider: [...new Set(entry.settings.agents)].join(", "),
          agents:
            entry.settings.agents.length === 1
              ? Number(entry.settings.parallel ?? 1)
              : entry.settings.agents.length,
          uses: entry.uses,
          lastUsed: entry.lastUsed ?? "Never",
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    }
    if (table === "worktrees") {
      const listing = this.worktrees;
      if (this.workspace && !listing)
        throw new Error(
          "Worktrees have not been loaded. Refresh the Worktrees table in Code60 first.",
        );
      if (!listing?.repository) return [];
      return listing.worktrees.map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch ?? "Detached HEAD",
        createdAt: worktree.createdAt ?? "Unknown",
        repository: listing.repository ?? "",
        sizeBytes: worktree.sizeBytes,
      }));
    }
    return this.poller.snapshot().sources.flatMap((source) => {
      const settings = `${timeSetting(source.setting.intervalMs)} and ${timeSetting(source.setting.idleIntervalMs)}`;
      const latest = source.history.at(-1);
      const sourceRow: McpTableRow = {
        rowType: "source",
        source: pollSourceLabels[source.key],
        status: source.status.charAt(0).toUpperCase() + source.status.slice(1),
        effectiveInterval: timeSetting(source.effectiveIntervalMs),
        settings,
        lastAttempt: source.polledAt ?? "Never",
        lastSuccess: source.succeededAt ?? "Never",
        nextPoll: source.nextAt ?? "Not scheduled",
        failures: source.failures,
        lastResult: latest
          ? `${latest.ok ? "Success" : "Failed"}, ${latest.trigger}, ${latest.durationMs} ms`
          : "None yet",
        recentDurationMs: latest?.durationMs ?? null,
      };
      const resultRows = source.history.toReversed().map(
        (result): McpTableRow => ({
          rowType: "result",
          source: pollSourceLabels[source.key],
          status: result.ok ? "Success" : "Failed",
          trigger: result.trigger,
          at: result.at,
          durationMs: result.durationMs,
          error: result.error ?? "",
        }),
      );
      return [sourceRow, ...resultRows];
    });
  }

  /** Recorded events plus live events not yet written to the event log. */
  private async mergedEvents(
    workspace: Workspace,
    runId: string,
    live: readonly SequencedEvent[] = this.events,
  ): Promise<RunEvent[]> {
    const disk = await workspace.store.readEvents(runId);
    const counts = new Map<string, number>();
    for (const event of disk) {
      const key = JSON.stringify(event);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const entry of live) {
      if (entry.event.runId !== runId) continue;
      const key = JSON.stringify(entry.event);
      const count = counts.get(key) ?? 0;
      if (count > 0) counts.set(key, count - 1);
      else disk.push(entry.event);
    }
    return disk;
  }

  /** Provider/database changes replace all chats; switching projects leaves them alive. */
  private async syncOrchestrationChat(restart = false): Promise<void> {
    const provider = this.orchestration.provider;
    const agent = provider ? this.config?.agents[provider] : undefined;
    const key = JSON.stringify([this.database?.path, provider, agent?.command]);
    if (!restart && key === this.chatKey) return;
    if (restart) {
      const previous = this.currentChat;
      await this.disposeChat(previous);
      this.currentChat = new ChatSession(++this.chatGeneration);
      this.chats.splice(this.chats.indexOf(previous), 1, this.currentChat);
    } else {
      await Promise.all(this.chats.map((session) => this.disposeChat(session)));
      this.currentChat = new ChatSession(++this.chatGeneration);
      this.chats = [this.currentChat];
    }
    this.chatKey = key;
    await this.startChat(this.currentChat);
  }

  private async disposeChat(session: ChatSession): Promise<void> {
    // Revoke capabilities before stopping the process, including queued gateway requests.
    session.revoked = true;
    session.workerScope = randomUUID();
    await this.closeMcpGateway(session);
    await session.chat?.shutdown(this.forceClosing);
    for (const dispose of session.chatDisposers) dispose();
    session.chatDisposers = [];
    session.inbox = [];
    session.dispatches.clear();
  }

  private async startChat(session: ChatSession): Promise<void> {
    const provider = this.orchestration.provider;
    const config = this.config;
    if (!this.database || !provider || !config) {
      this.changed();
      return;
    }
    if (!Object.hasOwn(config.agents, provider)) {
      session.chatError = `Unavailable orchestration provider: ${provider}`;
      this.changed();
      return;
    }
    // Paths are generated by the main process, never accepted from the renderer or agent.
    const directory = join(dirname(this.database.path), ".code60_workspace", randomUUID());
    session.chatDirectory = directory;
    try {
      const mcpServers = await this.mcpAgentServer(session);
      const chat = await prepareOrchestrationChat(this.deps, directory, provider, config, {
        mcpServers,
        promptContext: () =>
          effectivePrompts(this.config?.prompts ?? DEFAULT_PROMPT_TEMPLATES, this.savedPrompts)
            .operatingContract,
      });
      if (this.closing) {
        await chat.shutdown(this.forceClosing);
        await this.closeMcpGateway(session);
        return;
      }
      session.chat = chat;
      const gateway = session.mcpGateway;
      void chat.done
        .then(async () => {
          await gateway?.close();
          if (session.mcpGateway === gateway) session.mcpGateway = undefined;
        })
        .catch(() => {});
      session.chatDisposers = [
        chat.onEvent((event) => {
          this.changed();
          const entry = { revision: this.revision, event };
          session.chatEvents.push(entry);
          session.chatPending.push(entry);
          if (event.type === "status" && event.status === "idle") this.scheduleUpdates();
        }),
        chat.onChange(() => this.changed()),
        chat.onWarning((warning) => {
          session.chatError = warning;
          this.changed();
        }),
      ];
      chat.start();
    } catch (error) {
      await this.closeMcpGateway(session);
      session.chatError = message(error);
    }
    this.changed();
  }
  orchestrationChatAction(value: OrchestrationChatAction): Promise<void> {
    const request = parseOrchestrationChatAction(value);
    return this.exclusive(async () => {
      if (request.type === "new") {
        if (!this.database) throw new Error("Connect to a database first");
        const provider = this.orchestration.provider;
        if (!provider || !Object.hasOwn(this.config?.agents ?? {}, provider))
          throw new Error("Select an available orchestration provider");
        const session = new ChatSession(++this.chatGeneration);
        this.chats.push(session);
        this.currentChat = session;
        await this.startChat(session);
        return;
      }
      const session =
        request.id === null
          ? this.currentChat
          : this.chats.find((entry) => entry.chat?.runs()[0]?.id === request.id);
      const run = session?.chat?.runs()[0];
      if (!session || request.id !== (run?.id ?? null))
        throw new Error("This orchestration chat is no longer current");
      if (request.type === "select") {
        this.currentChat = session;
      } else if (request.type === "resume-updates") {
        session.updatesPaused = false;
        this.scheduleUpdates();
      } else if (request.type === "restart") {
        if (!this.database) throw new Error("Connect to a database first");
        if (!this.orchestration.provider) throw new Error("Select an orchestration provider");
        this.currentChat = session;
        await this.syncOrchestrationChat(true);
      } else if (!session.chat || !run) throw new Error("No orchestration session is available");
      else if (request.type === "send") {
        session.chat.reply(run.id, request.text);
        session.updatesPaused = false;
      } else if (request.type === "cancel") {
        session.updatesPaused = true;
        if (!session.chat.cancelTurn(run.id)) throw new Error("No turn is in progress");
      } else {
        session.updatesPaused = true;
        await session.chat.shutdown();
      }
      this.changed();
    });
  }
  get hasActiveWork(): boolean {
    return (
      this.active ||
      this.chats.some((session) =>
        session.chat?.runs().some((run) => ["queued", "running", "waiting"].includes(run.status)),
      )
    );
  }

  get active(): boolean {
    return [...this.batches.values()].some((batch) => batch.active);
  }

  get connected(): boolean {
    return this.database !== undefined;
  }

  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(allEvents = true): Snapshot {
    const views = new Map(
      [...this.batches.keys()].flatMap((batch) =>
        batch.runs().map((view) => [view.id, view] as const),
      ),
    );
    const session = this.currentChat;
    const chatSnapshot = (session: ChatSession) => ({
      workers: [...this.workers]
        .filter(
          ([, worker]) =>
            worker.generation === session.chatGeneration &&
            worker.directory === this.workspace?.dir,
        )
        .map(([id]) => id),
      run: session.chat?.runs()[0] ?? null,
      directory: session.chatDirectory,
      error: session.chatError,
      events: [...(allEvents ? session.chatEvents : session.chatPending)],
      updates: { paused: session.updatesPaused, pending: session.inbox.length },
    });
    return {
      versions: {
        code60: CODE60_VERSION,
        databaseSchema: SCHEMA,
        runRecordFormat: RUN_RECORD_FORMAT,
        acpProtocol: ACP_PROTOCOL_VERSION,
        mcpProtocol: MCP_PROTOCOL_VERSION,
        electron: process.versions.electron ?? null,
        chromium: process.versions.chrome ?? null,
        node: process.versions.node,
      },
      chat: chatSnapshot(session),
      chats: this.chats.map(chatSnapshot),
      workers: [...this.workers.keys()],
      orchestration: { ...this.orchestration },
      revision: this.revision,
      database: this.database?.path ?? null,
      databaseError: this.databaseError,
      projects: [...this.projects],
      configurations: structuredClone(this.configurations),
      directory: this.workspace?.dir ?? null,
      agents: Object.keys(this.config?.agents ?? {}),
      defaultAgent: this.config?.defaultAgent ?? "",
      maxParallel: this.config?.maxParallel ?? 4,
      turnTimeout: this.config?.turnTimeout ?? "30m",
      runs: this.history.map((run) => {
        const view = views.get(run.record.id);
        return view === undefined
          ? run
          : {
              ...run,
              record: {
                ...run.record,
                status: view.status,
                turns: view.turns,
                ...(view.reason === undefined ? {} : { reason: view.reason }),
              },
              view,
            };
      }),
      liveIds: [...views.keys()],
      active: this.active,
      warnings: [...this.warnings],
      events: [...(allEvents ? this.events : this.pending)],
      worktrees: structuredClone(this.worktrees),
      files: this.files,
      polling: this.poller.snapshot(),
      prompts: promptStates(this.config?.prompts ?? DEFAULT_PROMPT_TEMPLATES, this.savedPrompts),
    };
  }

  private changed(): void {
    this.revision += 1;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const snapshot = this.snapshot(false);
      this.pending = [];
      for (const session of this.chats) session.chatPending = [];
      for (const listener of this.listeners) listener(snapshot);
    }, 40);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closing) throw new Error("The app is stopping");
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  /** Reconnects to the database remembered from the previous launch, if any. */
  restore(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const provider = (await this.storage.preferences.orchestrationProvider?.()) ?? null;
        this.orchestration = {
          provider: parseOrchestrationProvider(provider),
          allowAll: true,
          connection: "idle",
          error: null,
        };
      } catch {
        this.warnings.push("Could not read the saved orchestration provider.");
      }
      try {
        const overrides = (await this.storage.preferences.polling?.()) ?? {};
        this.poller.configure(overrides);
        this.pollOverrides = overrides;
      } catch {
        this.warnings.push("Invalid saved polling settings. Using defaults.");
      }
      try {
        this.config = await loadConfig(this.deps.fs, this.env);
      } catch (error) {
        this.warnings.push(message(error));
      }
      let path: string | undefined;
      try {
        path = await this.storage.preferences.read();
      } catch (error) {
        this.databaseError = `Could not read the saved database setting: ${message(error)}`;
      }
      if (path !== undefined) {
        try {
          const database = this.storage.openDatabase(path, false);
          this.attach(database);
        } catch (error) {
          this.databaseError = `Could not reconnect to the saved database. ${message(error)}`;
        }
      }
      await this.syncOrchestrationChat();
      this.changed();
      this.poller.context(this.active);
    });
  }

  /** Connects to another database. On failure the current connection stays in use. */
  connect(path: string, create: boolean): Promise<void> {
    return this.exclusive(async () => {
      if (this.active) throw new Error("Finish or stop all runs before switching databases");
      await this.cancelOrchestrationTest();
      await this.stopMemoryExtraction();
      this.orchestration = { ...this.orchestration, connection: "idle", error: null };
      const config = await loadConfig(this.deps.fs, this.env);
      const database = this.storage.openDatabase(path, create);
      try {
        await this.storage.preferences.write(database.path);
      } catch (error) {
        database.close();
        throw new Error(`Could not remember the database: ${message(error)}`);
      }
      const previous = this.database;
      try {
        this.attach(database);
      } catch (error) {
        database.close();
        throw error;
      }
      previous?.close();
      this.config = config;
      if (previous?.path !== database.path) {
        this.clearWorkspace();
        this.savedPrompts = this.readPrompts(database);
      }
      await this.syncOrchestrationChat();
      this.changed();
    });
  }

  /** Opens a folder chosen by the user and adds it to the project history. */
  open(directory: string): Promise<void> {
    return this.exclusive(() => this.openDirectory(directory));
  }

  /** Opens a folder only if it is already in the connected database's history. */
  openProject(path: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.projects.some((project) => project.path === path))
        throw new Error("This project is not in the database's history");
      await this.openDirectory(path);
    });
  }

  /** Removes a project from the history. Its folder and run records are not touched. */
  removeProject(path: string): Promise<void> {
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      if (!this.projects.some((project) => project.path === path))
        throw new Error("This project is not in the database's history");
      database.remove(path);
      this.projects = database.list();
      this.changed();
    });
  }

  /** Clears the whole project history after confirmation. Resolves false when declined. */
  clearProjects(): Promise<boolean> {
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      if (this.projects.length === 0) return true;
      const confirmed = await this.dialogs.confirm(
        "Clear project history?",
        `This removes all ${this.projects.length} projects from ${database.path}. Project folders and their runs are not affected.`,
      );
      if (!confirmed) return false;
      database.clear();
      this.projects = database.list();
      this.changed();
      return true;
    });
  }

  private requireDatabase(): ProjectDatabase {
    if (this.database === undefined) throw new Error("Connect to a database first");
    return this.database;
  }

  private async openDirectory(directory: string): Promise<void> {
    await this.stopMemoryExtraction();
    const database = this.requireDatabase();
    if (this.active) throw new Error("Finish or stop all runs before switching folders");
    let dir: string;
    try {
      dir = await realpath(directory);
      if (!(await stat(dir)).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new Error(`This folder is not available: ${directory}`);
    }
    const config = await loadConfig(this.deps.fs, this.env);
    const workspace = await openWorkspace(this.deps, dir, this.env);
    const history = await listRuns(commandDeps(this.deps, workspace));
    this.clearWorkspace();
    this.workspace = workspace;
    this.config = config;
    this.history = history;
    this.poller.context(this.active);
    try {
      database.record(workspace.dir, this.deps.clock.now().toISOString());
      this.projects = database.list();
    } catch (error) {
      this.warnings.push(`Could not save this project to the database: ${message(error)}`);
    }
    this.changed();
  }

  private attach(database: ProjectDatabase): void {
    const projects = database.list();
    const configurations = database.configurations();
    const prompts = this.readPrompts(database);
    this.projects = projects;
    this.configurations = configurations;
    this.savedPrompts = prompts;
    this.database = database;
    this.databaseError = null;
    this.poller.invalidate(["configurations"]);
  }

  private clearWorkspace(): void {
    this.detach();
    this.workspace = undefined;
    for (const session of this.chats) session.workerScope = randomUUID();
    this.worktrees = null;
    this.fileContext = null;
    this.files = null;
    this.poller.invalidate(["history", "worktrees", "files"]);
    this.history = [];
    this.batches.clear();
    this.events = [];
    this.pending = [];
    this.warnings = [];
    this.launches.clear();
  }

  saveConfiguration(request: SaveConfiguration): Promise<void> {
    request = parseSaveConfiguration(request);
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      const existing = request.id
        ? this.configurations.find((entry) => entry.id === request.id)
        : undefined;
      if (request.id && !existing) throw new Error("Unknown run configuration");
      const launch = request.launchId ? this.launches.get(request.launchId) : undefined;
      if (request.launchId && !launch) throw new Error("This launch is no longer available");
      if (launch?.saved) throw new Error("This launch was already saved as a run configuration");
      const settings = parseRunSettings(launch?.settings ?? request.settings);
      const config = await loadConfig(this.deps.fs, this.env);
      if (!launch) {
        for (const name of settings.agents) {
          if (!Object.hasOwn(config.agents, name)) throw new Error(`Unavailable provider: ${name}`);
        }
      }
      const resolved: RunSettings = {
        ...settings,
        parallel:
          settings.parallel ?? String(settings.agents.length === 1 ? 1 : config.maxParallel),
        turnTimeout: settings.turnTimeout ?? config.turnTimeout,
      };
      database.saveConfiguration({
        id: existing?.id ?? randomUUID(),
        name: request.name,
        settings: resolved,
        uses: existing?.uses ?? (launch ? 1 : 0),
        lastUsed: existing?.lastUsed ?? launch?.at ?? null,
      });
      if (launch) launch.saved = true;
      this.configurations = database.configurations();
      void this.poller.poll("configurations", "change").catch(() => {});
      this.changed();
    });
  }

  deleteConfiguration(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      const entry = this.configurations.find((item) => item.id === id);
      if (!entry) throw new Error("Unknown run configuration");
      if (
        !(await this.dialogs.confirm(
          "Delete run configuration?",
          `Delete "${entry.name}"? Existing sessions are not affected.`,
        ))
      )
        return false;
      database.deleteConfiguration(id);
      this.configurations = database.configurations();
      void this.poller.poll("configurations", "change").catch(() => {});
      this.changed();
      return true;
    });
  }

  private readPrompts(database: ProjectDatabase): Partial<PromptTemplates> {
    const saved = database.promptTemplates();
    for (const warning of saved.skipped) {
      if (!this.warnings.includes(warning)) this.warnings.push(warning);
    }
    const stale =
      "The saved Operating Contract edit still tells the orchestrator not to start or control agent runs. Reset or edit it in Prompt Editor so it can use the worker tools.";
    if (saved.templates.operatingContract?.includes(STALE_CONTRACT)) {
      if (!this.warnings.includes(stale)) this.warnings.push(stale);
    } else this.warnings = this.warnings.filter((warning) => warning !== stale);
    return saved.templates;
  }

  /** Saves a template edit for future orchestration turns or handoffs. */
  async savePromptTemplate(request: SavePromptTemplate): Promise<void> {
    request = parseSavePromptTemplate(request);
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      database.savePromptTemplate(
        request.id,
        request.template,
        this.deps.clock.now().toISOString(),
      );
      this.savedPrompts = this.readPrompts(database);
      this.changed();
    });
  }

  /** Removes a saved template edit after confirmation. Resolves false when declined. */
  async resetPromptTemplate(id: PromptId): Promise<boolean> {
    id = parsePromptTemplateId(id);
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      if (this.savedPrompts[id] === undefined) return true;
      const restores =
        promptStates(this.config?.prompts ?? DEFAULT_PROMPT_TEMPLATES, {}).find(
          (state) => state.id === id,
        )?.fallbackSource === "config"
          ? "the template from config.json"
          : "the built-in template";
      if (
        !(await this.dialogs.confirm(
          "Reset prompt template?",
          `Remove the saved ${id} edit from ${database.path}? Future uses of this template use ${restores}. Turns already in progress are not affected.`,
        ))
      )
        return false;
      database.deletePromptTemplate(id);
      this.savedPrompts = this.readPrompts(database);
      this.changed();
      return true;
    });
  }

  private publishEvent(event: RunEvent): void {
    this.changed();
    const entry = { revision: this.revision, event };
    this.events.push(entry);
    this.pending.push(entry);
    this.trackWorker(event);
  }

  private publishPriorEvents(runId: string, events: readonly RunEvent[]): void {
    const existing = new Map<string, number>();
    for (const entry of this.events) {
      if (entry.event.runId !== runId) continue;
      const key = JSON.stringify(entry.event);
      existing.set(key, (existing.get(key) ?? 0) + 1);
    }
    for (const event of events) {
      const key = JSON.stringify(event);
      const count = existing.get(key) ?? 0;
      if (count > 0) existing.set(key, count - 1);
      else this.publishEvent(event);
    }
  }

  private activateBatch(orchestrator: Orchestrator, workspace: Workspace): void {
    const batch: Batch = {
      active: true,
      disposers: [
        orchestrator.onEvent((event) => this.publishEvent(event)),
        orchestrator.onChange(() => this.changed()),
        orchestrator.onWarning((warning) => {
          this.warnings.push(warning);
          this.changed();
        }),
      ],
    };
    this.batches.set(orchestrator, batch);
    this.poller.context(this.active);
    this.changed();
    void orchestrator.done.then(() => {
      batch.active = false;
      this.poller.context(this.active);
      for (const dispose of batch.disposers) dispose();
      batch.disposers = [];
      this.changed();
      if (!this.closing && this.workspace === workspace)
        void this.poller.poll("history", "change").catch((error: unknown) => {
          this.warnings.push(message(error));
          this.changed();
        });
    });
  }

  private async recoverableRun(workspace: Workspace, id: string): Promise<DesktopRun> {
    if (!this.history.some((run) => run.record.id === id))
      throw new Error("Unknown run in this workspace");
    const batch = this.liveBatch(id);
    const view = batch?.runs().find((run) => run.id === id);
    if (view && !ACTIVE_STATUSES.has(view.status)) await batch?.settled(id);
    this.history = await listRuns(commandDeps(this.deps, workspace));
    const run = this.history.find((entry) => entry.record.id === id);
    if (!run) throw new Error("Unknown run in this workspace");
    if (ACTIVE_STATUSES.has(run.record.status))
      throw new Error(`run ${id} is ${run.record.status}; active runs cannot be recovered`);
    if (run.agentAlive) {
      throw new Error(
        `the leftover agent for run ${id} is still alive (process group ${run.record.agentPid}); stop it before retrying`,
      );
    }
    return run;
  }

  /** Restores the run's ACP session and sends the message, or hands off to a fresh session. */
  private async continueRun(
    workspace: Workspace,
    id: string,
    text: string,
  ): Promise<RecoveryActionResult> {
    const restored = await this.resumeRun(workspace, id);
    if (restored.type === "handoff-required")
      return this.handoffRun(workspace, id, text, restored.reason);
    restored.orchestrator.reply(id, text);
    this.changed();
    return { type: "restored" };
  }

  private async resumeRun(
    workspace: Workspace,
    id: string,
  ): Promise<
    | { type: "restored"; orchestrator: Orchestrator }
    | Extract<RecoveryResult, { type: "handoff-required" }>
  > {
    const run = await this.recoverableRun(workspace, id);
    if (!run.record.acpSessionId) {
      return {
        type: "handoff-required",
        reason: "This run has no saved ACP session ID to restore.",
      };
    }
    let prepared: Awaited<ReturnType<typeof prepareRecovery>>;
    try {
      prepared = await prepareRecovery(
        this.deps,
        workspace,
        run.record,
        this.env,
        {},
        this.workerOverrides(id),
      );
    } catch (error) {
      if (
        error instanceof RefusedError &&
        (error.message.includes("still alive") || error.message.includes("only ended"))
      )
        throw error;
      return { type: "handoff-required", reason: message(error) };
    }
    const priorEvents = await workspace.store.readEvents(id);
    const emitted: RunEvent[] = [];
    const off = prepared.orchestrator.onEvent((event) => emitted.push(event));
    let result: RecoveryResult;
    try {
      result = await prepared.orchestrator.restore(id);
    } catch (error) {
      off();
      throw error;
    }
    off();
    if (result.type === "handoff-required") return result;
    if (this.closing) {
      await prepared.orchestrator.shutdown(this.forceClosing);
      throw new Error("The app is stopping");
    }
    this.publishPriorEvents(id, priorEvents);
    for (const event of emitted) this.publishEvent(event);
    this.activateBatch(prepared.orchestrator, workspace);
    try {
      this.history = await listRuns(commandDeps(this.deps, workspace));
    } catch (error) {
      this.warnings.push(message(error));
    }
    this.changed();
    return { type: "restored", orchestrator: prepared.orchestrator };
  }

  private async handoffRun(
    workspace: Workspace,
    id: string,
    text: string,
    reason: string,
  ): Promise<RecoveryActionResult> {
    const run = await this.recoverableRun(workspace, id);
    const priorEvents = await workspace.store.readEvents(id);
    const saved = { ...this.savedPrompts };
    const prepared = await prepareRecovery(
      this.deps,
      workspace,
      run.record,
      this.env,
      saved,
      this.workerOverrides(id),
    );
    const summary = buildHandoffPrompt(
      run.record,
      priorEvents,
      effectivePrompts(prepared.config.prompts, saved).handoffSummary,
    );
    const emitted: RunEvent[] = [];
    const off = prepared.orchestrator.onEvent((event) => emitted.push(event));
    try {
      await prepared.orchestrator.handoff(id, summary, text, reason);
    } catch (error) {
      off();
      throw error;
    }
    off();
    if (this.closing) {
      await prepared.orchestrator.shutdown(this.forceClosing);
      throw new Error("The app is stopping");
    }
    this.publishPriorEvents(id, priorEvents);
    for (const event of emitted) this.publishEvent(event);
    this.activateBatch(prepared.orchestrator, workspace);
    try {
      this.history = await listRuns(commandDeps(this.deps, workspace));
    } catch (error) {
      this.warnings.push(message(error));
    }
    this.changed();
    return { type: "handoff-started" };
  }

  /** Returns only the new run IDs, or an empty list when confirmation is declined. */
  start(request: StartRequest): Promise<string[]> {
    return this.exclusive(() => this.startBatch(request));
  }

  /** `register` sees the new run IDs before any of them starts. */
  private async startBatch(
    request: StartRequest,
    register?: (ids: string[], workspace: Workspace) => void,
  ): Promise<string[]> {
    const workspace = this.requireWorkspace();
    const configuration = request.configurationId
      ? this.configurations.find((entry) => entry.id === request.configurationId)
      : undefined;
    if (request.configurationId && !configuration) throw new Error("Unknown run configuration");
    const { configurationId: _configurationId, prompt: _prompt, ...options } = request;
    const settings = parseRunSettings(options);
    const prepared = await prepareRuns(this.deps, {
      ...request,
      cwd: workspace.dir,
      env: this.env,
      mode: "interactive",
    });
    const orchestrator = prepared.orchestrator;
    let warning: string | undefined;
    if (prepared.noWorktree !== undefined) {
      const chatSharing = (
        await Promise.all(
          this.chats.map(async (session) => {
            const chatRun = session.chat?.runs()[0];
            return (
              chatRun &&
              ACTIVE_STATUSES.has(chatRun.status) &&
              (await realpath(chatRun.worktree).catch(() => null)) === workspace.dir
            );
          }),
        )
      ).some(Boolean);
      const sharing =
        this.snapshot().runs.some(
          (run) =>
            run.record.base === null &&
            run.record.worktree === workspace.dir &&
            ["queued", "running", "waiting", "idle"].includes(
              run.view?.status ?? run.record.status,
            ),
        ) || chatSharing === true;
      warning = `Agents will work directly in ${workspace.dir}, without isolated worktrees. Diff and discard are unavailable. ${
        sharing
          ? "New runs share this directory with existing live sessions and can overwrite each other's changes."
          : orchestrator.runs().length > 1
            ? "All runs share this directory and can overwrite each other's changes."
            : ""
      }`;
      let confirmed: boolean;
      try {
        confirmed = await this.dialogs.confirm("Run without worktrees?", warning);
      } catch (error) {
        await orchestrator.shutdown(this.forceClosing);
        throw error;
      }
      if (!confirmed) {
        await orchestrator.shutdown(this.forceClosing);
        this.history = await listRuns(commandDeps(this.deps, workspace));
        this.changed();
        return [];
      }
    }
    // Shutdown may have begun while preparation or the native confirmation was pending.
    if (this.closing) {
      await orchestrator.shutdown(this.forceClosing);
      throw new Error("The app is stopping");
    }
    let history: DesktopRun[];
    try {
      history = await listRuns(commandDeps(this.deps, workspace));
    } catch (error) {
      await orchestrator.shutdown(this.forceClosing);
      throw error;
    }
    if (this.closing) {
      await orchestrator.shutdown(this.forceClosing);
      throw new Error("The app is stopping");
    }
    if (warning !== undefined) this.warnings.push(warning);
    this.config = prepared.config;
    this.history = history;
    this.activateBatch(orchestrator, workspace);
    register?.(
      orchestrator.runs().map((run) => run.id),
      workspace,
    );
    orchestrator.start();
    const ids = orchestrator.runs().map((run) => run.id);
    const at = this.deps.clock.now().toISOString();
    if (ids[0])
      this.launches.set(ids[0], {
        settings: {
          ...settings,
          parallel:
            settings.parallel ??
            String(settings.agents.length === 1 ? 1 : prepared.config.maxParallel),
          turnTimeout: settings.turnTimeout ?? prepared.config.turnTimeout,
        },
        at,
        saved: false,
      });
    if (configuration) {
      try {
        this.requireDatabase().useConfiguration(configuration.id, at);
        this.configurations = this.requireDatabase().configurations();
        void this.poller.poll("configurations", "change").catch(() => {});
      } catch {
        this.warnings.push(
          "Agents started, but run configuration usage could not be saved. Do not start the batch again.",
        );
      }
      this.changed();
    }
    return ids;
  }

  action(action: Action): Promise<ActionResult> {
    return this.exclusive(async () => {
      const workspace = this.requireWorkspace();
      const cmd = commandDeps(this.deps, workspace);
      const orchestrator = [...this.batches.entries()]
        .reverse()
        .find(
          ([batch, state]) =>
            state.active &&
            batch
              .runs()
              .some((run) =>
                action.type === "permission"
                  ? run.pending.some((permission) => permission.id === action.id)
                  : run.id === action.id,
              ),
        )?.[0];
      if (action.type === "permission") {
        if (!orchestrator?.answerPermission(action.id, action.answer))
          throw new Error("This approval request is no longer pending");
        return;
      }
      if (!this.history.some((run) => run.record.id === action.id))
        throw new Error("Unknown run in this workspace");
      if (action.type === "continue") return this.continueRun(workspace, action.id, action.text);
      switch (action.type) {
        case "events":
          return workspace.store.readEvents(action.id);
        case "diff":
          return diffRun(cmd, action.id);
        case "discard":
          await discardRun(
            cmd,
            workspace.repo?.topLevel ?? workspace.dir,
            action.id,
            async (files, record) =>
              this.dialogs.confirm(
                "Discard this worktree?",
                `This permanently removes ${record.worktree} and ${record.branch}.\n\nFiles that will be lost:\n${files.map((file) => `${file.status} ${file.path}`).join("\n") || "(no changed files)"}`,
              ),
          );
          this.history = await listRuns(cmd);
          break;
        case "stop":
          await stopRun(cmd, action.id);
          this.history = await listRuns(cmd);
          break;
        default:
          if (!orchestrator?.runs().some((run) => run.id === action.id))
            throw new Error("This run is not controlled by this app");
          if (action.type === "reply") orchestrator.reply(action.id, action.text);
          else if (action.type === "finish") orchestrator.finish(action.id);
          else if (!orchestrator.cancelTurn(action.id)) throw new Error("No turn is in progress");
      }
      this.changed();
    });
  }

  /** Orchestrated workers keep their fixed allow-all policy through restore and handoff. */
  private workerOverrides(id: string) {
    return this.workers.has(id) ? { allow: [], allowAll: true } : undefined;
  }

  private liveBatch(id: string): Orchestrator | undefined {
    return [...this.batches.entries()]
      .reverse()
      .find(([batch, state]) => state.active && batch.runs().some((run) => run.id === id))?.[0];
  }

  private liveView(id: string): RunView | undefined {
    for (const batch of [...this.batches.keys()].reverse()) {
      const view = batch.runs().find((run) => run.id === id);
      if (view) return view;
    }
    return undefined;
  }

  /** Queues one update per ended or failed worker turn; streamed chunks never wake the chat. */
  private trackWorker(event: RunEvent): void {
    const worker = this.workers.get(event.runId);
    if (!worker) return;
    if (event.type === "prompt") {
      worker.reply = "";
      return;
    }
    if (event.type === "message") {
      worker.reply = `${worker.reply}${event.text}`.slice(-MCP_CONTROL_LIMITS.excerpt);
      return;
    }
    const session = this.chats.find((session) => session.chatGeneration === worker.generation);
    if (event.type !== "status" || !session) return;
    const view = this.liveView(event.runId);
    const turn = view?.turns ?? worker.reportedTurn;
    const ended = !ACTIVE_STATUSES.has(event.status);
    const turnEnded = event.status === "idle" ? event.reason?.startsWith("turn ") === true : ended;
    const exited = ended && event.reason === "the agent exited while idle";
    if (!(turnEnded && turn > worker.reportedTurn) && !exited) return;
    worker.reportedTurn = turn;
    session.inbox.push({
      runId: event.runId,
      provider: worker.provider,
      status: event.status,
      turn,
      ...(view?.lastStopReason === undefined ? {} : { stopReason: view.lastStopReason }),
      ...(ended && event.reason !== undefined ? { reason: event.reason } : {}),
      excerpt: worker.reply,
    });
    this.scheduleUpdates();
  }

  private scheduleUpdates(): void {
    if (this.updateTimer !== undefined || this.closing) return;
    // A short delay coalesces several workers ending together into one prompt.
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      for (const session of this.chats) this.deliverUpdates(session);
    }, 50);
  }

  /** Sends queued worker updates only between the chat's turns, never overlapping a prompt. */
  private deliverUpdates(session: ChatSession): void {
    if (this.closing || session.updatesPaused || session.inbox.length === 0) return;
    const chat = session.chat;
    const run = chat?.runs()[0];
    if (!chat || !run || run.status !== "idle" || run.stopping) return;
    const updates = session.inbox.slice(0, UPDATE_BATCH);
    const template = effectivePrompts(
      this.config?.prompts ?? DEFAULT_PROMPT_TEMPLATES,
      this.savedPrompts,
    ).workerUpdates;
    try {
      chat.reply(
        run.id,
        renderPrompt("workerUpdates", template, {
          updates: updates.map(formatWorkerUpdate).join("\n"),
        }),
        "automatic",
      );
      session.inbox.splice(0, updates.length);
    } catch (error) {
      session.chatError = `Could not send worker updates: ${message(error)}`;
    }
    this.changed();
  }

  private requireScope(scope: string, session: ChatSession): Workspace {
    const workspace = this.workspace;
    if (!workspace) throw new Error("Open a project in Code60 before dispatching workers");
    if (scope !== session.workerScope)
      throw new Error("The scope token is stale; call code60_get_context again");
    return workspace;
  }

  private ownedWorker(id: string, session: ChatSession): Worker {
    const worker = this.workers.get(id);
    if (
      !worker ||
      worker.generation !== session.chatGeneration ||
      worker.directory !== this.workspace?.dir
    )
      throw new Error("No worker with this ID was dispatched by this chat in the open project");
    return worker;
  }

  private liveWorkerCount(session: ChatSession): number {
    let count = 0;
    for (const [id, worker] of this.workers) {
      const status = this.liveView(id)?.status;
      if (worker.generation === session.chatGeneration && status && ACTIVE_STATUSES.has(status))
        count++;
    }
    return count;
  }

  private async assertCapacity(session: ChatSession): Promise<void> {
    const config = this.config ?? (await loadConfig(this.deps.fs, this.env));
    if (this.liveWorkerCount(session) >= config.maxParallel)
      throw new Error(
        `All ${config.maxParallel} worker slots are in use. Finish or stop an idle worker first.`,
      );
  }

  private workerInfo(id: string) {
    const worker = this.workers.get(id) as Worker;
    const listed = this.history.find((run) => run.record.id === id);
    const view = this.liveView(id);
    const status = view?.status ?? listed?.record.status ?? "queued";
    const live = view !== undefined && ACTIVE_STATUSES.has(status) && !view.stopping;
    const agentAlive = listed?.agentAlive === true;
    const discarded = listed?.record.discardedAt !== undefined;
    const actions = live
      ? status === "idle"
        ? ["send", "finish", "stop"]
        : status === "queued"
          ? ["stop"]
          : ["cancel", "stop"]
      : view?.stopping
        ? []
        : agentAlive
          ? ["stop"]
          : discarded
            ? []
            : ["resume"];
    const reason = view?.reason ?? listed?.record.reason;
    const stopReason = view?.lastStopReason ?? listed?.record.lastStopReason;
    return {
      runId: id,
      provider: worker.provider,
      status,
      ...(reason === undefined ? {} : { reason }),
      turns: view?.turns ?? listed?.record.turns ?? 0,
      ...(stopReason === undefined ? {} : { lastStopReason: stopReason }),
      stopping: view?.stopping === true,
      branch: listed?.record.branch ?? view?.branch ?? null,
      worktree: listed?.record.worktree ?? view?.worktree ?? "",
      startedAt: listed?.record.startedAt ?? null,
      agentAlive,
      discarded,
      actions,
    };
  }

  /** Runs one worker tool for the current chat. Every change is serialized and scope-checked. */
  private chatExclusive<T>(session: ChatSession, operation: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      if (session.revoked) throw new Error("This orchestration chat is no longer current");
      return operation();
    });
  }

  private controlTool(name: McpControlTool, args: unknown, session: ChatSession): Promise<unknown> {
    switch (name) {
      case "code60_get_context":
        parseControlArgs(name, args);
        return this.chatExclusive(session, async () => {
          const config = this.config ?? (await loadConfig(this.deps.fs, this.env));
          const workspace = this.workspace;
          return {
            project: workspace?.dir ?? null,
            scope: workspace ? session.workerScope : null,
            gitRepository: workspace ? workspace.repo !== null : null,
            providers: Object.keys(config.agents),
            defaultProvider: config.defaultAgent,
            turnTimeout: config.turnTimeout,
            maxParallel: config.maxParallel,
            liveWorkers: this.liveWorkerCount(session),
            updatesPaused: session.updatesPaused,
          };
        });
      case "code60_dispatch_agent":
        return this.dispatchWorker(parseControlArgs(name, args), session);
      case "code60_list_agents":
        parseControlArgs(name, args);
        return this.chatExclusive(session, async () => {
          const directory = this.workspace?.dir;
          return {
            project: directory ?? null,
            workers: [...this.workers]
              .filter(
                ([, worker]) =>
                  worker.generation === session.chatGeneration && worker.directory === directory,
              )
              .reverse()
              .map(([id]) => this.workerInfo(id)),
          };
        });
      case "code60_read_agent": {
        const request = parseControlArgs(name, args);
        return this.chatExclusive(session, async () => {
          this.ownedWorker(request.runId, session);
          const workspace = this.requireWorkspace();
          const entries = workerTranscript(await this.mergedEvents(workspace, request.runId));
          const limit = request.limit ?? 50;
          const cursor = request.tail
            ? Math.max(0, entries.length - limit)
            : Math.min(request.cursor ?? 0, entries.length);
          const page = entries.slice(cursor, cursor + limit);
          return {
            worker: this.workerInfo(request.runId),
            cursor,
            total: entries.length,
            nextCursor: cursor + page.length < entries.length ? cursor + page.length : null,
            entries: page,
          };
        });
      }
      default:
        return this.controlWorker(name, parseControlArgs(name, args), session);
    }
  }

  private dispatchWorker(
    request: ControlArgs<"code60_dispatch_agent">,
    session: ChatSession,
  ): Promise<unknown> {
    const { requestId, ...settings } = request;
    const key = JSON.stringify(settings);
    const previous = session.dispatches.get(requestId);
    if (previous) {
      if (previous.key !== key)
        return Promise.reject(new Error("This requestId was already used with other arguments"));
      return previous.result;
    }
    const generation = session.chatGeneration;
    const result = this.chatExclusive(session, async () => {
      const workspace = this.requireScope(request.scope, session);
      const config = await loadConfig(this.deps.fs, this.env);
      const provider = request.provider ?? config.defaultAgent;
      if (!Object.hasOwn(config.agents, provider))
        throw new Error(
          `Unknown provider '${provider}' (configured: ${Object.keys(config.agents).join(", ")})`,
        );
      this.config = config;
      await this.assertCapacity(session);
      const ids = await this.startBatch(
        {
          agents: [provider],
          allow: [],
          allowAll: true,
          prompt: request.prompt,
          ...(request.base === undefined ? {} : { base: request.base }),
          ...(request.turnTimeout === undefined ? {} : { turnTimeout: request.turnTimeout }),
        },
        (started, target) => {
          for (const id of started)
            this.workers.set(id, {
              generation,
              directory: target.dir,
              provider,
              reportedTurn: -1,
              reply: "",
            });
        },
      );
      const [runId] = ids;
      if (runId === undefined || workspace !== this.workspace)
        throw new Error("The user declined to run the worker without an isolated worktree");
      return {
        ...this.workerInfo(runId),
        note: "The worker is running. Code60 sends an automatic update when its turn ends.",
      };
    });
    session.dispatches.set(requestId, { key, result });
    // A failed dispatch started nothing, so the same requestId may be retried.
    result.catch(() => {
      if (session.dispatches.get(requestId)?.result === result)
        session.dispatches.delete(requestId);
    });
    return result;
  }

  private controlWorker(
    name: Exclude<
      McpControlTool,
      "code60_get_context" | "code60_dispatch_agent" | "code60_list_agents" | "code60_read_agent"
    >,
    request: { scope: string; runId: string; prompt?: string },
    session: ChatSession,
  ): Promise<unknown> {
    return this.chatExclusive(session, async () => {
      const workspace = this.requireScope(request.scope, session);
      this.ownedWorker(request.runId, session);
      const id = request.runId;
      const batch = this.liveBatch(id);
      const view = batch?.runs().find((run) => run.id === id);
      const live = view !== undefined && ACTIVE_STATUSES.has(view.status);
      if (name === "code60_resume_agent") {
        if (live) throw new Error(`Worker ${id} is ${view.status}; resume only ended workers`);
        await this.assertCapacity(session);
        const result = await this.continueRun(workspace, id, request.prompt as string);
        return { ...this.workerInfo(id), recovery: result.type };
      }
      if (name === "code60_stop_agent") {
        if (batch && live) {
          void batch.shutdown().catch((error: unknown) => {
            this.warnings.push(message(error));
            this.changed();
          });
          this.changed();
          return { ...this.workerInfo(id), note: "The worker is stopping." };
        }
        const stopped = await stopRun(commandDeps(this.deps, workspace), id);
        this.history = await listRuns(commandDeps(this.deps, workspace));
        this.changed();
        return { ...this.workerInfo(id), note: stopped.message };
      }
      if (!batch || !live) throw new Error(`Worker ${id} has ended; resume it with a new prompt`);
      if (name === "code60_send_agent") batch.reply(id, request.prompt as string);
      else if (name === "code60_finish_agent") batch.finish(id);
      else if (!batch.cancelTurn(id)) throw new Error(`Worker ${id} has no turn in progress`);
      this.changed();
      return this.workerInfo(id);
    });
  }
  stopAll(): Promise<void> {
    return this.exclusive(async () => {
      for (const session of this.chats) session.updatesPaused = true;
      await this.stopMemoryExtraction();
      await this.shutdownBatches();
      this.changed();
    });
  }

  async shutdown(force = false): Promise<void> {
    this.closing = true;
    await this.cancelOrchestrationTest();
    await this.stopMemoryExtraction();
    this.poller.stop();
    this.forceClosing ||= force;
    // A force request must not wait behind an earlier graceful shutdown.
    if (force) await this.shutdownBatches(true);
    await this.queue;
    await this.shutdownBatches(this.forceClosing);
    this.detach();
    for (const session of this.chats) {
      for (const dispose of session.chatDisposers) dispose();
      session.chatDisposers = [];
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    for (const session of this.chats) session.inbox = [];
    this.listeners.clear();
    this.database?.close();
    this.database = undefined;
    await Promise.all(this.chats.map((session) => this.closeMcpGateway(session).catch(() => {})));
  }

  private requireWorkspace(): Workspace {
    if (this.workspace === undefined) throw new Error("Choose a folder first");
    return this.workspace;
  }

  private detach(): void {
    for (const batch of this.batches.values()) {
      for (const dispose of batch.disposers) dispose();
      batch.disposers = [];
    }
  }

  private async shutdownBatches(force = false): Promise<void> {
    await Promise.all(
      [
        ...this.batches.keys(),
        ...this.chats.flatMap((session) => (session.chat ? [session.chat] : [])),
      ].map((batch) => batch.shutdown(force)),
    );
  }
}

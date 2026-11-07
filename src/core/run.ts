import {
  type AgentMcpServer,
  type AgentSession,
  AgentStartError,
  type Agents,
  type AgentUpdate,
  type PermissionAnswer,
  type PermissionRequest,
} from "../agents/index.js";
import { type PromptTemplates, renderPrompt } from "../contracts/index.js";
import type { Git } from "../git/index.js";
import type { Clock } from "./clock.js";
import { type Processes, recordedAgentAlive } from "./processes.js";
import type { RecordStore } from "./records.js";
import { HANDOFF_PROMPT_LIMIT } from "./recovery.js";
import type {
  FinalRunStatus,
  Mode,
  PendingPermission,
  PermissionRule,
  RecoveryResult,
  RunEvent,
  RunEventBody,
  RunRecord,
  RunStatus,
  RunView,
  StopReason,
  ToolKind,
} from "./types.js";
import { ACTIVE_STATUSES, RefusedError } from "./types.js";

export interface RunDeps {
  agents: Agents;
  git: Git;
  store: RecordStore;
  clock: Clock;
  processes: Processes;
  ownerPid?: number;
  ownerIdentity?: NonNullable<RunRecord["ownerIdentity"]>;
  onEvent(event: RunEvent): void;
  /** Called when view-only state changes without an event, such as a run starting to stop. */
  onChange(): void;
  warn(message: string): void;
}

export interface RunSettings {
  mode: Mode;
  repoDir: string;
  command: readonly [string, ...string[]];
  env?: Readonly<Record<string, string>>;
  mcpServers?: readonly AgentMcpServer[];
  /** Additional context sent with each user turn, but not recorded as user-authored text. */
  promptContext?: () => string;
  turnTimeoutMs: number;
  /** How long a cancelled turn may take to end before the agent is killed. */
  cancelGraceMs: number;
  /** Time between SIGTERM and SIGKILL when stopping the agent. */
  killGraceMs: number;
  decide(kind: ToolKind): PermissionRule;
  prompts: Readonly<PromptTemplates>;
}

type CancelCause = "user" | "timeout" | "shutdown";

interface Outcome {
  status: FinalRunStatus;
  reason?: string;
}

interface Pending {
  view: PendingPermission;
  resolve(answer: PermissionAnswer): void;
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function outcomeOf(reason: StopReason): Outcome {
  switch (reason) {
    case "end_turn":
      return { status: "finished" };
    case "cancelled":
      return { status: "cancelled", reason: "the turn was cancelled" };
    default:
      return { status: "failed", reason: `the turn stopped: ${reason}` };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One agent session, in its own worktree or directly in a directory, driven through the run lifecycle. */
export class Run {
  readonly finished: Promise<void>;
  private resolveFinished!: () => void;
  private session: AgentSession | undefined;
  private sessionExited = false;
  private worktreeCreated = false;
  private turnActive = false;
  private turnTimer: unknown;
  private graceTimer: unknown;
  private cancelCause: CancelCause | undefined;
  private lastOutcome: Outcome | undefined;
  private readonly pending = new Map<string, Pending>();
  private permissionCount = 0;
  private shutdownRequested = false;
  private forced = false;
  private ending = false;
  private readonly startAbort = new AbortController();

  constructor(
    readonly record: RunRecord,
    private readonly deps: RunDeps,
    private readonly settings: RunSettings,
  ) {
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  get id(): string {
    return this.record.id;
  }

  get status(): RunStatus {
    return this.record.status;
  }

  get hasWorktree(): boolean {
    return this.worktreeCreated;
  }

  view(): RunView {
    const r = this.record;
    return {
      id: r.id,
      agent: r.agent,
      status: r.status,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      turns: r.turns,
      branch: r.branch,
      worktree: r.worktree,
      ...(r.lastStopReason === undefined ? {} : { lastStopReason: r.lastStopReason }),
      pending: [...this.pending.values()].map((p) => p.view),
      stopping: this.ending && !this.isFinal(),
    };
  }

  /** Announces the queued run. */
  queue(): Promise<void> {
    return this.setStatus("queued");
  }

  /** Never rejects: every failure becomes the run's final status. */
  async start(): Promise<void> {
    try {
      await this.startAndRun();
    } catch (error) {
      await this.end({ status: "failed", reason: message(error) });
    }
  }

  /** Restores a saved ACP session without replaying a previous prompt. */
  async restore(): Promise<RecoveryResult> {
    await this.assertRecoverableAndSafe();
    const previousStatus = this.status;
    const previousReason = this.record.reason;
    const sessionId = this.record.acpSessionId;
    if (!sessionId) {
      return {
        type: "handoff-required",
        reason: "This run has no saved ACP session ID to restore.",
      };
    }
    if (!this.deps.agents.restore) {
      return {
        type: "handoff-required",
        reason: "The configured agent launcher does not support ACP session restore.",
      };
    }
    let session: AgentSession;
    try {
      session = await this.startRecoveryAgent((signal) =>
        (this.deps.agents.restore as NonNullable<Agents["restore"]>)(
          {
            name: this.record.agent,
            command: this.settings.command,
            cwd: this.record.worktree,
            ...(this.settings.env === undefined ? {} : { env: this.settings.env }),
            ...(this.settings.mcpServers === undefined
              ? {}
              : { mcpServers: this.settings.mcpServers }),
          },
          sessionId,
          signal,
        ),
      );
    } catch (error) {
      return { type: "handoff-required", reason: message(error) };
    }
    await this.installSession(session);
    this.record.ownerPid = this.deps.ownerPid ?? process.pid;
    delete this.record.endedAt;
    this.lastOutcome = { status: "finished" };
    const previousOutcome =
      previousStatus === "interrupted"
        ? "The previous turn was interrupted."
        : `This run previously ended with status ${previousStatus}.`;
    this.emit({ type: "note", text: "Reconnected to the earlier agent session." });
    await this.setStatus(
      "idle",
      `${previousOutcome}${previousReason ? ` Recorded reason: ${previousReason}.` : ""} The ACP session was restored; review the worktree before replying.`,
    );
    if (this.sessionExited && !this.ending) {
      void this.end({ status: "failed", reason: "the agent exited while idle" });
    }
    return { type: "restored" };
  }

  /**
   * Starts a fresh ACP session in this run's existing worktree. Its first turn sends the bounded
   * summary with the user's message; the transcript records the summary as a note.
   */
  async handoff(summary: string, text: string, reason: string): Promise<void> {
    await this.assertRecoverableAndSafe();
    if (summary.trim() === "") throw new Error("the recovery handoff is empty");
    if (summary.length > HANDOFF_PROMPT_LIMIT)
      throw new Error("the recovery handoff exceeds its size limit");
    if (text.trim() === "") throw new Error("the message is empty");
    const sent = renderPrompt("handoffTurn", this.settings.prompts.handoffTurn, {
      summary,
      message: text,
    });
    let session: AgentSession;
    try {
      session = await this.startRecoveryAgent((signal) =>
        this.deps.agents.start(
          {
            name: this.record.agent,
            command: this.settings.command,
            cwd: this.record.worktree,
            ...(this.settings.env === undefined ? {} : { env: this.settings.env }),
            ...(this.settings.mcpServers === undefined
              ? {}
              : { mcpServers: this.settings.mcpServers }),
          },
          signal,
        ),
      );
    } catch (error) {
      throw new Error(`could not start a fresh agent session: ${message(error)}`);
    }
    await this.installSession(session);
    this.record.ownerPid = this.deps.ownerPid ?? process.pid;
    delete this.record.endedAt;
    this.lastOutcome = { status: "finished" };
    this.emit({
      type: "note",
      text: `The earlier agent session could not be restored (${reason.replace(/\.$/, "")}). Started a fresh session in the same worktree with a summary of the earlier work.`,
      detail: summary,
    });
    await this.setStatus("running", "Started a fresh session with a handoff summary.");
    void this.runTurn(text, true, true, sent);
  }

  /** Sends a follow-up prompt to an idle run (desktop app only). */
  reply(text: string, origin?: "automatic"): void {
    if (this.settings.mode !== "interactive")
      throw new Error("follow-up prompts are only available in the desktop app");
    if (this.status !== "idle" || this.ending) {
      throw new Error(`run ${this.id} is ${this.status}; you can reply only to an idle run`);
    }
    if (text.trim() === "") throw new Error("the reply is empty");
    const context = this.settings.promptContext?.();
    const heading =
      origin === "automatic"
        ? "--- Automatic Code60 update (not written by the user) ---"
        : "--- User request ---";
    const sent = context ? `${context}\n\n${heading}\n${text}` : text;
    this.runTurn(text, true, false, sent, origin).catch((error) =>
      this.end({ status: "failed", reason: message(error) }),
    );
  }

  /** Ends an idle run. Its final status comes from the last turn. */
  finish(): void {
    if (this.status !== "idle" || this.ending) {
      throw new Error(`run ${this.id} is ${this.status}; you can finish only an idle run`);
    }
    void this.end(this.lastOutcome ?? { status: "finished" });
  }

  /** Cancels the current turn. Returns false when no turn is in progress. */
  cancelTurn(cause: CancelCause = "user"): boolean {
    const session = this.session;
    if (!this.turnActive || session === undefined) return false;
    if (this.cancelCause !== undefined) return true;
    this.cancelCause = cause;
    this.withdrawPending();
    if (this.status === "waiting") void this.setStatus("running");
    session.cancel().catch(() => {});
    this.graceTimer = this.deps.clock.setTimeout(
      () => void session.stop(this.forced ? 0 : this.settings.killGraceMs),
      this.forced ? 0 : this.settings.cancelGraceMs,
    );
    return true;
  }

  answerPermission(id: string, answer: PermissionAnswer): boolean {
    const entry = this.pending.get(id);
    if (entry === undefined) return false;
    this.pending.delete(id);
    this.emitPermission(entry.view, answer, "user");
    if (this.pending.size === 0 && this.status === "waiting") void this.setStatus("running");
    entry.resolve(answer);
    return true;
  }

  /** Cancels any turn and ends the run. With `force`, skips the grace periods. */
  shutdown(force = false): Promise<void> {
    this.shutdownRequested = true;
    if (force) {
      this.forced = true;
      this.startAbort.abort();
      if (this.session !== undefined) void this.session.stop(0);
      if (this.cancelCause !== undefined && this.session !== undefined) {
        this.deps.clock.clearTimeout(this.graceTimer);
      }
    }
    switch (this.status) {
      case "queued":
        void this.end({ status: "cancelled", reason: "cancelled before it started" });
        break;
      case "idle":
        if (!this.ending) void this.end(this.lastOutcome ?? { status: "finished" });
        break;
      case "running":
      case "waiting":
        if (!this.cancelTurn("shutdown")) this.startAbort.abort();
        break;
      default:
        break;
    }
    return this.finished;
  }

  private isFinal(): boolean {
    return !ACTIVE_STATUSES.has(this.status);
  }

  private async startAndRun(): Promise<void> {
    const { git, agents, clock } = this.deps;
    const { record, settings } = this;
    await this.setStatus("running");
    if (record.branch !== null && record.base !== null) {
      try {
        await git.addWorktree({
          repoDir: settings.repoDir,
          path: record.worktree,
          branch: record.branch,
          base: record.base,
        });
        this.worktreeCreated = true;
      } catch (error) {
        return this.end({
          status: "failed",
          reason: `could not create the worktree: ${message(error)}`,
        });
      }
    }
    if (this.shutdownRequested) {
      return this.end({ status: "cancelled", reason: "cancelled before the agent started" });
    }

    let startTimedOut = false;
    const timer = clock.setTimeout(() => {
      startTimedOut = true;
      this.startAbort.abort();
    }, settings.turnTimeoutMs);
    let session: AgentSession;
    try {
      session = await agents.start(
        {
          name: record.agent,
          command: settings.command,
          cwd: record.worktree,
          ...(settings.env === undefined ? {} : { env: settings.env }),
          ...(settings.mcpServers === undefined ? {} : { mcpServers: settings.mcpServers }),
        },
        this.startAbort.signal,
      );
    } catch (error) {
      clock.clearTimeout(timer);
      if (error instanceof AgentStartError && error.stderrTail !== "") {
        this.emit({ type: "stderr", text: error.stderrTail });
      }
      if (startTimedOut) {
        return this.end({
          status: "timed_out",
          reason: `the agent did not start within ${formatDuration(settings.turnTimeoutMs)}`,
        });
      }
      if (this.shutdownRequested) {
        return this.end({ status: "cancelled", reason: "cancelled before the agent started" });
      }
      return this.end({ status: "failed", reason: message(error) });
    }
    clock.clearTimeout(timer);
    await this.installSession(session);

    if (this.shutdownRequested) {
      return this.end({ status: "cancelled", reason: "cancelled before the first prompt" });
    }
    if (record.firstPrompt === "") {
      this.lastOutcome = { status: "finished", reason: "no prompt was sent" };
      await this.setStatus("idle", "no prompt yet");
      return;
    }
    await this.runTurn(record.firstPrompt);
  }

  private async installSession(session: AgentSession): Promise<void> {
    this.session = session;
    this.sessionExited = false;
    session.onUpdate((update) => this.emit(update));
    session.onPermission((request, signal) => this.onPermission(request, signal));
    void session.exited.then(() => {
      this.sessionExited = true;
      if (this.status === "idle" && !this.ending) {
        void this.end({ status: "failed", reason: "the agent exited while idle" });
      }
    });

    this.record.agentPid = session.pid;
    if (session.identity === undefined) delete this.record.agentIdentity;
    else this.record.agentIdentity = session.identity;
    if (this.deps.ownerIdentity) this.record.ownerIdentity = this.deps.ownerIdentity;
    else delete this.record.ownerIdentity;
    this.record.agentCommand = this.settings.command;
    this.record.acpSessionId = session.sessionId;
    const commandLine = await this.deps.processes.commandLine(session.pid).catch(() => undefined);
    if (commandLine === undefined) delete this.record.agentCommandLine;
    else this.record.agentCommandLine = commandLine;
    await this.save();
  }

  private async assertRecoverableAndSafe(): Promise<void> {
    if (ACTIVE_STATUSES.has(this.status) || this.ending) {
      throw new RefusedError(`run ${this.id} is ${this.status}; only ended runs can be recovered`);
    }
    if (await recordedAgentAlive(this.deps.processes, this.record)) {
      throw new RefusedError(
        `the leftover agent for run ${this.id} is still alive (process group ${this.record.agentPid}); stop it before retrying`,
      );
    }
  }

  private async startRecoveryAgent(
    start: (signal: AbortSignal) => Promise<AgentSession>,
  ): Promise<AgentSession> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.startAbort.signal.addEventListener("abort", abort, { once: true });
    if (this.startAbort.signal.aborted) abort();
    let timedOut = false;
    const timer = this.deps.clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.settings.turnTimeoutMs);
    try {
      const session = await start(controller.signal);
      if (timedOut) {
        await session.stop(0);
        throw new Error(
          `the agent did not start within ${formatDuration(this.settings.turnTimeoutMs)}`,
        );
      }
      return session;
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `the agent did not start within ${formatDuration(this.settings.turnTimeoutMs)}`,
        );
      }
      throw error;
    } finally {
      this.deps.clock.clearTimeout(timer);
      this.startAbort.signal.removeEventListener("abort", abort);
    }
  }

  private async runTurn(
    text: string,
    setInitialPrompt = true,
    preserveInterruptedOnFailure = false,
    sent = text,
    origin?: "automatic",
  ): Promise<void> {
    const session = this.session as AgentSession;
    const { clock } = this.deps;
    const { settings } = this;
    this.record.turns += 1;
    const turn = this.record.turns;
    if (setInitialPrompt && this.record.firstPrompt === "") this.record.firstPrompt = text;
    this.cancelCause = undefined;
    this.turnActive = true;
    this.emit({ type: "prompt", turn, text, ...(origin === undefined ? {} : { origin }) });
    const statusSaved = this.status === "running" ? Promise.resolve() : this.setStatus("running");
    this.turnTimer = clock.setTimeout(() => this.cancelTurn("timeout"), settings.turnTimeoutMs);

    let stopReason: StopReason | undefined;
    let failure: unknown;
    try {
      stopReason = await session.prompt(sent);
    } catch (error) {
      failure = error;
    }
    const completedAt = clock.now().toISOString();
    clock.clearTimeout(this.turnTimer);
    clock.clearTimeout(this.graceTimer);
    this.turnActive = false;
    this.withdrawPending();
    await statusSaved;

    const cause = this.cancelCause;
    const causeOutcome = (c: CancelCause): Outcome =>
      c === "timeout"
        ? {
            status: "timed_out",
            reason: `turn ${turn} exceeded the ${formatDuration(settings.turnTimeoutMs)} turn timeout`,
          }
        : {
            status: "cancelled",
            reason: c === "user" ? "the turn was cancelled" : "cancelled during shutdown",
          };

    if (stopReason === undefined) {
      if (preserveInterruptedOnFailure) {
        return this.end(
          {
            status: "interrupted",
            reason: `the handoff session could not complete: ${message(failure)}`,
          },
          { turn, completedAt },
        );
      }
      return this.end(
        cause !== undefined ? causeOutcome(cause) : { status: "failed", reason: message(failure) },
        { turn, completedAt },
      );
    }
    this.record.lastStopReason = stopReason;
    const outcome =
      cause !== undefined && (cause === "timeout" || stopReason === "cancelled")
        ? causeOutcome(cause)
        : outcomeOf(stopReason);
    this.emit({ type: "turnEnd", turn, stopReason, completedAt, outcome: outcome.status });
    if (settings.mode === "headless" || this.shutdownRequested) return this.end(outcome);

    this.lastOutcome = outcome;
    const note = cause === "timeout" ? " (turn timed out)" : "";
    await this.setStatus("idle", `turn ${turn} ended: ${stopReason}${note}`);
  }

  private onPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    const rule = this.settings.decide(request.kind);
    if (rule !== "ask" || this.settings.mode === "headless") {
      const answer: PermissionAnswer = rule === "allow" ? "allow" : "deny";
      this.emitPermission(request, answer, "policy");
      return Promise.resolve(answer);
    }
    if (signal.aborted || this.cancelCause !== undefined || this.ending) {
      return Promise.resolve("deny");
    }
    this.permissionCount += 1;
    const id = `${this.id}#${this.permissionCount}`;
    return new Promise((resolve) => {
      this.pending.set(id, { view: { id, runId: this.id, ...request }, resolve });
      signal.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          resolve("deny");
          if (this.pending.size === 0 && this.status === "waiting" && !this.ending) {
            void this.setStatus("running");
          }
        },
        { once: true },
      );
      void this.setStatus("waiting");
    });
  }

  private withdrawPending(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.resolve("deny");
  }

  private emitPermission(
    request: PermissionRequest,
    answer: PermissionAnswer,
    by: "policy" | "user",
  ): void {
    this.emit({
      type: "permission",
      toolCallId: request.toolCallId,
      title: request.title,
      kind: request.kind,
      decision: answer === "allow" ? "allowed" : "denied",
      by,
      ...(request.options === undefined
        ? {}
        : { options: request.options.map((option) => ({ ...option })) }),
    });
  }

  private async end(
    outcome: Outcome,
    timing?: { turn: number; completedAt: string },
  ): Promise<void> {
    if (this.ending) return this.finished;
    this.ending = true;
    const { clock } = this.deps;
    clock.clearTimeout(this.turnTimer);
    clock.clearTimeout(this.graceTimer);
    this.withdrawPending();
    this.deps.onChange();
    const session = this.session;
    if (session !== undefined) {
      try {
        await session.stop(this.forced ? 0 : this.settings.killGraceMs);
      } catch (error) {
        const reason = `could not verify agent cleanup: ${message(error)}`;
        this.deps.warn(reason);
        outcome = {
          status: outcome.status === "finished" ? "failed" : outcome.status,
          reason: outcome.reason ? `${outcome.reason}; ${reason}` : reason,
        };
      }
      const tail = session.stderrTail();
      if (tail !== "") this.emit({ type: "stderr", text: tail });
    }
    if (outcome.status === "interrupted") delete this.record.endedAt;
    else this.record.endedAt = clock.now().toISOString();
    await this.setStatus(outcome.status, outcome.reason, timing);
    this.resolveFinished();
  }

  private setStatus(
    status: RunStatus,
    reason?: string,
    timing?: { turn: number; completedAt: string },
  ): Promise<void> {
    this.record.status = status;
    if (reason === undefined) delete this.record.reason;
    else this.record.reason = reason;
    this.emit({ type: "status", status, ...(reason === undefined ? {} : { reason }), ...timing });
    return this.save();
  }

  private save(): Promise<void> {
    return this.deps.store
      .save({ ...this.record })
      .catch((error) =>
        this.deps.warn(`could not write the record for run ${this.id}: ${message(error)}`),
      );
  }

  private emit(body: RunEventBody | AgentUpdate): void {
    const event = { runId: this.id, at: this.deps.clock.now().toISOString(), ...body } as RunEvent;
    this.deps.store
      .appendEvent(event)
      .catch((error) =>
        this.deps.warn(`could not write events for run ${this.id}: ${message(error)}`),
      );
    this.deps.onEvent(event);
  }
}

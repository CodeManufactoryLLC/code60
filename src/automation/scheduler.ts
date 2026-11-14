import { randomUUID } from "node:crypto";
import {
  AUTOMATION_LIMIT,
  type Automation,
  type AutomationDraft,
  type AutomationRequest,
  type AutomationState,
  automationDraftSchema,
  type Execution,
  type ExecutionReason,
  type ServiceStatus,
} from "../contracts/index.js";
import { CODE60_VERSION, dueDecision, nextOccurrence } from "../core/index.js";
import { AutomationError } from "./errors.js";
import { type ExecutionOutcome, ExecutionRefused, type Executor } from "./executor.js";
import type { StateWriter } from "./store.js";

type Active = {
  executionId: string;
  automationId: string;
  abort: AbortController;
  done: Promise<void>;
};
const unfinished = (execution: Execution) =>
  execution.status === "claimed" || execution.status === "running";

/** Single writer with a short control queue. Agent turns never hold the queue. */
export class Scheduler {
  private tail: Promise<unknown> = Promise.resolve();
  private active: Active | null = null;
  private stopped = false;
  private failed = false;
  private lastTick: number;
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly startedAt: string;

  constructor(
    private readonly store: StateWriter,
    private readonly executor: Executor,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.startedAt = now().toISOString();
    this.lastTick = now().getTime();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }
  private async save(next: AutomationState) {
    if (this.failed)
      throw new AutomationError(
        "unavailable",
        "Schedule persistence failed. Restart after repairing storage.",
      );
    next.revision = this.store.state.revision + 1;
    try {
      await this.store.save(next);
    } catch {
      this.failed = true;
      this.active?.abort.abort();
      throw new AutomationError(
        "unavailable",
        "Schedule persistence failed. No further launches are allowed.",
      );
    }
    for (const listener of this.listeners) {
      try {
        listener(next.revision);
      } catch {
        /* Client failures cannot affect dispatch. */
      }
    }
  }
  onChange(listener: (revision: number) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  status(): ServiceStatus {
    return {
      version: 1,
      appVersion: CODE60_VERSION,
      pid: process.pid,
      startedAt: this.startedAt,
      revision: this.store.state.revision,
      pausedAll: this.store.state.pausedAll,
      block: this.failed
        ? { reason: "persistence_failed", executionId: null, runId: null }
        : this.store.state.block,
      activeExecutionId: this.active?.executionId ?? null,
    };
  }
  /** Restart always advances to future occurrences, even if downtime was brief. */
  async initialize(): Promise<void> {
    await this.serial(async () => {
      const state = structuredClone(this.store.state);
      for (const execution of state.executions.filter(unfinished)) {
        if ((await this.executor.inspect(execution)) === "blocked") {
          state.block = {
            reason: "leftover_agent",
            executionId: execution.id,
            runId: execution.runId,
          };
          break;
        }
        execution.status = "interrupted";
        execution.reason = "service_restarted";
        execution.endedAt = this.now().toISOString();
      }
      for (const automation of state.automations)
        automation.nextRunAt = automation.enabled
          ? dueDecision(
              automation.schedule,
              null,
              this.now(),
              this.claimedThrough(automation),
            ).nextRunAt.toISOString()
          : null;
      await this.save(state);
    });
  }
  private find(state: AutomationState, id: string, revision?: number): Automation {
    const automation = state.automations.find((value) => value.id === id);
    if (!automation) throw new AutomationError("not_found", "Automation not found.");
    if (revision !== undefined && automation.revision !== revision)
      throw new AutomationError("conflict", "The automation changed. Reload before saving.");
    return automation;
  }
  private claimedThrough(automation: Automation): Date | null {
    let latest: string | null = null;
    for (const execution of this.store.state.executions) {
      if (
        execution.automationId === automation.id &&
        execution.revision === automation.revision &&
        execution.scheduledFor &&
        (!latest || Date.parse(execution.scheduledFor) > Date.parse(latest))
      )
        latest = execution.scheduledFor;
    }
    return latest ? new Date(latest) : null;
  }
  private async draft(draft: AutomationDraft, previous?: Automation): Promise<Automation> {
    const valid = automationDraftSchema.parse(draft);
    const identity = await this.executor.validate(valid);
    const at = this.now().toISOString();
    const { repository: _repository, ...fields } = valid;
    return {
      ...fields,
      ...identity,
      id: previous?.id ?? randomUUID(),
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
      nextRunAt: valid.enabled ? nextOccurrence(valid.schedule, this.now()).toISOString() : null,
    };
  }
  private addExecution(
    state: AutomationState,
    automation: Automation,
    scheduledFor: string | null,
    reason: ExecutionReason | null,
  ): Execution {
    // Explicit bound, never silently delete run evidence to make room.
    if (state.executions.length >= 5000)
      throw new AutomationError(
        "refused",
        "Execution metadata limit reached. Schedules are preserved; dispatch is paused.",
      );
    const execution: Execution = {
      id: randomUUID(),
      sequence: ++state.sequence,
      automationId: automation.id,
      automationName: automation.name,
      repository: { ...automation.repository },
      evidence: null,
      revision: automation.revision,
      trigger: scheduledFor ? "schedule" : "manual",
      scheduledFor,
      claimedAt: this.now().toISOString(),
      startedAt: null,
      endedAt: reason ? this.now().toISOString() : null,
      status: reason ? "skipped" : "claimed",
      reason,
      runId: reason ? null : `auto-${randomUUID()}`,
      denials: 0,
      changedFiles: null,
    };
    state.executions.push(execution);
    return execution;
  }
  private async claim(automation: Automation, scheduledFor: string | null, missed = false) {
    const state = structuredClone(this.store.state);
    const current = this.find(state, automation.id);
    if (scheduledFor) {
      const claimedThrough = this.claimedThrough(current);
      const next = new Date(
        Math.max(this.now().getTime(), Date.parse(scheduledFor), claimedThrough?.getTime() ?? 0),
      );
      current.nextRunAt = nextOccurrence(current.schedule, next).toISOString();
      if (claimedThrough && Date.parse(scheduledFor) <= claimedThrough.getTime()) {
        await this.save(state);
        return null;
      }
    }
    const reason = missed
      ? "missed"
      : state.block || this.failed
        ? "blocked"
        : state.pausedAll || this.stopped
          ? "paused"
          : this.active
            ? "busy"
            : null;
    const execution = this.addExecution(state, automation, scheduledFor, reason);
    await this.save(state); // Unique claim + advanced schedule are durable before launch.
    if (!reason && this.stopped) {
      execution.status = "cancelled";
      execution.reason = "service_stopped";
      execution.endedAt = this.now().toISOString();
      await this.save(state);
      return execution;
    }
    if (!reason) {
      const abort = new AbortController();
      const snapshot = structuredClone(automation);
      this.active = {
        executionId: execution.id,
        automationId: automation.id,
        abort,
        done: Promise.resolve(),
      };
      // Leave the control queue before preparation, cancellation or agent execution.
      this.active.done = Promise.resolve().then(() =>
        this.launch(snapshot, execution, abort.signal),
      );
    }
    return execution;
  }
  private async launch(
    automation: Automation,
    execution: Execution,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.serial(async () => {
        const state = structuredClone(this.store.state);
        const entry = state.executions.find((value) => value.id === execution.id);
        if (!entry) throw new Error("Missing claim");
        entry.status = "running";
        entry.startedAt = this.now().toISOString();
        await this.save(state);
      });
      let outcome: ExecutionOutcome;
      try {
        outcome = await this.executor.execute(automation, execution, signal, (evidence) =>
          this.serial(async () => {
            const state = structuredClone(this.store.state);
            const entry = state.executions.find((value) => value.id === execution.id);
            if (!entry || signal.aborted) throw new Error("Execution cancelled");
            entry.evidence = evidence;
            await this.save(state);
          }),
        );
      } catch (error) {
        outcome = {
          status: signal.aborted ? ("cancelled" as const) : ("failed" as const),
          reason:
            error instanceof ExecutionRefused ? error.reason : ("preparation_failed" as const),
          denials: 0,
          changedFiles: null,
        };
      }
      // A stopped turn is a cancellation, even when the interrupted agent reports failure.
      if (
        signal.aborted &&
        outcome.status !== "finished" &&
        outcome.reason !== "persistence_failed"
      )
        outcome = {
          ...outcome,
          status: "cancelled",
          reason: this.stopped ? "service_stopped" : "cancelled_by_user",
        };
      await this.serial(async () => {
        const state = structuredClone(this.store.state);
        const entry = state.executions.find((value) => value.id === execution.id);
        if (!entry) throw new Error("Missing execution");
        Object.assign(entry, outcome, { endedAt: this.now().toISOString() });
        if (outcome.reason === "low_disk" || outcome.reason === "persistence_failed")
          state.pausedAll = true;
        // Unknown leftover ownership blocks every later launch, regardless of outcome.
        if ((await this.executor.inspect(entry)) !== "gone")
          state.block = { reason: "leftover_agent", executionId: entry.id, runId: entry.runId };
        await this.save(state);
      });
    } catch {
      this.failed = true; // An uncertain save cannot authorize more execution.
    } finally {
      this.active = null;
    }
  }

  async tick(): Promise<void> {
    await this.serial(async () => {
      const gap = this.now().getTime() - this.lastTick;
      this.lastTick = this.now().getTime();
      if (this.stopped || this.failed || this.store.state.pausedAll || this.store.state.block)
        return;
      for (const saved of [...this.store.state.automations]) {
        if (!saved.enabled) continue;
        const decision = dueDecision(
          saved.schedule,
          saved.nextRunAt ? new Date(saved.nextRunAt) : null,
          this.now(),
          this.claimedThrough(saved),
        );
        if (decision.type !== "wait") {
          await this.claim(
            saved,
            decision.scheduledFor.toISOString(),
            decision.type === "missed" || gap > 5000,
          );
        } else if (saved.nextRunAt !== decision.nextRunAt.toISOString()) {
          const state = structuredClone(this.store.state);
          this.find(state, saved.id).nextRunAt = decision.nextRunAt.toISOString();
          await this.save(state);
        }
      }
    });
  }

  async request(request: AutomationRequest): Promise<unknown> {
    return this.serial(async () => {
      const state = structuredClone(this.store.state);
      switch (request.action) {
        case "status":
          return this.status();
        case "list":
          return state.automations.map(({ prompt: _prompt, repository, ...value }) => ({
            ...value,
            repository: { dev: repository.dev, ino: repository.ino },
          }));
        case "get":
          return this.find(state, request.id);
        case "history":
          return state.executions
            .filter(
              (value) =>
                (!request.id || value.automationId === request.id) &&
                (!request.before || value.sequence < request.before),
            )
            .slice(-(request.limit ?? 50))
            .reverse()
            .map(({ repository: _repository, evidence: _evidence, ...value }) => value);
        case "create": {
          if (state.automations.length >= AUTOMATION_LIMIT)
            throw new AutomationError("refused", "Automation limit reached.");
          const automation = await this.draft(request.draft);
          state.automations.push(automation);
          await this.save(state);
          return automation;
        }
        case "update": {
          const previous = this.find(state, request.id, request.revision);
          const automation = await this.draft(request.draft, previous);
          state.automations[state.automations.indexOf(previous)] = automation;
          await this.save(state);
          return automation;
        }
        case "setEnabled": {
          const automation = this.find(state, request.id, request.revision);
          automation.enabled = request.enabled;
          automation.revision++;
          automation.updatedAt = this.now().toISOString();
          automation.nextRunAt = request.enabled
            ? nextOccurrence(automation.schedule, this.now()).toISOString()
            : null;
          await this.save(state);
          return automation;
        }
        case "delete":
          this.find(state, request.id, request.revision);
          if (this.active?.automationId === request.id)
            throw new AutomationError("refused", "Cancel active work before deleting.");
          state.automations = state.automations.filter((value) => value.id !== request.id);
          await this.save(state);
          return null;
        case "runNow":
          return this.claim(this.find(state, request.id), null);
        case "cancel":
          if (this.active?.automationId === request.id) this.active.abort.abort();
          return null;
        case "pauseAll":
          state.pausedAll = true;
          if (request.cancelActive) this.active?.abort.abort();
          await this.save(state);
          return null;
        case "resumeAll":
          state.pausedAll = false;
          for (const automation of state.automations)
            automation.nextRunAt = automation.enabled
              ? nextOccurrence(automation.schedule, this.now()).toISOString()
              : null;
          await this.save(state);
          return null;
        case "resolveBlock":
          for (const execution of state.executions.filter(
            (value) => unfinished(value) || value.id === state.block?.executionId,
          )) {
            if ((await this.executor.inspect(execution)) !== "gone")
              throw new AutomationError(
                "refused",
                "A leftover agent is alive or cannot be verified. Stop it manually, then retry.",
              );
            if (unfinished(execution)) {
              execution.status = "interrupted";
              execution.reason = "service_restarted";
              execution.endedAt = this.now().toISOString();
            }
          }
          state.block = null;
          await this.save(state);
          return null;
        case "subscribe":
          return { revision: state.revision };
        default:
          throw new AutomationError("invalid", "This action needs an execution evidence reader.");
      }
    });
  }

  execution(id: string): Execution {
    const value = this.store.state.executions.find((entry) => entry.id === id);
    if (!value) throw new AutomationError("not_found", "Execution not found.");
    return structuredClone(value);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.active?.abort.abort();
    await this.tail; // Fence claims that were still persisting when shutdown began.
    this.active?.abort.abort();
    await this.active?.done;
    await this.tail;
  }
}

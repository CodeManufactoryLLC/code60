import { realpath } from "node:fs/promises";
import type { AutomationDiff, AutomationTranscript } from "../contracts/index.js";
import { type CoreDeps, openWorkspace } from "../core/index.js";
import { AutomationError } from "./errors.js";
import { verifyRepository } from "./executor.js";
import type { Scheduler } from "./scheduler.js";

/** Read evidence without reconciling, recovering, applying, or starting an agent. */
export async function executionEvidence(
  scheduler: Scheduler,
  deps: CoreDeps,
  env: Readonly<NodeJS.ProcessEnv>,
  executionId: string,
  kind: "transcript" | "diff",
): Promise<AutomationTranscript | AutomationDiff> {
  const execution = scheduler.execution(executionId);
  if (!execution.runId) throw new AutomationError("not_found", "This occurrence has no agent run.");
  await verifyRepository(execution.repository);
  const workspace = await openWorkspace(deps, execution.repository.path, env);
  const record = await workspace.store.read(execution.runId);
  if (kind === "diff") {
    const pin = execution.evidence;
    if (
      !pin ||
      record.base !== pin.base ||
      record.branch !== pin.branch ||
      (await realpath(record.worktree)) !== pin.worktree.path
    )
      throw new AutomationError("refused", "No pinned isolated changes are available.");
    await verifyRepository(pin.worktree);
    const text = await deps.git.diff(pin.worktree.path, pin.base);
    return {
      executionId,
      runId: record.id,
      text: text.slice(0, 48_000),
      truncated: text.length > 48_000,
    };
  }
  const events = await workspace.store.readEvents(record.id);
  const entries: AutomationTranscript["entries"] = [];
  let size = 0;
  let truncated = false;
  for (const event of events) {
    const text =
      "text" in event && typeof event.text === "string"
        ? event.text
        : event.type === "permission"
          ? `${event.kind}: ${event.decision}`
          : event.type === "status"
            ? event.status
            : "";
    if (!text) continue;
    const remaining = 48_000 - size;
    if (remaining <= 0 || entries.length >= 500) {
      truncated = true;
      break;
    }
    entries.push({
      at: event.at,
      type:
        event.type === "message" ||
        event.type === "prompt" ||
        event.type === "permission" ||
        event.type === "status"
          ? event.type
          : "note",
      text: text.slice(0, remaining),
    });
    size += Math.min(text.length, remaining);
    if (text.length > remaining) truncated = true;
  }
  return { executionId, runId: record.id, entries, truncated };
}

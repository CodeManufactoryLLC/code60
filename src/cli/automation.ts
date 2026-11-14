import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type AutomationRequest,
  automationClient,
  automationDraftSchema,
  automationRequestSchema,
  schedulerControl,
} from "../automation/index.js";
import { UsageError } from "../core/index.js";
import type { CliIo } from "./run.js";

export const AUTOMATION_HELP = `Usage:
  code60 automation list|get <id>|history [id] [--before <sequence>] [--json]
  code60 automation create --file <draft.json> [--json]
  code60 automation update <id> --revision <n> --file <draft.json> [--json]
  code60 automation enable|disable|delete <id> --revision <n> [--yes] [--json]
  code60 automation run|cancel <id> [--json]
  code60 automation transcript|diff <execution-id> [--json]
  code60 automation pause-all [--cancel-active] [--json]
  code60 automation resume-all|resolve-block [--json]
  code60 scheduler status|install|repair|start|stop|uninstall [--yes] [--json]

Install/repair requires --yes (explicit consent to per-user background execution).
Delete requires --yes. These commands never prompt.
Create/update reads a bounded JSON file with name, prompt, agent, repository (absolute),
baseBranch (local), allow (tool kinds), turnTimeout, enabled and schedule.
Schedule: {"type":"interval","everyMinutes":60,"anchor":"2026-01-01T00:00:00Z"},
{"type":"daily","time":"09:00","timeZone":"America/New_York"}, or
{"type":"weekly","days":[1,3,5],"time":"09:00","timeZone":"America/New_York"}.
Start disabled, review permissions, then use run to test before enabling.
Unapproved tools are denied. Allowing execute grants broad user-account access.
No catch-up, retries, auto-merge or worktree cleanup. The user must be logged in and awake.
`;

const revision = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new UsageError("Provide a positive integer --revision.");
  return Number(value);
};

async function readDraft(path: string | undefined) {
  if (!path) throw new UsageError("Provide --file <draft.json>.");
  const handle = await open(path);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024)
      throw new UsageError("Draft must be a JSON file of at most 64 KiB.");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer);
    if (bytesRead > 64 * 1024) throw new UsageError("Draft exceeds 64 KiB.");
    return automationDraftSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await handle.close();
  }
}

export async function automationCommand(
  command: "automation" | "scheduler",
  argv: readonly string[],
  io: CliIo,
  request = automationClient(io.env ?? process.env),
  control = schedulerControl,
): Promise<number> {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      yes: { type: "boolean" },
      file: { type: "string" },
      revision: { type: "string" },
      before: { type: "string" },
      "cancel-active": { type: "boolean" },
    },
  });
  if (parsed.values.help) {
    io.stdout.write(AUTOMATION_HELP);
    return 0;
  }
  const [action, id, ...extra] = parsed.positionals;
  if (!action || extra.length > 0) throw new UsageError(AUTOMATION_HELP);
  let result: unknown;
  if (command === "scheduler") {
    if (id || !["status", "install", "repair", "start", "stop", "uninstall"].includes(action))
      throw new UsageError(AUTOMATION_HELP);
    result = await control(
      io.env ?? process.env,
      action as Parameters<typeof schedulerControl>[1],
      parsed.values.yes === true,
    );
  } else {
    let operation: unknown;
    switch (action) {
      case "list":
      case "resume-all":
      case "resolve-block":
        if (id) throw new UsageError("This action takes no ID.");
        operation = {
          action:
            action === "resume-all"
              ? "resumeAll"
              : action === "resolve-block"
                ? "resolveBlock"
                : "list",
        };
        break;
      case "pause-all":
        if (id) throw new UsageError("This action takes no ID.");
        operation = { action: "pauseAll", cancelActive: parsed.values["cancel-active"] === true };
        break;
      case "get":
      case "cancel":
        operation = { action, id };
        break;
      case "run":
        operation = { action: "runNow", id };
        break;
      case "history":
        operation = {
          action,
          ...(id ? { id } : {}),
          ...(parsed.values.before ? { before: revision(parsed.values.before) } : {}),
        };
        break;
      case "transcript":
      case "diff":
        operation = { action, executionId: id };
        break;
      case "create":
        if (id) throw new UsageError("Create takes no ID.");
        operation = { action, draft: await readDraft(parsed.values.file) };
        break;
      case "update":
        operation = {
          action,
          id,
          revision: revision(parsed.values.revision),
          draft: await readDraft(parsed.values.file),
        };
        break;
      case "enable":
      case "disable":
        operation = {
          action: "setEnabled",
          id,
          revision: revision(parsed.values.revision),
          enabled: action === "enable",
        };
        break;
      case "delete":
        if (!parsed.values.yes)
          throw new UsageError("Delete requires --yes. Cancel active work first.");
        operation = { action, id, revision: revision(parsed.values.revision) };
        break;
      default:
        throw new UsageError(AUTOMATION_HELP);
    }
    const checked = automationRequestSchema.safeParse(operation);
    if (!checked.success) throw new UsageError("Invalid automation ID or command arguments.");
    result = await request(checked.data as AutomationRequest);
  }
  io.stdout.write(
    `${JSON.stringify(result ?? { ok: true }, null, parsed.values.json ? undefined : 2)}\n`,
  );
  return 0;
}

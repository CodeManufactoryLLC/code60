import { z } from "zod";

// Keep code generation disabled when this module is imported directly.
z.config({ jitless: true });

import { durationSchema, TOOL_KINDS } from "./values.js";

/** Version of the local scheduler service protocol and its private state file. */
const AUTOMATION_PROTOCOL_VERSION = 1;
const AUTOMATION_STATE_FORMAT = 1;
/** Largest single protocol frame, in UTF-16 code units, accepted by either side. */
export const AUTOMATION_FRAME_LIMIT = 512 * 1024;
export const AUTOMATION_LIMIT = 100;
const AUTOMATION_HISTORY_PAGE = 50;
const AUTOMATION_MIN_INTERVAL_MINUTES = 1;
const AUTOMATION_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

const bounded = (label: string, min: number, max: number) =>
  z
    .string({ error: `Invalid ${label}` })
    .refine((value) => value.trim().length >= min && value.length <= max, `Invalid ${label}`);

function validTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string({ error: "Invalid time zone" })
  .refine(validTimeZone, "Invalid time zone");
const localTimeSchema = z
  .string({ error: "Invalid time" })
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Time must use 24-hour HH:MM");
/** Sunday is 0, matching `Date.getUTCDay`. */
const weekdaySchema = z.number().int().min(0).max(6);
const isoInstant = z.iso.datetime();

export const automationScheduleSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("interval"),
    everyMinutes: z
      .number()
      .int()
      .min(AUTOMATION_MIN_INTERVAL_MINUTES, "Intervals must be at least one minute")
      .max(AUTOMATION_MAX_INTERVAL_MINUTES, "Intervals must be at most seven days"),
    /** Occurrences fall at anchor + k × interval, so runs never drift by their duration. */
    anchor: isoInstant,
  }),
  z.strictObject({
    type: z.literal("daily"),
    time: localTimeSchema,
    timeZone: timeZoneSchema,
  }),
  z.strictObject({
    type: z.literal("weekly"),
    days: z
      .array(weekdaySchema)
      .min(1, "Choose at least one day")
      .max(7)
      .refine((days) => new Set(days).size === days.length, "Days must be unique"),
    time: localTimeSchema,
    timeZone: timeZoneSchema,
  }),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

const agentNameSchema = z
  .string({ error: "Invalid agent" })
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Invalid agent");
/** Local branch names only; remote refs, revisions and option-like names are rejected. */
export const branchNameSchema = z
  .string({ error: "Invalid branch" })
  .max(200)
  .refine(
    (name) =>
      /^[A-Za-z0-9._/-]+$/.test(name) &&
      !name.startsWith("-") &&
      !name.startsWith("/") &&
      !name.endsWith("/") &&
      !name.endsWith(".") &&
      !name.endsWith(".lock") &&
      !name.includes("..") &&
      !name.includes("//") &&
      !name.split("/").some((part) => part.startsWith(".")),
    "Invalid branch",
  );
const allowSchema = z
  .array(z.enum(TOOL_KINDS))
  .max(TOOL_KINDS.length)
  .refine((kinds) => new Set(kinds).size === kinds.length, "Permissions must be unique");
const timeoutSchema = z
  .string()
  .max(32)
  .refine((value) => durationSchema.safeParse(value).success, "Invalid timeout");

/** Fields a person chooses. The repository path is supplied only by trusted local callers. */
const draftShape = {
  name: bounded("name", 1, 80),
  prompt: bounded("prompt", 1, 32_000),
  agent: agentNameSchema,
  baseBranch: branchNameSchema,
  /** Tool-call kinds allowed without asking. Every other kind is denied. */
  allow: allowSchema,
  turnTimeout: timeoutSchema,
  schedule: automationScheduleSchema,
  enabled: z.boolean(),
};
const absolutePath = z
  .string({ error: "Invalid repository" })
  .min(1)
  .max(4096)
  .refine(
    (path) => !path.includes("\0") && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)),
    "The repository must be an absolute path",
  );
export const automationDraftSchema = z.strictObject({ ...draftShape, repository: absolutePath });
export type AutomationDraft = z.input<typeof automationDraftSchema>;
/** Renderer drafts name a main-process repository choice, never a path. */
export const rendererAutomationDraftSchema = z.strictObject({
  ...draftShape,
  repositoryToken: z.uuid().optional(),
});
export type RendererAutomationDraft = z.input<typeof rendererAutomationDraftSchema>;

const decimal = z.string().regex(/^\d{1,40}$/);
const automationSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  createdAt: isoInstant,
  updatedAt: isoInstant,
  name: z.string().max(80),
  prompt: z.string().max(32_000),
  agent: agentNameSchema,
  /** SHA-256 of the provider command approved when the automation was saved. */
  providerHash: z.string().regex(/^[a-f0-9]{64}$/),
  repository: z.strictObject({ path: absolutePath, dev: decimal, ino: decimal }),
  baseBranch: branchNameSchema,
  allow: allowSchema,
  turnTimeout: z.string().max(32),
  schedule: automationScheduleSchema,
  enabled: z.boolean(),
  nextRunAt: isoInstant.nullable(),
});
export type Automation = z.infer<typeof automationSchema>;

const EXECUTION_STATUSES = [
  "claimed",
  "running",
  "finished",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "skipped",
] as const;
/** Fixed reasons, so history never needs to echo prompts, paths or provider output. */
const EXECUTION_REASONS = [
  "missed",
  "busy",
  "paused",
  "blocked",
  "provider_missing",
  "provider_changed",
  "repository_missing",
  "repository_replaced",
  "base_missing",
  "low_disk",
  "persistence_failed",
  "preparation_failed",
  "service_restarted",
  "cancelled_by_user",
  "service_stopped",
  "agent_failed",
  "timed_out",
] as const;
export type ExecutionReason = (typeof EXECUTION_REASONS)[number];

const evidenceSchema = z.strictObject({
  worktree: z.strictObject({ path: absolutePath, dev: decimal, ino: decimal }),
  base: z.string().regex(/^[a-f0-9]{40,64}$/),
  branch: z.string().max(200),
});
export type AutomationEvidence = z.infer<typeof evidenceSchema>;
const executionSchema = z.strictObject({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  automationId: z.uuid(),
  automationName: z.string().max(80),
  repository: z.strictObject({ path: absolutePath, dev: decimal, ino: decimal }),
  evidence: evidenceSchema.nullable(),
  revision: z.number().int().positive(),
  trigger: z.enum(["schedule", "manual"]),
  scheduledFor: isoInstant.nullable(),
  claimedAt: isoInstant,
  startedAt: isoInstant.nullable(),
  endedAt: isoInstant.nullable(),
  status: z.enum(EXECUTION_STATUSES),
  reason: z.enum(EXECUTION_REASONS).nullable(),
  runId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .nullable(),
  /** Permission requests denied because they were outside the saved policy. */
  denials: z.number().int().min(0),
  changedFiles: z.number().int().min(0).nullable(),
});
export type Execution = z.infer<typeof executionSchema>;

const serviceBlockSchema = z.strictObject({
  reason: z.enum(["leftover_agent", "persistence_failed"]),
  executionId: z.uuid().nullable(),
  runId: z.string().max(64).nullable(),
});
export const automationStateSchema = z.strictObject({
  format: z.literal(AUTOMATION_STATE_FORMAT),
  revision: z.number().int().min(0),
  sequence: z.number().int().min(0),
  pausedAll: z.boolean(),
  block: serviceBlockSchema.nullable(),
  automations: z.array(automationSchema).max(AUTOMATION_LIMIT),
  executions: z.array(executionSchema).max(5000),
});
export type AutomationState = z.infer<typeof automationStateSchema>;

export interface ServiceStatus {
  version: number;
  appVersion: string;
  pid: number;
  startedAt: string;
  revision: number;
  pausedAll: boolean;
  block: z.infer<typeof serviceBlockSchema> | null;
  activeExecutionId: string | null;
}

const id = z.uuid({ error: "Invalid automation ID" });
const revision = z.number().int().positive();
export const automationRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("get"), id }),
  z.strictObject({
    action: z.literal("history"),
    id: id.optional(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(AUTOMATION_HISTORY_PAGE).optional(),
  }),
  z.strictObject({ action: z.literal("create"), draft: automationDraftSchema }),
  z.strictObject({ action: z.literal("update"), id, revision, draft: automationDraftSchema }),
  z.strictObject({ action: z.literal("setEnabled"), id, revision, enabled: z.boolean() }),
  z.strictObject({ action: z.literal("delete"), id, revision }),
  z.strictObject({ action: z.literal("runNow"), id }),
  z.strictObject({ action: z.literal("cancel"), id }),
  z.strictObject({ action: z.literal("pauseAll"), cancelActive: z.boolean() }),
  z.strictObject({ action: z.literal("resumeAll") }),
  z.strictObject({ action: z.literal("resolveBlock") }),
  z.strictObject({ action: z.literal("transcript"), executionId: z.uuid() }),
  z.strictObject({ action: z.literal("diff"), executionId: z.uuid() }),
  z.strictObject({ action: z.literal("subscribe") }),
]);
export type AutomationRequest = z.input<typeof automationRequestSchema>;

export const automationEnvelopeSchema = z.strictObject({
  v: z.literal(AUTOMATION_PROTOCOL_VERSION),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.uuid(),
  request: automationRequestSchema,
});

const AUTOMATION_ERROR_CODES = [
  "unauthorized",
  "invalid",
  "version",
  "not_found",
  "conflict",
  "refused",
  "unavailable",
  "internal",
] as const;
export type AutomationErrorCode = (typeof AUTOMATION_ERROR_CODES)[number];
export const automationResponseSchema = z.union([
  z.strictObject({ v: z.number().int(), id: z.uuid(), ok: z.literal(true), result: z.unknown() }),
  z.strictObject({
    v: z.number().int(),
    id: z.uuid().nullable(),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(AUTOMATION_ERROR_CODES),
      message: z.string().max(500),
    }),
  }),
  z.strictObject({
    v: z.number().int(),
    notice: z.literal("changed"),
    revision: z.number().int().min(0),
  }),
]);
export type AutomationResponse = z.infer<typeof automationResponseSchema>;

interface AutomationTranscriptEntry {
  at: string;
  type: "prompt" | "message" | "tool" | "permission" | "status" | "note";
  text: string;
}
export interface AutomationTranscript {
  executionId: string;
  runId: string;
  entries: AutomationTranscriptEntry[];
  truncated: boolean;
}
export interface AutomationDiff {
  executionId: string;
  runId: string;
  text: string;
  truncated: boolean;
}

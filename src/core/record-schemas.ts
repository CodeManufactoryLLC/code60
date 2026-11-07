import { z } from "zod";
import { runIdSchema, stopReasonSchema, toolKindSchema } from "../contracts/index.js";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "idle",
  "finished",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

const nativeIdentitySchema = z.object({
  createdAt: z.string().regex(/^\d{1,20}$/),
  owner: z.string().regex(/^S-\d+(?:-\d+)+$/),
  job: z
    .string()
    .regex(/^Local\\Code60-[a-f\d-]{36}$/)
    .optional(),
});

// Stored records may contain additional metadata from a newer writer. Validate the known
// fields and discard unknown ones; IPC and configuration objects instead reject extra fields.
export const runRecordSchema = z
  .object({
    id: runIdSchema,
    agent: z.string(),
    status: runStatusSchema,
    firstPrompt: z.string(),
    turns: z.number().int().nonnegative(),
    /** Commit the worktree started from; null for runs directly in a directory. */
    base: z.string().nullable(),
    /** The run's branch; null for runs directly in a directory. */
    branch: z.string().nullable(),
    worktree: z.string().min(1),
    ownerPid: z.number().int().positive(),
    agentPid: z.number().int().positive().optional(),
    ownerIdentity: nativeIdentitySchema.optional(),
    agentIdentity: nativeIdentitySchema.optional(),
    agentCommand: z.array(z.string()).readonly().optional(),
    /** Absent on records written before explicit session recovery was added. */
    acpSessionId: z.string().optional(),
    /** The command line reported by ps, used to guard against reused PIDs. */
    agentCommandLine: z.string().optional(),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    lastStopReason: stopReasonSchema.optional(),
    reason: z.string().optional(),
    discardedAt: z.string().optional(),
  })
  .refine(
    (record) => (record.base === null) === (record.branch === null),
    "Inconsistent worktree metadata",
  );

export const runEventBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    status: runStatusSchema,
    reason: z.string().optional(),
    turn: z.number().int().positive().optional(),
    completedAt: z.string().optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    turn: z.number().int().positive(),
    text: z.string(),
    /** Absent for prompts the user wrote; "automatic" for prompts Code60 generated itself. */
    origin: z.literal("automatic").optional(),
  }),
  z.object({ type: z.literal("message"), text: z.string() }),
  z.object({ type: z.literal("thought"), text: z.string() }),
  z.object({
    type: z.literal("toolCall"),
    toolCallId: z.string(),
    title: z.string(),
    kind: toolKindSchema,
    status: z.string(),
  }),
  z.object({
    type: z.literal("permission"),
    toolCallId: z.string(),
    title: z.string(),
    kind: toolKindSchema,
    decision: z.enum(["allowed", "denied"]),
    by: z.enum(["policy", "user"]),
    /** Absent on events written before permission options were recorded. */
    options: z
      .array(z.object({ optionId: z.string(), name: z.string(), kind: z.string() }))
      .optional(),
  }),
  z.object({ type: z.literal("stderr"), text: z.string() }),
  z.object({ type: z.literal("note"), text: z.string(), detail: z.string().optional() }),
  z.object({
    type: z.literal("turnEnd"),
    turn: z.number().int().positive(),
    stopReason: stopReasonSchema,
    /** Actual prompt completion, before persistence/cleanup; absent in legacy records. */
    completedAt: z.string().optional(),
    outcome: z.enum(["finished", "cancelled", "timed_out", "failed", "interrupted"]).optional(),
  }),
  /** A raw ACP session update; `payload` is its JSON text, clipped when `truncated`. */
  z.object({
    type: z.literal("acp"),
    update: z.string(),
    payload: z.string(),
    size: z.number().int().nonnegative(),
    truncated: z.literal(true).optional(),
  }),
]);
/** Event types this version understands. Readers skip other types written by newer versions. */
export const RUN_EVENT_TYPES: ReadonlySet<string> = new Set(
  runEventBodySchema.options.map((option) => option.shape.type.value),
);
export const runEventSchema = z.intersection(
  z.object({ runId: runIdSchema, at: z.string() }),
  runEventBodySchema,
);

export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunEventBody = z.infer<typeof runEventBodySchema>;
export type RunEvent = z.infer<typeof runEventSchema>;

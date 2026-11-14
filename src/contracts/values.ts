import { z } from "zod";

// Disable code generation before constructing schemas in directly imported modules.
z.config({ jitless: true });

/** Browser-safe values shared by IPC, configuration, and persisted records. */
export const TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;
export const toolKindSchema = z.enum(TOOL_KINDS);
export type ToolKind = z.infer<typeof toolKindSchema>;
export const stopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);
export type StopReason = z.infer<typeof stopReasonSchema>;
export const runIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const permissionRuleSchema = z.enum(["allow", "deny", "ask"]);
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

const units: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
/** Preserve the duration grammar; reject totals that cannot be represented exactly. */
export const durationSchema = z.string().transform((text, ctx) => {
  const trimmed = text.trim();
  if (!/^(\d+(ms|s|m|h))+$/.test(trimmed)) {
    ctx.addIssue({
      code: "custom",
      message: `invalid duration '${text}' (use e.g. 30m, 90s, 1h30m)`,
    });
    return z.NEVER;
  }
  const total = [...trimmed.matchAll(/(\d+)(ms|s|m|h)/g)].reduce(
    (sum, match) => sum + Number(match[1]) * (units[match[2] ?? ""] ?? 0),
    0,
  );
  if (total <= 0 || !Number.isSafeInteger(total)) {
    ctx.addIssue({
      code: "custom",
      message:
        total <= 0
          ? `duration '${text}' must be greater than zero`
          : "duration must be a safe integer number of milliseconds",
    });
    return z.NEVER;
  }
  return total;
});

import { z } from "zod";

export * from "./logs.js";
export * from "./memory.js";

import { type OperatingContractClauses, type PromptId, validatePromptTemplate } from "./prompts.js";

// Disable code generation before constructing objects: even the eval capability probe
// triggers a CSP violation in the sandboxed renderer. Apply the same mode in Node.
z.config({ jitless: true });

export * from "./values.js";

/** Return one concise message, never a serialized Zod issue containing input data. */
export function parseValue<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value, { jitless: true });
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid value");
  return result.data;
}

export * from "./activity.js";
export * from "./automation.js";
export * from "./commands.js";
export * from "./mcp-tools.js";
export * from "./product.js";
export * from "./prompts.js";
export * from "./search-summary.js";
export * from "./session-state.js";
export * from "./tactics.js";

const promptTemplateSchema = (id: PromptId) =>
  z.string().superRefine((template, ctx) => {
    const problem = validatePromptTemplate(id, template);
    if (problem) ctx.addIssue({ code: "custom", message: `prompts.${id}: ${problem}` });
  });
export const operatingContractSchema = z
  .custom<OperatingContractClauses>(
    (value) => validatePromptTemplate("operatingContract", value) === undefined,
    { error: "Invalid Operating Contract clauses" },
  )
  .transform((clauses) => ({ ...clauses }));
/** User overrides for the built-in prompt templates, keyed by template ID. */
export const promptTemplatesSchema = z.strictObject({
  // Old single-block overrides reset to defaults rather than being migrated.
  operatingContract: z
    .union([operatingContractSchema, z.string().transform(() => undefined)])
    .optional(),
  handoffSummary: promptTemplateSchema("handoffSummary").optional(),
  handoffTurn: promptTemplateSchema("handoffTurn").optional(),
  workerUpdates: promptTemplateSchema("workerUpdates").optional(),
});

/** IPC limits historically count UTF-16 code units, including surrogate pairs. */
export function boundedString(label: string, max: number) {
  return z
    .string({ error: `Invalid ${label}` })
    .refine((value) => value.length <= max, `Invalid ${label}`);
}

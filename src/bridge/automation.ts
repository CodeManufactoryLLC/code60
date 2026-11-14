import { z } from "zod";
import {
  automationScheduleSchema,
  parseValue,
  rendererAutomationDraftSchema,
} from "../contracts/index.js";

export type { RendererAutomationDraft, ServiceStatus } from "../contracts/index.js";
export { TOOL_KINDS } from "../contracts/index.js";

const id = z.uuid();
const revision = z.number().int().positive();
const schema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("pickRepository") }),
  z.strictObject({ action: z.literal("preview"), schedule: automationScheduleSchema }),
  z.strictObject({ action: z.literal("get"), id }),
  z.strictObject({
    action: z.literal("history"),
    id: id.optional(),
    before: z.number().int().positive().optional(),
  }),
  z.strictObject({ action: z.literal("create"), draft: rendererAutomationDraftSchema }),
  z.strictObject({
    action: z.literal("update"),
    id,
    revision,
    draft: rendererAutomationDraftSchema,
  }),
  z.strictObject({ action: z.literal("setEnabled"), id, revision, enabled: z.boolean() }),
  z.strictObject({ action: z.literal("delete"), id, revision }),
  z.strictObject({ action: z.literal("runNow"), id }),
  z.strictObject({ action: z.literal("cancel"), id }),
  z.strictObject({ action: z.literal("pauseAll"), cancelActive: z.boolean() }),
  z.strictObject({ action: z.literal("resumeAll") }),
  z.strictObject({ action: z.literal("resolveBlock") }),
  z.strictObject({ action: z.literal("transcript"), executionId: id }),
  z.strictObject({ action: z.literal("diff"), executionId: id }),
  z.strictObject({
    action: z.literal("scheduler"),
    control: z.enum(["status", "install", "repair", "start", "stop", "uninstall"]),
  }),
]);
export type AutomationUiRequest = z.infer<typeof schema>;
export const parseAutomationUiRequest = (value: unknown): AutomationUiRequest =>
  parseValue(schema, value);
export interface AutomationSummary {
  id: string;
  revision: number;
  name: string;
  agent: string;
  enabled: boolean;
  nextRunAt: string | null;
}
export interface AutomationHistoryEntry {
  id: string;
  sequence: number;
  automationId: string;
  automationName: string;
  status: string;
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
  reason: string | null;
  denials: number;
  runId: string | null;
}
export interface AutomationEditor {
  id: string;
  revision: number;
  repositoryLabel: string;
  draft: z.infer<typeof rendererAutomationDraftSchema>;
}

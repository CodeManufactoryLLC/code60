import { z } from "zod";
import {
  boundedString,
  durationSchema,
  PROMPT_IDS,
  PROMPT_TEMPLATE_LIMIT,
  type PromptId,
  parseValue,
  runIdSchema,
  toolKindSchema,
  validatePromptTemplate,
} from "../contracts/index.js";
import type { GitWorktree, ListedRun, RunEvent, RunView } from "../core/index.js";

export {
  CODE60_COPYRIGHT,
  DEFAULT_PROMPT_TEMPLATES,
  findMcpTableTool,
  findMcpTool,
  isMcpControlTool,
  MCP_CONTROL_LIMITS,
  MCP_CONTROL_TOOL_DEFINITIONS,
  MCP_CONTROL_TOOLS,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCP_TABLE_TOOL_DEFINITIONS,
  MCP_TABLES,
  MCP_TOOL_CONTRACT_INFO,
  MCP_TOOL_DEFINITIONS,
  type McpControlTool,
  type McpControlToolDefinition,
  type McpTable,
  type McpTableToolDefinition,
  type McpToolDefinition,
  PROMPT_FIELDS,
  PROMPT_IDS,
  PROMPT_TEMPLATE_LIMIT,
  type PromptFields,
  type PromptId,
  type PromptTemplates,
  renderPrompt,
  validatePromptTemplate,
} from "../contracts/index.js";

/** Where a template's effective text comes from, highest priority first. */
export type PromptSource = "database" | "config" | "built-in";

export interface PromptTemplateState {
  id: PromptId;
  fields: readonly string[];
  /** The effective text used by this prompt. */
  template: string;
  source: PromptSource;
  /** What the template returns to when its saved edit is removed. */
  fallback: string;
  fallbackSource: Exclude<PromptSource, "database">;
}

export interface DesktopRun extends ListedRun {
  view?: RunView;
}

export interface SequencedEvent {
  revision: number;
  event: RunEvent;
}

export interface ProjectEntry {
  path: string;
  openedAt: string;
}

export interface WorktreeListing {
  repository: string | null;
  worktrees: GitWorktree[];
}

export const pollKeys = ["history", "config", "configurations", "worktrees", "files"] as const;
export type PollKey = (typeof pollKeys)[number];
export interface PollSetting {
  intervalMs: number | null;
  idleIntervalMs: number | null;
}
export const pollDefaults: Record<PollKey, PollSetting> = {
  history: { intervalMs: 5000, idleIntervalMs: 30000 },
  config: { intervalMs: 15000, idleIntervalMs: null },
  configurations: { intervalMs: null, idleIntervalMs: null },
  worktrees: { intervalMs: 30000, idleIntervalMs: 30000 },
  files: { intervalMs: 5000, idleIntervalMs: 5000 },
};
export const pollRanges: Record<PollKey, readonly [number, number]> = {
  history: [2000, 300000],
  config: [5000, 600000],
  configurations: [30000, 3600000],
  worktrees: [5000, 600000],
  files: [2000, 600000],
};
export type PollSettings = Record<PollKey, PollSetting>;
export type PollSettingsPatch = z.infer<typeof pollSettingsSchema>;
export interface PollResult {
  id: number;
  at: number;
  durationMs: number;
  trigger: "manual" | "timer" | "change";
  ok: boolean;
  error: string | null;
}
export interface PollState {
  key: PollKey;
  setting: PollSetting;
  status:
    | "unavailable"
    | "disabled"
    | "paused"
    | "hidden"
    | "idle"
    | "polling"
    | "healthy"
    | "failed";
  effectiveIntervalMs: number | null;
  polledAt: number | null;
  succeededAt: number | null;
  durationMs: number | null;
  nextAt: number | null;
  failures: number;
  lastError: string | null;
  history: PollResult[];
}
export interface Polling {
  paused: boolean;
  sources: PollState[];
}
export interface PollVisibility {
  visible: boolean;
  worktrees: boolean;
  files?: boolean | undefined;
}

export interface FileEntry {
  path: string;
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
}
export interface FileDirectory {
  path: string;
  entries: FileEntry[];
  error: string | null;
  truncated: boolean;
}
export interface FilePreview {
  path: string;
  text: string | null;
  size: number | null;
  modifiedAt: string | null;
  error: string | null;
}
export interface FileSnapshot {
  context: FileContext;
  directories: FileDirectory[];
  preview: FilePreview | null;
}
export type FileContext = z.infer<typeof fileContextSchema>;

export type DatabaseMode = "open" | "create";

/** Versions shown in Settings for inspection and bug reports. */
export interface Versions {
  code60: string;
  databaseSchema: number;
  runRecordFormat: number;
  acpProtocol: number;
  mcpProtocol: string;
  electron: string | null;
  chromium: string | null;
  node: string;
}

export interface Snapshot {
  versions: Versions;
  chat: OrchestrationChat;
  chats: OrchestrationChat[];
  orchestration: OrchestrationProvider;
  revision: number;
  database: string | null;
  databaseError: string | null;
  projects: ProjectEntry[];
  configurations: RunConfiguration[];
  directory: string | null;
  agents: string[];
  defaultAgent: string;
  maxParallel: number;
  turnTimeout: string;
  runs: DesktopRun[];
  liveIds: string[];
  active: boolean;
  warnings: string[];
  events: SequencedEvent[];
  worktrees: WorktreeListing | null;
  files: FileSnapshot | null;
  polling: Polling;
  prompts: PromptTemplateState[];
  /** Runs dispatched by the orchestration chat this launch; they always allow all actions once. */
  workers: string[];
}

export type StartRequest = z.infer<typeof startSchema>;
export type RunSettings = z.infer<typeof runSettingsSchema>;

export interface RunConfiguration {
  id: string;
  name: string;
  settings: RunSettings;
  uses: number;
  lastUsed: string | null;
}

export type SaveConfiguration = z.infer<typeof saveConfigurationSchema>;
export type SavePromptTemplate = z.infer<typeof savePromptTemplateSchema>;
export type Action = z.infer<typeof actionSchema>;

export type RecoveryActionResult = { type: "restored" } | { type: "handoff-started" };

export type ActionResult = string | RunEvent[] | RecoveryActionResult | undefined;

export interface DesktopApi {
  extractMemory(request: MemoryExtractionRequest): Promise<MemoryExtractionResult>;
  cancelMemoryExtraction(requestId: string): Promise<void>;
  setFileContext(context: FileContext | null): Promise<void>;
  orchestrationChatAction(request: OrchestrationChatAction): Promise<void>;
  windowAppearance(): Promise<{ transparent: boolean; enabled: boolean; clickThrough: boolean }>;
  setTransparent(enabled: boolean): Promise<void>;
  setBackgroundHitTest(ignore: boolean): Promise<void>;
  snapshot(): Promise<Snapshot>;
  /** Resolves false when the native picker is cancelled. */
  connectDatabase(mode: DatabaseMode): Promise<boolean>;
  /** Resolves false when the native picker is cancelled. */
  chooseFolder(): Promise<boolean>;
  openProject(path: string): Promise<void>;
  removeProject(path: string): Promise<void>;
  /** Asks for confirmation first; resolves false when declined. */
  clearProjects(): Promise<boolean>;
  poll(keys: PollKey[]): Promise<void>;
  setPollSettings(settings: PollSettingsPatch): Promise<void>;
  setPollingPaused(paused: boolean): Promise<void>;
  setVisibility(visibility: PollVisibility): Promise<void>;
  setOrchestrationProvider(provider: string | null): Promise<void>;
  testOrchestrationProvider(): Promise<void>;
  cancelOrchestrationTest(): Promise<void>;
  /** New session IDs in batch order; empty when confirmation is declined. */
  start(request: StartRequest): Promise<string[]>;
  saveConfiguration(request: SaveConfiguration): Promise<void>;
  deleteConfiguration(id: string): Promise<boolean>;
  /** Saves an edited template in the connected database. */
  savePromptTemplate(request: SavePromptTemplate): Promise<void>;
  /** Asks for confirmation, then removes the saved edit; resolves false when declined. */
  resetPromptTemplate(id: PromptId): Promise<boolean>;
  action(action: Action): Promise<ActionResult>;
  stopAll(): Promise<void>;
  subscribe(listener: (update: Snapshot) => void): () => void;
  /** Commands chosen from the native application menu. */
  onMenu(listener: (command: MenuCommand) => void): () => void;
}

export type MenuCommand = "open-project" | "database";

export interface OrchestrationProvider {
  provider: string | null;
  allowAll: true;
  connection: "idle" | "testing" | "connected" | "failed";
  error: string | null;
}

export interface OrchestrationChat {
  /** Current-project workers owned by this conversation, never inferred from process liveness. */
  workers?: string[];
  run: RunView | null;
  directory: string | null;
  error: string | null;
  events: SequencedEvent[];
  /** Worker updates waiting to be sent automatically between the chat's turns. */
  updates: { paused: boolean; pending: number };
}

export type OrchestrationChatAction = z.infer<typeof orchestrationChatActionSchema>;

const objectError = (issue: { code: string }) =>
  issue.code === "unrecognized_keys" ? "Unknown field" : "Expected an object";
const booleanSchema = z.boolean({ error: "Expected a boolean" });
const configurationIdSchema = boundedString("configuration ID", 80).pipe(runIdSchema);
const orchestrationChatActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("new") }),
  z.strictObject({ type: z.literal("select"), id: configurationIdSchema }),
  z.strictObject({
    type: z.literal("send"),
    id: configurationIdSchema,
    text: boundedString("message", 1_000_000).refine(
      (text) => text.trim().length > 0,
      "The message is empty",
    ),
  }),
  z.strictObject({
    type: z.literal("resume-updates"),
    id: configurationIdSchema,
  }),
  z.strictObject({
    type: z.enum(["restart", "stop", "cancel"]),
    id: configurationIdSchema.nullable(),
  }),
]);
const stringList = (label: string, max: number) =>
  z.array(boundedString(label, 128), { error: `Invalid ${label}` }).max(max, `Invalid ${label}`);

const startFieldsSchema = z.strictObject(
  {
    prompt: boundedString("prompt", 1_000_000).optional(),
    agents: stringList("agents", 32),
    parallel: boundedString("parallel", 256).optional(),
    base: boundedString("base", 256).optional(),
    turnTimeout: boundedString("turnTimeout", 256).optional(),
    allow: stringList("permissions", 11),
    allowAll: z.boolean({ error: "Invalid allowAll" }),
    configurationId: configurationIdSchema.optional(),
  },
  { error: objectError },
);

// Omit absent optional properties, preserving the exact optional request contract.
const startSchema = startFieldsSchema.transform(
  ({ prompt, parallel, base, turnTimeout, configurationId, ...required }) => ({
    ...required,
    ...(prompt === undefined ? {} : { prompt }),
    ...(parallel === undefined ? {} : { parallel }),
    ...(base === undefined ? {} : { base }),
    ...(turnTimeout === undefined ? {} : { turnTimeout }),
    ...(configurationId === undefined ? {} : { configurationId }),
  }),
);

const runSettingsSchema = startFieldsSchema
  .omit({ prompt: true, configurationId: true })
  .extend({
    agents: stringList("agents", 32).refine(
      (names) => names.length > 0 && names.every((name) => name.trim().length > 0),
      "Select at least one provider",
    ),
    parallel: boundedString("parallel", 256)
      .refine(
        (value) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)),
        "Invalid parallel count",
      )
      .optional(),
    base: boundedString("base", 256)
      .refine((value) => value.trim().length > 0 && !value.includes("\0"), "Invalid base revision")
      .optional(),
    allow: stringList("permissions", 11).refine(
      (kinds) => kinds.every((kind) => toolKindSchema.safeParse(kind).success),
      "Invalid permission kind",
    ),
    turnTimeout: boundedString("turnTimeout", 256)
      .refine((value) => durationSchema.safeParse(value).success, "Invalid turn timeout")
      .optional(),
  })
  .refine(
    (value) =>
      value.agents.length !== 1 || value.parallel === undefined || Number(value.parallel) <= 32,
    "Invalid parallel count",
  )
  .transform(({ parallel, base, turnTimeout, ...required }) => ({
    ...required,
    ...(parallel === undefined ? {} : { parallel }),
    ...(base === undefined ? {} : { base }),
    ...(turnTimeout === undefined ? {} : { turnTimeout }),
  }));

const saveConfigurationSchema = z
  .strictObject(
    {
      id: configurationIdSchema.optional(),
      name: boundedString("configuration name", 128)
        .trim()
        .refine(
          (name) =>
            name.length > 0 &&
            [...name].every(
              (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
            ),
          "Invalid configuration name",
        ),
      settings: runSettingsSchema.optional(),
      launchId: configurationIdSchema.optional(),
    },
    { error: objectError },
  )
  .refine(
    (value) => (value.settings === undefined) !== (value.launchId === undefined),
    "Supply settings or a launched batch",
  )
  .refine(
    (value) => value.id === undefined || value.launchId === undefined,
    "Cannot overwrite from a launch",
  );

const promptIdSchema = z.enum(PROMPT_IDS as [PromptId, ...PromptId[]], {
  error: "Unknown prompt template",
});
const savePromptTemplateSchema = z
  .strictObject(
    {
      id: promptIdSchema,
      template: boundedString("prompt template", PROMPT_TEMPLATE_LIMIT),
    },
    { error: objectError },
  )
  .superRefine(({ id, template }, ctx) => {
    const problem = validatePromptTemplate(id, template);
    if (problem) ctx.addIssue({ code: "custom", message: `Template ${problem}` });
  });

const actionSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject(
      {
        type: z.enum(["reply", "continue"]),
        id: runIdSchema,
        text: boundedString("prompt", 1_000_000),
      },
      { error: objectError },
    ),
    z.strictObject(
      {
        type: z.enum(["finish", "cancel", "diff", "discard", "stop", "events"]),
        id: runIdSchema,
      },
      { error: objectError },
    ),
    z.strictObject(
      {
        type: z.literal("permission"),
        id: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,63}#\d+$/, "Invalid permission ID")
          .max(80, "Invalid run ID"),
        answer: z.enum(["allow", "deny"], { error: "Invalid answer" }),
      },
      { error: objectError },
    ),
  ],
  { error: "Unknown action" },
);

const pollKeysSchema = z
  .array(z.enum(pollKeys), { error: "Invalid polling sources" })
  .min(1, "Invalid polling sources")
  .max(pollKeys.length, "Invalid polling sources")
  .refine((keys) => new Set(keys).size === keys.length, "Invalid polling sources");

function pollSettingSchema(key: PollKey) {
  const [min, max] = pollRanges[key];
  const interval = z
    .number({ error: `Invalid ${key} interval` })
    .int()
    .min(min)
    .max(max)
    .nullable()
    .refine((value) => key !== "history" || value !== null, "History polling cannot be disabled");
  return z
    .strictObject({ intervalMs: interval, idleIntervalMs: interval }, { error: objectError })
    .nullable()
    .optional();
}
const pollSettingsSchema = z
  .strictObject(
    {
      history: pollSettingSchema("history"),
      config: pollSettingSchema("config"),
      configurations: pollSettingSchema("configurations"),
      worktrees: pollSettingSchema("worktrees"),
      files: pollSettingSchema("files"),
    },
    { error: objectError },
  )
  .refine(
    (settings) => Object.values(settings).every((setting) => setting !== undefined),
    "Expected an object",
  );
const visibilitySchema = z.strictObject(
  { visible: booleanSchema, worktrees: booleanSchema, files: booleanSchema.optional() },
  { error: objectError },
);
const databaseModeSchema = z.enum(["open", "create"], { error: "Invalid database mode" });
const projectPathSchema = boundedString("project path", 4096).refine(
  (value) =>
    !value.includes("\0") &&
    (value.startsWith("/") ||
      (/^[a-z]:[\\/]/i.test(value) && !/[\r\n]/.test(value) && !value.slice(2).includes(":"))),
  "Invalid project path",
);

const relativeFilePathSchema = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      path === "" ||
      (!path.includes("\\") &&
        !path.includes("\0") &&
        path.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
    "Expected a relative file path without traversal",
  );
const fileContextSchema = z
  .strictObject({
    project: projectPathSchema,
    root: projectPathSchema,
    directories: z
      .array(relativeFilePathSchema)
      .min(1)
      .max(64)
      .refine(
        (paths) => paths.includes("") && new Set(paths).size === paths.length,
        "Invalid folders",
      ),
    preview: relativeFilePathSchema.refine((path) => path !== "", "Expected a file").nullable(),
  })
  .refine(
    (context) =>
      !/^[a-z]:[\\/]/i.test(context.root) ||
      [...context.directories, context.preview ?? ""].every(
        (path) =>
          path === "" ||
          (!/[:<>"|?*]/.test(path) &&
            [...path].every((character) => character.charCodeAt(0) >= 32) &&
            path
              .split("/")
              .every(
                (part) =>
                  !/[. ]$/.test(part) &&
                  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
              )),
      ),
    "Invalid Windows file path",
  );
export const parseFileContext = (value: unknown) => parseValue(fileContextSchema.nullable(), value);

export const parseBoolean = (value: unknown) => parseValue(booleanSchema, value);
export const parseOrchestrationChatAction = (value: unknown) =>
  parseValue(orchestrationChatActionSchema, value);
export const parseOrchestrationProvider = (value: unknown): string | null =>
  parseValue(
    boundedString("orchestration provider", 128)
      .refine(
        (name) =>
          name.trim().length > 0 &&
          [...name].every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
        "Invalid provider",
      )
      .nullable(),
    value,
  );
export const parsePollKeys = (value: unknown) => parseValue(pollKeysSchema, value);
export const parsePollSettings = (value: unknown) => parseValue(pollSettingsSchema, value);
export const parsePollVisibility = (value: unknown) => parseValue(visibilitySchema, value);
export const parseStart = (value: unknown) => parseValue(startSchema, value);
export const parseConfigurationId = (value: unknown) => parseValue(configurationIdSchema, value);
export const parseRunSettings = (value: unknown) => parseValue(runSettingsSchema, value);
export const parseSaveConfiguration = (value: unknown) =>
  parseValue(saveConfigurationSchema, value);
export const parsePromptTemplateId = (value: unknown) => parseValue(promptIdSchema, value);
export const parseSavePromptTemplate = (value: unknown) =>
  parseValue(savePromptTemplateSchema, value);
export const parseDatabaseMode = (value: unknown) => parseValue(databaseModeSchema, value);
export const parseProjectPath = (value: unknown) => parseValue(projectPathSchema, value);
export const parseAction = (value: unknown) => parseValue(actionSchema, value);

export { DEFAULT_EPISODIC_MEMORY_PROMPT } from "../contracts/index.js";

const memoryRequestIdSchema = z.string().uuid();
const memoryExtractionSchema = z
  .strictObject({
    requestId: memoryRequestIdSchema,
    directory: boundedString("project path", 4096).min(1),
    prompt: boundedString("extraction prompt", 8_000).refine(
      (text) => text.trim().length > 0,
      "Enter an extraction prompt",
    ),
    runs: z
      .array(
        z.strictObject({
          id: runIdSchema,
          count: z.number().int().min(1).max(10_000),
        }),
      )
      .min(1)
      .max(10_000),
  })
  .refine(
    (request) => new Set(request.runs.map((run) => run.id)).size === request.runs.length,
    "Duplicate session IDs",
  )
  .refine(
    (request) => request.runs.reduce((sum, run) => sum + run.count, 0) <= 10_000,
    "Extraction supports at most 10,000 events",
  );
export type MemoryExtractionRequest = z.infer<typeof memoryExtractionSchema>;
export interface MemoryExtractionResult {
  statements: string[];
  eventCount: number;
}
export const parseMemoryExtraction = (value: unknown): MemoryExtractionRequest =>
  parseValue(memoryExtractionSchema, value);
export const parseMemoryRequestId = (value: unknown): string =>
  parseValue(memoryRequestIdSchema, value);

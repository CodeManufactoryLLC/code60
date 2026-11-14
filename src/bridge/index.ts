export * from "./automation.js";
export * from "./database.js";
export * from "./details.js";
export * from "./logs.js";
export * from "./plans.js";
export type { ProjectRequestIdentity } from "./project-identity.js";
export * from "./projects.js";
export * from "./relay.js";
export * from "./relay-files.js";
export * from "./relay-reviews.js";
export * from "./tactics.js";
export * from "./web-links.js";

import { modeChangeSchema } from "../contracts/index.js";
import type { AgentSetupSnapshot, SetupAttempt, SetupBegin, SetupIdentity } from "./agent-setup.js";

export * from "./agent-setup.js";
export * from "./git-setup.js";

import { z } from "zod";
import {
  type ActivitySnapshot,
  boundedString,
  type Command,
  commandNameSchema,
  type DeleteCommand,
  deleteCommandSchema,
  durationSchema,
  operatingContractSchema,
  PROMPT_IDS,
  PROMPT_TEMPLATE_LIMIT,
  type PromptId,
  type PromptTemplate,
  parseValue,
  runIdSchema,
  type SaveCommand,
  SEARCH_EXCERPT_LIMIT,
  SEARCH_QUERY_LIMIT,
  SEARCH_SOURCE_LIMIT,
  type SearchSummarySource,
  saveCommandSchema,
  tacticIdSchema,
  toolKindSchema,
  validatePromptTemplate,
} from "../contracts/index.js";
import type { GitWorktree, ListedRun, RunEvent, RunView } from "../core/index.js";
import { projectRequestFields } from "./project-identity.js";
import type { WebLink } from "./web-links.js";

export {
  ACTIVITY_LIFETIME_MS,
  ACTIVITY_MESSAGE_MS,
  ACTIVITY_TYPES,
  type ActivityAcknowledgment,
  type ActivityDeclaration,
  type ActivitySnapshot,
  type ActivityState,
  assembleOperatingContract,
  availableCommands,
  BUILTIN_COMMANDS,
  CODE60_COPYRIGHT,
  COMMAND_LIMIT,
  type Command,
  commandFieldsSchema,
  commandSchema,
  DEFAULT_OPERATING_CONTRACT_CLAUSES,
  DEFAULT_PROMPT_TEMPLATES,
  type DeleteCommand,
  expandCommand,
  findMcpTableTool,
  isActivityTool,
  isMcpControlTool,
  leadingCommand,
  MCP_ACTIVITY_TOOL_DEFINITIONS,
  MCP_CONTROL_LIMITS,
  MCP_CONTROL_TOOL_DEFINITIONS,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCP_TABLE_TOOL_DEFINITIONS,
  MCP_TABLES,
  MCP_TOOL_DEFINITIONS,
  type McpControlTool,
  type McpTable,
  OPERATING_CONTRACT_CLAUSE_IDS,
  OPERATING_CONTRACT_CLAUSES,
  PROMPT_FIELDS,
  PROMPT_IDS,
  PROMPT_TEMPLATE_LIMIT,
  type PromptFields,
  type PromptId,
  type PromptTemplate,
  type PromptTemplates,
  parseActivityContextArgs,
  parseActivityReport,
  parseValue,
  renderPrompt,
  type SaveCommand,
  SEARCH_QUERY_LIMIT,
  SEARCH_SOURCE_LIMIT,
  type SearchSummarySource,
  searchEvidenceExcerpt,
  searchKeywords,
  validatePromptTemplate,
} from "../contracts/index.js";

/** Where a template's effective text comes from, highest priority first. */
export type PromptSource = "database" | "config" | "built-in";

export interface PromptTemplateState {
  id: PromptId;
  fields: readonly string[];
  /** The effective text used by this prompt. */
  template: PromptTemplate;
  source: PromptSource;
  /** What the template returns to when its saved edit is removed. */
  fallback: PromptTemplate;
  fallbackSource: Exclude<PromptSource, "database">;
}

export interface DesktopRun extends ListedRun {
  view?: RunView;
  replies?: { count: number; lastTurn: number };
  historyIncomplete?: boolean;
  /** Application-owned Relay workers are never implicitly bound to the selected project. */
  relay?: {
    conversationId: string;
    generation: number;
    taskId: string;
    targetId: string;
    cwd: string;
    workspaceMode: "direct" | "worktree";
    reviewId?: string;
  };
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
export interface PollScope {
  kind: "application" | "database" | "target";
  id: string;
}
export interface PollState {
  key: PollKey;
  scope?: PollScope;
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
  /** App metadata only. Detail revisions and caches are independent. */
  summaryOnly?: true;
  /** At most 128 active subscription UUIDs, with their last publication revisions. */
  detailRevisions?: Record<string, number>;
  openProjects?: import("./projects.js").OpenProject[];
  projectInstanceId?: string | null;
  databaseEpoch?: number;
  gitReadiness?: import("./git-setup.js").GitReadiness;
  reviews?: import("./reviews.js").ReviewSummary[];
  agentSetup?: AgentSetupSnapshot;
  versions: Versions;
  chat: OrchestrationChat;
  chats: OrchestrationChat[];
  orchestration: OrchestrationProvider;
  revision: number;
  /** Delta broadcasts only. Full snapshot reads have no predecessor. */
  previousRevision?: number;
  database: string | null;
  databaseError: string | null;
  projects: ProjectEntry[];
  configurations: RunConfiguration[];
  commands: Command[];
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

const diffIdentitySchema = z.strictObject({ requestId: z.string().uuid() });
const diffRequestSchema = diffIdentitySchema.extend({ id: runIdSchema });
export type DiffIdentity = z.infer<typeof diffIdentitySchema>;
export type DiffRequest = z.infer<typeof diffRequestSchema>;
export const parseDiffIdentity = (value: unknown) => parseValue(diffIdentitySchema, value);
export const parseDiffRequest = (value: unknown) => parseValue(diffRequestSchema, value);

export type RecoveryActionResult = { type: "restored" } | { type: "handoff-started" };

export type ActionResult = string | RunEvent[] | RecoveryActionResult | undefined;

export interface DesktopApi {
  automation(request: import("./automation.js").AutomationUiRequest): Promise<unknown>;
  onAutomationChanged(listener: () => void): () => void;
  memorySnapshot(): Promise<import("../contracts/index.js").MemorySnapshot>;
  browseMemories(
    request: import("../contracts/index.js").MemoryBrowse,
  ): Promise<import("../contracts/index.js").MemoryPage>;
  memoryDetail(request: { id: string }): Promise<import("../contracts/index.js").MemoryDetail>;
  memoryAction(request: import("../contracts/index.js").MemoryAction): Promise<boolean>;
  onMemoryChanged(listener: () => void): () => void;
  subscribeDetails(request: import("./details.js").DetailRequest): Promise<void>;
  readDetails(
    request: import("./details.js").DetailRequest,
  ): Promise<import("./details.js").DetailFrame>;
  unsubscribeDetails(request: import("./details.js").DetailIdentity): Promise<void>;
  setRelayFileContext(context: import("./relay-files.js").RelayFileContext): Promise<void>;
  onDetails(listener: (frame: import("./details.js").DetailFrame) => void): () => void;
  readRelayMessage(
    request: import("./relay.js").RelayMessageRead,
  ): Promise<import("./relay.js").RelayMessageSource>;
  relayReview(
    request: import("./relay-reviews.js").RelayReviewRequest,
  ): Promise<import("./relay-reviews.js").RelayReviewResponse>;
  projectAction(request: import("./projects.js").ProjectAction): Promise<void>;
  ragStatus(): Promise<import("./rag.js").RagStatus>;
  rebuildRag(request: import("./rag.js").RagIdentity): Promise<void>;
  retrieveRag(request: import("./rag.js").RagQuery): Promise<import("./rag.js").RagResults>;
  cancelRag(requestId: string): Promise<void>;
  clearRag(request: import("./rag.js").RagIdentity): Promise<boolean>;
  onRagStatus(listener: (status: import("./rag.js").RagStatus) => void): () => void;
  /** Confirms an HTTP(S) destination natively; false means cancelled or already pending. */
  openWebLink(request: WebLink): Promise<boolean>;
  queryLogs(request: import("./logs.js").LogQuery): Promise<import("./logs.js").LogPage>;
  logDetail(request: { id: string }): Promise<import("./logs.js").LogRecord | null>;
  clearLogs(request: { confirm: true }): Promise<boolean>;
  onLogsChanged(listener: () => void): () => void;
  readPlan(request: import("./plans.js").PlanRead): Promise<import("./plans.js").Plan>;
  planAction(request: import("./plans.js").PlanAction): Promise<void>;
  checkGit(
    request: import("./git-setup.js").GitProject,
  ): Promise<import("./git-setup.js").GitReadiness>;
  beginGitSetup(
    request: import("./git-setup.js").GitProject,
  ): Promise<import("./git-setup.js").GitSetupSession>;
  previewGitSetupFile(
    request: import("./git-setup.js").GitSetupFileRequest,
  ): Promise<FilePreview | null>;
  initializeGit(
    request: import("./git-setup.js").GitSetupIdentity,
  ): Promise<import("./git-setup.js").GitSetupOutcome>;
  commitGitSetup(
    request: import("./git-setup.js").GitSetupCommit,
  ): Promise<import("./git-setup.js").GitSetupOutcome>;
  cancelGitSetup(request: import("./git-setup.js").GitProject): Promise<void>;
  readReview(request: import("./reviews.js").ReviewRead): Promise<import("./reviews.js").Review>;
  taskAction(request: import("./tasks.js").TaskAction): Promise<import("./tasks.js").TaskView>;
  reviewAction(request: import("./reviews.js").ReviewAction): Promise<string>;
  captureReview(request: import("./reviews.js").ReviewRead): Promise<void>;
  readReviewFile(
    request: import("./reviews.js").ReviewFileRead,
  ): Promise<import("./reviews.js").ReviewContent>;
  readDiff(request: DiffRequest): Promise<string>;
  cancelDiff(request: DiffIdentity): Promise<void>;
  beginAgentSetup(request: SetupBegin): Promise<void>;
  attemptAgentSetup(request: SetupAttempt): Promise<void>;
  cancelAgentSetup(request: SetupIdentity): Promise<void>;
  finishAgentSetup(request: SetupIdentity): Promise<void>;
  abandonAgentSetup(request: SetupIdentity): Promise<void>;
  update(action: UpdateAction): Promise<UpdateState>;
  onUpdate(listener: (state: UpdateState) => void): () => void;
  summarizeSearch(request: SearchSummaryRequest): Promise<SearchSummaryResult>;
  cancelSearchSummary(requestId: string): Promise<void>;
  extractMemory(request: MemoryExtractionRequest): Promise<MemoryExtractionResult>;
  cancelMemoryExtraction(requestId: string): Promise<void>;
  setFileContext(context: FileContext | null): Promise<void>;
  orchestrationChatAction(request: OrchestrationChatAction): Promise<void>;
  windowAppearance(): Promise<{ transparent: boolean; enabled: boolean; clickThrough: boolean }>;
  setWindowTheme(dark: boolean): Promise<void>;
  setTransparent(enabled: boolean): Promise<void>;
  setBackgroundHitTest(ignore: boolean): Promise<void>;
  snapshot(): Promise<Snapshot>;
  /** Initial app state and gap recovery without transcript/file payloads. */
  appSummary?(): Promise<Snapshot>;
  /** Resolves false when the native picker is cancelled. */
  connectDatabase(mode: DatabaseMode, databaseEpoch?: number): Promise<boolean>;
  /** Resolves false when the native picker is cancelled. */
  chooseFolder(databaseEpoch?: number): Promise<boolean>;
  openProject(path: string, databaseEpoch?: number): Promise<void>;
  removeProject(path: string, databaseEpoch?: number): Promise<void>;
  /** Asks for confirmation first; resolves false when declined. */
  clearProjects(databaseEpoch?: number): Promise<boolean>;
  poll(
    keys: PollKey[],
    identity?: import("./project-identity.js").ProjectRequestIdentity,
  ): Promise<void>;
  setPollSettings(settings: PollSettingsPatch): Promise<void>;
  setPollingPaused(paused: boolean): Promise<void>;
  setVisibility(visibility: PollVisibility): Promise<void>;
  setOrchestrationProvider(provider: string | null): Promise<void>;
  testOrchestrationProvider(): Promise<void>;
  cancelOrchestrationTest(): Promise<void>;
  /** New session IDs in batch order; empty when confirmation is declined. */
  start(request: StartRequest): Promise<string[]>;
  saveConfiguration(request: SaveConfiguration, databaseEpoch?: number): Promise<void>;
  saveCommand(request: SaveCommand, databaseEpoch?: number): Promise<void>;
  /** Asks for native confirmation; false when declined. */
  deleteCommand(request: DeleteCommand, databaseEpoch?: number): Promise<boolean>;
  deleteConfiguration(id: string, databaseEpoch?: number): Promise<boolean>;
  /** Saves an edited template in the connected database. */
  savePromptTemplate(request: SavePromptTemplate, databaseEpoch?: number): Promise<void>;
  /** Asks for confirmation, then removes the saved edit; resolves false when declined. */
  resetPromptTemplate(id: PromptId, databaseEpoch?: number): Promise<boolean>;
  action(action: Action): Promise<ActionResult>;
  stopAll(): Promise<void>;
  subscribe(listener: (update: Snapshot) => void): () => void;
  /** Commands chosen from the native application menu. */
  onMenu(listener: (command: MenuCommand) => void): () => void;
}

export type MenuCommand = "open-project" | "database";

const updateActionSchema = z.enum([
  "status",
  "check",
  "download",
  "cancel",
  "install",
  "auto-on",
  "auto-off",
]);
export type UpdateAction = z.infer<typeof updateActionSchema>;
export const parseUpdateAction = (value: unknown): UpdateAction => updateActionSchema.parse(value);

export interface UpdateState {
  revision: number;
  status:
    | "unavailable"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  version: string | null;
  percent: number;
  message: string;
  autoCheck: boolean;
}

export interface OrchestrationProvider {
  provider: string | null;
  allowAll: true;
  connection: "idle" | "testing" | "connected" | "failed";
  error: string | null;
}

export interface OrchestrationChat {
  historySaving?: "available" | "unavailable";
  projectId?: string;
  kind?: "relay" | "project";
  conversationId?: string;
  generation?: number;
  /** Constant-size change hint; review collections remain explicit bounded reads. */
  reviewRevision?: number;
  /** Constant-size unread summary, independent of transcript/detail subscriptions. */
  replies?: { count: number; lastTurn: number };
  history?: {
    messages?: {
      id: string;
      role: "human" | "assistant" | "activity";
      at: string;
      text: string;
      partial?: boolean;
      source?: string;
    }[];
    serialized: string;
    characters: number;
    older: boolean;
    incomplete: boolean;
    cursor: string | null;
  };
  /** Absent only for legacy/disconnected snapshots; null is an explicit removal. */
  tactic?: string | null;
  restored?: boolean;
  taskId?: string;
  title?: string;
  archived?: boolean;
  plans?: import("./plans.js").PlanSummary[];
  /** Ephemeral live presentation, never reconstructed from transcript history. */
  activity?: ActivitySnapshot;
  /** Current-project workers owned by this conversation, never inferred from process liveness. */
  workers?: string[];
  /** Role names the orchestrator assigned when dispatching, by worker run ID. */
  workerLabels?: Record<string, string>;
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
  z.strictObject({
    type: z.literal("history"),
    id: runIdSchema,
    before: z.string().uuid().nullable(),
  }),
  z.strictObject({
    type: z.literal("set-tactic"),
    id: runIdSchema,
    project: z.string().max(32_768).nullable(),
    tactic: tacticIdSchema.nullable(),
  }),
  z.strictObject({ type: z.literal("continue-task"), id: runIdSchema, taskId: z.string().uuid() }),
  z.strictObject({ type: z.literal("set-mode"), id: runIdSchema, change: modeChangeSchema }),
  z.strictObject({ type: z.literal("new"), projectId: z.string().uuid().optional() }),
  z.strictObject({ type: z.literal("select"), id: configurationIdSchema }),
  z.strictObject({ type: z.literal("archive"), id: configurationIdSchema }),
  z.strictObject({
    type: z.literal("rename"),
    id: configurationIdSchema,
    title: boundedString("chat title", 120).refine(
      (title) =>
        title.trim().length > 0 &&
        [...title].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      "Use a nonempty, single-line title",
    ),
  }),
  z.strictObject({
    type: z.literal("send"),
    id: configurationIdSchema,
    command: commandNameSchema.optional(),
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
    projectId: z.string().uuid().optional(),
    databaseEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
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
const startSchema = startFieldsSchema
  .transform(
    ({
      prompt,
      parallel,
      base,
      turnTimeout,
      configurationId,
      projectId,
      databaseEpoch,
      ...required
    }) => ({
      ...required,
      ...(projectId === undefined ? {} : { projectId }),
      ...(databaseEpoch === undefined ? {} : { databaseEpoch }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(parallel === undefined ? {} : { parallel }),
      ...(base === undefined ? {} : { base }),
      ...(turnTimeout === undefined ? {} : { turnTimeout }),
      ...(configurationId === undefined ? {} : { configurationId }),
    }),
  )
  .refine(
    (request) => (request.projectId === undefined) === (request.databaseEpoch === undefined),
    "Project identity and database epoch must be supplied together",
  );

const runSettingsSchema = startFieldsSchema
  .omit({ prompt: true, configurationId: true, projectId: true, databaseEpoch: true })
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
      template: z.union([
        boundedString("prompt template", PROMPT_TEMPLATE_LIMIT),
        operatingContractSchema,
      ]),
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
    z.strictObject({ type: z.literal("set-mode"), id: runIdSchema, change: modeChangeSchema }),
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
const pollRequestSchema = z
  .strictObject({
    keys: pollKeysSchema,
    ...projectRequestFields,
  })
  .refine(
    (request) => request.projectId === undefined || request.databaseEpoch !== undefined,
    "Project polling requires a database epoch",
  );

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
    projectId: z.string().uuid().optional(),
    databaseEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    active: z.boolean().optional(),
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
    (context) => (context.projectId === undefined) === (context.databaseEpoch === undefined),
    "Project identity and database epoch are required together",
  )
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
export const parsePollRequest = (value: unknown) => parseValue(pollRequestSchema, value);
export const parsePollSettings = (value: unknown) => parseValue(pollSettingsSchema, value);
export const parsePollVisibility = (value: unknown) => parseValue(visibilitySchema, value);
export const parseStart = (value: unknown) => parseValue(startSchema, value);
export const parseConfigurationId = (value: unknown) => parseValue(configurationIdSchema, value);
export const parseRunSettings = (value: unknown) => parseValue(runSettingsSchema, value);
export const parseSaveConfiguration = (value: unknown) =>
  parseValue(saveConfigurationSchema, value);
export const parseSaveCommand = (value: unknown) => parseValue(saveCommandSchema, value);
export const parseDeleteCommand = (value: unknown) => parseValue(deleteCommandSchema, value);
export const parsePromptTemplateId = (value: unknown) => parseValue(promptIdSchema, value);
export const parseSavePromptTemplate = (value: unknown) =>
  parseValue(savePromptTemplateSchema, value);
export const parseDatabaseMode = (value: unknown) => parseValue(databaseModeSchema, value);
export const parseProjectPath = (value: unknown) => parseValue(projectPathSchema, value);
export const parseAction = (value: unknown) => parseValue(actionSchema, value);

export type {
  MemoryAction,
  MemoryBrowse,
  MemoryCandidate,
  MemoryDetail,
  MemoryGeneration,
  MemoryPage,
  MemoryRecord,
  MemorySettings,
  MemorySnapshot,
  MemorySource,
} from "../contracts/index.js";
export {
  DEFAULT_EPISODIC_MEMORY_PROMPT,
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_TYPES,
  memoryRecordSchema,
  memorySettingsSchema,
  memorySourceSchema,
} from "../contracts/index.js";
export * from "./memory.js";
export * from "./rag.js";

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

const searchSummarySchema = z
  .strictObject({
    requestId: memoryRequestIdSchema,
    directory: boundedString("project path", 4096).min(1),
    query: boundedString("search query", SEARCH_QUERY_LIMIT).refine(
      (value) => value.trim().length > 0,
      "Enter a search query",
    ),
    includeFiles: z.boolean().optional(),
    sources: z
      .array(
        z.strictObject({
          id: boundedString("source ID", 4096).min(1),
          kind: z.enum(["project", "run", "prompt", "message", "thought"]),
          title: boundedString("source title", 512),
          text: boundedString("source excerpt", SEARCH_EXCERPT_LIMIT),
          runId: runIdSchema.optional(),
          eventIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        }),
      )
      .max(SEARCH_SOURCE_LIMIT),
  })
  .refine(
    (request) =>
      new Set(request.sources.map((source) => source.id)).size === request.sources.length,
    "Duplicate search sources",
  );
export type SearchSummaryRequest = z.infer<typeof searchSummarySchema>;
export interface SearchSummaryResult {
  requestId: string;
  text: string;
  sources: SearchSummarySource[];
}
export const parseSearchSummary = (value: unknown): SearchSummaryRequest =>
  parseValue(searchSummarySchema, value);
export const parseSearchSummaryRequestId = (value: unknown): string =>
  parseValue(memoryRequestIdSchema, value);

export * from "./reviews.js";
export { parseTaskAction, type TaskAction, type TaskView } from "./tasks.js";

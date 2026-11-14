import { randomUUID } from "node:crypto";
import {
  type Automation,
  type AutomationRequest,
  automationClient,
  automationRoot,
  schedulerControl,
  subscribeService,
} from "../automation/index.js";
import { type AutomationEditor, parseAutomationUiRequest } from "../bridge/index.js";
import { upcomingOccurrences } from "../core/index.js";

/** Renderer capabilities resolve only here; a displayed path never grants execution. */
export class DesktopAutomations {
  private readonly repositories = new Map<string, { path: string; expires: number }>();
  private unwatch: (() => void) | undefined;
  private watching = false;
  private generation = 0;
  constructor(
    private readonly env: Readonly<NodeJS.ProcessEnv>,
    private readonly dialogs: {
      pick(): Promise<string | null>;
      confirm(title: string, detail: string): Promise<boolean>;
    },
    private readonly changed: () => void,
    private readonly providers: () => string[],
  ) {}
  reset() {
    this.generation++;
    this.repositories.clear();
    this.unwatch?.();
    this.unwatch = undefined;
    this.watching = false;
  }
  private async watch() {
    if (this.watching) return;
    this.watching = true;
    const generation = this.generation;
    try {
      const off = await subscribeService(automationRoot(this.env), (disconnected) => {
        if (disconnected) {
          this.unwatch = undefined;
          this.watching = false;
        }
        this.changed();
      });
      if (generation !== this.generation) off();
      else this.unwatch = off;
    } catch {
      this.watching = false;
    }
  }
  async request(value: unknown): Promise<unknown> {
    const request = parseAutomationUiRequest(value);
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation)
        throw new Error("Automation view was replaced. Retry the action.");
    };
    const client = automationClient(this.env);
    if (request.action === "pickRepository") {
      const path = await this.dialogs.pick();
      check();
      if (!path || !(await this.dialogs.confirm("Use this automation repository?", path)))
        return null;
      check();
      for (const [id, choice] of this.repositories)
        if (choice.expires < Date.now()) this.repositories.delete(id);
      if (this.repositories.size >= 32)
        this.repositories.delete(this.repositories.keys().next().value ?? "");
      const token = randomUUID();
      this.repositories.set(token, { path, expires: Date.now() + 10 * 60_000 });
      return { token, label: path };
    }
    if (request.action === "preview")
      return upcomingOccurrences(request.schedule, new Date(), 5).map((value) =>
        value.toISOString(),
      );
    if (request.action === "scheduler") {
      if (
        request.control !== "status" &&
        !(await this.dialogs.confirm(
          `${request.control} background execution?`,
          "The local service can run saved prompts while Code60 is quit. Your computer must be awake and logged in. Worktrees are not a sandbox. Stop/uninstall pauses schedules and preserves evidence.",
        ))
      )
        return null;
      check();
      return schedulerControl(this.env, request.control, true);
    }
    if (request.action === "create" || request.action === "update") {
      if (!this.providers().includes(request.draft.agent))
        throw new Error("Choose an enabled, verified provider.");
      const token = request.draft.repositoryToken;
      const choice = token ? this.repositories.get(token) : undefined;
      if (token && (!choice || choice.expires < Date.now()))
        throw new Error("Repository choice expired. Choose it again.");
      const previous =
        request.action === "update"
          ? ((await client({ action: "get", id: request.id })) as Automation)
          : null;
      const repository = choice?.path ?? previous?.repository.path;
      if (!repository) throw new Error("Choose an automation repository.");
      const { repositoryToken: _token, ...fields } = request.draft;
      check();
      const result = await client({ ...request, draft: { ...fields, repository } });
      if (token) this.repositories.delete(token);
      await this.watch();
      return result ? { ok: true } : null;
    }
    if (request.action === "delete") {
      if (
        !(await this.dialogs.confirm(
          "Delete automation?",
          "Cancel active work first. Saved run evidence and worktrees will be kept.",
        ))
      )
        return null;
      check();
    }
    const result = await client(request as AutomationRequest);
    await this.watch();
    if (request.action === "get") {
      const automation = result as Automation;
      return {
        id: automation.id,
        revision: automation.revision,
        repositoryLabel: automation.repository.path,
        draft: {
          name: automation.name,
          prompt: automation.prompt,
          agent: automation.agent,
          baseBranch: automation.baseBranch,
          allow: automation.allow,
          turnTimeout: automation.turnTimeout,
          schedule: automation.schedule,
          enabled: automation.enabled,
        },
      } satisfies AutomationEditor;
    }
    return result;
  }
}

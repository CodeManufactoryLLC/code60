import { join } from "node:path";
import { type AutomationState, automationStateSchema } from "../contracts/index.js";
import {
  fileCode,
  lockPrivateState,
  readPrivateJson,
  writePrivateJson,
} from "../platform/index.js";

const STATE_LIMIT = 16 * 1024 * 1024;
export const emptyState = (): AutomationState => ({
  format: 1,
  revision: 0,
  sequence: 0,
  pausedAll: false,
  block: null,
  automations: [],
  executions: [],
});

export interface StateWriter {
  readonly state: AutomationState;
  save(next: AutomationState): Promise<void>;
}

export class AutomationStore implements StateWriter {
  private constructor(
    private readonly path: string,
    public state: AutomationState,
    readonly close: () => Promise<void>,
  ) {}

  static async open(root: string): Promise<AutomationStore> {
    const release = await lockPrivateState(root);
    const path = join(root, "state.json");
    try {
      let state: AutomationState;
      try {
        state = automationStateSchema.parse(await readPrivateJson(path, STATE_LIMIT));
      } catch (error) {
        if (fileCode(error) !== "ENOENT") throw error;
        state = emptyState();
        await writePrivateJson(path, state, undefined, STATE_LIMIT);
      }
      return new AutomationStore(path, state, release);
    } catch (error) {
      await release();
      throw error;
    }
  }

  async save(next: AutomationState): Promise<void> {
    const parsed = automationStateSchema.parse(next);
    await writePrivateJson(this.path, parsed, this.state, STATE_LIMIT);
    this.state = parsed;
  }
}

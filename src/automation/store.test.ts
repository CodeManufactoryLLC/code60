import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "code60-automation-"));
  roots.push(root);
  return join(root, "code60", "automations");
};
describe("automation store", () => {
  it("holds exclusive ownership and preserves metadata across restart", async () => {
    const root = await temporary();
    const store = await AutomationStore.open(root);
    await expect(AutomationStore.open(root)).rejects.toThrow("already running");
    await store.save({ ...store.state, revision: 1, pausedAll: true });
    await store.close();
    const reopened = await AutomationStore.open(root);
    expect(reopened.state.pausedAll).toBe(true);
    await reopened.close();
  });
  it("refuses corrupt, externally changed and unsafe state without resetting it", async () => {
    const root = await temporary();
    const store = await AutomationStore.open(root);
    await writeFile(join(root, "state.json"), "invalid", { mode: 0o600 });
    await expect(store.save({ ...store.state, revision: 1 })).rejects.toThrow();
    await store.close();
    await expect(AutomationStore.open(root)).rejects.toThrow();
    if (process.platform !== "win32") {
      await chmod(join(root, "state.json"), 0o644);
      await expect(AutomationStore.open(root)).rejects.toThrow("permissions");
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRequest } from "../contracts/index.js";
import { readPrivateJson, writePrivateJson } from "../platform/index.js";
import { prepareSchedulerUpdate, restoreSchedulerUpdate } from "./registration.js";
import { automationRoot } from "./service.js";

const fake = vi.hoisted(() => ({
  running: true,
  pausedAll: false,
  request: vi.fn(),
  control: vi.fn(),
}));
vi.mock("../platform/index.js", async (original) => ({
  ...(await original<object>()),
  controlUserService: fake.control,
}));
vi.mock("./service.js", async (original) => ({
  ...(await original<object>()),
  automationClient: () => fake.request,
}));
const roots: string[] = [];
beforeEach(() => {
  fake.running = true;
  fake.pausedAll = false;
  fake.request.mockReset().mockImplementation(async (request: AutomationRequest) => {
    if (!fake.running) throw new Error("offline");
    if (request.action === "pauseAll") fake.pausedAll = true;
    if (request.action === "resumeAll") fake.pausedAll = false;
    return { pausedAll: fake.pausedAll, activeExecutionId: null, block: null };
  });
  fake.control.mockReset().mockImplementation(async (_definition, action) => {
    fake.running = action !== "stop";
    return { available: fake.running };
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(installed = true) {
  const root = await mkdtemp(join(tmpdir(), "c60-update-"));
  roots.push(root);
  const env = { ...process.env, XDG_STATE_HOME: root };
  // The production store has already created this private directory.
  const { privateDirectory } = await import("../platform/index.js");
  await privateDirectory(automationRoot(env));
  await writePrivateJson(
    join(automationRoot(env), "registration.json"),
    { installed, runtime: {} },
    undefined,
    16_384,
  );
  return { env, marker: join(automationRoot(env), "update-restart.json") };
}
describe("scheduler update recovery", () => {
  it.each([false, true])(
    "restores a running scheduler with previous pausedAll=%s",
    async (paused) => {
      const s = await setup();
      fake.pausedAll = paused;
      await prepareSchedulerUpdate(s.env);
      expect(fake.running).toBe(false);
      expect(fake.pausedAll).toBe(true);
      expect(await readPrivateJson(s.marker, 4096)).toEqual({ version: 1, pausedAll: paused });
      await restoreSchedulerUpdate(s.env);
      expect(fake.control.mock.calls.map((call) => call[1])).toEqual(["stop", "repair"]);
      expect(fake.running).toBe(true);
      expect(fake.pausedAll).toBe(paused);
      await expect(readPrivateJson(s.marker, 4096)).rejects.toMatchObject({ code: "ENOENT" });
      await restoreSchedulerUpdate(s.env);
      expect(fake.control).toHaveBeenCalledTimes(2);
    },
  );
  it("does not start a scheduler that was stopped before the update", async () => {
    const s = await setup();
    fake.running = false;
    await prepareSchedulerUpdate(s.env);
    await restoreSchedulerUpdate(s.env);
    expect(fake.control).not.toHaveBeenCalled();
  });
  it("preserves restart intent after a failed repair for the next startup", async () => {
    const s = await setup();
    await prepareSchedulerUpdate(s.env);
    fake.control.mockRejectedValueOnce(new Error("supervisor unavailable"));
    await expect(restoreSchedulerUpdate(s.env)).rejects.toThrow("supervisor");
    expect(await readPrivateJson(s.marker, 4096)).toEqual({ version: 1, pausedAll: false });
    await restoreSchedulerUpdate(s.env);
    expect(fake.pausedAll).toBe(false);
  });
  it("never installs an unregistered standalone scheduler without consent", async () => {
    const s = await setup(false);
    await expect(prepareSchedulerUpdate(s.env)).rejects.toThrow("standalone");
    expect(fake.control).not.toHaveBeenCalled();
    expect(fake.pausedAll).toBe(false);
  });
});

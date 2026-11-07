import { describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../bridge/index.js";
import { prepareFileNavigation } from "./file-navigation.js";

const scope = { database: "/db", directory: "/project" };
const snapshot = () => ({ ...scope, worktrees: null }) as Snapshot;
describe("project-root file navigation", () => {
  it("ignores legacy worktree roots without polling inventory", async () => {
    const latest = snapshot();
    const api = { poll: vi.fn(async () => {}), snapshot: vi.fn(async () => latest) };
    expect(await prepareFileNavigation(api, scope, "/worker")).toBe(latest);
    expect(api.poll).not.toHaveBeenCalled();
  });
  it("discards late navigation across project and database changes", async () => {
    for (const changed of [{ directory: "/other" }, { database: "/other-db" }]) {
      const api = { poll: vi.fn(), snapshot: vi.fn(async () => ({ ...snapshot(), ...changed })) };
      expect(await prepareFileNavigation(api, scope, "/private-chat")).toBeNull();
    }
  });
  it("requires a project and propagates snapshot failures", async () => {
    const api = {
      poll: vi.fn(),
      snapshot: vi.fn(async (): Promise<Snapshot> => {
        throw Error("Unavailable");
      }),
    };
    await expect(prepareFileNavigation(api, { ...scope, directory: null })).rejects.toThrow(
      "Open a project",
    );
    await expect(prepareFileNavigation(api, scope)).rejects.toThrow("Unavailable");
  });
});

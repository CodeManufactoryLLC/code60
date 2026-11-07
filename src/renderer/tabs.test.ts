import { describe, expect, it } from "vitest";
import { initialTabs, updateTabs } from "./tabs.js";

describe("page tabs", () => {
  it("starts on Chat with all eleven permanent tabs", () => {
    expect(initialTabs).toEqual({
      open: [
        "chat",
        "episodic-memory",
        "sessions",
        "messages",
        "events",
        "search",
        "configurations",
        "worktrees",
        "polling",
        "prompts",
        "settings",
      ],
      active: "chat",
    });
    for (const id of initialTabs.open) {
      expect(updateTabs(initialTabs, { type: "close", id })).toBe(initialTabs);
    }
  });
  it("selects the existing Settings tab without duplicating it", () => {
    const settings = updateTabs(initialTabs, { type: "open", id: "settings" });
    expect(settings.open).toBe(initialTabs.open);
    expect(settings.active).toBe("settings");
    expect(updateTabs(settings, { type: "open", id: "settings" })).toEqual(settings);
    expect(updateTabs(settings, { type: "close", id: "settings" })).toBe(settings);
    expect(updateTabs(settings, { type: "select", id: "chat" })).toEqual(initialTabs);
  });
  it("routes legacy Files actions to Chat without recreating a Files page", () => {
    const settings = updateTabs(initialTabs, { type: "select", id: "settings" });
    for (const type of ["open", "select"] as const) {
      const result = updateTabs(settings, { type, id: "files" });
      expect(result.active).toBe("chat");
      expect(result.open).not.toContain("files");
    }
  });
});

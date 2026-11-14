import { describe, expect, it, vi } from "vitest";
import {
  pageAvailable,
  pageCommands,
  pageDefinitions,
  pageGroup,
  pages,
  pagesInGroup,
  renderedPages,
  resolvePage,
  settingsSectionIds,
} from "./navigation.js";

describe("navigation registry", () => {
  it("defines every static destination once and routes aliases to rendered pages", () => {
    expect(new Set(pages.map((page) => page.id)).size).toBe(pages.length);
    expect(renderedPages.map((page) => page.id)).toEqual(
      pages.filter((page) => page.id !== "files").map((page) => page.id),
    );
    expect(resolvePage("files")).toBe("chat");
    for (const section of settingsSectionIds) expect(pageGroup(section)).toBe("settings");
    expect(pageGroup("episodic-memory")).toBe("advanced");
    expect(pageGroup("rag")).toBe("advanced");
    expect(pagesInGroup("experiments")).toEqual(["episodic-memory", "rag"]);
  });
  it("keeps tables alphabetical and primary navigation in its documented order", () => {
    const labels = pagesInGroup("tables").map((id) => pageDefinitions[id].label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(pagesInGroup("apps")).toEqual(["commands", "prompts"]);
    expect(pagesInGroup("primary")).toEqual(["home", "automations", "apps", "search"]);
  });
  it("uses the same availability for palette and sidebar, including database-free Logs", () => {
    for (const database of [null, "/db"]) {
      const navigate = vi.fn();
      const commands = pageCommands("chat", database, navigate, "Ctrl+,");
      for (const command of commands) {
        const id = command.id as keyof typeof pageDefinitions;
        expect(command.disabled).toBe(!pageAvailable(id, database));
        command.run();
        if (command.disabled) expect(navigate).not.toHaveBeenCalledWith(id);
        else expect(navigate).toHaveBeenCalledWith(id);
      }
    }
    expect(pageAvailable("logs", null)).toBe(true);
    expect(pageAvailable("automations", null)).toBe(true);
    expect(pageAvailable("memories", null)).toBe(true);
    expect(pageAvailable("settings", null)).toBe(true);
    expect(pageAvailable("apps", null)).toBe(true);
    expect(pageAvailable("sessions", null)).toBe(false);
  });
});

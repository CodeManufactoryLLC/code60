import { describe, expect, it } from "vitest";
import { emptyChats, updateChats } from "./chats.js";

const startup = () =>
  updateChats(emptyChats, { type: "sync", ids: ["a", "b", "old"], live: ["a", "b"] });

describe("chat dock state", () => {
  it("adds live chats on startup, all minimized, including reload", () => {
    expect(startup().entries).toEqual([
      { id: "a", expanded: false },
      { id: "b", expanded: false },
    ]);
    expect(emptyChats.entries).toEqual([]);
  });
  it("opens multiple independent chats without duplicates", () => {
    const state = updateChats(startup(), { type: "open", id: "b" });
    expect(state.entries).toEqual([
      { id: "a", expanded: false },
      { id: "b", expanded: true },
    ]);
    expect(updateChats(state, { type: "open", id: "b" })).toBe(state);
  });
  it("minimizes live and historical chats without removing their footer", () => {
    const opened = updateChats(startup(), { type: "open", id: "old" });
    const ended = updateChats(opened, { type: "sync", ids: ["a", "b", "old"], live: [] });
    expect(updateChats(ended, { type: "minimize", id: "old" }).entries).toEqual([
      { id: "a", expanded: false },
      { id: "b", expanded: false },
      { id: "old", expanded: false },
    ]);
    expect(updateChats(ended, { type: "minimize", id: "missing" })).toBe(ended);
  });
  it("does not resurrect closed chats on routine live snapshots", () => {
    const closed = updateChats(startup(), { type: "close", id: "a" });
    expect(updateChats(closed, { type: "sync", ids: ["a", "b", "old"], live: ["a", "b"] })).toBe(
      closed,
    );
    expect(updateChats(closed, { type: "open", id: "a" }).entries.at(-1)).toEqual({
      id: "a",
      expanded: true,
    });
  });
  it("reorders without changing open/minimized state", () => {
    const state = startup();
    const moved = updateChats(state, { type: "move", id: "b", to: 0 });
    expect(moved.entries).toEqual([
      { id: "b", expanded: false },
      { id: "a", expanded: false },
    ]);
    expect(state.entries[0]?.id).toBe("a");
    expect(updateChats(moved, { type: "move", id: "b", to: -5 })).toBe(moved);
    expect(updateChats(moved, { type: "move", id: "b", to: 99 }).entries).toEqual(state.entries);
    expect(updateChats(moved, { type: "move", id: "missing", to: 0 })).toBe(moved);
    expect(updateChats(moved, { type: "move", id: "a", to: Number.NaN })).toBe(moved);
  });
  it("drops unavailable sessions and minimizes every session of a new batch", () => {
    const state = updateChats(startup(), { type: "close", id: "a" });
    const next = updateChats(state, { type: "sync", ids: ["old", "c", "d"], live: ["c", "d"] });
    expect(next.entries).toEqual([
      { id: "c", expanded: false },
      { id: "d", expanded: false },
    ]);
  });
  it("appends additional live sessions without changing existing visibility or order", () => {
    const state = updateChats(startup(), { type: "move", id: "b", to: 0 });
    expect(
      updateChats(state, { type: "sync", ids: ["a", "b", "c"], live: ["a", "b", "c"] }).entries,
    ).toEqual([...state.entries, { id: "c", expanded: false }]);
  });
});

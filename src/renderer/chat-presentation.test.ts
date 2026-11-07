import { describe, expect, it, vi } from "vitest";
import type { DesktopRun } from "../bridge/index.js";
import type { RunEvent, RunStatus, RunView } from "../core/index.js";
import {
  delegatedActivity,
  durationText,
  newestMessage,
  sessionStatus,
  timingText,
  turnTimings,
} from "./chat-presentation.js";
import { copyMessage } from "./message-controls.js";
import { transcript } from "./state.js";

const at = (seconds: number) => new Date(seconds * 1000).toISOString();
const event = (seconds: number, body: object) =>
  ({ runId: "a", at: at(seconds), ...body }) as RunEvent;
const prompt = (seconds: number, turn = 1) =>
  event(seconds, { type: "prompt", turn, text: " prompt\n" });
const view = (status: RunStatus, patch: Partial<RunView> = {}) =>
  ({ status, turns: 1, stopping: false, pending: [], ...patch }) as RunView;
const worker = (id: string, status: RunStatus, patch: Partial<RunView> = {}) =>
  ({ record: { id, status }, view: view(status, patch) }) as DesktopRun;

describe("authoritative activity", () => {
  it("isolates ownership and excludes idle, ended, and process-only sessions", () => {
    const runs = [
      worker("a", "running"),
      worker("b", "waiting"),
      worker("c", "idle"),
      worker("d", "failed"),
    ];
    expect(delegatedActivity(["a"], runs)).toBe("1 subagent: working");
    expect(delegatedActivity(["a", "b"], runs)).toBe("2 subagents: waiting for approval");
    expect(delegatedActivity(["c", "d", "unknown"], runs)).toBe("");
    expect(delegatedActivity([], runs)).toBe("");
    expect(
      delegatedActivity(["a"], [{ record: { id: "a" }, agentAlive: true } as DesktopRun]),
    ).toBe("");
    expect(delegatedActivity(["c"], [worker("c", "idle", { stopping: true })])).toBe(
      "1 subagent: stopping",
    );
  });
  it("distinguishes all dock transitions with labels and icons", () => {
    const transitions = [
      view("queued"),
      view("running", { turns: 0 }),
      view("running"),
      view("waiting"),
      view("idle"),
      view("running", { stopping: true }),
      view("failed"),
      view("finished"),
      view("cancelled"),
      view("timed_out"),
      view("interrupted"),
    ];
    expect(transitions.map((run) => sessionStatus(run).label)).toEqual([
      "Queued",
      "Connecting",
      "Working",
      "Approval needed",
      "Awaiting input",
      "Stopping",
      "Failed",
      "Finished",
      "Cancelled",
      "Timed out",
      "Interrupted",
    ]);
    expect(transitions.every((run) => sessionStatus(run).icon.length)).toBe(true);
  });
});

describe("message ages and turn history", () => {
  it("uses only original response chunk times, not replay or other event types", () => {
    const events = [
      prompt(1),
      event(2, { type: "message", text: "hi" }),
      event(3, { type: "message", text: " there" }),
      event(20, { type: "thought", text: "thinking" }),
      event(25, { type: "status", status: "idle" }),
    ];
    expect(newestMessage(events)).toBe(3000);
    expect(newestMessage(structuredClone(events))).toBe(3000);
    expect(newestMessage([prompt(100)])).toBeUndefined();
    expect(newestMessage([{ ...events[1], at: "invalid" } as RunEvent])).toBeNull();
    expect(newestMessage([event(1, { type: "message", text: "" })])).toBeUndefined();
  });
  it("excludes startup/idle, includes permissions, freezes completion and separates followups", () => {
    const events = [
      event(1, { type: "status", status: "queued" }),
      prompt(10),
      event(12, { type: "status", status: "waiting" }),
      event(94, { type: "turnEnd", turn: 1, stopReason: "end_turn" }),
      prompt(200, 2),
    ];
    const groups = [...turnTimings(events, "running").values()];
    if (!groups[0] || !groups[1]) throw new Error("Missing turn timing");
    expect(timingText(groups[0], 999999)).toBe("Worked for 1m 24s (finished)");
    expect(timingText(groups[1], 212000)).toBe("Working for 12s");
    expect([...turnTimings(structuredClone(events), "running").values()]).toEqual(groups);
    expect([...turnTimings([prompt(1)], "idle").values()][0]?.active).toBe(false);
  });
  it("preserves precise timeout/failure timing and marks legacy crash timing incomplete", () => {
    for (const outcome of ["cancelled", "timed_out", "failed", "interrupted"]) {
      const terminal = event(100, {
        type: "status",
        status: outcome,
        turn: 1,
        completedAt: at(22),
      });
      const timing = [...turnTimings([prompt(10), terminal], outcome as RunStatus).values()][0];
      if (!timing) throw new Error("Missing terminal timing");
      expect(timingText(timing, 999999)).toBe(`Worked for 12s (${outcome.replaceAll("_", " ")})`);
    }
    const incomplete = [
      ...turnTimings(
        [prompt(10), event(100, { type: "status", status: "interrupted" })],
        "interrupted",
      ).values(),
    ][0];
    if (!incomplete) throw new Error("Missing incomplete timing");
    expect(timingText(incomplete, 999999)).toBe("Timing unavailable / incomplete (interrupted)");
    const timeout = [
      ...turnTimings(
        [
          prompt(10),
          event(40, {
            type: "turnEnd",
            turn: 1,
            stopReason: "cancelled",
            outcome: "timed_out",
            completedAt: at(22),
          }),
        ],
        "idle",
      ).values(),
    ][0];
    if (!timeout) throw new Error("Missing timeout timing");
    expect(timingText(timeout, 999999)).toBe("Worked for 12s (timed out)");
    const legacy = [
      ...turnTimings(
        [
          prompt(10),
          event(22, { type: "turnEnd", turn: 1, stopReason: "cancelled" }),
          event(100, { type: "status", status: "timed_out" }),
        ],
        "timed_out",
      ).values(),
    ][0];
    if (!legacy) throw new Error("Missing legacy timeout timing");
    expect(timingText(legacy, 999999)).toBe("Worked for 12s (timed out)");
  });
  it("formats clocks safely without negative or fabricated durations", () => {
    expect(durationText(-10)).toBe("0s");
    expect(durationText(3724000)).toBe("1h 2m 4s");
    for (const start of [NaN, 20])
      expect(timingText({ key: "0", turn: 1, start, end: 10, active: false }, 30)).toContain(
        "unavailable",
      );
  });
});

describe("plain-source Copy", () => {
  it("captures current streaming source and awaits completion", async () => {
    const events = [prompt(1), event(2, { type: "message", text: "```ts\n  x();\n```\n" })];
    const blocks = transcript(events);
    let finish = () => {};
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let complete = false;
    const copied = copyMessage(blocks[1]?.text ?? "", write).then(() => {
      complete = true;
    });
    events.push(event(3, { type: "message", text: "later" }));
    events.splice(
      2,
      0,
      event(3, {
        type: "acp",
        update: "agent_message_chunk",
        payload: "{}",
        size: 2,
      }),
    );
    expect(write).toHaveBeenCalledWith("```ts\n  x();\n```\n");
    expect(complete).toBe(false);
    finish();
    await copied;
    expect(complete).toBe(true);
    expect(transcript(structuredClone(events))[0]?.text).toBe(" prompt\n");
    expect(transcript(structuredClone(events))[1]?.text).toBe("```ts\n  x();\n```\nlater");
  });
  it("propagates clipboard failure for actionable retry", async () => {
    await expect(
      copyMessage(" source ", async () => {
        throw Error("Denied");
      }),
    ).rejects.toThrow("Denied");
    const write = vi.fn(async () => {});
    await copyMessage(" source ", write);
    expect(write).toHaveBeenCalledWith(" source ");
  });
});

import { describe, expect, it } from "vitest";
import type { AutomationSchedule } from "../contracts/index.js";
import { dueDecision, localInstants, nextOccurrence, upcomingOccurrences } from "./recurrence.js";

const date = (value: string) => new Date(value);
const interval: AutomationSchedule = {
  type: "interval",
  everyMinutes: 5,
  anchor: "2026-01-01T00:00:00.000Z",
};

describe("automation recurrence", () => {
  it("keeps the claimed high-water mark across a backward clock correction", () => {
    const claimed = date("2026-01-01T00:05:00Z");
    for (const saved of [claimed, date("2026-01-01T00:10:00Z"), null]) {
      const decision = dueDecision(interval, saved, date("2026-01-01T00:04:59Z"), claimed);
      expect(decision.type).toBe("wait");
      expect(decision.nextRunAt.toISOString()).toBe("2026-01-01T00:10:00.000Z");
    }
  });
  it("anchors intervals rather than drifting from run completion", () => {
    expect(nextOccurrence(interval, date("2026-01-01T00:06:12Z")).toISOString()).toBe(
      "2026-01-01T00:10:00.000Z",
    );
    expect(nextOccurrence(interval, date("2025-12-31T23:00:00Z")).toISOString()).toBe(
      interval.anchor,
    );
    expect(nextOccurrence(interval, date(interval.anchor)).toISOString()).toBe(
      "2026-01-01T00:05:00.000Z",
    );
  });

  it("skips DST gaps and runs at only the first repeated local time", () => {
    const daily: AutomationSchedule = {
      type: "daily",
      time: "02:30",
      timeZone: "America/New_York",
    };
    expect(nextOccurrence(daily, date("2026-03-08T05:00:00Z")).toISOString()).toBe(
      "2026-03-09T06:30:00.000Z",
    );
    const repeated = { ...daily, time: "01:30" };
    expect(nextOccurrence(repeated, date("2026-11-01T04:00:00Z")).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(nextOccurrence(repeated, date("2026-11-01T05:31:00Z")).toISOString()).toBe(
      "2026-11-02T06:30:00.000Z",
    );
    expect(
      localInstants({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, daily.timeZone),
    ).toEqual([Date.parse("2026-11-01T05:30:00Z"), Date.parse("2026-11-01T06:30:00Z")]);
  });

  it("handles half-hour DST transitions and zones across the date line", () => {
    expect(
      localInstants({ year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, "Australia/Lord_Howe"),
    ).toEqual([]);
    expect(
      nextOccurrence(
        { type: "daily", time: "00:00", timeZone: "Pacific/Kiritimati" },
        date("2026-01-01T09:59:00Z"),
      ).toISOString(),
    ).toBe("2026-01-01T10:00:00.000Z");
  });

  it("previews weekly days in the selected zone, including a skipped Sunday", () => {
    const weekly: AutomationSchedule = {
      type: "weekly",
      days: [0],
      time: "02:30",
      timeZone: "America/New_York",
    };
    expect(
      upcomingOccurrences(weekly, date("2026-03-07T00:00:00Z"), 2).map((v) => v.toISOString()),
    ).toEqual(["2026-03-15T06:30:00.000Z", "2026-03-22T06:30:00.000Z"]);
    expect(upcomingOccurrences(weekly, date("2026-03-07T00:00:00Z"), 0)).toEqual([]);
  });

  it("advances directly after downtime, waits before due, and handles backward clock changes", () => {
    const due = date("2026-01-01T00:05:00Z");
    expect(dueDecision(interval, due, date("2026-01-01T00:04:00Z")).type).toBe("wait");
    expect(dueDecision(interval, due, date("2026-01-01T00:05:01Z")).type).toBe("run");
    const missed = dueDecision(interval, due, date("2026-02-01T00:01:00Z"));
    expect(missed.type).toBe("missed");
    expect(missed.nextRunAt.toISOString()).toBe("2026-02-01T00:05:00.000Z");
    expect(
      dueDecision(
        interval,
        date("2026-02-01T00:05:00Z"),
        date("2026-01-01T00:01:00Z"),
      ).nextRunAt.toISOString(),
    ).toBe("2026-01-01T00:05:00.000Z");
    expect(dueDecision(interval, null, date("2026-01-01T00:01:00Z")).type).toBe("wait");
  });
});

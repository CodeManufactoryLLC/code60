import { describe, expect, it } from "vitest";
import {
  automationDraftSchema,
  automationEnvelopeSchema,
  automationScheduleSchema,
  branchNameSchema,
  rendererAutomationDraftSchema,
} from "../src/contracts/index.js";

const draft = {
  name: "Check",
  prompt: "Run checks",
  agent: "droid",
  repository: "/repo",
  baseBranch: "main",
  allow: ["read"],
  turnTimeout: "30m",
  enabled: false,
  schedule: { type: "interval", everyMinutes: 1, anchor: "2026-01-01T00:00:00Z" },
};

describe("automation contracts", () => {
  it("validates without transforming saved timeouts", () => {
    expect(automationDraftSchema.parse(draft).turnTimeout).toBe("30m");
    for (const turnTimeout of ["", "0m", "oops", "9007199254740992h"])
      expect(automationDraftSchema.safeParse({ ...draft, turnTimeout }).success).toBe(false);
  });
  it("rejects unknown fields and renderer filesystem capabilities", () => {
    expect(automationDraftSchema.safeParse({ ...draft, shell: "bad" }).success).toBe(false);
    expect(rendererAutomationDraftSchema.safeParse(draft).success).toBe(false);
    const { repository: _repository, ...renderer } = draft;
    expect(rendererAutomationDraftSchema.safeParse(renderer).success).toBe(true);
  });
  it("rejects unsafe branch names, permissions and invalid schedules", () => {
    for (const branch of ["--help", "../main", "a.lock", "a/.hidden", "a..b", "a//b"])
      expect(branchNameSchema.safeParse(branch).success).toBe(false);
    expect(branchNameSchema.safeParse("feature/checks").success).toBe(true);
    for (const schedule of [
      { type: "daily", time: "25:00", timeZone: "UTC" },
      { type: "daily", time: "12:00", timeZone: "Not/AZone" },
      { type: "weekly", days: [1, 1], time: "12:00", timeZone: "UTC" },
      { type: "interval", everyMinutes: 0, anchor: "2026-01-01T00:00:00Z" },
      { type: "interval", everyMinutes: 10081, anchor: "2026-01-01T00:00:00Z" },
      { type: "interval", everyMinutes: 1, anchor: "tomorrow" },
    ])
      expect(automationScheduleSchema.safeParse(schedule).success).toBe(false);
    expect(
      automationDraftSchema.safeParse({ ...draft, allow: ["execute", "execute"] }).success,
    ).toBe(false);
  });
  it("requires protocol version, token and strict fixed actions", () => {
    const envelope = {
      v: 1,
      id: "00000000-0000-4000-8000-000000000001",
      token: "a".repeat(64),
      request: { action: "status" },
    };
    expect(automationEnvelopeSchema.safeParse(envelope).success).toBe(true);
    for (const change of [{ v: 2 }, { token: "" }, { request: { action: "exec", command: "bad" } }])
      expect(automationEnvelopeSchema.safeParse({ ...envelope, ...change }).success).toBe(false);
  });
});

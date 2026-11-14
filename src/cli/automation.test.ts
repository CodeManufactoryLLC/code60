import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_HELP, automationCommand } from "./automation.js";
import { run } from "./run.js";

const id = "00000000-0000-4000-8000-000000000001";
const harness = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (v: string) => out.push(v) },
      stderr: { write: (v: string) => err.push(v) },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
};
describe("automation CLI", () => {
  it("prints help and preserves non-TTY JSON output", async () => {
    const h = harness();
    await automationCommand("automation", ["--help"], h.io);
    expect(h.out()).toBe(AUTOMATION_HELP);
    const json = harness();
    const request = vi.fn(async () => ({ ok: true }));
    expect(await automationCommand("automation", ["run", id, "--json"], json.io, request)).toBe(0);
    expect(request).toHaveBeenCalledWith({ action: "runNow", id });
    expect(JSON.parse(json.out())).toEqual({ ok: true });
    expect(json.err()).toBe("");
  });
  it("requires revisions and explicit deletion consent, without prompting", async () => {
    const h = harness();
    const request = vi.fn(async () => null);
    await expect(
      automationCommand("automation", ["delete", id, "--revision", "1"], h.io, request),
    ).rejects.toThrow("--yes");
    await expect(automationCommand("automation", ["disable", id], h.io, request)).rejects.toThrow(
      "--revision",
    );
    await automationCommand("automation", ["disable", id, "--revision", "2"], h.io, request);
    expect(request).toHaveBeenLastCalledWith({
      action: "setEnabled",
      id,
      revision: 2,
      enabled: false,
    });
    await expect(automationCommand("automation", ["run", "bad"], h.io, request)).rejects.toThrow(
      "Invalid",
    );
  });
  it("sends fixed supervisor controls and returns useful errors from the real entry point", async () => {
    const h = harness();
    const control = vi.fn(async () => ({ available: true }));
    await automationCommand("scheduler", ["install", "--yes", "--json"], h.io, undefined, control);
    expect(control).toHaveBeenCalledWith(process.env, "install", true);
    expect(await run(["automation", "delete", id], h.io)).toBe(2);
    expect(h.err()).toContain("--yes");
    expect(await run(["scheduler", "--help"], h.io)).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_FRAME_LIMIT } from "../contracts/index.js";
import { readPrivateJson } from "../platform/index.js";
import { AutomationError } from "./errors.js";
import {
  listenService,
  receiveFrames,
  serviceAddress,
  serviceRequest,
  subscribeService,
} from "./protocol.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "c60-ipc-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const listeners = new Set<(revision: number) => void>();
  const handle = vi.fn(async () => ({ result: true }));
  const server = await listenService(root, handle, (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  cleanups.push(() => server.close());
  const token = ((await readPrivateJson(join(root, "connection.json"), 4096)) as { token: string })
    .token;
  const raw = (frame: string) =>
    new Promise<unknown>((resolve) => {
      const socket = createConnection(serviceAddress(root));
      socket.on("error", () => resolve(null));
      socket.once("connect", () => socket.write(frame));
      socket.once("close", () => resolve(null));
      receiveFrames(socket, (value) => {
        resolve(value);
        socket.destroy();
      });
    });
  return { root, token, handle, listeners, raw };
}
describe("private scheduler protocol", () => {
  it("explains how to save when the scheduler has not been started", async () => {
    const root = await mkdtemp(join(tmpdir(), "c60-ipc-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const operation of [
      serviceRequest(root, { action: "list" }),
      subscribeService(root, () => {}),
    ])
      await expect(operation).rejects.toMatchObject({
        code: "unavailable",
        message: "Scheduler is not running. Install or start the background service.",
      });
  });
  it("authenticates fixed requests and returns safe typed errors", async () => {
    const s = await setup();
    expect(await serviceRequest(s.root, { action: "status" })).toEqual({ result: true });
    expect(s.handle).toHaveBeenCalledWith({ action: "status" });
    const unauthorized = await s.raw(
      `${JSON.stringify({ v: 1, id: randomUUID(), token: "b".repeat(64), request: { action: "list" } })}\n`,
    );
    expect(unauthorized).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    s.handle.mockRejectedValueOnce(new AutomationError("conflict", "Reload."));
    await expect(serviceRequest(s.root, { action: "list" })).rejects.toThrow("Reload");
    s.handle.mockRejectedValueOnce(new Error("/secret/provider/prompt"));
    await expect(serviceRequest(s.root, { action: "list" })).rejects.toThrow("could not complete");
  });
  it("rejects malformed, oversized and wrong-version frames before dispatch", async () => {
    const s = await setup();
    expect(await s.raw("bad\n")).toBe(null);
    expect(await s.raw(`${"x".repeat(AUTOMATION_FRAME_LIMIT + 1)}\n`)).toBe(null);
    expect(
      await s.raw(
        `${JSON.stringify({ v: 2, id: randomUUID(), token: s.token, request: { action: "status" } })}\n`,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(s.handle).not.toHaveBeenCalled();
  });
  it("pushes bounded notices and releases subscriptions when clients close", async () => {
    const s = await setup();
    const notice = vi.fn();
    const off = await subscribeService(s.root, notice);
    await vi.waitFor(() => expect(s.listeners.size).toBe(1));
    for (const listener of s.listeners) listener(12);
    await vi.waitFor(() => expect(notice).toHaveBeenCalled());
    off();
    await vi.waitFor(() => expect(s.listeners.size).toBe(0));
  });
});

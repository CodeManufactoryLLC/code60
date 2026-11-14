import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  AUTOMATION_FRAME_LIMIT,
  type AutomationRequest,
  type AutomationResponse,
  automationEnvelopeSchema,
  automationResponseSchema,
} from "../contracts/index.js";
import {
  fileCode,
  readPrivateJson,
  verifyPrivatePath,
  writePrivateJson,
} from "../platform/index.js";
import { AutomationError } from "./errors.js";

export const serviceAddress = (root: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\code60-scheduler-${createHash("sha256").update(root).digest("hex").slice(0, 32)}`
    : join(root, "service.sock");
const endpointPath = (root: string) => join(root, "connection.json");
async function connectionMetadata(root: string) {
  const raw = (await readPrivateJson(endpointPath(root), 4096).catch((error) => {
    if (fileCode(error) !== "ENOENT") throw error;
    throw new AutomationError(
      "unavailable",
      "Scheduler is not running. Install or start the background service.",
    );
  })) as { v?: unknown; token?: unknown } | null;
  if (raw?.v !== 1 || typeof raw.token !== "string" || !/^[a-f0-9]{64}$/.test(raw.token))
    throw new AutomationError("unavailable", "Scheduler connection metadata is invalid.");
  return { token: raw.token };
}

function send(socket: Socket, value: AutomationResponse) {
  const frame = `${JSON.stringify(value)}\n`;
  if (
    Buffer.byteLength(frame) > AUTOMATION_FRAME_LIMIT ||
    socket.writableLength > AUTOMATION_FRAME_LIMIT
  ) {
    socket.destroy();
    return;
  }
  socket.write(frame);
}

/** Bytes are bounded before decoding. Never split or accept invalid UTF-8 frames. */
export function receiveFrames(socket: Socket, receive: (value: unknown) => void) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    if (buffer.length + chunk.length > AUTOMATION_FRAME_LIMIT) {
      socket.destroy();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) break;
      const frame = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        receive(JSON.parse(decoder.decode(frame)));
      } catch {
        socket.destroy();
        return;
      }
    }
  });
}

export async function listenService(
  root: string,
  handle: (request: AutomationRequest) => Promise<unknown>,
  subscribe: (listener: (revision: number) => void) => () => void,
) {
  await verifyPrivatePath(root, true);
  const address = serviceAddress(root);
  if (process.platform !== "win32") {
    if (Buffer.byteLength(address) > 100)
      throw new Error("Scheduler state path is too long for a local socket");
    const existing = await lstat(address).catch((error) => {
      if (fileCode(error) !== "ENOENT") throw error;
      return null;
    });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.())
        throw new Error("Unsafe scheduler endpoint");
      await unlink(address); // Caller must already hold exclusive service ownership.
    }
  }
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => {});
    socket.setTimeout(60_000, () => socket.destroy());
    let unlisten = () => {};
    let queued = 0;
    let tail = Promise.resolve();
    socket.on("close", () => {
      sockets.delete(socket);
      unlisten();
    });
    receiveFrames(socket, (value) => {
      const parsed = automationEnvelopeSchema.safeParse(value);
      if (!parsed.success) {
        send(socket, {
          v: 1,
          id: null,
          ok: false,
          error: { code: "invalid", message: "Invalid service request or protocol version." },
        });
        socket.end();
        return;
      }
      const envelope = parsed.data;
      if (!timingSafeEqual(Buffer.from(envelope.token, "hex"), Buffer.from(token, "hex"))) {
        send(socket, {
          v: 1,
          id: envelope.id,
          ok: false,
          error: { code: "unauthorized", message: "Unauthorized." },
        });
        socket.end();
        return;
      }
      if (++queued > 8) {
        socket.destroy();
        return;
      }
      tail = tail
        .then(async () => {
          try {
            if (socket.destroyed) return;
            if (envelope.request.action === "subscribe") {
              socket.setTimeout(0);
              unlisten();
              unlisten = subscribe((revision) =>
                send(socket, { v: 1, notice: "changed", revision }),
              );
            }
            const result = await handle(envelope.request);
            const response: AutomationResponse = { v: 1, id: envelope.id, ok: true, result };
            if (Buffer.byteLength(JSON.stringify(response)) > AUTOMATION_FRAME_LIMIT - 1)
              throw new AutomationError(
                "refused",
                "Result exceeds the service frame limit. Request a smaller page.",
              );
            send(socket, response);
          } catch (error) {
            send(socket, {
              v: 1,
              id: envelope.id,
              ok: false,
              error: {
                code: error instanceof AutomationError ? error.code : "internal",
                message:
                  error instanceof AutomationError
                    ? error.message
                    : "The service could not complete the request.",
              },
            });
          } finally {
            queued--;
          }
        })
        .catch(() => {
          socket.destroy();
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  try {
    if (process.platform !== "win32") await chmod(address, 0o600);
    const previous = await readPrivateJson(endpointPath(root), 4096).catch((error) => {
      if (fileCode(error) !== "ENOENT") throw error;
      return undefined;
    });
    await writePrivateJson(endpointPath(root), { v: 1, token }, previous, 4096);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function subscribeService(
  root: string,
  changed: (disconnected?: boolean) => void,
): Promise<() => void> {
  const raw = await connectionMetadata(root);
  const socket = createConnection(serviceAddress(root));
  socket.on("error", () => {});
  const timer = setTimeout(() => socket.destroy(), 10_000);
  socket.on("connect", () =>
    socket.write(
      `${JSON.stringify({
        v: 1,
        token: raw.token,
        id: randomUUID(),
        request: { action: "subscribe" },
      })}\n`,
    ),
  );
  let closed = false;
  socket.once("close", () => {
    clearTimeout(timer);
    if (!closed) changed(true);
  });
  receiveFrames(socket, (value) => {
    const checked = automationResponseSchema.safeParse(value);
    if (!checked.success || checked.data.v !== 1 || ("ok" in checked.data && !checked.data.ok)) {
      socket.destroy();
      return;
    }
    clearTimeout(timer);
    changed(false); // Initial subscribe acknowledgement also closes the read/subscribe race.
  });
  return () => {
    closed = true;
    clearTimeout(timer);
    socket.destroy();
  };
}

export async function serviceRequest(root: string, request: AutomationRequest): Promise<unknown> {
  const raw = await connectionMetadata(root);
  const id = randomUUID();
  const frame = `${JSON.stringify({ v: 1, id, token: raw.token, request })}\n`;
  if (Buffer.byteLength(frame) > AUTOMATION_FRAME_LIMIT)
    throw new AutomationError("invalid", "Request exceeds the service frame limit.");
  return new Promise((resolve, reject) => {
    const socket = createConnection(serviceAddress(root));
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new AutomationError("unavailable", "Scheduler request timed out.")),
      15_000,
    );
    socket.once("connect", () => socket.write(frame));
    socket.once("error", () =>
      finish(new AutomationError("unavailable", "Scheduler is not running.")),
    );
    socket.once("close", () =>
      finish(new AutomationError("unavailable", "Scheduler connection closed.")),
    );
    receiveFrames(socket, (value) => {
      const parsed = automationResponseSchema.safeParse(value);
      if (!parsed.success || parsed.data.v !== 1) {
        finish(new AutomationError("version", "Scheduler protocol mismatch."));
        return;
      }
      const response = parsed.data;
      if ("notice" in response || response.id !== id) return;
      if (response.ok) finish(null, response.result);
      else finish(new AutomationError(response.error.code, response.error.message));
    });
  });
}

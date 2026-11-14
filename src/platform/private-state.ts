import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { helperOutput } from "./helper.js";
import {
  atomicReplace,
  createPrivateDirectory,
  privateDirectory,
  writePrivateFile,
} from "./storage.js";

export const fileCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/** Same privacy and same-handle rules as desktop Relay storage, without a desktop dependency. */
export async function verifyPrivatePath(path: string, directory: boolean) {
  const info = await lstat(path, { bigint: true });
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)
  )
    throw new Error("Unsafe private storage");
  if (process.platform === "win32") await helperOutput(["verify-private", path]);
  else if ((info.mode & 0o077n) !== 0n || info.uid !== BigInt(process.getuid?.() ?? -1))
    throw new Error("Unsafe private storage permissions");
  return info;
}

export async function readPrivateJson(path: string, maximumBytes: number): Promise<unknown> {
  const before = await verifyPrivatePath(path, false);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const start = await file.stat({ bigint: true });
    if (start.dev !== before.dev || start.ino !== before.ino || start.size > BigInt(maximumBytes))
      throw new Error("Private state changed or exceeded its limit");
    const bytes = Buffer.alloc(Number(start.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const end = await file.stat({ bigint: true });
    const entry = await verifyPrivatePath(path, false);
    if (
      count !== Number(start.size) ||
      start.ctimeNs !== end.ctimeNs ||
      start.mtimeNs !== end.mtimeNs ||
      start.dev !== entry.dev ||
      start.ino !== entry.ino
    )
      throw new Error("Private state changed while reading");
    const source = bytes.subarray(0, count);
    if (!isUtf8(source)) throw new Error("Invalid private state encoding");
    return JSON.parse(source.toString("utf8"));
  } finally {
    await file.close();
  }
}

export async function writePrivateJson(
  path: string,
  value: unknown,
  previous: unknown | undefined,
  maximumBytes: number,
): Promise<void> {
  const data = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(data) > maximumBytes) throw new Error("Private state limit reached");
  const verify = async () => {
    await verifyPrivatePath(dirname(path), true);
    if (previous !== undefined) {
      if (!isDeepStrictEqual(await readPrivateJson(path, maximumBytes), previous))
        throw new Error("Private state changed outside its owner");
    } else {
      const exists = await lstat(path).catch((error) => {
        if (fileCode(error) !== "ENOENT") throw error;
        return null;
      });
      if (exists) throw new Error("Private state already exists");
    }
  };
  await verify();
  const temporary = join(dirname(path), `${randomUUID()}.tmp`);
  await writePrivateFile(temporary, data, { mode: 0o600, flag: "wx" });
  try {
    const handle = await open(temporary, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await verify();
    await atomicReplace(temporary, path);
    if (process.platform !== "win32") {
      const dir = await open(dirname(path), constants.O_RDONLY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (fileCode(error) !== "ENOENT") throw error;
    });
  }
}

/** Conservative ownership: PID reuse or inaccessible ownership never authorizes takeover. */
export async function lockPrivateState(root: string): Promise<() => Promise<void>> {
  for (const path of [dirname(root), root]) {
    await privateDirectory(path);
    await verifyPrivatePath(path, true);
  }
  const lock = join(root, ".writer");
  const owner = `owner-${process.pid}-${randomUUID()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await createPrivateDirectory(lock);
      break;
    } catch (error) {
      if (fileCode(error) !== "EEXIST") throw error;
      await verifyPrivatePath(lock, true);
      const entries = await readdir(lock);
      const name = entries[0];
      const match = name && /^owner-([1-9]\d{0,9})-[a-f0-9-]{36}$/.exec(name);
      if (attempt > 1 || entries.length !== 1 || !match)
        throw new Error("Service writer ownership cannot be verified");
      await verifyPrivatePath(join(lock, name), false);
      try {
        process.kill(Number(match[1]), 0);
        throw new Error("Service is already running");
      } catch (probe) {
        if (fileCode(probe) !== "ESRCH") throw probe;
      }
      await unlink(join(lock, name));
      await rmdir(lock);
    }
  }
  try {
    await writePrivateFile(join(lock, owner), "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rmdir(lock);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    await verifyPrivatePath(lock, true);
    await unlink(join(lock, owner));
    await rmdir(lock);
    released = true;
  };
}

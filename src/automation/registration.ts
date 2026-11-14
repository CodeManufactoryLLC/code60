import { access, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  controlUserService,
  fileCode,
  privateDirectory,
  readPrivateJson,
  type ServiceRuntime,
  userHome,
  userServiceDefinition,
  writePrivateJson,
} from "../platform/index.js";
import { AutomationError } from "./errors.js";
import { automationClient, automationRoot } from "./service.js";

const updatePath = (env: Readonly<NodeJS.ProcessEnv>) =>
  join(automationRoot(env), "update-restart.json");

/** Persist restart intent before stopping: the installer replaces this process too. */
export async function prepareSchedulerUpdate(env: Readonly<NodeJS.ProcessEnv>): Promise<void> {
  const status = await automationClient(env)({ action: "status" }).catch(() => null);
  if (!status) return;
  const registration = (await readPrivateJson(
    join(automationRoot(env), "registration.json"),
    16_384,
  ).catch((error) => {
    if (fileCode(error) !== "ENOENT") throw error;
    return null;
  })) as { installed?: unknown } | null;
  if (registration?.installed !== true)
    throw new AutomationError(
      "refused",
      "Stop the standalone scheduler before updating, or install the background service first.",
    );
  const previous = await readPrivateJson(updatePath(env), 4096).catch((error) => {
    if (fileCode(error) !== "ENOENT") throw error;
    return undefined;
  });
  await writePrivateJson(
    updatePath(env),
    previous ?? { version: 1, pausedAll: (status as { pausedAll: boolean }).pausedAll },
    previous,
    4096,
  );
  await schedulerControl(env, "stop");
}

/** Repair the previously consented registration to point at the newly installed runtime. */
export async function restoreSchedulerUpdate(env: Readonly<NodeJS.ProcessEnv>): Promise<void> {
  const marker = await readPrivateJson(updatePath(env), 4096).catch((error) => {
    if (fileCode(error) !== "ENOENT") throw error;
    return null;
  });
  if (marker === null) return;
  const saved = marker as { version?: unknown; pausedAll?: unknown };
  if (saved.version !== 1 || typeof saved.pausedAll !== "boolean")
    throw new AutomationError("unavailable", "Scheduler update recovery metadata is invalid.");
  await schedulerControl(env, "repair", true);
  const client = automationClient(env);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await client({ action: "status" }).catch(() => null);
    if (status) break;
    if (Date.now() >= deadline)
      throw new AutomationError("unavailable", "Scheduler did not restart after the update.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!saved.pausedAll) await client({ action: "resumeAll" });
  await unlink(updatePath(env));
}

// Resolve the entry inside each new AppImage mount, never save a temporary mount path.
const APPIMAGE_SERVICE_CODE =
  'import(require("node:url").pathToFileURL(require("node:path").join(require("node:path").dirname(process.execPath),"resources/app.asar/dist/automation/main.js")).href)';

async function schedulerRuntime(env: Readonly<NodeJS.ProcessEnv>): Promise<ServiceRuntime> {
  const executable = await realpath(env.APPIMAGE || process.execPath);
  await access(executable);
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "main.js");
  const runtimeEnv: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["PATH", "HOME", "USERPROFILE", "XDG_STATE_HOME", "XDG_CONFIG_HOME"])
    if (env[key]) runtimeEnv[key] = env[key];
  return {
    executable,
    args: env.APPIMAGE ? ["-e", APPIMAGE_SERVICE_CODE] : [entry],
    env: runtimeEnv,
  };
}

export async function schedulerControl(
  env: Readonly<NodeJS.ProcessEnv>,
  action: "install" | "repair" | "start" | "stop" | "uninstall" | "status",
  consent = false,
) {
  const root = automationRoot(env);
  const marker = join(root, "registration.json");
  const registered = await readPrivateJson(marker, 16_384).catch((error) => {
    if (fileCode(error) !== "ENOENT") throw error;
    return null;
  });
  if ((action === "install" || action === "repair") && !consent)
    throw new AutomationError(
      "refused",
      "Explicit consent is required to install or repair background execution.",
    );
  const runtime = await schedulerRuntime(env);
  const definition = userServiceDefinition(process.platform, userHome(env), root, runtime);
  if (action === "status") {
    const native = await controlUserService(definition, "status");
    const service = await automationClient(env)({ action: "status" }).catch(() => null);
    return { installed: registered !== null, nativeAvailable: native.available, service };
  }
  if (action === "stop" || action === "uninstall" || action === "repair")
    await suspendScheduler(env);
  if (action === "install" || action === "repair") await privateDirectory(root);
  const result = await controlUserService(definition, action);
  if (action === "install" || action === "repair" || action === "uninstall")
    await writePrivateJson(
      marker,
      { installed: action !== "uninstall", runtime },
      registered ?? undefined,
      16_384,
    );
  return result;
}

/** Updates cannot replace a running agent's executable. Never silently abandon cleanup. */
async function suspendScheduler(env: Readonly<NodeJS.ProcessEnv>): Promise<void> {
  const client = automationClient(env);
  const status = await client({ action: "status" }).catch(() => null);
  if (!status) return;
  await client({ action: "pauseAll", cancelActive: true });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const current = (await client({ action: "status" })) as {
      activeExecutionId: string | null;
      block: unknown;
    };
    if (current.block)
      throw new AutomationError(
        "refused",
        "Resolve blocked automation ownership before stopping or updating the service.",
      );
    if (!current.activeExecutionId) return;
    if (Date.now() >= deadline)
      throw new AutomationError(
        "refused",
        "Automation cleanup did not finish. No binaries were replaced.",
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

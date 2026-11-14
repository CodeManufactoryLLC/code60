import { join } from "node:path";
import { type CoreDeps, defaultDeps, stateHome } from "../core/index.js";
import { executionEvidence } from "./evidence.js";
import { createExecutor } from "./executor.js";
import { listenService, serviceRequest } from "./protocol.js";
import { Scheduler } from "./scheduler.js";
import { AutomationStore } from "./store.js";

export const automationRoot = (env: Readonly<NodeJS.ProcessEnv>) =>
  join(stateHome(env), "code60", "automations");

export async function startService(
  env: Readonly<NodeJS.ProcessEnv>,
  deps: CoreDeps = defaultDeps(),
) {
  const root = automationRoot(env);
  const store = await AutomationStore.open(root);
  const scheduler = new Scheduler(store, createExecutor(deps, env));
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await scheduler.initialize();
    const server = await listenService(
      root,
      (request) =>
        request.action === "transcript" || request.action === "diff"
          ? executionEvidence(scheduler, deps, env, request.executionId, request.action)
          : scheduler.request(request),
      (listener) => scheduler.onChange(listener),
    );
    let ticking = false;
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void scheduler
        .tick()
        .catch(() => {})
        .finally(() => {
          ticking = false;
        });
    }, 1000);
    let stopping: Promise<void> | undefined;
    return {
      scheduler,
      stop() {
        stopping ??= (async () => {
          clearInterval(timer);
          await server.close();
          await scheduler.stop();
          await store.close();
        })();
        return stopping;
      },
    };
  } catch (error) {
    clearInterval(timer);
    await scheduler.stop();
    await store.close();
    throw error;
  }
}

export function automationClient(env: Readonly<NodeJS.ProcessEnv>) {
  return (request: Parameters<typeof serviceRequest>[1]) =>
    serviceRequest(automationRoot(env), request);
}

# Desktop

`src/desktop` is the Electron main process: the window, native dialogs, IPC handlers, and the `DesktopController` that owns one workspace and multiple independent run batches. Read [ARCHITECTURE.md](../../ARCHITECTURE.md) before changing it.

- Depend only on `core`, `bridge`, and the Node-only `platform` leaf. Only this module imports `electron`.
- Keep the renderer sandboxed: context isolation on, Node.js integration off, navigation and new windows blocked.
- Keep `preload.cts` self-contained and expose only fixed methods. Never expose `ipcRenderer` or raw channels.
- Check the sender of every IPC request and parse its arguments with `bridge` before acting. Act only on runs recorded in the open workspace.
- Serialize user actions and completion history refreshes in the controller. Allow overlapping batches, each with its own selected parallel limit, orchestrator, and subscriptions. Route actions and approvals to the owning batch, and retain earlier transcripts when adding sessions.
- Refuse folder and database switches until every batch has ended. Stop all and every shutdown path, including forced shutdown, must stop every batch.
- Return only newly created session IDs from start so the renderer identifies the new minimized dock entries without disturbing existing chats or drafts. When sessions run without worktrees, warn about directory sharing with existing live sessions as well as within the new batch; declining must leave existing sessions untouched.
- Ask with a native dialog before destructive or unisolated actions, and before quitting with active runs.
- On quit, signals, and renderer crashes, shut down every run through `core` and wait for it before exiting. Never remove worktrees automatically.
- Keep the project database (`projects.ts`) to repository paths, open times, saved run configurations (name, batch settings, use count, last use), and validated prompt template edits. Never store user task prompts or transcripts in it, never modify a database that is not a Code60 database, and never recreate a missing one silently. Load `node:sqlite` lazily; Node.js 22.12 has it only behind a flag.
- Route every repeated external read (run history, config, run configurations, worktrees) through the `Poller` in `poller.ts`. Keep reads single-flight, discard results after a workspace or database switch, keep worktree scans outside the exclusive queue, and stop the poller on shutdown. Never poll agent events or watch files. Persist only user overrides under `polling` in desktop.json.
- Do not use top-level `await` in `main.ts`; Electron automation needs the module to finish loading.

- On successful database open or startup reconnection, ensure `.code60_workspace` exists beside the SQLite file, with mode `0700` for a newly created directory. Preserve existing directory contents. Validate the database before creating the directory and surface filesystem conflicts through the database connection error path.

- Persist the app-wide orchestration provider in desktop preferences, independent of ordinary run settings. Its allow-all policy is fixed on. Keep ACP connection probes single-flight, cancellable and time-bounded, rooted in the database's `.code60_workspace`, with no prompts or run records. Stop their process group after testing, on provider/command or database changes, and during shutdown.

- Own multiple independent orchestration Chat sessions, each rooted in a generated private subfolder of `.code60_workspace` beside the database. Start an initial chat automatically once provider/database are available; New chat adds a session without stopping existing ones. Reuse all chats and selection across renderer reloads and project switches, and replace all on provider/command/database changes. Retry replaces only its target chat. Use core for run records, streaming, once-only allow-all permissions, cancellation and process cleanup. Chat actions are the explicit exception to the open-project run rule: accept only IDs of existing orchestration runs, and never accept a workspace path. Keep each chat's event stream separate from project events; stop every chat on Stop all and every shutdown path.

- Expose worker dispatch and control only through the chat's authenticated MCP gateway. Validate arguments, require the current project/chat scope for mutations, and act only on workers created by that chat in the open project. Never pass the gateway to workers. Keep ownership and request-ID deduplication in memory, enforce `maxParallel` including idle workers, and preserve normal worktree and leftover-process safeguards.
- Deliver bounded worker turn-end/failure updates only between orchestration turns, with automatic prompt origin. Stop and Stop all pause automatic updates; user send or Resume updates unpauses them. Revoke the gateway on chat replacement and clear update timers on shutdown.

- Include current-project worker IDs owned by each chat generation in every chat snapshot. Renderer aggregate activity must not derive ownership from the global list or process existence. Preserve Windows process/job support and sandbox boundaries.

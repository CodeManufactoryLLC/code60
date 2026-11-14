# Core

`src/core` owns runs: the scheduler, permission policy, run records, and leftover detection. Read [ARCHITECTURE.md](../../ARCHITECTURE.md) before changing it.

- Receive `agents`, `git`, the filesystem, the clock, and process checks as injected interfaces, so tests run without real agents or repositories.
- Own pure automation recurrence only. The automation module owns durable schedules,
  claims and restart reconciliation, the explicitly approved recovery exception.
- Keep core usable without the desktop app.
- Optional interactive-only memory hooks may build bounded evidence context and
  replace an idle ACP session between turns. Never replay a dispatched prompt,
  infer permissions from a checkpoint, or enable memory for headless runs.
  Validate exact cited spans; isolated generators deny permissions and always
  stop their processes. Desktop owns scope, storage, settings and extraction.
  Context budgeting is the approved exception to the budget non-goal below.
- RAG owns exact-span tokenizer-aware chunking, streamed-message reconstruction
  and stable cosine ranking through injected query/document embedding operations.
  Never import Transformers.js here. Read-only snapshots must not reconcile run
  state; strict listings must surface corrupt history instead of skipping it.
- Optional desktop diagnostic sinks must be inert when absent or throwing.
  Correlate turns with generated operation IDs and emit fixed metadata once per
  meaningful boundary, never prompts, event payloads, paths, commands or errors.
  Keep diagnostic retention independent of authoritative run/transcript stores.
- In headless mode, never wait for input. Treat `ask` as deny unless a flag allows the kind.
- Never pick an ACP "always" permission option.
- Headless runs are exactly one turn. Only the desktop app (`interactive` mode) sends follow-up prompts, and only after the previous turn ended.
- Never decide from an agent's message text whether it asked a question or is done.
- Never commit to project branches, merge, push, or remove a worktree without an explicit user
  command. Desktop task snapshots may use internal refs. Applying and undoing task files
  require human action, guarded file writes and a private recovery journal.
- Mark a run `interrupted` only when its owning process is gone. Never guess a different outcome.
- Write `run.json` atomically and append to `events.jsonl`. Create both with mode `0600`.
- Stay within the non-goals in ARCHITECTURE.md. Retries, durable queues, budgets, and automatic recovery are out of scope.
- Desktop may read saved orchestration history without starting agents, then
  explicitly restore or hand off an ended chat with trusted operating/task
  context. Retain typed transcript text separately from delivered instructions.
  Reuse process safeguards; historical evidence never establishes completion.

- Preserve prompt dispatch timestamps and record actual turn completion before persistence/cleanup. Optional turnEnd outcome/completedAt and terminal status turn/completedAt metadata distinguish timeout, cancellation and transport failure without changing CLI outcomes. Keep older events readable; never infer successful completion after a crash.

- The search summary helper runs one evidence-only ACP turn through injected agents, with denied permission requests, bounded text and timeout, and unconditional process/listener/timer cleanup. It never creates run records or worktrees.

- Run preparation/recovery may accept an already resolved configuration from desktop so it can enforce enabled-provider policy. Without that explicit argument, retain the existing headless config loading and defaults; core must not depend on desktop preferences or setup state.

- Diff preparation owns run validation and interrupted-run reconciliation; diff execution accepts a prepared worktree/base and optional abort signal without mutating run records. Keep `diffRun` as the CLI-compatible composition.

- The internal requireIsolation preparation option rejects direct-folder fallback before records or agents are created. CLI defaults stay unchanged. Optional desktop history composition retains both stores without migration or schema changes.
- Explicit internal workspaceMode selects direct or required worktree preparation
  for Relay. Direct always uses the supplied directory, including inside Git;
  worktree never falls back. Reject direct together with requireIsolation or base.
  Omitting workspaceMode retains all existing CLI defaults.
- Interactive runs pass their startup cancellation signal into worktree creation.
  Shutdown before the agent starts is cancellation, not a failed task. Preserve
  headless Git calls and wait for started subprocess cleanup before settling.
- TaskLoop may bind an already captured baseline for a Relay task/target. Validate
  the commit identity, refuse rebinding, and never snapshot again for that binding.

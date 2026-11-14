# Architecture

Status: implemented (first version). Code60 has two interfaces: the Electron desktop app and the headless `code60` command-line tool.

## What it does

`code60` runs coding agents in parallel on one Git repository. Each run gets its own worktree, so the agents cannot overwrite each other. When the agents finish, you review each worktree's diff and decide what to keep.

Git is not required for headless CLI runs. Desktop project workers require a Git repository with an initial commit. In the CLI, outside a Git repository, or in a repository with no commits yet, every run works directly in the current directory instead (see [Runs without a worktree](#runs-without-a-worktree)).

That is the whole product. The tool talks to agents over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), runs them from an Electron and React desktop app or headless from the CLI, and keeps only the plain files it needs to show what happened.

## Relay and multi-project architecture

The Relay architecture replaces database-wide orchestration.
The rules in this section take precedence over the single-project descriptions
below. Desktop conversations are Relay or project-bound chats. Database-wide
legacy chat files are not loaded into interactive conversations, migrated,
assigned to projects or deleted. Explicit read-only RAG snapshots are the
exception for searching existing database-associated history.
See [Relay implementation status](docs/relay-implementation.md) for available
features, resource bounds and remaining native-platform validation.

- Relay is one application-owned logical conversation, available without a database.
  Project chats belong to individual open projects. Selecting or expanding a
  project changes presentation, never Relay's authority.
  Home is the first sidebar page-list destination, with a Phosphor house icon
  and a database-independent launchpad, followed by Relay and Projects. Home
  uses the standard page title position and title-only feature cards for Relay, Command
  Builder and Prompt Builder. The Relay card selects Relay and clears worker selection;
  tool cards use the existing database availability rules. Cards adapt to narrow
  layouts and enlarged text, with shared keyboard focus and theme colors.
  Startup remains on Chat. A utility row above the list holds the Search
  magnifier at its upper right; there is no sidebar wordmark or full Search row.
  Relay’s race track and border are black in Light and gray in Dark/System dark;
  the icon animates during
  active work and shows a static state with reduced motion. Projects uses the Phosphor clipboard icon and contains the
  open project headings. Project chats
  indent one 24px step beneath their project; owned workers indent one more step
  beneath their conversation. Labels toggle disclosures without chevrons, with separate New chat
  and More actions. Rows retain full-width highlights. Project menus anchor to
  their trigger and remain within the viewport. The Projects heading contains a separate plus action labelled Open Project
  when connected, opening the existing project modal.
- Desktop host, Relay service, project host, execution host and database services
  remain in `src/desktop`. Do not construct a DesktopController per project.
  Core stays Electron-independent and receives explicit workspaces/dependencies.
  ProjectHost owns retained runtime identities and database-instance epochs.
  Each runtime owns its workspace, batches, history, review/task state, file
  context and project conversations. Async work captures its runtime before
  yielding; callbacks bind that owner explicitly, never the selected directory.
  Selection changes presentation only. Closed or replaced runtime identities
  cannot acquire authority again, even when the same path is reopened.
  Project review/task/Git requests carry the runtime UUID and database epoch.
  Bind the owner unconditionally before asynchronous work, including requests
  for the currently selected project; a path alone cannot identify a live owner.
  Command, configuration and prompt-template writes carry the database epoch
  captured by the originating view. Validate it again inside the action queue;
  never obtain a fresh epoch to make a stale action succeed.
  Database selection and project-history actions use that same captured epoch.
  Native pickers run outside the queue and recheck it after every dialog, then
  again inside the queued operation. A delayed picker cannot replace or modify
  a newer database, including a reopened instance of the same SQLite path.
  Relay activity never blocks database selection or becomes database-owned work.
- An execution target is a canonical directory with an opaque identity, independent
  of Git, database membership and open-project history. Project chats may use only
  their bound target and must use isolated worktrees.
- Relay alone may accept a required, bounded absolute `cwd` through its
  authenticated MCP gateway, with explicit `direct` or `worktree` mode. Main
  canonicalizes and rechecks directory identity before launch. No renderer process,
  command, environment or arbitrary filesystem capability is added. The configured
  verified provider and the harness's permission decisions remain authoritative.
  Never fall back between modes or retry in a different directory.
  Keep filesystem device/inode comparisons at full integer precision, including
  Windows file identities above JavaScript's safe-number range. These internal
  identities are not renderer capabilities or persisted execution authority.
- Explicit direct mode runs in the exact directory, even inside Git, and has no
  isolated apply/undo/discard semantics. Worktree mode requires a valid Git base.
  CLI defaults and existing run-record format remain unchanged.
- Relay lives in `$XDG_STATE_HOME/code60/relay` (default
  `~/.local/state/code60/relay`). `state.json` sits outside `workspace/`, its
  persistent ACP/process directory. Validate private permissions, Windows ACLs,
  same-handle bounded reads and atomic writes. Never initialize Git, associate it
  with a database, or remove it on shutdown. Missing workspace data, malformed
  metadata and unsafe storage require explicit recovery. An exclusive writer
  lock never displaces a live or unverifiable owner.
  A persisted history gap remains recorded but permits a fresh connection when
  the journal passes validation. Retry clears a transient write-failure latch
  after validation succeeds. Damaged frames or changed journal identity still
  block connection; a history gap alone never permanently disables Send.
- Relay journal writes coalesce adjacent fragments of the same message and flush
  after 50 ms, at 64 KiB, at turn completion, and before reconnect/shutdown.
  The serialized writer bounds queued plus in-flight text to 1,048,576 UTF-16
  code units and 1,024 records. Each batch shares a file sync.
  A journal failure stops that generation's journal writes, releases queued
  buffers and marks history incomplete where possible. The live conversation
  and worker delivery continue with a separate history-saving warning.
  Explicit reconnect validates storage before creating a new writer. Partial
  batches are never replayed. Diagnostic records retain the first failure's
  stage, allowlisted code, queue sizes and changed identity fields, with
  incomplete-marker failure recorded separately. No source or raw error is logged.
- After verified setup, startup creates a fresh ACP session automatically, without
  any prompt. It never restores native provider context, worker ownership, task
  authority, gateways, pending plans or feedback. Only a human Send creates live
  authority and attaches prepared history, once. Failed connection exposes Retry,
  not an unbounded reconnect loop.
- One history-window builder supplies retained historical evidence and first-Send context.
  The Relay screen shows the live conversation and composer. It has no separate
  historical transcript panel, history paging buttons or historical Copy controls.
  Historical labels, summaries and partial-excerpt markers count toward 64,000
  Unicode characters. Prefer complete recent messages, preserve structured records,
  omit duplicate raw ACP/tool payloads and never split a Unicode character.
  Older source stays on disk, with explicit bounded paging and exact-source Copy.
  Copy may read only a pinned message through expiring opaque source cursors.
  Pin the journal's exact native identity and nanosecond change stamps for the
  lifetime of the reader. Serialize bounded journal I/O with its own appends,
  not conversation turns. Only verified local appends advance that stamp;
  replacement or outside modification invalidates Copy, even for valid UTF-8
  with unchanged size. Check the handle and directory entry after each read.
  Each source read is bounded and runs outside lifecycle/turn queues; it never
  grants filesystem paths or execution authority. Renderer clipboard access stays
  unchanged. An explicit full-message Copy is separate from bounded display pages.
  Tail reads/indexes, event buffers and UI pages must remain bounded; incomplete
  evidence is visibly incomplete. This is not transcript retention or a cap on
  the uninterrupted harness session's own context.
- Worker authority is conversation identity, live generation, human-authorized
  task, target and owned run. Scope tokens are ephemeral. Capacity is reserved
  before asynchronous preparation and includes idle workers across all targets.
  Deduplication includes target and mode; metadata failures after acceptance never
  permit redispatch. Manual batches and project chats retain independent limits.
- Serialize lifecycle changes briefly, controls per target and turns per
  conversation. Expensive reads run outside control queues. Git record writes
  coordinate by canonical common directory; apply/undo remains checkout-local.
  Worktree create/remove, internal task snapshots and initial-commit metadata
  operations share an in-process queue keyed by canonical Git common directory,
  across Git instances and linked checkouts. Independent repositories proceed
  independently. Revalidate directory identity after waiting. Queued cancellation
  performs no mutation; cancellation after starting awaits subprocess cleanup.
  Git's own filesystem locks remain authoritative across processes. Never remove
  a Git lock or hold this metadata queue over human apply/undo file writes.
  Interactive run shutdown cancels queued worktree creation without waiting for
  another owner's metadata operation. Started worktree commands use owned process
  trees and settle cleanup before shutdown returns. Headless CLI execution keeps
  its existing subprocess behavior.
- Freeze instructions per human request. Baselines, worker assignments, plan rows,
  results and reviews are target-qualified. Human Accept authorizes the specific
  plan revision and target assignments. A target change requires new acceptance.
  Relay operating instructions never follow database prompt overrides.
  Relay review workers pin their accepted canonical worktree, native directory
  identity, branch and base. Capture and application reject record redirection
  or directory replacement, even within the same Git common directory. Older
  unpinned evidence remains readable but cannot be recaptured or applied.
  Review index rollover writes one new page before advancing its manifest. A
  validated single-entry next page after a full page completes that interrupted
  publication on reopen or append. Invalid or ambiguous pages fail visibly and
  remain untouched; recovery never reinstates execution authority.
- Open-project views survive navigation and dispose on actual close. Closing a
  project stops only project-owned work after confirmation, not Relay workers in
  that folder. Folder stop explicitly includes them and pauses replacement for
  that task/target; other targets continue. Stop all pauses automation and stops
  orchestrator turns and all workers.
- Database replacement disposes database-owned work only. Database tool requests
  carry an instance epoch and reject stale requests. Shutdown, renderer crash,
  signals and updates attempt cleanup for every owner, collect failures and retain
  forced escalation. Relay is not a detached daemon.
- App summaries and scoped detail subscriptions carry explicit identities,
  generations and monotonic revisions. Subscribe before reading, buffer updates
  and resynchronize on gaps. Inactive summaries stay small. Relay's file view
  explicitly selects its own workspace or a target, never the selected project.
  Poll by application/database/target keys, deduplicate shared stores and read
  previews/sizes only for visible requested views; agent results stay pushed.
  Relay worker transcript tools page the same bounded live target event window,
  not a lifetime `events.jsonl` read. Responses identify the window revision and
  incompleteness; cursor positions belong to that window. Original run evidence
  stays on disk. Project and headless record-reader contracts remain unchanged.
  The polling registry partitions application configuration, database-instance
  tables and target-runtime sources. It resolves the owner synchronously before
  installing a flight. Each scope retains its own single-flight, failure history
  and timers; navigating never invalidates another live target's reads.
  Closed scopes stop scheduling and discard late results. Visibility gates
  target previews and worktree-size scans without retargeting their callbacks.
  Detail subscriptions use a generated subscription UUID plus an explicit
  project-instance/database epoch, conversation/generation, or execution-target/
  Relay-generation address. Main captures that owner when subscribing, before
  any initial read. Detail frames carry their own predecessor revision; full
  reads use no predecessor. Closing/replacing an owner emits a terminal frame,
  never a frame for its replacement. The registry is bounded to 128 concurrent
  subscriptions, clears on renderer reload/shutdown and isolates listener errors.
  Subscribing and reading never select a project or grant execution authority.
  Detail publication checks owner-local change versions before constructing
  payloads. Unrelated project, Relay-target and file-root updates do not reread
  or rebroadcast an unchanged owner. Still check validity on every app publication
  so a closed owner emits its terminal frame. Listener and release failures cannot
  prevent publication or cleanup for other owners.
  App summaries include only each active detail subscription's last publication
  revision (at most 128 UUID/number pairs). A missing final detail frame therefore
  triggers that subscription's bounded full-read recovery, without copying an
  unchanged owner on unrelated updates. Hints received during an initial or
  recovery read are checked before installing its result.
  Explicit hidden worktree inventory reads omit recursive sizes. A visible size
  scan checks its captured owner and visibility throughout traversal, stopping
  on navigation, hide or close rather than finishing an unwanted filesystem scan.
  Existing CLI worktree listing defaults remain unchanged.
  Renderer detail readers share the app stream's bounded subscribe-before-read
  recovery protocol, but merge on their own revisions. Retained caches are keyed
  by the complete owner address and pruned on close/generation replacement.
  Inactive conversation summaries carry constant-size reply counters and compact
  plan status/progress summaries, not transcripts or full plan documents.
  Each open-project entry also carries compact worker summaries, so inactive
  sidebar workers receive new IDs and status changes without transcript reads.
  Cached project detail frames may fill prompt/event data, but cannot rewind
  newer worker metadata from app summaries.
  Reply counters preserve unread badges without history reads. Plan status
  comes from the app summary, atomically with selection, never ahead of it
  through a detail frame that could reopen a background conversation's plan.
  The production app stream is summary-only, including the selected conversation.
  Its fixed summary read supports initial load and gap recovery; explicit legacy
  snapshot reads remain full for existing callers. Summaries omit transcripts,
  history windows, worker prompt bodies, files, worktree listings and review data.
  Selected project/conversation/Relay-target details supply those views. Worker
  reply counters are pushed with run summaries, without transcript reads. App
  revisions cannot advance detail-data fences or replace retained detail content.
  A selected Relay worker subscribes to its exact target/conversation/generation;
  navigation releases that subscription, while cached data has the same complete
  address and is pruned on generation replacement. Status and plan selection stay
  authoritative on the app stream, even if a detail frame arrives first.
  Relay worker windows are bounded separately per target (512 events and 256,000
  serialized UTF-16 code units each), with at most 256 targets. Activity in one
  folder cannot evict another folder's visible history. Compatibility full reads
  retain one bounded aggregate window. Truncated target evidence is labelled;
  original worker records remain on disk. Clear windows on generation replacement.
  Relay file views explicitly select its workspace or an owned execution target.
  A file context names an existing Relay conversation/target detail subscription,
  an increasing view sequence, expanded relative folders and one optional relative
  preview. It accepts no root path, project address or filesystem capability.
  Main resolves and rechecks the canonical root and generation before and after
  reads. Unsubscribe/reload invalidates the file context, including in-flight
  requests; late context changes cannot overwrite a newer sequence.
  Cache and schedule file reads per root through the existing Poller, with shared
  single flights, bounded listings/previews and independent failure history.
  Only active, visible requested file views schedule previews. App pause/settings
  apply to those pollers; project/database navigation does not retarget them.
  Files travel on the addressed detail stream, not inactive app summaries.
  File contexts are bounded to 16 concurrent views. Identical requests to the
  same canonical root share a read; different roots retain independent failures.
  Explicitly opening Files chooses Relay workspace initially and offers only
  currently owned targets. A root change replaces file tabs, never plan tabs.
- Relay reviews belong to its private application store, not a project database.
  Persist conversation/generation/task, opaque target, canonical cwd, exact native
  directory identity, workspace mode and the already captured default baseline.
  For Relay records the legacy `project` key is the logical Relay UUID, never a
  path capability. Keep worker-turn assignments with their originating task.
  Saved provenance permits evidence reads, not restored worker authority.
  Load individual bounded review records on demand through private same-handle
  readers. A paged compact creation index must not turn the complete lifetime
  review collection into startup work or an in-memory collection. Preserve old
  records on disk. Reuse immutable review contents and checkout-local TaskLoop
  journals, seeding its baseline from first-default-dispatch capture rather than
  recapturing at Accept or human application.
  Relay-only review requests carry current conversation/generation plus generated
  target/review/revision/file IDs, never a renderer-supplied cwd or project fallback.
  Historical reviews remain readable; feedback requires live originating task,
  generation and worker-turn ownership. Restart fails pending delivery and never
  reconnects saved workers or feedback automatically.
  Group Changes by target, splitting bounded worker groups rather than silently
  dropping assignments. Direct targets show their actual cwd and transcripts,
  with no isolated apply/undo/discard. Human application remains checkout-local,
  revalidates target identity, immutable sources, workers and affected files, and
  requires confirmation. Navigation and database replacement do not retarget it.
  Push a constant-size review revision hint with Relay metadata, not review
  collections or file contents. Only an active Changes view reads its bounded
  index page or selected review. Renderer reload cancels human reads/operations
  without revoking Relay's worker assignments or replaying feedback.
  Worker summaries may retain an opaque review link even if creation-index
  persistence failed. It identifies saved evidence only, never a path capability.

Deferred: workspace relocation, durable recovery, automatic task continuation,
RAG, semantic retrieval and automatic history retrieval outside the window.
SQLite remains schema 5. No bulk transcript moves/deletions or implicit legacy
imports are permitted.

## Non-goals

### Approved scheduled automations

An Electron-independent `automation` module owns local scheduled execution, private
metadata, restart reconciliation and authenticated local IPC. Durable schedule
metadata and persisted occurrence claims are approved exceptions to durable recovery
being deferred. There is no durable task queue, catch-up, retry or exactly-once
guarantee. Relay remains desktop-owned, not a daemon.

Intervals are anchored elapsed time; daily/weekly schedules use a saved IANA zone.
Skip nonexistent local times and use only the first repeated local time. Persist
claims and advance recurrence before launch. Never replay uncertain work. Dispatch
at most one automation globally and record busy/missed occurrences rather than queue
them. Pause affects future runs; editing never changes an active snapshot.

The service is the sole metadata writer under the private application state
directory. Bound reads, check revisions, write atomically and hold an exclusive
writer lock. Live or unverifiable ownership blocks recovery. Preserve history and
worktrees. Persistence failure and low space stop dispatch.

Use core headless single-turn execution with mandatory worktrees, the saved local
base branch resolved at launch, explicit deny-by-default permissions and no MCP or
implicit memory. Pin repository and provider identities; changes require review.
Worktrees are not sandboxes. Never automatically merge, apply, commit or push.

Installation requires consent. Use per-user launchd, Task Scheduler or systemd
without linger. No TCP or hosted service. Desktop and CLI use the automation public
API; the renderer uses narrow validated preload methods and opaque repository IDs.
Desktop shutdown and Stop all do not stop service-owned work.
The database-independent Automations sidebar page follows Projects in both display
and keyboard order. The quit dialog explains that background automations continue.

### Approved agent memory

Apps → Data Viewer → Memories is a database-independent, application-wide table
of persistent memory records. It uses the shared Glide table, saved filters and
presentation settings, with bounded cursor pages rather than loading the store.
Compact project/type/status selectors beside the title filter saved records;
table search, column filters and sorting apply to the current page. A compact
pager reports the page's record count. Pushed memory notices refresh the current
page without timers. Hidden pages retain filters and paging but defer reads;
stale replies cannot replace the current view. Selecting a row or pressing Enter
opens a compact Memory details dialog with readable attributes, editable text,
named project/conversation provenance, formatted dates and last recall, attributed
evidence quotes, expandable source messages with cited text highlighted, and
newest-first revision history. Raw IDs and offsets stay out of the presentation.
A sticky action row provides revision-checked edit, pin, resolve, promote and
forget actions; Save changes is enabled only for changed text or pin state.
Native confirmation still owns
global promotion and forgetting. Settings → Memory and its browser remain intact.

Desktop memory is an explicit exception to automatic semantic retrieval and
managed context handoff being deferred. Relay, project chats and workers may
receive scoped historical evidence and between-turn checkpoints. A separate,
private application `memory.sqlite` stores generated knowledge and continuity;
it never changes project schemas or grants persisted execution authority.
Automatic extraction uses the verified orchestration provider with tools denied.
Global promotion is human-only. Memory settings, source provenance, corrections,
suppression and bounded retrieval are owned by desktop; core receives optional
injected lifecycle hooks. CLI defaults and the manual RAG experiment stay unchanged.
Only completed, committed source ranges can advance extraction cursors. Provider
session replacement never replays a dispatched request or restores task authority.

Exception for the desktop RAG experiment: Settings → Advanced → Experiments → RAG
manually snapshots all saved/live orchestration chats and workers across the
connected database's registered projects, including archived/stopped conversations
and legacy directory histories. It includes retained and closed project chats,
with project provenance, and reads live worker events from each captured owner.
The application-owned Relay conversation is not database-associated and is excluded.
It indexes only human prompts and assistant text.
Core reconstructs streamed messages, chunks exact source spans (512 total model
tokens, up to 64-token overlap), validates normalized vectors and ranks cosine
similarities with stable ties. The injected embedder separates document/query
operations. Desktop alone owns discovery, storage and CPU inference.

Jina Embeddings v2 Base Code INT8 (768 dimensions) and its tokenizer are bundled at
a pinned revision and SHA-256 hashes, prepared explicitly with `npm run prepare:models`.
Transformers.js is pinned. Model loading, embedding, index parsing and ranking run
in a lazy, bounded Node sidecar using the Electron executable in Node mode, not in
main or the renderer. Masked mean pooling and L2 normalization follow the model card.
Remote model loading, filesystem caches and runtime downloads are disabled.
Packages unpack the native ONNX/sharp runtime and include model provenance and
Apache-2.0 notices. Only the target ONNX CPU binaries are shipped.

Private, versioned JSON generations beneath
`.code60_workspace/rag/<database-path-sha256>` store conversation provenance,
message ordinal, original offsets/text and little-endian float32 vectors encoded
as base64. Model, chunker, database, source and vector identities are checked.
The database schema, CLI, Search and MCP tools are unchanged. Future repository
sources must add a distinct versioned source kind, not misuse conversation fields.
An atomic manifest replacement publishes a completed generation. Failed/cancelled
builds keep the old manifest; native-confirmed Clear deletes only derived RAG files.
There is no auto-indexing, generation, agent access or repository indexing.

Rebuild/retrieve/clear are single-flight outside the controller action queue;
strict bridge requests carry only opaque database/request identities and bounded
query text. Status and progress are pushed. Queries are limited to 8,192 characters
and 512 total tokens and return at most ten text-only chunks. Reads are bounded
(1 MiB records, 32 MiB transcripts, 128 MiB snapshot, 1 MiB per message);
an index supports 2,000 conversations, 10,000 chunks and 96 MiB persisted data.
Limit or unreadable-source failures are explicit, never partial successes.
Read-only orchestration history and strict project listing avoid reconciliation
writes and silent corrupt-record skipping during indexing. Chat metadata snapshots
reserve a read between the existing ChatStore's pending and subsequent atomic
writes, without entering the controller action queue. Cancellation targets
the current request UUID and runs on database replacement, renderer reload/loss,
Stop all and shutdown. Sidecars are stopped before unfinished generations are
removed. Page changes retain query/results; database changes reset them.

Exception for Tactics and stopped orchestration chats: a browser-safe versioned
catalog supplies eight bundled prompt workflows. Only the composer opens the
searchable native Tactics modal. Preview is distinct from Apply; Apply and Remove
persist selection without sending, dispatching, or modifying the draft. The bridge
accepts only chat/project identity and a trusted catalog ID or explicit null.
Unavailable saved IDs require replacement or clearing.

Desktop ChatStore persists versioned private metadata in
`.code60_workspace/chats/<generated-directory-id>.json`, bounded to 500 records,
16 MiB each and 1,000 task contexts per chat, with a 64 MiB metadata read budget.
Run records are read at most 1 MiB and transcripts at most 32 MiB per read.
Only the selected stopped chat loads transcript events and plans; other histories
load on explicit selection. Oversized history remains on disk with an actionable
error, never an empty or silently truncated successful recovery.
Atomic private writes and bounded same-handle reads reject symlinks and malformed
records. Each human Send freezes the effective tactic ID/version/full prompt.
Legacy absent selection leaves ordinary delivery unchanged; an explicit removal
sends a no-tactic context. Worker-turn assignments, saved plans and review feedback
retain their originating task context, with automatic updates batched per task,
not by the currently selected tactic. The operating contract remains authoritative;
typed text and slash-command expansion retain their existing separation.

Full restart restores titles, archive/selection, existing transcript references,
and task provenance as stopped history. It restores no gateway, worker ownership,
deduplication, automatic inbox or plan authority. Continue task explicitly uses the
frozen task instructions; Send is a new request with the current selection. ACP
restore/fresh handoff keeps existing process/provider checks and re-establishes a
new scoped gateway only on explicit continuation. Saved plans remain paused until
human continuation, revised plans still need Accept, and applying changes remains
human-only. Roles, review stability and correction limits are prompt instructions,
not a hard workflow engine or additional worker permissions. Failed/incomplete
evidence must not be represented as verified completion.

Exception for orchestrator plans: a conversation may save Markdown task lists in
`<chat working directory>/plans`, with versioned private records in `.code60/plans`.
Only a human Accept action authorizes the displayed revision. The orchestrator reports
completion with evidence notes; this does not approve or merge worker changes. Drafts
block new worker work in that conversation. Plans use existing between-turn delivery,
not a durable job queue; restart never restores execution authority. Failed or paused
execution requires explicit continuation. Plan tabs share the Chat side panel and show
an equally weighted completed/total progress bar and “X out of Y” outside the document.
Each task row shows a read-only completion checkbox centred on its first line of text, a
written status (Pending, In progress, Blocked, Completed) and its evidence note aligned
with the task text.


Exception for Chat review: desktop-only review records, immutable bounded file snapshots,
human review decisions and editable pending feedback are persisted beneath the private
`.code60_workspace/reviews` directory beside the project database. This is not a general
job queue. Restart never automatically delivers saved feedback or grants worker authority.
Users explicitly reconnect saved reviews to a current chat. A human can preview and apply a
reviewed result to the open project and can undo an application. Agents can revise their
isolated work through feedback. CLI records and the database schema are unchanged.

Chat review groups workers by the human request that dispatched them. A Changes tab shares
the Chat side panel with project and revision-specific file tabs. Overlapping paths in
different workers remain distinct. Git snapshots use a temporary index and immutable blob
content, with limits and explicit unavailable/partial states. Revision selection remains
stable as new captures arrive. Feedback anchors carry revision, worker, path, side and lines;
changed content invalidates reviewed state and marks earlier anchors outdated. Only humans
resolve feedback or mark files reviewed. Pending feedback is delivered through the conversation
coordinator between turns, with explicit status, retry and withdrawal. Saved provenance never
authorizes a worker mutation. Existing ownership, scope and recovery checks still apply.

New Chat tasks at the repository root share a frozen baseline of current saved files unless a
worker uses an explicit Git base. A temporary index captures tracked changes and eligible
untracked files while respecting Git ignores and excluding Code60 storage, common generated
files and known untracked credential filenames. Internal snapshot commits use
`refs/code60/tasks/` and leave HEAD, branches and staging alone. Each review revision can
reference immutable worker captures independently of bounded display text. Older reviews
remain readable and need a new capture before application.

**Use these changes…** previews the worker changes combined with the current project. Applying
requires confirmation and idle or ended workers. Conflicts leave the project untouched.
**Ask workers to revise** sends a separate feedback batch to the attached conversation and
records the conflicting context so a correction can preserve the user's edit. Apply and undo
recheck affected files, serialize writes per checkout and record before and after contents in
private review storage. Interrupted writes require explicit recovery, which preserves newer
edits and reports unresolved paths. Worktrees and internal snapshots are retained. The
application supports regular files up to 32 MiB and bounds journal content at 128 MiB. Changed
links and submodules are refused.

These are deliberately out of scope. Add one back only when a real user needs it.

- Merging, committing worker changes to a project branch, pushing, or deciding whether a task succeeded. Exceptions for explicit initial commits and internal desktop task snapshots are described here.
- Retries, durable task queues, and exactly-once execution. A failed run is reported, and the user starts a new one.
- Automatic crash recovery. After a crash, the tool lists what was left behind; recovery starts only when the user sends a new message to an ended session in the desktop app.
- Storing credentials. Agents log in through their own CLIs. The CLI passes the environment through unchanged; desktop startup enriches only PATH to discover installed tools.
- Settings profiles, workspace trust, imported project settings, and settings export. The desktop app's saved run configurations (see [Desktop app](#desktop-app)) are the one exception: named batch settings stored in the project database, never applied to the CLI or the config file.
- CLI orchestration services, external ACP servers, and arbitrary agent-to-agent communication. Only the desktop Orchestration Chat may dispatch and control its own workers in the open project through the scoped MCP tools described below.
- Agent-controlled session save and fork; steering (prompting an agent in the middle of a turn); and mid-run model changes. Follow-up prompts between turns are supported in the desktop app only. Explicit ACP restoration of ended desktop runs is described in [Ended-run recovery](#ended-run-recovery).
- Budgets, cost tracking, and usage totals. The desktop shows only the current context occupancy reported by the harness.
- Workspace capacity limits, transcript retention, and Worktrunk hooks. The read-only Worktrees tab measures logical file sizes when it is opened and in the background while it is visible, but does not enforce limits. Private desktop diagnostics are the focused retention exception described below.
- File watching. The desktop app polls external state on a schedule (see [Polling](#polling)) instead.
- Shared or remote Code60 servers, and coordination across machines. User-configured remote MCP tool servers are supported as described below.
- Sandboxing. A worktree is not a security boundary, and the agent runs with the user's permissions.
- Windows ARM64 and Windows versions older than Windows 11. Windows desktop distribution targets x64 only.

## Desktop diagnostic logging

Desktop startup alone enables an optional typed log sink in core and agents. The
headless CLI does not construct a store or enable capture; its commands, output,
exit codes and run records are unchanged. Browser-safe record/query schemas live
in contracts and cross the bridge through its existing entry point. Desktop owns
the focused JSONL store, not SQLite or the transcript store.

Diagnostic records use version 1, generated record/launch/operation UUIDs, UTC time,
fixed component/event/message values, severity, outcome, optional duration and
allowlisted provider/run/project identifiers and error categories/codes. Project
identifiers hash the project directory; paths are never recorded. Each turn has its
own correlation ID even when turns overlap. Streaming chunks and successful polls
are not diagnostic events. Persistence failures are coalesced per run.

Storage is `$XDG_STATE_HOME/code60/logs` (default `~/.local/state/code60/logs`),
separate from transcripts, preferences and databases. Diagnostics alone retain up
to seven days and 20 MiB total, including active segments. Startup writes, reads
and writes prune storage; queries also check record expiry. Private segments rotate
at 256 KiB or one minute. A shared exclusive directory lock serializes every app's
pruning, append, clear and query, with a 300 ms acquisition deadline. Live or
unverifiable owners are never displaced; dead-owner locks become reclaimable after
30 seconds. Unique owner filenames prevent stale reclaimers deleting a new owner's
file. POSIX ownership/modes and Windows private ACL checks reject unsafe storage.

Capture validates an allowlist before serialization. It accepts no arbitrary text,
exceptions, prompts, transcript fragments, raw ACP/tool payloads, environments,
commands, arguments or absolute paths. No approved free-form diagnostic text is
currently stored; any future approved text must use existing credential redaction
before UTF-8-safe truncation. This is not encryption or an anonymization guarantee.
Records are capped at 2 KiB; pending capture is bounded by 512 records and 512 KiB.
Logging failures never throw into lifecycle operations or recursively log themselves.
Shutdown flushing waits at most 500 ms. Dropped records, persistence failures in
this launch, and malformed/truncated retained records appear explicitly in the viewer.

Apps → Data Viewer → Logs sits alphabetically between Events and Messages and has a palette
entry. It remains usable without a database. Compact selectors beside the title choose
current-project scope (including app events) or all projects and the current launch; all-project, launch, severity, component, provider, run, outcome and time
filters apply to retained history, not just the page. Shared DataTable column
settings and saved filters are reused. Search/filter changes discard stale responses.
Pages contain at most 200 records and use bounded, five-minute opaque cursors.
Cursor snapshots pin file byte boundaries, including same-millisecond writes.
Main retains at most 128 cursor tokens and 2 MiB of estimated snapshot metadata;
the viewer retains a 128-page back stack but can keep paging into older history.
Refresh always returns to the latest page. Evicted,
expired/cleared/restarted cursors require an explicit latest-page refresh. Column
sorting is page-local. Clicking a row or Enter opens structured details and Copy
record. Main-process notices are batched at 40 ms; there is no renderer fetch timer.
Paused, selected, scrolled and older-page readers are not moved by live notices.
Viewing pause never pauses capture. Clear logs requires a native confirmation and
touches diagnostic segments only, never Events/transcripts, databases or run records.

For diagnostics, preload exposes only `queryLogs`, `logDetail`, `clearLogs` and a payload-free
`onLogsChanged` subscription. Main checks the sender and bridge validates strict
bounded requests. No request accepts a path; no agent or MCP tool can access logs.
The seven-day/20 MiB policy does **not** expire or limit existing transcripts.

## Modules

| Module | Source | Responsibility |
| --- | --- | --- |
| CLI | `src/cli` | Argument parsing, headless output, signals, and exit codes. |
| Desktop | `src/desktop` | Electron main process: the window, native dialogs, the IPC handlers, one workspace with multiple independent run batches, and shutdown. |
| Bridge | `src/bridge` | The typed IPC contract between `desktop` and `renderer`, and validation of every request from the renderer. |
| Renderer | `src/renderer` | The React interface, built with Vite. It runs sandboxed, with no Node.js or Electron access. |
| Contracts | `src/contracts` | Browser-safe Zod schemas, shared value definitions, and the prompt templates sent to agents; no application or platform dependencies. |
| Core | `src/core` | Runs, the parallel scheduler, permission policy, run records, and leftover detection. |
| Automation | `src/automation` | Electron-independent scheduled execution service, private metadata, execution integration and local client. |
| Agents | `src/agents` | Starting an agent process, the ACP client, translating ACP updates into run events, cancelling, and killing the process. |
| Git | `src/git` | Creating, listing, and removing worktrees, measuring their logical file sizes, diffs, and status, using the `git` executable. |
| Platform | `src/platform` | Node-only leaf module for executable/environment resolution, owned process trees, native identity, path identity, and private storage. Uses the first-party `native/windows` helper on Windows, never an ABI-dependent addon. |

```mermaid
flowchart LR
  CLI["cli"] --> Core["core"]
  Renderer["renderer (React)"] -. preload IPC .-> Desktop["desktop (Electron main)"]
  Renderer --> Bridge["bridge"]
  Desktop --> Bridge
  Desktop --> Core
  Bridge --> Core
  Bridge --> Contracts["contracts (Zod)"]
  Core --> Contracts
  Agents --> Contracts
  Core --> Agents["agents"]
  Core --> Git["git"]
  Agents --> ACP["agent process (ACP over stdio)"]
  Git --> GitBin["git executable"]
  Desktop --> Platform["platform (Node only)"]
  Core --> Platform
  Agents --> Platform
  Git --> Platform
  Platform --> Win32["Win32 helper / Job Objects"]
```

- `cli` depends on `core` and `automation`. `automation` depends only on `core`, `contracts` and `platform`. Pure recurrence lives in core; OS service primitives live in platform.
- `desktop` depends on `core`, `bridge`, `automation` and `platform`. `bridge` and `renderer` may import only types from `core`; neither may import `platform`. The renderer reaches the main process only through the preload bridge. Only `desktop` imports Electron, and only `renderer` imports React.
- `agents` and `git` never import each other or `core`. `core` receives them as injected interfaces, so tests can use fakes.
- `core`, `bridge`, and `agents` may import `contracts` through its index. `contracts` imports only Zod, never application modules or Node.js. It owns shared IDs, tool kinds, stop reasons, duration rules, and the [prompt templates](#prompt-templates). Record schemas live in `core`, IPC schemas in `bridge`, and config schemas in `core`. Zod code generation is disabled before schema construction to preserve the renderer CSP.
- Domain logic lives in `core` and runs without the desktop app.
- `core`, `agents`, `git`, and `desktop` may import `platform` only through its index. `platform` imports no application modules, Electron, React, or provider SDKs. Bridge, renderer, and contracts remain browser-safe.

### Native Windows contracts

On Windows, all agent roles use a first-party helper executable outside ASAR.
It creates agents suspended, assigns them to exclusive kill-on-close Job Objects
with no breakaway, restricts inherited handles to ACP stdio, and then resumes
them. A separate authenticated control pipe and an owner-process handle stop
the job on owner/control loss. Root exit also terminates descendants. Startup
has a five-second deadline and job exit verification a five-second deadline.
ACP cancellation and its ten-second wait are unchanged. Windows then terminates
the owned job, without emulating SIGTERM. POSIX retains its existing grace.

Optional native identities contain creation time, owner SID, and agent job name.
Legacy records remain readable. Windows never authorizes a leftover stop using
command text or a PID alone. Missing, inaccessible or mismatched identities
block continuation/discard and unsafe stops; only a verified absent owned job
authorizes writing to its worktree again. Owner access failures are conservative.
Recovery remains explicit and ACP once-only permission rules are unchanged.

Windows desktop discovery reads inherited, user and machine PATH and documented
installation directories, separated with semicolons. It never runs shell profiles.
Environment names are case-insensitive on Windows; absolute executable commands
remain authoritative. Standard npm/npx shims resolve to their CLI JavaScript and
a matching Node executable. Other batch launchers use one rejecting adapter,
never blanket shell mode. Prompts stay on ACP stdin.

Browser-relative file paths remain slash-separated. Windows previews/listings
hold non-delete-sharing handles for every ancestor, reject every reparse point,
and bound reads. Local absolute drive paths are supported; device/drive-relative
paths, alternate streams and unsupported long paths fail clearly. Filesystem
identity uses canonical spelling, not globally lowercased paths. XDG/home config
and state defaults remain unchanged. New private objects receive restrictive
owner/SYSTEM ACLs at creation; existing user parent ACLs are never rewritten.
An unsafe existing Code60-private ACL fails closed. Atomic rename retries only
Windows EBUSY, asynchronously for at most 500 ms, never delete-then-write. Each
helper rename attempt keeps the normal seven-second helper bound.

## A run

A run is one agent session in one new worktree (or, [without a worktree](#runs-without-a-worktree), directly in the current directory). It starts with one prompt (in the desktop app, the prompt is optional; see [Desktop app](#desktop-app)). In the desktop app, you can send follow-up prompts after each turn, and the agent keeps its context. A headless run is exactly one turn.

1. **Create the worktree.** Core creates a run ID, then, when the run has a worktree, `git` runs `git worktree add -b code60/<run-id> <path> <base>`. `<base>` defaults to `HEAD`. Worktrees go in `<repo-parent>/<repo-name>.worktrees/<run-id>` unless the config says otherwise.
2. **Start the agent.** `agents` spawns the configured command with the worktree as its working directory, in its own process group. It initializes ACP, creates a session rooted at the worktree, and sends the prompt.
3. **Stream events.** ACP session updates become run events (see [Run events](#run-events)). Core appends each event to the run's event log and forwards it to the CLI.
4. **Answer permission requests.** Core applies the [permission policy](#permissions). The desktop app may ask the user. Headless mode never waits.
5. **End the turn.** In headless mode, the turn's stop reason decides the run's final status, and `agents` stops the agent process. In the desktop app, the run becomes `idle` instead (see [Follow-up turns](#follow-up-turns)).
6. **Review.** `code60 diff <run-id>` shows the worktree's changes against `<base>`, including untracked files and any commits the agent made. The user keeps the work by committing or merging with Git, or removes it with `discard`.

The tool advertises no ACP file-system or terminal client capabilities. Agents use their own tools inside the worktree, and permission requests are the only point where the tool approves anything.

If an agent requires ACP authentication, the run fails with a message telling the user to log in through that agent's own CLI.

### Runs without a worktree

In the CLI, when the current directory is not inside a Git repository (or `git` is missing), or `HEAD` resolves to no commit because the repository has none yet, the runs have no worktree. The agent starts directly in the current directory, and nothing is created, initialized, or committed for it.

- The CLI says so on standard error before the runs start. With more than one run, it warns that the runs share the directory and can overwrite each other's changes.
- `--base` still requires a commit and is a usage error (exit code 2) when it cannot be resolved.
- The record has `base` and `branch` set to `null`, and `worktree` is the directory the agent ran in. `--json` reports `"branch": null` and `"changedFiles": null`.
- `diff` and `discard` refuse (exit code 1), because there is no separate worktree or branch. Review and undo the changes in the directory itself. `list` and `stop` work as usual.

### Run statuses

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for a free slot under the parallel limit. |
| `running` | The agent is working. |
| `waiting` | A permission request is waiting for the user (desktop app only). |
| `idle` | A turn ended, and the agent is waiting for a follow-up prompt or for you to finish the run (desktop app only). The agent process stays alive. |
| `finished` | The last turn ended normally (`end_turn`). This is not a check that the task succeeded. |
| `failed` | The worktree or agent failed to start, the agent exited, ACP failed, or the last turn stopped for any reason other than `end_turn` or `cancelled`. The reason is recorded. |
| `cancelled` | The last turn was cancelled by the user, or the process received SIGINT or SIGTERM. |
| `timed_out` | The last turn exceeded the turn timeout. |
| `interrupted` | Found after a crash: the run was active, but the process that owned it is gone. |

### Parallelism

`run` accepts several agents. Each `--agent` flag creates one run, and the same agent may be named more than once. When only one agent is named (or none, meaning the default agent), `--parallel <n>` starts `n` runs of it, all at once, up to 32. With several `--agent` flags, `--parallel` instead overrides `maxParallel` for that invocation. Core keeps an in-memory queue and starts runs up to `maxParallel` (default 4). An `idle` run keeps its slot, because its agent process is still alive; finish it to free the slot. A failed run does not affect the others. Nothing is queued across process restarts.

Two `code60` processes can work on the same repository at the same time. Run IDs, branches, worktree paths, and record directories are all unique per run, so the processes never write to the same files.

The desktop app can also run multiple independent batches in the current project. Each batch has its own orchestrator and selected parallel limit, not a project-wide limit. New sessions do not inherit earlier sessions' ACP context or worktree changes; each isolated worktree starts from its selected base revision. Without worktrees, sessions necessarily share the folder's changes.

### Follow-up turns

In the desktop app, a turn that ends for any reason other than an agent exit or ACP failure moves the run to `idle`. From `idle` you can:

- **Reply.** Type a prompt and send it. Core sends it as a new `session/prompt` on the same session, and the run returns to `running`. A new prompt is sent only after the previous turn has ended.
- **Finish.** End the run. `agents` stops the agent process, and the last turn's stop reason sets the final status, using the same rules as headless mode.

Core never reads an agent's message to decide whether it asked a question. You read it and decide whether to reply. An `idle` run has no timeout. Quitting the desktop app finishes every `idle` run.

### Ended-run recovery

Recovery is explicit and desktop-only. It never starts automatically after a crash. Sending a new message from the chat composer continues any ended run (`finished`, `failed`, `cancelled`, `timed_out`, or `interrupted`) in the open workspace. Resume in the actions menu or command palette only opens the chat and focuses its composer; it starts no agent. Queued, running, and waiting runs are already active; an `idle` run already has a live session that accepts replies. Continuation is disabled while the ended run's recorded agent process group is alive, or after its worktree was deleted. The user must stop a leftover process before trying again; core checks the process group again before starting a writer.

When the record has an ACP session ID, sending the message launches the configured agent in the existing worktree and initializes ACP. It calls `session/resume` when advertised, otherwise `session/load` when advertised. Transcript updates replayed by `session/load` are suppressed because the append-only event log already contains them. A successful restore keeps the run ID, branch, worktree, and history, records a reconnection note, and sends only the new message, without resending any prior prompt.

If the record has no ACP session ID, the agent does not advertise restore, or ACP restoration fails, the same send action starts a fresh ACP session in the same worktree without a confirmation modal. Code60 builds a deterministic handoff summary of at most 12,000 characters from the `handoffSummary` [prompt template](#prompt-templates) from saved prompts, agent messages, tool-call summaries, and run state. It tells the new agent to inspect the worktree and verify completed work instead of blindly repeating prior requests. The first ACP prompt combines that summary and the user's new message. The transcript records only the new message as a prompt, and records the reason for the handoff as a note with an expandable Handoff summary. A failed agent start leaves the previous status unchanged. Handoff reuses the existing run record, branch, worktree, and event log; it creates no replacement run or worktree.

### Cancellation and timeouts

The turn timeout (`turnTimeout`, default 30 minutes) applies to each turn, not to the time a run spends `idle`.

Cancelling a turn, whether by the Cancel turn command (context menu or command palette) or timeout, sends ACP `session/cancel` and waits up to 10 seconds for the turn to end. In the desktop app, a turn that ends within that time leaves the run `idle`, so you can reply or finish. In headless mode, or when the turn does not end in time, the run ends: the agent's process group gets SIGTERM, followed by SIGKILL after 5 seconds. Killing the whole group also stops the tool processes the agent started. The worktree is always kept.

On SIGINT or SIGTERM, the CLI cancels every active turn and ends every run. It waits for the agents to stop and exits with code 130. The desktop app does the same on these signals, then quits. A second signal skips the grace periods.

## Permissions

ACP permission requests carry a tool-call kind: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, or `other`. A request with a missing or unknown kind is treated as `other`. The policy maps each kind to `allow`, `deny`, or `ask`:

```json
{ "read": "allow", "search": "allow", "think": "allow", "edit": "allow", "default": "ask" }
```

- `ask` prompts in the desktop app. In headless mode, `ask` means deny.
- `--allow <kind>` (repeatable) and `--allow-all` override the policy for one invocation.
- Core picks the agent's "once" option when allowing (`allow_once`) and when denying (`reject_once`). It never picks the "always" options, so the agent keeps no lasting grant. If the agent offers no matching "once" option, the request is answered as cancelled.
- Every decision is recorded as a `permission` event, with who decided it (`policy` or `user`) and the options offered by the agent.

## Run events

```ts
type RunEvent = { runId: string; at: string } & (
  | { type: "status"; status: RunStatus; reason?: string; turn?: number; completedAt?: string }
  | { type: "prompt"; turn: number; text: string; origin?: "automatic" }
  | { type: "note"; text: string; detail?: string }     // Reconnection or handoff explanation
  | { type: "message"; text: string }
  | { type: "thought"; text: string }
  | { type: "toolCall"; toolCallId: string; title: string; kind: string; status: string }
  | { type: "permission"; toolCallId: string; title: string; kind: string;
      decision: "allowed" | "denied"; by: "policy" | "user";
      options?: { optionId: string; name: string; kind: string }[] }
  | { type: "turnEnd"; turn: number; stopReason: StopReason;
      completedAt?: string; outcome?: "finished" | "cancelled" | "timed_out" | "failed" | "interrupted" }
  | { type: "sessionState"; state: SessionState } // Model, context occupancy and harness modes
  | { type: "acp"; update: string; payload: string; size: number; truncated?: true }
  | { type: "stderr"; text: string }   // Written once when the run ends: up to 64 KiB of scrubbed stderr
);
```

Every ACP session update is recorded as a raw `acp` event, including updates that also produce typed events and updates the tool does not understand (plans, non-text content, tool inputs/outputs, and other provider fields). `update` is the ACP update name, `payload` is its JSON text, and `size` is its original UTF-8 byte count. Payload text is capped at 256 KiB per update, clipped at a complete UTF-8 code point with `truncated: true`; clipped payloads are not necessarily valid JSON. Unrecognized updates are never treated as errors or approvals. Raw and typed transcript updates replayed by `session/load` are suppressed to avoid duplicating history. Session metadata is collected during setup/replay and published once as current state after the setup response. Each completed ACP prompt response records its turn number and stop reason as `turnEnd`; transport failures instead retain the run's failure status/reason.

### Session information and harness modes

Orchestrator and worker composers share a compact footer: the current mode on the left; context donut, read-only model name, 20px harness logo and Send/Stop on the right. Metadata formerly below the composer is inside it. Missing reports use **N/A**; zero capacity has no percentage. The donut uses dark charcoal for used capacity against a light track, clamps its visual fraction to 0–100%, and exposes reported token counts and percentage in a mouse/keyboard tooltip. Long model names truncate with full-name tooltips; unknown harnesses use a Carbon terminal icon. The footer wraps on narrow composers. Context usage may decrease after compaction and is never inferred from transcript length. The model label is read-only. Ended sessions retain read-only values identified as **Last reported** in their tooltips.

To change a mode, wait until the session is idle and use the custom popover menu above its trigger. It preserves advertised controls and option groups, uses radio semantics and checkmarks, supports arrow/Home/End/Enter/Space navigation and Escape/outside dismissal, and restores trigger focus. Busy, inactive, ended, session replacement and new mode reports dismiss an open menu. The visible Harness Mode label is omitted, with an accessible label retained. Names, ordering and groups come from that harness; Code60 does not impose universal approval levels. **Code60 auto-approval**, shown in the mode trigger tooltip, is a separate policy. Orchestration chats and their workers keep it on: selecting an Ask mode does not turn off Code60's automatic once-only answers to permission requests. The harness determines the effects of its modes, including any sandbox behavior; Code60 forwards the selected value.

The stable ACP v1 adapter prefers categorized select `configOptions` and uses legacy `modes` only when config options are absent. It does not advertise boolean-config support or interpret provider metadata. New/load/resume responses and pushed config, mode and usage notifications feed a bounded, validated session snapshot. Updates before a new session's ID arrives are limited to 128 metadata notifications / 256 KiB and matched to the returned ID. Usage has safe nonnegative integer counts; malformed/unsupported controls cannot grant capabilities.

Optional `sessionState` in `run.json` and `RunView` retains model, usage, mode controls and report timestamps. Deduplicated `sessionState` events use existing ordered writes and snapshot revisions, without polling, SQLite changes or a record-format bump. Older records remain readable. Fresh handoffs clear old values; restored connections use newly reported state without reapplying a saved mode. State events do not become conversation text, unread replies, timing activity or worker summaries. CLI JSON output omits this added record metadata.

The existing worker/chat IPC action unions accept a narrow `set-mode` action with a run ID and `{source, configId, value}`. Main-process ownership and core idle-state checks apply, and values must match current advertised choices. Core exposes a pending mode-change flag, rejects overlapping prompts/changes, and automatic worker delivery waits until it clears. The controller releases its action queue while awaiting the RPC so shutdown and other sessions remain responsive. Requests time out after 15 seconds; local waits abort on shutdown. A rejected change retains reported state; a timeout labels mode unconfirmed until a subsequent report or successful retry. No failure claims to roll back the harness.

## Files

Project run records live inside the repository's Git directory, so they travel with the repository. The desktop orchestration conversation instead keeps its records in `.code60_workspace/<chat-folder>/.code60/runs` beside the connected database. Outside a Git repository, they live in `$XDG_STATE_HOME/code60/dirs/<key>/runs/` (default `~/.local/state`), where `<key>` is the first 16 hex digits of the SHA-256 of the directory's absolute path. `list` and the other commands look in the same place for the directory they run in.

```text
<git-common-dir>/code60/runs/<run-id>/
  run.json       Run record: status, agent, first prompt, turn count, base, branch, worktree, PIDs,
                 the agent's command line, times, last stop reason, and when it was discarded
  events.jsonl   Append-only run events, for display and review
```

- `run.json` is replaced atomically (written to a temporary file, then renamed). `events.jsonl` is append-only.
- Records and events are validated when read, including agreement with the requested run ID. Malformed records are omitted from listings; directly reading a malformed record or event log reports an error without including its contents. Unknown metadata fields are ignored, and older records without optional recovery fields remain readable. Event readers skip unknown string event types after checking their run ID; known types still require valid fields. Older releases reject logs containing `acp` or `turnEnd`, so this run-record change requires a major release.
- Both files are created with mode `0600`. The event log can contain anything the agent printed, so it is treated as sensitive. It never leaves the machine.
- Raw ACP updates preserve provider content as well as the typed display events, so logs grow faster and may contain sensitive tool inputs and outputs. The 256 KiB raw-payload cap applies per update, not per log; no total-size limit or retention policy is enforced. Stderr retains up to 64 KiB of scrubbed text, written when the run ends; oversized lines are omitted.
- The platform diagnostic utility redacts common credentials before clipping operational errors and stderr. ACP provider errors become generic failures instead of echoing provider text. This is best-effort protection, not PII anonymization: prompts, messages, tool payloads and raw ACP transcripts remain intact, and existing records are not rewritten. See [the security policy](SECURITY.md#local-data-and-sensitive-records) before sharing records.
- The first prompt is stored in `run.json` so `list` can show it. `run.json` also stores the optional ACP session ID for desktop recovery; older records without it remain readable. Every prompt, including follow-ups, is a `prompt` event in `events.jsonl`. Logs on standard error never include prompts.
- These files are records, not a recovery mechanism. If they are lost, only history is lost.

Configuration is one JSON file at `$XDG_CONFIG_HOME/code60/config.json` (default `~/.config/code60/config.json`). It is read-only to the tool; the user edits it.

```json
{
  "defaultAgent": "claude",
  "maxParallel": 4,
  "turnTimeout": "30m",
  "worktreeDir": null,
  "mcpServers": {},
  "permissions": { "read": "allow", "search": "allow", "think": "allow", "edit": "allow", "default": "ask" },
  "agents": {
    "claude":   { "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"] },
    "codex":    { "command": ["npx", "-y", "@agentclientprotocol/codex-acp"] },
    "opencode": { "command": ["opencode", "acp"] },
    "droid":    { "command": ["droid", "exec", "--output-format", "acp"] }
  },
  "prompts": {
    "handoffTurn": "{{summary}}\n\nThe user's new message follows. Check the worktree first, then respond to it.\n\n{{message}}"
  }
}
```

Every key is optional. `permissions`, `agents`, and `prompts` are merged over the defaults shown above, one kind, agent, or template at a time. Unknown keys (including inside agent definitions) and invalid values are a configuration error (exit code 2). Durations use the same grammar in CLI configuration and saved desktop configurations, and must total a positive safe integer number of milliseconds.

The model is part of an agent's command or of the agent's own configuration. The tool does not pick models; the desktop displays the model reported through ACP configuration.

### User MCP servers

The optional top-level `mcpServers` map defaults to empty. See [MCP configuration](MCP.md)
for stdio, HTTP and SSE examples. Each definition has an explicit `type`: stdio
accepts only `command`, `args` and `env`; HTTP/SSE accept only `url` and `headers`.
Names and commands must be nonempty, arguments and environment/header values must
be strings, and URLs must use HTTP(S). Omitted `args`, `env` and `headers` become
empty collections. Unknown fields and the reserved server name `code60` are usage
errors (exit code 2). MCP validation and malformed-JSON errors never echo values.

The distributed `mcp.default.json` is an opt-in starter containing pinned stdio
Playwright MCP (isolated/headless) and Context7 definitions without credentials.
It ships in the CLI package root and desktop resources, but is never loaded
automatically or copied over user configuration. Users explicitly merge selected
entries into `config.json`; runtime defaults remain empty.

The default orchestration contract permits explicitly requested tasks through
user-configured MCP tools, while project edits still go to workers. It follows
the provider's tool catalog, including OpenCode's Code Mode `execute` wrapper;
inner MCP tool names are not assumed to be direct top-level tools. This guidance
grants no new main-process authority and does not authorize shell commands.

Tool-call events may include optional `mcp: { server?: string }` attribution.
The agents adapter recognizes documented structured programmatic MCP tool names
and Claude ACP metadata, never free-text titles, arguments or configured-server
presence. Partial updates retain attribution; corrected names may replace it.
Only the marker and bounded server label enter typed history and snapshots.
Legacy history remains readable without attribution. Both chat renderers show a
shared MCP badge and server label; Events adds a category-filterable Server column.
Unknown explicit MCP calls say Unknown; ordinary tools remain unlabelled.
Attribution is presentation metadata, never authority or evidence of success.
The built-in worker transcript projection flattens attribution to `mcp` and
`server` fields, keeping its scalar-only contract.

Core resolves a detached server list when preparing headless CLI runs, desktop
manual runs, dispatched workers, orchestration chats and explicit ended-run
recovery. Only chats also receive their own built-in Code60 stdio gateway.
Workers, CLI and manual sessions receive configured servers without that gateway.
Setup/connection probes, episodic-memory extraction and search-summary helpers
receive neither user servers nor the gateway.

The ACP adapter sends definitions on `session/new`, `session/load` and
`session/resume`, translating maps to ACP environment/header entries and omitting
the stdio `type` on the wire. After initialization it requires the provider's
`agentCapabilities.mcpCapabilities.http` or `.sse` to be `true` for every configured
remote transport. Missing support fails session startup explicitly and follows
normal connection/process cleanup; servers are never silently dropped.
Stdio requires no optional capability.

Config reloads do not restart or alter active sessions, including idle sessions.
Later runs/workers, new/retried chats and explicit recovery use the newly resolved
configuration. Restoration and fresh handoffs do not use saved server definitions.
Definitions stay in main-process memory and ACP setup requests, not run records,
transcripts, renderer snapshots or CLI results. The agent owns MCP connections and
stdio children; Code60 retains its existing agent process-tree cleanup and
once-only permission policies. This is not a new sandbox or a permission grant.

Configuration stays user-managed and read-only, without a Settings editor,
credential writes, OAuth implementation or environment-variable interpolation.
Users must trust their providers and servers: configured environment/header values
are sent to the selected provider, and agent/tool output can still contain sensitive
content in ordinary transcripts. Keep the config private and out of source control.

### Prompt templates

Orchestration and recovery prompts that Code60 writes itself are templates in `src/contracts/prompts.ts`. Dedicated memory extraction and search overview helpers use fixed prompt-rendering functions in `contracts`; these are not orchestration template overrides. A template marks merge fields as `{{name}}` (spaces inside the braces are allowed). `prompts` in `config.json` may replace any template by its ID. The `operatingContract` is injected before each user message in the orchestration chat; its text is not recorded as if the user wrote it. ACP v1 has no stable system-prompt field, so this context is included in the prompt sent to the selected provider.

The orchestration chat uses the connected database's saved Operating Contract edit first, then `config.json`, then the built-in template, on each new turn. Desktop handoffs resolve each template the same way; edits apply only to later handoffs, never a turn already in progress. Edits are shared by every project in that database. The CLI does not read database edits and never sends these templates.

`operatingContract` is a fixed clause map rather than a string. Its required keys, in assembly order, are
`role`, `requests`, `delegation`, `planning`, `workers`, `activity`, `updates`, `reviews`,
`permissions`, `discovery`, `browser`, `untrustedData`, and `responses`. Each value must be nonempty
text with no merge fields. Assembly joins the text with one newline, without adding clause labels,
and the complete body must fit the existing 8,000-character limit. The renderer preview and main-process
agent delivery share the same assembly function. Configuration overrides must supply the complete map;
legacy string overrides reset to built-in clauses instead of being migrated.

| Template | Sent | Merge fields |
| --- | --- | --- |
| `handoffSummary` | The summary of an ended run for a fresh handoff session, truncated to 12,000 characters after merging. | `status`, `turns`, `agent`, `branch` and `base` (`none` without a worktree), `worktree`, `reason` (`none` when not recorded), `prompts` (one `- ` line each), `messages` (one line each), `toolCalls` (`- title (kind, status)` for the latest state of each call); lists are `(none)` when empty |
| `handoffTurn` | The first prompt of a handoff session. | `summary` (the merged `handoffSummary`), `message` (the user's new message, required) |
| `operatingContract` | Prepended to each user turn in the app-wide orchestration chat. | none |
| `workerUpdates` | Automatic worker turn-end and failure updates, delivered between orchestration chat turns. | `updates` (required; worker states and bounded reply excerpts) |

- A template is at most 8,000 characters and not empty. An unknown or malformed merge field, an unknown template ID, or a missing required field is a configuration error (exit code 2).
- Merging is one pass: values are inserted as they are, never escaped and never scanned for further merge fields. Saved prompts and agent output are untrusted text inside the prompt.
- Automatic orchestration turns also receive the Operating Contract, with an explicit automatic-update heading. Their prompt events carry `origin: "automatic"`; older/user prompt events omit it. The saved clause set is assembled immediately before delivery; edits never affect a turn already in progress.
- The CLI's own prompts are exactly the user's text, so headless runs use no template.

### Commands

Commands are reusable user-authored prompts, separate from system prompt templates.
The Command Builder page precedes Prompt Builder under Apps. It lists `/name` and title beside an editor
for Name, Title, Description and Prompt, with Save, Discard and natively confirmed
Delete. The name follows the title until manually edited. Drafts stay in memory
across page, project and command switches within the connected database.
The Command Builder page uses the page-title header style; its title and New command
action remain outside the scrolling list/editor body, including narrow layouts.

Schema 5 adds `code60_commands`: UUID `id`, case-insensitive unique `name`, `title`,
`description`, `prompt`, `created_at` and `updated_at`. Upgrades from schemas 1–4
create the table in the same transaction as earlier upgrade steps; upgrading from
4 does not reset Operating Contract clauses again. Commands are shared across
projects in that database and never stored in project files.
Contracts bound names to 1–64 lowercase letters, digits and hyphens (starting with
a letter or digit), single-line titles to 120 characters, optional descriptions to
500 characters, prompts to 100,000 characters, and saved commands to 200.

The orchestrator-only `code60_create_command` MCP tool accepts the same fields
without an ID and saves immediately only when the user requests a reusable command.
It uses the authenticated current-chat gateway and serialized main-process writes,
returns the saved command, and publishes updated snapshots. Duplicate names and
the command limit fail without overwriting anything. It cannot update or delete
commands, execute prompts, or grant workers access to commands.

The bundled `/create-command` prompt is available in the orchestrator slash picker
without a saved row. Append a description of the command to create; the prompt asks
the orchestrator to infer its fields, clarify missing instructions, call
`code60_create_command`, and report the saved invocation without running its prompt.
The bundled `/plan` command asks the orchestrator to create or revise a Code60 plan
for the supplied request, then end its turn and wait for the human Accept action.
The bundled `/business-evaluation` command preserves the supplied entrepreneurial
evaluation prompt verbatim. Its mandatory plan gate forbids research, substantive
analysis, delegation and deliverables before Code60 delivers acceptance. After
acceptance, it requests evidence-based evaluation, a bounded challenger review
when useful, and five documents or labelled sections: decision brief, supporting
feasibility analysis, market/economics model, risks/assumptions, and validation plan.
These are prompt instructions, not new execution authority or automated jobs;
existing plan, Git-readiness, worker ownership and permission checks still apply.
Built-ins are supplied by contracts and resolved by main at send time. They do not
count toward the 200 saved-command limit or appear as editable database rows.
An existing saved command with the same name takes precedence in both the picker
and main, preserving user-authored commands.

The narrow `saveCommand` and `deleteCommand` preload methods are strictly validated
in bridge and checked again by main. Snapshots include commands sorted by name,
or an empty list without a database. Main resolves the current database command
with bundled commands as a fallback
when an orchestrator `send` request includes its name, rejecting missing commands
instead of silently sending plain text. After the Operating Contract and
`--- User request ---`, the agent receives:

```text
Command /name: <title>
<prompt>

Additional instructions:
<text after /name>
```

The Additional instructions block is omitted when the suffix is empty. Only one
command is expanded, at the very start of a message. There are no placeholders or
argument substitutions. Core keeps delivered text separate from the exact typed
text recorded in prompt events; the user bubble marks the recognized leading
command, and Copy still copies the original message.

The orchestrator composer exposes a filtered ARIA combobox while the caret is in
the initial slash word. Up/Down selects; Enter or Tab inserts `/name ` rather than
sending; Escape dismisses. Unknown slash words show a plain-text notice and are
sent unchanged, including paths such as `/tmp`. Worker chats and the CLI do not
expand commands.

## Leftovers after a crash

`run.json` records the PID of the owning `code60` process and of the agent's process group. When the tool starts, and whenever you run `list`:

- A run that was `queued`, `running`, `waiting`, or `idle` when its owning process disappeared is marked `interrupted`.
- If the agent process for an ended run still exists, `list` says so and shows its command line.
- `stop <run-id>` kills that process group, but only after confirming that the live process's command line still matches the recorded one, which guards against reused PIDs. The recorded command line is what `ps` reported right after the agent started, because launchers such as `npx` change how their command line looks. If it does not match, the tool refuses and prints the PID so the user can decide.
- Worktrees are never removed automatically.
- In the desktop app, an ended run with its worktree intact may be continued by sending a message after its leftover agent is stopped. It attempts ACP restoration first, then starts a handoff if needed as described above. This is not automatic crash recovery.

## CLI

```text
code60 run [prompt] [--prompt-file <path>] [--agent <name>]... [--base <rev>]
           [--turn-timeout <duration>] [--parallel <n>] [--allow <kind>]... [--allow-all]
           [--headless] [--json]
code60 list [--json]
code60 diff <run-id>
code60 discard <run-id> [--yes]
code60 stop <run-id>
code60 --version
```

- `run` is always headless and runs exactly one turn per run. It reads the prompt from the argument, `--prompt-file`, or standard input, and exactly one of them must be given. Standard input is read only when neither of the others is given and it is not a TTY. `--headless` is accepted for compatibility and changes nothing. Use the desktop app for interactive runs.
- In headless mode, progress goes to standard error: status changes, new tool calls, and permission decisions, without tool/permission titles or status reasons that may echo task content. `--json` writes one result object to standard output, `{"runs": [...]}`, with every run's ID, agent, status, reason, branch, worktree, and changed-file count. Diagnostic reasons receive best-effort credential redaction; fields and exit-code semantics stay unchanged. Without `--json`, a short table goes to standard output.
- `discard` refuses while the run is active or its agent process is alive. It shows the files that would be lost, then removes the worktree and its `code60/<run-id>` branch. It asks for confirmation in a TTY and requires `--yes` otherwise.

### Exit codes

When runs end with different statuses, the code earliest in this table wins:

| Code | Meaning |
| --- | --- |
| 2 | Invalid usage or configuration, including an unknown run ID. |
| 130 | Cancelled by a signal, or at least one run was cancelled by the user. |
| 124 | At least one run timed out. |
| 1 | At least one run failed or was interrupted. |
| 0 | Every run finished. |

## Desktop app

### Renderer ownership and composition

`main.tsx` only loads assets, runs existing preference migrations and mounts the
API-injected `App`. The shell composes snapshot, preference, window appearance,
visibility and splash lifecycles with focused pages, dialogs, menus and footer
components. `desktop-snapshot.ts` subscribes before the initial read and publishes
buffered updates atomically through the revision-aware snapshot reducer.

Ownership does not imply visibility:

| Lifetime | Owners |
| --- | --- |
| Application | Preferences, updates, notifications, navigation, splash, snapshot subscription and file-panel layout/visibility |
| Database | Orchestrator identities/events, conversation views and Command Builder/Prompt Builder drafts |
| Project instance | Worker views/selection, Explorer and file tabs/reads, transcript cache, table selections, menus and project dialogs |
| Conversation or dialog | Form/draft text, action progress/errors, scroll and disclosure state |

Hiding a page, closing the file panel or returning to splash does not dispose its
owner. Replacing the single open project disposes its temporary state and read
callbacks, but does not key or reset the database's conversations or editor
drafts. Database replacement also disposes those database-owned views. Existing
storage keys and persisted history remain intact. `ScopeLifetime` captures a
generation, not just a path: completions from the first A in A → B → A cannot
publish into the new A. Snapshot replacement epochs preserve that boundary even
when React batches away the intermediate B render. Captured run/project identities go to existing bridge
methods; disposal never stops workers, deletes history, or replays actions.
Transcript reads stay bounded and file-context changes remain serialized.

`navigation.ts` is the static source for page and Settings IDs, labels, ordering,
groups, availability and palette destinations. `app-pages.tsx` renders an
exhaustive page map. Dynamic conversations stay separate. Focused modules replace
the former mixed `state.ts`: snapshot state, transcript formatting, session
presentation, appearance, typography and table preferences.

`ChatMessage` shares safe presentation, exact-source Copy/age controls and slots
for command highlighting or handoff details. `ChatDraft` shares storage and
revision-aware, success-only clearing without erasing in-flight edits.
`OrchestratorActions` and `WorkerActions` remain distinct controllers; recovery,
permissions, tactics, semantic activity and timing retain their feature owners.

`style.css` declares `vendor`, `tokens`, `base`, `layout`, `components`,
`utilities`, then `accessibility`. Feature sheets in `styles/` own navigation,
editors, settings, tables, chats, files/plans, overlays and splash. Glide CSS is
imported into `vendor`; necessary Monaco runtime adapters target only its editor
internals. Every control and surface is square through the shared zero `--ui-radius`;
only radio buttons and status dots remain circular, without a universal important radius reset. The preference
lifecycle retains selected `data-theme` and publishes resolved
`data-color-scheme`; explicit Dark and live System-dark use the same palette,
signal tokens, artwork and canvas/editor colors.

These are preparation boundaries, not concurrent-project support. There is no
project cache or multi-project host. Concurrent snapshots, polling, background
execution and execution authority still require backend/bridge design; view
activation alone grants none of those capabilities.

The Code60 desktop app is the interactive interface. It is a standalone Electron app with a React interface. `npm run dev` builds and starts it, rebuilding on changes; `npm start` starts the built app. It is not packaged or signed in this version.

- **Orchestration Chat.** Chat is the default page after the splash and renderer reload, and the first alphabetical sidebar entry. Once setup is complete and a database and enabled orchestration provider are available, the main process loads saved conversations as stopped history. With no saved conversations, it creates an initial idle ACP session in a generated UUID subfolder of `.code60_workspace` beside the database. **New chat** creates and selects another independent session; the expandable Chat group in the primary sidebar switches conversations without stopping background turns. An accessible Carbon plus action sits beside Chat, outside the tab button and available even while the Chat group is collapsed. It creates a conversation and reveals the group. Only labelled conversation buttons are nested beneath Chat, with selection, activity and failure indicators. Creation and selection share an in-flight guard and visible failure feedback. Expansion is remembered, external navigation reveals the selected conversation, and collapse never changes it. Each live chat has its own working directory, transcript, draft, scroll position, worker ownership, authenticated gateway and automatic-update inbox. New directories use mode `0700`; existing folders and legacy workspace contents are retained, with no Git initialization or branch creation. Sessions start idle without a prompt and use the fixed allow-all, once-only permission policy. They stay alive across page and project switches; changing databases, provider, or its configured command ends live chats while preserving their saved files. Renderer reloads reuse all main-process sessions and the selected conversation, never creating another. Conversations are independent of project batches, tables and search. Run and event records live privately in `.code60_workspace/<chat-folder>/.code60/runs`, outside SQLite. Restart restores only stopped history and metadata, not gateways, worker ownership, update inboxes or plan authority. The empty conversation shows “Give Code60 a task.” The header retains connection controls. The page presents user messages on the right and streamed replies on the left; thoughts, tools, permissions and session notes appear in inline activity dropdowns toggled by the live activity icon/status or completed turn timing. Errors stay visible. A persistent composer has square corners and a visible 1px hairline border with no outer shadow. It and both sidebars use the main app surface rather than a contrasting background fill, including resting controls and file previews. Focus replaces the normal border color with the focus color, without a separate inset line or layout shift, including system colors in forced-color mode. Worker composers use the same border replacement. The current provider logo appears inside the composer footer; connection, cancel and new-session controls remain in the header. It shows explicit semantic activity below the latest transcript message. Neither chat composers nor sidebar entries show striped loading lines. Current-project worker counts remain in the activity tooltip, supplied by main-process ownership snapshots even when automatic updates are paused. These counts never change orchestrator sendability or Stop semantics. Enter sends a new human request, Shift+Enter inserts a newline, and Stop cancels that chat's turn. Stopped chats offer explicit Continue task with the frozen tactic, or Send with the current selection; New session replaces only that conversation. The main process validates every action against an existing chat run ID; stale requests cannot target replacement sessions. Paths are generated only in the main process, never supplied by the renderer or agents. Existing core startup and turn timeouts, permission handling, cancellation and process-group cleanup apply. Stop all and every shutdown path stop every chat; quitting warns when any chat is starting or working, and idle orchestrators alone do not trigger a confirmation. Each chat's draft survives switching conversations, pages and renderer reloads for the current run. Initial database connection is available from Chat when needed.

- **Agent setup.** Every installation, including existing users with a legacy provider preference, must complete the desktop wizard once. The desktop-owned catalog presents Antigravity, Claude, Codex, Copilot, Droid, Kiro and OpenCode alphabetically with bundled logos in button cards that start detection and connection immediately on click or keyboard activation, without radio inputs or a Continue step. Wizard headings are 16px and text/controls 13px, independent of larger page-title preferences. Choose a Primary / Orchestrator, detect its executable and prerequisites, then initialize ACP and create a session without a prompt. Successful verification automatically commits through the existing main-process finish action, without add-another questions, review pages or confirmation dialogs. The result stays open with Close and an optional Add another agent action; failures offer Close and Retry. Save failures retain verification for an explicit save retry and never claim Connected. Each optional addition starts a new add transaction, preserving the saved primary and earlier successes even when a later attempt fails or is dismissed. Only Detected and Connected label agent status; progress and failures are separate. Settings offers Add agents and Change primary. Changing primary requires all active orchestration work to finish or stop; adding agents preserves live chats. Existing settings remain active until the verified connection is saved automatically.

- **Setup transaction and probes.** The main process owns the candidate, role, phase, errors and verified set, recovered through snapshots after renderer reload. A single attempt runs at a time. Detection refreshes desktop PATH and checks provider-specific prerequisites; npx alone does not establish Claude/Codex detection. Configured command overrides remain authoritative. Existing npx adapters may download when connecting; Code60 never installs provider CLIs or stores login credentials. A probe initializes ACP and creates a session in a generated private `code60-agent-probe-*` temporary directory independent of the database. It sends no prompts and creates no runs, transcripts or worktrees. The existing 15-second timeout and process cleanup apply; stop the process before removing the directory. Cancellation, dismissal, config changes, renderer loss/reload and shutdown cancel attempts and discard stale completions. Completed verification stays in memory until committed or abandoned.

- **Enabled agents.** The automatically invoked finish action atomically writes `agentSetup` version 1 to desktop preferences: primary provider, enabled IDs and SHA-256 identities of verified command argument arrays. Legacy preferences never satisfy this gate and available agents are never imported automatically. Persisted membership means configured, not a live connection. Automatic chat startup, manual and MCP worker dispatch, continuation, and saved run configuration validation require completed setup and an enabled provider with an unchanged command identity. Snapshots and MCP provider lists contain only enabled agents. Changing a verified command requires verification again. Core accepts an optional resolved configuration for desktop launches/recovery; the headless CLI still uses its original config, defaults, flags and lifecycle. Native desktop defaults add `agy acp`, `copilot --acp --stdio`, and `kiro-cli acp`, retaining Claude/Codex npx adapters and the existing Droid/OpenCode commands.

- **Visual system.** Light uses white surfaces except for colored user bubbles, including resting controls, table headers and rows, code blocks, disabled controls, and the footer. Hairline borders separate fields, buttons, groups and sections; only overlays keep one tight shadow. Hover uses pale blue fills without adding borders; selection uses neutral gray. Primary actions use blue (`#5b9fe6`). Dark and System dark mirror the white-surface treatment with midnight slate (`#0f172a`) resting surfaces throughout, including every table row, with `#162036` raised bands for table headers, dialog headings and button groups. Main text is white, muted text is `#9aa8bf`, subtle borders are `#2a3a55`, control borders are `#64799d`, and selection uses `#1e2b45`. The native title-bar overlay and window background use `#0f172a`. Fine borders separate controls and fields; disabled controls are dimmed with solid borders, without hatching or dashed outlines, and unavailable sidebar destinations are dimmed labels without outlines. The database notice is a single compact status row with its Connect to database action. Primary actions and user bubbles use a lighter blue (`#77b7f5`), with related shades for focus and hover. Status signals remain opt-in. The sidebar is square and has no outer border; main page surfaces use square corners without an outer border. Passive containers other than cards are square. The shared Code60 wordmark uses locally bundled D-DIN Regular, independently of text-role preferences, and has a small 45-degree chamfer at the upper-right of its colored 60 block. The subtitle retains its D-DIN font. Buttons, cards, checkboxes, switch tracks/thumbs, modal/popup windows and new-message composers are square; radio inputs and their selected dots stay circular, without altering Carbon checkbox marks. The selected sidebar row carries a 2px inset accent bar on its left edge. Digits use tabular numerals, and timestamps, counts, versions, card titles and fact labels use a compact monospace metadata face. The full-window splash and native window frame retain their existing geometry. Human message bubbles, agent messages, page panels and vendor editor/table internals remain square. Text fields, scrollbar thumbs and other passive containers stay square. Standard controls and composite prompt editors show a subtle shadow on keyboard focus. The Focus highlight border switch adds an outline and stronger halo. Both chat composers use a focus border, and independent icon actions highlight the glyph. The switch defaults off, applies immediately, and persists locally as `code60.focusHighlight`. When enabled, outlines follow control geometry; explicit selection, validation, approval and failure cues remain. Standalone buttons have no trailing-edge border effect. Related controls, including segmented radio choices, form seamless square groups with straight internal separators, with no overlapping hit areas. A fine outer border distinguishes control groups; their fill is white in Light and raised midnight slate in Dark. Standard groups use 28px controls (30px including the frame); compact groups use 24px controls. Menus, dialogs, chat windows, the palette and toasts use one tight overlay shadow. Sidebar pages and navigation groups use locally bundled Phosphor duotone icons sized to match their navigation label text. Carbon glyphs in navigation scale with the same setting. Resting left footer glyphs match the footer text. Original paths and 20% secondary-layer opacity are retained from @phosphor-icons/core 2.1.1 (MIT), without a dependency or runtime fetch. Decorative glyphs inherit their label color through hover, selection and forced colors. Icons are decorative, without extra names, focus targets or actions, and retain an 8px label gap and at least 12px of leading space. The gutter and 40px minimum rows expand with larger text to avoid clipping and preserve hierarchy alignment. Other icons use locally bundled IBM Carbon glyphs in the DOM and canvas, with 16px as the standard size. Six configurable text roles retain their independent choices. Status labels and symbols carry meaning with optional signal colors; nothing blinks. Reduced motion disables functional animation; forced colors retain visible control edges and selection. Scrollbars use subtle theme-relative thumbs and a stronger hover tone app-wide; forced colors retain native contrast. Dialogs, menus, editors and canvas-table scrollers reserve a stable gutter before overflow so wrapping and scrollbar appearance do not shift content sideways. Horizontal tab strips, workflow diagrams and code/table blocks reserve scrollbar height as well. Non-scrolling clipped frames keep automatic gutters, and Monaco retains its own overlay-scrollbar layout. No decorative dots or middle-dot delimiters are added outside the explicitly requested dotted preview frame.
- **Overlays.** Buttons with an accessible label or a `data-tooltip` show an inverted tooltip after a 500ms hover, or at once on keyboard focus or a quick move from another tooltip; Escape hides it. Tooltips prefer to sit above their control with a 2px stem pointing at it, flip below near the top edge, appear beside menus for menu items, and show shortcuts (from `data-tooltip-keys`) at the right. Unavailable menu items and buttons explain why in their tooltip. Cmd+K (Ctrl+K) opens a command palette, unless a dialog is open. An empty query lists every command in groups: Pages (Chat, File Explorer, and the remaining page tabs, including Prompt Builder and Settings), Project (New agent session, Open project, Connect to database, Poll project data, Stop all runs), Appearance (each theme, Signal colors, and Inline charts, with checkmarks on the current choices), and Session (commands for the selected session). Typing switches to one ranked list: label prefixes first, then word starts, then substrings, then matches in the group or run context, with matched letters bold and underlined. Arrow keys move, Enter runs, Escape closes and restores focus, and the footer counts the results. Unavailable commands are listed but disabled, following the same rules as the buttons they mirror. Right-clicking a session row, pressing the Context Menu key or Shift+F10 on the grid, or activating its Actions cell opens the same actions menu: Open chat and Review changes; Cancel turn, Finish run, Resume, and Stop leftover agent; and Delete worktree last under a 2px rule. Actions menus never have title strips. Items have Carbon icons; unavailable items keep their place, hatched, and say why in a tooltip. Arrow keys, Home, End, and typing a letter move between items; Escape or Tab closes the menu and restores focus, while an outside click, resizing, or window blur closes it without moving focus. Resume is unavailable while the recorded process group is alive or the worktree was deleted; it only opens the chat and focuses the composer. Toasts appear 16px from the window's bottom-left corner, newest at the bottom, at most three (a fourth displaces the oldest). Each has a Carbon icon, a written tone, and a 3px left rule: Note (4 seconds), Done (6 seconds), Warning (8 seconds), and Error (stays until dismissed or displaced). A bottom bar shows the time remaining; hover or focus pauses it, and the dismiss button or Escape closes a focused toast. Notes, Done, and Warning are announced politely; errors use `role="alert"`. Approvals stay in place until handled.
- **Splash.** Require verified main-process agent setup before entry. The full-window splash uses solid white or midnight slate for the saved Light, Dark or System appearance, with upper-right Light/Dark controls and a separate draggable top strip. Center the bundled D-DIN wordmark and exact subtitle "v0.2 'Paddock' (Beta)" with one Start button below them. Lift the group up to 48px within its available space, reducing the lift on short windows. Project selection is available through the Projects plus action after entry, not on the splash. Start and Escape enter without opening or switching a project; Start receives focus when configured and connected to a database. Retain the database notice and connection action when disconnected, the setup wizard when unverified, and actionable errors. Active runs do not block entry. Returning from the footer preserves projects, chats, drafts and active work; an explicit return remains visible across reloads until Start or Escape. Use system colors and visible focus in forced colors. Dark and System dark show one bundled, licensed background image (`src/renderer/splash-backgrounds/stripes.jpeg`) over the midnight-slate surface; Light and forced colors stay solid. There is no background selector or legacy splash-background preference.
- **Database.** Edit > Database Connection… in the native application menu, or Connect to database on the start screen, opens a Select database dialog to open an existing SQLite file or create a new one with the native file pickers. The database stores the history of opened project folders (canonical path and last-opened time), saved run configurations, prompt template edits and reusable commands; run records stay where they are. New databases use schema 5. Older Code60 databases upgrade in one transaction: schemas 1 and 2 gain the prompt-template table, schema 1 also gains the run-configuration table, single-block Operating Contract edits are reset once when upgrading from before schema 4, and schemas 1–4 gain the commands table. Other saved prompts, configurations and project history are preserved. Schema 4 introduced Operating Contract clause maps as JSON in its prompt-template row. Opening projects requires a connection. The app remembers the selected database in `$XDG_STATE_HOME/code60/desktop.json` and reconnects on launch; a saved database that is missing or unusable is reported, never recreated. Only empty files and Code60 databases are accepted, and other databases are never modified. Switching databases requires every run to have ended and closes the open project.
- **Workspace.** File > Open Project… in the native application menu (Cmd+O or Ctrl+O) is enabled while a database is connected and no batch is active. Open Project shows a dialog with the connected database's project history, newest first. Choosing an entry first asks for confirmation; Open Folder is a plus-labelled button link below the list and picks an existing folder with the native folder picker, then confirms the selected path before opening. Cancel leaves the current project and history unchanged. Neither action creates files or initializes Git. Each opened folder is recorded once. Remove takes one project out of the history without touching its folder or runs. The selectors no longer expose a bulk Clear history button. A folder that no longer exists is reported and stays in the history. Run records are found the same way as for the CLI, so the app shows the folder's earlier runs as history. Switching projects requires every run to have ended.
- **Run batches.** The sessions table's New agent session add row (see [Tables](#tables)), or New agent session in the command palette, starts one batch with an optional first prompt, one or more agents (the same agent may repeat), a parallel count with the same meaning as `--parallel`, and advanced options for the base revision, turn timeout, and per-kind permission overrides. Validation and defaults are the same as for `run`. Additional independent batches can start while earlier sessions are running, waiting for approval, or idle. Parallel limits apply per batch. The controller tracks each batch and its subscriptions, routes actions and approvals to its owner, and combines snapshots and sequenced events without clearing earlier transcripts. Completion history reads are serialized with starts and refreshes so overlapping batches cannot overwrite newer history or a switched workspace. Project and database switches stay blocked until all batches have ended; Stop all and every shutdown path stop all batches, including forced shutdown. Without a first prompt, each run goes straight to `idle` ("no prompt yet"), and the first prompt you send becomes turn 1 and the run's first prompt. Finishing a run that never got a prompt gives `finished` with the reason "no prompt was sent".
- **Database workspace directory.** Whenever the desktop app successfully opens or reconnects to a Code60 SQLite database, it creates `.code60_workspace` in the database file’s parent directory if missing, using private directory permissions. Existing contents are preserved. This includes startup reconnection and databases selected after launch. A file conflict or filesystem error follows the existing database connection error path.
- **Episodic Memory experiment.** Settings → Advanced → Experiments → Episodic Memory extracts important details from the open project's recorded events with the configured orchestration provider. A **Maximum events** field beside the centered extraction button accepts a whole number from 1 to 10,000, defaults to 10,000, and remembers the last valid value locally. The cap follows the existing session order and takes each session’s earliest recorded events until reached; a larger limit processes all available events. The button count reflects the capped selection. Invalid limits disable extraction, and the limit cannot change during a run. Clear retains both the prompt and the limit. The **Extract from N events** button captures the displayed per-session event counts, waits for complete transcript reads, and displays each returned natural-language statement as a separate cloud, with softly rounded edges, two subtle lobes, and a continuous contrasting outline around the filled shape. Clouds flow side by side and wrap onto new rows with a 35ch maximum width, 28px vertical/32px horizontal padding, and text at least 16px. Light mode uses a diagonal white-to-light-blue fill and dark text. Dark mode uses the gradient only in a thick 4px outline, with a transparent interior and the normal foreground text color. The silhouette keeps fixed-size lobes as text grows; forced-colors mode uses system colors and a plain outline. Completion reports the end-to-end elapsed time measured with a monotonic clock, including startup and cleanup; Clear and a new extraction reset the timing status. **Edit prompt** opens an inline editor; edits persist locally, **Reset prompt** restores the default instructions, and **Clear** removes results and status while retaining the prompt. Results remain in memory across page switches and reset on project/database changes or renderer reload. Extraction may be rerun with a revised prompt. Empty input, unavailable providers, incomplete reads, invalid responses, and errors are explicit; failed or cancelled runs do not publish partial results.
  - The main process validates the request ID, project directory, session membership, prompt size (8,000 characters), and event counts. It reads the selected event prefixes itself, including live events not yet written to disk; later events are left for the next extraction. A request supports up to 10,000 events and 1,000,000 serialized characters, with explicit errors rather than silent truncation. Core divides input into excerpts of at most 32,000 characters and uses one fresh ACP session per excerpt, validates JSON statements, and deduplicates identical text ignoring case and repeated whitespace. Responses are bounded to 64,000 characters and 500 statements per excerpt, 2,000 characters per statement, and 2,000 combined statements.
  - Extraction is single-flight, has a five-minute deadline, and runs in a temporary directory with no Code60 MCP server. Its fixed prompt treats event text as data and prohibits tool use; permission requests are denied. This uses the existing agent process model, not a sandbox. It does not add project runs, feed the orchestration Chat, or save extracted statements. The process group is stopped and the temporary directory removed on completion or failure. **Cancel extraction**, Stop all, project/database/provider changes, and shutdown cancel outstanding work; stale cancellation IDs cannot stop another extraction. The two fixed preload methods use the ordinary sender checks and strict bridge validation.

- **Prompt Builder.** A permanent sidebar page lists the handoff templates, worker-update template and Operating Contract, with each effective source (Saved edit, config.json, or Built-in). The Operating Contract has 13 labelled clause editors in a fixed order, without add/remove/reorder controls. Its single Preview replaces all boxes with the assembled read-only body, including unsaved changes. Save commits all clauses together; Discard changes and confirmed Reset to default affect the whole contract. Other templates keep one monospace editor, a merge-field dropdown when fields exist, and inline validation; their Preview uses fixed sample values, never real run data. Edit template returns to the unsaved draft. The page does not list MCP tool descriptions or input contracts. Invalid templates cannot be saved. Unsaved drafts are kept per template through page switches; Discard changes restores the effective text. Save stores an edit in the connected database. Reset to default confirms before removing the saved edit and restores the config.json template, or the built-in template when no config override exists; its tooltip names that source. The page offers Connect to database when disconnected. Saved edits load on connection and with the run-configurations poll; invalid or unknown saved templates are skipped with a warning.
- **Run configurations.** A permanent Configurations tab shows a table like the sessions table with Name, Preset Provider (every distinct agent in the configuration), # Agents (sessions the configuration creates), Uses, and Last Used (local time, or Never). Its New run configuration add row opens the run configuration editor; it is unavailable while another action is in progress. An Actions column after Name works like the sessions table's: clicking its cell, or pressing Enter on it, opens a menu with Edit and Delete for that configuration; deleting asks for confirmation and never affects sessions. A configuration holds the batch settings from the run form (agents, parallel count, base revision, turn timeout, and permission overrides), never a task prompt or project path. Names are unique within the database, ignoring case, and configurations are shared by every project in it. When saved, a missing parallel count or turn timeout is filled in from the current defaults; an empty base revision stays empty, so the configuration also works without Git. New agent session first lists the configurations and a Do not use a run configuration option. Choosing a configuration opens the run form prefilled with its settings and an empty prompt; changes apply only to that batch. Back returns to the list and keeps the draft. A batch counts as one use of its configuration once it has started; declined and invalid starts do not count. After a batch starts, a confirmation reports how many sessions started and has an unchecked Save Run Configuration checkbox. Checking it shows a name field, and saving stores the batch's settings as a new configuration with one use, without starting agents again. Each batch can be saved once; a failed save can be retried.
- **Git readiness.** Desktop dispatch, manual launch and continuation require Git and an initial HEAD commit. Core preparation revalidates required isolation before creating records or workers. Existing non-isolated runs remain readable and stoppable, but cannot receive prompts or resume, even after Git setup. Their review says “No baseline was captured for this run” and offers project browsing and setup where needed; Refresh cannot reconstruct it. CLI defaults remain unchanged.
- **Tables.** The Sessions, Messages, Events, Configurations, Worktrees, and Polling tables share one Glide Data Grid component and its built-in interactions. Each grid has a page title on the left, followed by any store-wide selectors, and one right-aligned toolbar of borderless Carbon icon actions: Search, Filters, Columns, Settings, and any table-wide actions after a thin divider. Each action keeps its accessible name, which the shared tooltip shows. An applied saved filter appears as a removable chip (Unapply filter) beside Filters. When the controls exceed the available width, a separate container scrolls horizontally and places the scrollbar below the toolbar. The area behind the toolbar is transparent; there is no separate toolbar above it. Pages do not add explanatory sentences about how their filters or controls work. Search, or Cmd+F (Ctrl+F) while that table's page is visible and no dialog is open, opens Glide's search overlay for that table only; Escape closes it and returns focus to the grid. Each column heading except Actions has a Glide header menu (also reachable from the Column picker by keyboard) with Sort ascending, Sort descending, and a filter. Text columns offer Contains, Is, Is not, Is empty, and Is present; category columns such as Agent and Status choose Is or Is not from the column's values; number and date columns add At least and At most (on or after and on or before for dates). Filters on several columns combine with AND. While column filters apply, a row below the header shows one removable chip per filtered column (Clear <column> filter), a Clear all filters link and an N of M rows status. Ad hoc column filters are kept in memory for the open database and project only, and reset when either changes; Polling result rows always stay under their source. The Settings button opens a labelled native modal dialog for that table: Row density, Row lines, Column lines, Heading lines, Fit columns to width, Visible columns (at least one stays visible), Inline charts on the sessions table, and Reset to defaults. The modal uses an 880px maximum width, 32px viewport margins, fixed header/footer, and a scrollable body. Its four-row Glide preview uses fictional sample data with the current table's headings, order and widths, shared typography and theme, and sample Sessions charts. Draft edits update only the preview until Apply; Cancel, Escape and the close button discard them and return focus to the trigger. Reset changes the draft to inherited defaults; Apply then removes the saved override unless the user edits the reset draft. Turning off charts preserves at least one ordinary visible column. Workspace/table replacement discards an open draft. The preview has an orange dotted outer frame and a plain Preview heading. Visible columns lives in a closed-by-default dropdown above it; Escape closes the dropdown before the modal, and outside clicks or moving focus outside the dropdown dismiss it. Display settings use two columns of On/Off toggles with no row dividers, stacking only on very small windows. Column visibility also uses toggles. The preview has no editing, sorting, resizing, or row actions. Column widths from resizing and the column order from dragging headings are saved with these choices by stable column ID, per table, in local storage under `code60.tableView.v1:<table>`; a table without saved choices follows the Settings page's Table defaults. Legacy session-filter storage is preserved; the new named-filter workflow uses its own versioned schema. The sessions and run configuration tables end with Glide's sticky, tinted add row (New agent session and New run configuration); activating it opens the existing creation form and never creates a row inline. A labelled button with the same name, visible on keyboard focus, does the same, and both are disabled under the same conditions. Selection stays with the row's ID through sorting, filtering, and data updates.
- **Named filters.** Every existing table has a Named filters dialog for creating, inspecting, editing, deleting, applying and unapplying a definition. Conditions use stable column IDs and typed comparisons with Match all/any, including relative minutes for date columns. A preview counts matching parent rows after ad hoc column filters. Only one named filter is active per table and it intersects with existing column filters; edits apply immediately, unapply removes only its effect, and deletion clears its selection. Versioned local storage scopes definitions and selection to table plus database/project (Polling uses the database). Unknown columns/types/operators/versions are explained and never silently rewritten. Malformed libraries are retained until the user explicitly resets them.
- **Consolidated Search.** Search starts with a 560px-wide form centered horizontally and set slightly below the vertical midpoint with an explicit Search button followed by square, accessible Type and Sort dropdowns. The dropdowns wrap beneath the query and button when space is tight. Enter or Search captures the query, type and sort together and moves the form above the results with a responsive top inset. A notification icon appears while draft edits are unapplied, with an Unapplied Search Changes tooltip on hover and keyboard focus. Clearing the query cancels generation and returns to the entry view with the filter selections preserved. While transcript reads or the overview are in progress, Search centers bundled artwork tinted with the current theme’s primary blue and a spotlight-animated Searching... label below the form. Skeleton paragraphs preview the AI overview, followed by skeleton result rows with timestamp, title and snippet placeholders. As the overview settles, placeholders fade and collapse while completed content fades in. Reduced-motion and forced-colors settings use a static icon, label and skeleton. Search covers the current project's documentation and source files as well as its identity, run metadata, prompts, messages and thoughts. The shared transcript cache settles pending reads before capturing an immutable submitted result set, preserving partial-read errors and retry. Literal session results require all terms case-insensitively; title and exact identifier matches rank ahead of content, with newest sorting available. If a natural-language question has no literal match, the overview uses relevant saved context ranked by meaningful query words, then recent context. Every submitted question starts an overview, including an empty-evidence question, for which the worker must report the missing evidence. Results form a single column below an AI overview, with highlighted excerpts and local metadata. Clicking a title or activating it by keyboard opens its source; transcript results retain the first event's address. Arrow keys, Home and End move between result actions. Search remains mounted across page switches.

  The overview uses one dedicated background ACP helper with the configured orchestration provider, independent of conversations and ordinary workers. A narrow validated bridge accepts a unique request ID, the current directory as a scope check, the query, and up to 20 saved-result excerpts of 4,000 characters each, including an empty list; source session IDs must belong to the open project. An optional includeFiles flag defaults on; All types and File searches enable it. The main process independently gathers project file evidence through the Files reader, visiting at most 32 directories (four levels deep), examining at most 24 text files and returning at most ten excerpts. It prioritizes documentation, manifests and query-relevant paths/content and skips hidden paths, generated/dependency folders, symlinks, binary/oversized files, lockfiles and known credential filenames. Up to ten saved excerpts plus ten file excerpts form the evidence when files are available; otherwise up to twenty saved excerpts are retained. No caller-selected file path is accepted by the summary endpoint. The result returns the exact numbered evidence; file result/citation actions open the existing read-only project preview. Source results remain visible beside the overview even when they were retrieved as context rather than literal matches. The main process generates a private temporary working directory, never uses a caller path as the helper's working directory, passes no Code60 MCP gateway, and denies permission requests. The contracts module owns the evidence-only prompt. This is a prompt/permission policy, not a filesystem sandbox. Only the completed plain-text answer is shown; validated in-range numeric citations open the captured local sources. Queries are bounded at 2,048 characters, replies at 16,000 characters and generation at five minutes including startup. Empty literal matches still start the helper; missing evidence is explicit in its response. Generation uses a search-only 12px striped loading-line animation, inset one pixel inside the search field's top edge and spanning only the field width. It preserves reduced-motion and forced-color behavior, with an accessible status announcement. Errors offer Retry while results remain usable. Stop cancels generation. Only one helper is active; replacement waits for cleanup. Project/database/provider or provider-command changes, renderer reload, Stop all and shutdown cancel it. Every exit stops the process and releases listeners, timers and the temporary directory. Helpers create no run records, worktrees, sidebar conversation or chat-dock entry; summaries are not persisted.
- **Shared transcripts.** Search, Messages and Events share a renderer-owned cache for each database/project. Reads use the existing validated `events` action, run at most four concurrently, deduplicate in-flight/cached requests and invalidate changed run versions. Project switches dispose the old cache and stop queued reads; late results cannot publish into the new project. Loading, per-run partial failures, retry and empty states are visible. Live events supersede cached history. No CLI or IPC capability is added.

- **Sessions table and chat.** A Glide Data Grid table fills the window. There is no app header. Stop leftover agent and Stop all runs (while a batch is active) join the shared table toolbar as stop icons; refresh is in the application footer polling widget. Rows are numbered on the left, with white backgrounds in Light and black backgrounds in Dark; clicking a row number opens that session's chat like any other cell. Sortable, resizable columns show Agent, Actions, Status (including discarded runs), Turns, Approvals (blank at zero), ID (last six characters), PID (the agent's process group, blank before the agent starts), Branch (`none` without a worktree), and Started (local time). Clicking a session's Actions cell, or pressing Enter on it, opens the actions menu described under Overlays instead of the chat. Sorted columns show a Carbon arrow in the heading. Newest sessions appear first by default. Status is text, not only color: the Status column draws each state's 16px Carbon icon and 12px label in a 128px slot, following the emphasis rules under Visual system. With Inline charts on (the default), three more columns draw on the canvas from the run's recorded events: Turn time (a line of the last six completed turns, prompt to turn end, with the latest duration), Events, 5 min (bars for ten 30-second buckets of non-status events, with the total), and Last 2 min (a strip of state spans, solid while working and hatched while awaiting approval). Each column shares one scale across rows (at least 0 to 20 seconds and 0 to 8 events); a run without samples shows Unavailable rather than zero, and the cells' text gives the same values in words. The charts redraw on the chart ticker, every five seconds by default (see [Polling](#polling)), and only while the Sessions tab and window are visible. Context usage, ratings, tags, and owners are not shown, since Code60 does not record them. The application footer polling widget shows an eye icon and scoped agent-message age above its Pause/Start and Refresh buttons. Search, column filters, and table settings work as described under Tables. Click a row, or press Enter on the focused cell, to select the session and open its chat.

Current-project sessions, including history, appear beneath Chat in the primary sidebar. Orchestrator-owned workers nest beneath their controlling chat, using the current snapshot's ownership IDs; manual sessions and history without a known owner appear directly under Chat, except that finished sessions are hidden unless a current (unarchived) orchestrator owns them. They stay available in the Sessions table. Ownership is not inferred or persisted across app restarts. Workers are named by the `label` the orchestrator gave `code60_dispatch_agent` (held in memory with ownership and published as `workerLabels`), in both the sidebar row and the worker chat heading; without one they show the provider and short run ID. Conversation names have decorative Phosphor chat-circle icons for project orchestrators and arrow-elbow-down-right icons for workers, with role provenance in accessible descriptions and independent status text and unread counts. A separate labelled chevron disclosure controls each orchestrator's workers. New children expand their parent without selecting a conversation or stealing focus; otherwise manual collapse is retained. External worker navigation reveals Chat and its parent. Up/Down traverse visible controls, Right expands or enters workers, and Left collapses or returns to the parent. Collapse never changes selection.

One selected conversation fills the normal Chat workspace beside the shared file panel. Sessions, Events, Search, Open chat and Resume all navigate there, never into a popup. Worker selection does not change backend orchestrator selection, ownership, automatic updates, sendability or Stop semantics. The footer retains polling, updates and an actionable approval count, but no chat dock. Opening a session preserves other conversations' drafts and scroll positions. New or discovered sessions never replace the selected conversation. Worker drafts survive renderer reload for the same run; reload otherwise starts on the selected orchestrator. Workspace changes clear worker selection and view state. Historical transcripts are loaded on demand through the existing bounded, project-scoped cache, with retryable failures. Agent output remains plain text; thoughts, tools, permissions and recovery notes are in expandable Activity. Copy and turn timing use the shared components.
- **Controls.** Worker composers send follow-ups to idle runs or explicitly continue ended runs using existing ACP restoration/handoff safeguards. Enter sends and Shift+Enter adds a line. Stop cancels the selected worker's active turn; Finish run, leftover stop and worktree deletion remain in session actions. Deleted worktrees show an inactive message; other blockers explain why sending is unavailable. Approvals retain Allow once and Deny, with other runs continuing independently. Chat no longer has window, minimize, close, fullscreen or dock-reordering controls.

- **Review.** Review Changes opens a Changes tab beside orchestrator Chat, showing captured worker revisions, file diffs, review decisions and anchored feedback. It includes untracked files and retains branch/worktree provenance. Delete Worktree is enabled once the session has ended and its agent is gone. Delete Worktree and Stop leftover agent use the same core commands and safeguards as `discard` and `stop`; discard lists the files that will be lost in a native confirmation dialog.
- **Worktrees.** A permanent Worktrees tab lists every existing Git worktree registered with the currently open repository, including worktrees created outside Code60. Each row shows its path, an Actions menu with Browse project files, branch (or detached), filesystem creation time, repository name, and logical size. Creation time uses the directory's birth time when available. Size is the sum of regular-file byte sizes, excluding symlinks and the top-level `.git` entry so shared Git objects are not attributed to one worktree; inaccessible or missing values show as unknown. The shared table header names the page; refresh uses the application footer. The tab scans when selected and then polls in the background while it and the window stay visible; the listing arrives in the revisioned snapshot. A failed scan keeps the last listing and shows the error. It never changes, removes, or prunes worktrees. A non-Git project shows an explanatory empty state.
- **Events.** A permanent Events table consolidates all recorded events from every run in the open project, newest first. Every log entry stays separate, including streamed chunks, intermediate tool states, raw ACP updates and turn-end outcomes. Columns show time, agent, full session ID, event type, status or outcome (including permission decision and stop reason), ACP update name, tool kind, tool-call ID, and payload details as plain text. Raw ACP details show their JSON text directly, with an explicit marker and original byte size when clipped at 256 KiB; other details are JSON fields. Selecting a row opens its session chat at that event; raw ACP and turn-end events do not create duplicate chat blocks. It uses the shared table search, typed column filters, named filters and saved presentation settings, and shares the project transcript cache with Search and Messages, including loading, partial errors and retry. The orchestration chat can read and search these same source rows through `code60_read_events` and `code60_search_events`; no new IPC is added. Raw ACP and turn-end events are excluded from activity chart counts to avoid double-counting typed events.
- **Messages.** A permanent Messages tab lists every prompt, agent message, and thought from every run in the open project. Adjacent streamed message and thought updates are combined into one row. The table shows time, agent, session ID, type, and message text; tool calls, status events, permissions, and stderr are not message rows.
- **Page tabs.** After the splash, a 220px left navigation container with only a subtle 1px theme-aware right divider, square corners, full-width rows and wider in-row label indents, and a main app surface shared with the composer wraps its project-opening action and page tabs. Its top and bottom align with the desktop right file panel, with a 12px bottom inset above the footer; the native-control drag strip remains separate from its fill. The sidebar stays open and has no collapse toggle or hover expansion. Its right edge is a keyboard-accessible resize handle (Left/Right arrows adjust by 20px). Width defaults to 220px, is bounded between 180px and 480px while reserving 360px for content, and persists locally as code60.sidebarWidth. Window resizing clamps the displayed width to available space. Resizing preserves page selection, conversations, drafts and disclosure state. The tab list scrolls within the remaining sidebar height. Its scrollbar is hidden so rows reach the right divider when the list overflows. Its Projects heading uses the Phosphor clipboard icon and an independent Carbon plus action labelled Open Project when connected. Without a database the plus is labelled Connect to database and opens the database dialog. There is no standalone Open Project header. When connected it opens the project-selection modal for recent projects or a folder picker. Successful opening adds or selects a retained project and shows a success toast; the action label remains unchanged. Cancelling preserves selection; errors stay in the modal. Other projects may remain active while opening or selecting a project. Home sits first, followed by Relay and Projects (with project accordions, per-project New chat actions and owned conversations), Apps (Command Builder, Data Viewer and Prompt Builder). Data Viewer contains Configurations, Events, Logs, Memories, Messages, Polling, Sessions and Worktrees, all with the Phosphor grid-nine icon. Settings follows Apps as the last normal navigation item. Its Advanced disclosure contains Experiments → Episodic Memory and the sibling Contributor Tools placeholder. Project orchestrator rows have Phosphor chat-circle icons; worker rows have arrow-elbow-down-right icons. Relay retains its custom icon. Nested pages and groups have dedicated Phosphor duotone icons. A Carbon folder marks each project accordion. Clicking the project name or row background toggles it. Opening from the row selects that project, and closing keeps the current conversation. Sidebar accordion labels toggle their groups without chevrons or empty icon actions, including Settings and project rows. Apps uses the Phosphor app-window icon; clicking its sidebar item opens a database-independent Apps home page with a card for every nested app. Cards open their corresponding pages and retain each page's database requirement. The database-independent Data Viewer card opens Logs and expands both Apps and Data Viewer. Clicking Apps toggles its children open and closed; opening also shows the Apps home page, while closing keeps the current page. Left/Right collapses/expands the group without changing the active page, and external child navigation reveals it. Its expansion retains the existing code60.toolsExpanded storage key. Owned workers retain a separate agent-icon toggle so collapsing them does not change the open conversation. More uses the horizontal overflow icon. Independent icon actions retain accessible labels; New chat uses a separate icon-only Carbon plus button. Keyboard, selection, expansion and disabled semantics are preserved. The database icon remains in the separate application footer, with an independent Carbon back arrow immediately to its left. Its tooltip is “return to splash page”; it preserves every open project and active work. No tab has a close button. Sessions shows the start screen before a database is connected and the sessions table afterward. Page labels use a 40px minimum base left inset, growing to fit larger icons, and 24px hierarchy steps (conversation labels retain their 4px alignment offset), without narrowing full-row highlights. Full-width, left-aligned tab buttons stack vertically, wrap long labels, have square corners with no gaps between sidebar items, 4px vertical padding and 40px minimum rows that grow with larger button text, and have no side rules. Resting labeled controls use the sidebar background. Enabled hover uses blue. The selected page has a contrasting fill at regular text weight, without an underline or bottom border, with selection also exposed to assistive technology. Preserve system selection outlines in forced colors. Up/Down wrap through the visible navigation order. Home and End move to the first and last visible destination. Switching tabs preserves table state, session selection, chat drafts, and Settings scroll position. A separate 28px draggable strip above the workspace reserves space for native window controls. The active page fills the remaining space to the right of the sidebar, separated by 12px; the workspace has matching 12px left and right insets and a 12px bottom inset. Each main page has no outer border and uses square corners. Page headers have a small bottom margin. Content uses consistent spacing: toolbars, the chat footer, and banners are inset 16px from the sides, the workspace sits above the application-wide footer with no footer reserved inside individual pages, Settings scrolls between 20px top and bottom margins, and conversations fill the Chat workspace. Toasts and actions menus render outside the page frame so they are never clipped. Every launch and renderer reload starts on Chat; saved preferences are unaffected. Chats use the normal Chat workspace; change reviews share its side panel with project files.
- **Window frame and app menu.** There is no native title bar. The window controls sit over the dedicated top drag strip (the macOS traffic lights at its left; on Linux, window buttons drawn at its right), above the sidebar tabs so the tabs stay clear. On Windows, the native caption controls remain native, and their overlay background and symbols follow the effective app theme, including changes to System appearance. Dragging the top strip, the sessions toolbar, the start screen, or the Settings page heading moves the window. The window title stays `Code60 - <version>` for the Window menu and window switchers. The first native menu is the Code60 app menu, with About Code60 showing the version from `package.json`; on Linux it also holds Quit. On macOS the bold menu title is the running bundle's name, which stays Electron while the app is unpackaged.
- **Settings.** There is no native Settings menu or app-wide settings gear. The File Explorer gear opens only its own settings dialog. The permanent Settings tab, Settings in the command palette, or Cmd+, (Ctrl+,) selects Settings, unless a dialog is open. Escape does not leave Settings; choose another tab instead. The page's content is centered in the window, and only its heading drags the window so the page can scroll. Settings pages show no explanatory paragraphs; an information button beside a setting or section heading shows the explanation in a tooltip, and the setting's control keeps it as its accessible description. Each Settings page starts with a header holding its title and page-wide actions (Change primary and Add agents; Reset text; Reset polling defaults and Open polling monitor; Check for updates and the download and install actions; Copy version info), followed by bordered cards: titled groups of rows (Appearance: Window and Accessibility; Table defaults: Lines and Layout, with Row density as a joined segmented control; Agents: Connected agents and Permissions), field groups with a Reset button at the top right (each Text role, with a live preview and a Reset shown once customized; each polling source and Charts), the Updates status and automatic-check rows, and the About version list. The Appearance section has Theme (Light, Dark, or System, the default), a Transparent background switch (off by default), and a Signal colors switch (off by default) that adds red failure and green success colors without removing icons or labels. The switch is saved in the main process's desktop.json alongside the database path, and applies only after restarting the app, not on renderer reload. When enabled, the window is created transparent without a native shadow; the area outside the content frame and opaque tabs is fully transparent instead of the solid theme surface. On macOS, mouse movement over these transparent areas enables click-through to the desktop, restoring interaction over content, overlays, tabs, and native controls. Linux keeps the window clickable. The splash stays opaque. The Text section has independent settings for Table Headings, Button Text, Agent Chat Messages, Human Chat Messages, Page Titles, and Normal Text: font size (8 to 48px), weight (Regular, Medium, Semibold, Bold), a Case choice (As written, Uppercase, or Lowercase), and Typeface (System, Computer Modern, D-DIN, Georgia, IBM Plex Sans, IBM Plex Serif, Lexend, Shantell Sans, OCR-A, Roboto, Space Grotesk, Tahoma, or Verdana). All categories default to D-DIN Regular in sentence case: Table Headings 12px, Button Text 13px, Agent Chat Messages 14px, Human Chat Messages 14px, Page Titles 18px, and Normal Text 13px. Left navigation labels default to 15px while other buttons stay at 13px; an explicit Button Text size overrides both, even when explicitly set to 13px. Resetting Button Text restores the separate defaults. Saved typefaces, sizes, weights and case choices remain intact when adopting the new defaults, without advancing the existing migration markers or repeating their resets. The legacy one-time typography migration still clears old typeface and weight overrides while preserving sizes, case, theme, table layouts and later choices. The shared wordmark uses D-DIN Regular; the regular 18px D-DIN splash subtitle remains unchanged. IBM Plex Sans includes bundled bold and regular/bold italic faces for existing weight settings and semantic Markdown emphasis. Navigation, headings, labels, status text and the wordmark have no fixed bold styling. The Table defaults section sets the defaults for tables without their own Table settings: Row lines, Column lines, and Heading lines (the lines directly above and below the column headings) switches, all off by default; an Inline charts switch (on by default) for the sessions table's chart columns; a Fit columns to width switch (off by default) that scales the columns, keeping their proportions, to exactly fill the window's width as it is resized, with column resizing disabled while it is on; and Row density radio buttons: High (24px rows, the default), Medium (32px), or Low (44px). Legacy Paper selections resolve to Light and are saved as Light on load. All other appearance and table choices are stored in the renderer's local storage. Explicit role choices override these defaults; size, weight, and case remain independent. Page Titles includes table page headings, Settings, and dialog titles. Normal Text sets table-cell size, weight, and case, while data cells use Normal Text’s typeface; Table Headings styles the canvas headers. Reset text restores only text settings to their built-in defaults. The Code60 theme resets every appearance setting once (text styles, the legacy typeface, theme, table lines, row density, fit columns, signal colors, and inline charts), marked by `code60.appearanceVersion = theme-4`; per-table presentation settings are reset in this same migration; later choices, named filters, drafts, saved configurations, and project and database data are preserved. Case changes affect display only, never stored messages or prompts; code and diffs stay monospace and case-preserving. Computer Modern uses CMU Serif. D-DIN, CMU Serif, IBM Plex, Lexend, Shantell Sans, OCR-A, Roboto, and Space Grotesk are bundled for offline use (OCR-A has only a regular weight, and bold is never synthesized for buttons and titles); Georgia, Tahoma, and Verdana use installed system fonts with fallbacks. The agent configuration file stays read-only.
- **Polling.** See [Polling](#polling). Settings has a Polling section after Text for intervals and reset controls, and a button that opens the Polling page.
- **Quitting.** Closing the window or quitting while runs are active asks for confirmation, then cancels active turns, finishes every run, and waits for the agents to stop. SIGINT and SIGTERM do the same without asking; a second signal skips the grace periods. A crashed renderer also triggers this shutdown. Worktrees are never removed.

Sidebar disclosure groups (Projects, Apps, Data Viewer, Settings, Advanced, Experiments and owned
workers) expand and collapse their actual height and opacity over the shared
175ms UI transition, after a short 20ms delay. Keep children mounted, with closed
groups immediately inert and hidden from assistive technology while the visual
collapse finishes. Native CSS transitions reverse from their current position on
rapid toggles, without renderer timers or delayed navigation actions. Reduced
motion and forced colors skip both the delay and animation. Reveal focused
destinations immediately to avoid clipping keyboard or external navigation.
Preserve saved expansion, external reveals, keyboard navigation and selected-row fills.
Pressing regular or primary buttons does not change their border color; retain
their pressed fills and visible keyboard focus. Conversation rows retain their
hover fill and text color on mouse down.

Left-sidebar navigation fills and right-panel tab fills share a 20ms hover delay
and 175ms background-color fade on both entry and exit. Reduced motion and forced
colors make these changes instant; keyboard-focus indicators remain immediate.
Each right-panel tab paints its selected or hovered fill under both its label and
separate transparent Close button, without giving the icon action its own fill.
Keep selection, closing, drag/reorder and keyboard semantics unchanged.

Conversation navigation rows paint one shared square background beneath the
chat label, ellipsis action and worker disclosure, with straight internal seams. Keep these buttons independent, transparent when
enabled, keyboard reachable and visibly focused; retain disabled cues.
New or revised draft plans still open their existing side-panel tabs, without
adding duplicate Plan buttons above the conversation.

Human prompt bubbles, automatic worker prompts and agent code blocks are square. Completed-turn timing notices have
a theme-aware 1px horizontal separator below the timing text or disclosure button,
not inside that button; active timers have no separator. Both message composers
are defined by their 1px border without an outer shadow. Focus replaces only the
border color, without adding a glow or changing the box geometry. Forced colors
retain the existing system-colored borders.

### Chat file panel and read-only tabs

Standard controls show a subtle shadow on keyboard focus. Focus highlight border adds an outline and stronger halo and is off by default. Forced colors uses a system outline. Independent icon actions throughout the app use borderless, transparent hit targets. Hover, pressed and focus states highlight the glyph without filling its background or adding an outline, including when Focus highlight border is enabled; disabled controls retain their muted glyph. Decorative icons inherit the state of their labeled button, navigation item or row. Close, add and drag controls inside larger areas remain independent buttons with their own hover state.

Chat has one right-side file panel, toggled by an accessible Carbon side-panel drawer icon at the right of its tab header. It starts fully closed at zero width with no divider or reserved rail. The same accessible toggle appears at the top-right of the chat area when closed, and inside the panel toolbar when open. Expanding/closing animates over 175ms and respects reduced motion. On narrow windows the closed panel also has zero height. Hidden panel contents are inert; toggling preserves focus, tabs, preview state and the last expanded width. It shares the main app surface through the left navigation's `--chat-neutral` token, including Monaco, with only a subtle 1px theme-aware left divider and no top, bottom or left container padding. It is hidden outside Chat. A single borderless keyboard/pointer divider resizes the panel, initially 20% of the Chat workspace (40% of its former half-width), with a 120px panel minimum and a 300px conversation minimum. At window widths of 1200px or below it stacks beneath Chat and the width divider is hidden.

The empty panel shows a centered Open Files link button. A plus action immediately after the rightmost tab creates a closable New tab with the same empty view. Open Files replaces its blank tab with File Explorer, or creates an Explorer tab from an empty panel. Multiple Explorer tabs are allowed. Selecting a file opens and selects a read-only file tab, reusing an existing tab for that project-relative path. Only the selected tab's content is shown. Duplicate basenames use relative paths as tab labels. The tab strip scrolls horizontally while the adjacent plus and drawer toggle stay available. Every tab can be dragged to reorder or closed; Left/Right and Home/End select tabs, Delete closes, and Alt+Left/Right reorders. Closing the selected tab focuses its right neighbor, then its left neighbor, or plus when none remain. Closing the final tab keeps the panel open in its empty state.

Tabs, order, selection, panel width and Monaco scroll/selection state remain in renderer memory across panel toggles, conversation changes and page switches. Project/database changes and renderer reloads clear tabs; paths and contents are not persisted. Headless Tree retains keyboard navigation, lazy reads and per-project expansion; Explorer tabs share expansions, last selected file and the hidden-files preference. Show hidden files lives only in the native modal opened by the settings icon beside the Explorer title. Its checkbox applies immediately; Done, close and Escape dismiss the modal and restore trigger focus. Workspace/page/tab changes or hiding the panel dismiss it.

Explorer always browses the current project root (including non-Git projects), never a worktree or private orchestration directory. Without a project it offers Open project. Legacy Files navigation, the palette and Browse project files actions select an existing Explorer tab or create one, revealing Chat and the panel. Search file sources open their file tab directly. File context and polling visibility follow only the active Explorer or file tab; blank/empty panels, hidden panels and pages outside Chat clear context and suspend file reads. Project/context changes discard late reads. No preview has a Reveal in Files action.

The fixed `setFileContext` preload method accepts only the current project, an allowed root, expanded relative directory paths and one preview path. Bridge validation rejects traversal, unknown fields, duplicates and requests above 64 directories. Main-process authorization allows only the open project or a worktree from its inventory. Reads reject symlinks and paths outside the canonical root, and never execute file content. A listing is capped at 2,000 entries per directory and 10,000 entries overall, with visible truncation notices. Previews accept regular UTF-8 text files up to 1 MiB; binary, larger, missing and unreadable files report an explicit error. Filesystem I/O is asynchronous, outside the controller's action queue, with results discarded after context/project changes or shutdown.

The Files poll source refreshes the requested directories and preview every five seconds while a Chat Explorer or file tab is visible, respecting global pause, manual refresh and interval settings. Initial selections/expansions trigger a read even when automatic polling is paused. There are no renderer fetch timers or filesystem watchers.

Monaco and its worker/language assets are bundled locally and loaded on the first preview. The Vite build gives Monaco-generated style elements a build-specific nonce authorized by the HTML CSP; inline scripts and unapproved style elements remain forbidden. A separate `style-src-attr` allowance supports Monaco's generated per-token positioning styles. Workers are allowed only from the app. Code previews have no links, editing, remote services or language servers. Headless Tree and Monaco are renderer-only dependencies.

### Polling

The desktop main process owns one scheduler (`src/desktop/poller.ts`) for every external read the app repeats. Live agent events are pushed by the orchestrator and are never polled. There is no file watching.

| Source | Reads | Default | Range |
| --- | --- | --- | --- |
| Run history | `listRuns` for the open folder (also marks interrupted runs and checks leftover agents) | 5s while a batch is active, 30s otherwise | 2 to 300s; cannot be turned off |
| Agent config | `config.json` | 15s while a batch is active, off otherwise | 5 to 600s, or off |
| Run configurations | Saved run configurations and prompt template edits in the connected database | Off (read on connect and after each write) | 30 to 3600s, or off |
| Worktrees | `git worktree list` and logical sizes | 30s while Worktrees is visible | 5 to 600s, or off |
| Files | Expanded directories and the selected preview | 5s while a Chat Explorer or file tab is visible | 2 to 600s, or off |

- Each source runs at most one read at a time. Overlapping requests share the read in flight, and a change during a read (such as a batch ending) queues exactly one more. History, config, and configuration reads are serialized with user actions; worktree scans are not, so size scans never block session controls.
- Automatic polls run only while the window is visible, and worktree polls only while Worktrees is selected, and file polls only while an Explorer or file tab is visible in the Chat panel. A failed poll keeps the last good data, records the error, and backs off exponentially up to 60 seconds, never faster than the configured interval. A project or database switch discards results from reads still in flight. Shutdown stops every timer.
- Pausing stops automatic polls for the rest of the session; Poll now still works. Interval overrides are saved under `polling` in desktop.json, holding only the sources the user changed, and Reset restores the built-in defaults. Config changes apply to later batches, not running sessions.
- The Polling page uses the shared table header with its title on the left and controls on the right. A vertically centered last-seen button at the left of the application footer shows the age of the newest received agent-text message. The footer has no top border, uses a 20px default content height plus 4px bottom padding with compact vertically centered controls, and shows the full runtime Code60 version at its bottom right. Clicking it opens a native modal containing Pause/Start polling and manual Refresh of all available sources; these actions are absent from the resting footer. The modal retains busy/error handling and restores focus on Escape or close. Chat scopes that age to the selected conversation, including a worker; other pages use current-project sessions, including saved history. Original event timestamps are used, never replay/poll time. No messages yet and Message time unavailable distinguish absent and incomplete data. Pausing polling does not pause streaming; actual poll times remain in Polling. Manual refresh works while automatic polling is paused; unavailable sources are excluded. Refresh and pause controls are centralized here, including for Worktrees and Sessions. A sources table like the other tables lists each source with an Actions column (Poll now and Polling settings), its status (Unavailable, Disabled, Paused, Hidden, Idle, Polling, Healthy, or Failed, drawn as an icon and text; Failed adds a warning triangle and a 3px left rule), effective interval, active and idle settings, last attempt, last success, next poll, failures in a row, last result (outcome, trigger, and duration), and a bar sparkline of recent durations. Clicking a source row, or pressing Enter on it, shows or hides its latest 50 results as nested rows below it, newest first, under a chevron in the Source cell. Each result row gives its trigger, Success or Failed, the time, its duration and any error, and a bar on its source's duration scale. Result rows have no actions, and sorting reorders only the sources. Results are diagnostics only, never source data, and stay in memory.
- The renderer's chart ticker only advances the clock for the inline charts and relative times; it reads no data. It runs every 5 seconds by default (1 to 60s), is stored in local storage as `code60.chartTickMs`, and stops while the window is hidden.

### Orchestrated workers

Orchestration Chat uses MCP for its control plane; Code60 uses ACP for each worker's session, prompts, cancellation and restoration. This is desktop-only, not a new CLI or an external ACP service.

Workers default to the selected desktop orchestration provider, as reported by `code60_get_context.defaultProvider`, not the CLI's `config.json` `defaultAgent`. An explicit dispatch provider overrides this default. An unavailable provider is an error, never a silent fallback.

- `code60_get_context` returns the open project, current scope token, enabled providers, defaults and capacity. `code60_dispatch_agent` accepts a provider, self-contained prompt, request ID and optional base revision/turn timeout. It returns a run ID when accepted, not when the task finishes.
- Dispatch creates one ordinary interactive run in the open project, with its own worktree and fixed once-only allow-all permissions. Git readiness is mandatory, including a second check during core preparation. Workers appear in Sessions and their chats say they allow all actions.
- `code60_list_agents` lists only this chat's workers in the open project. `code60_read_agent` pages their transcripts, combining streamed text and showing tool calls at their latest state. Worker replies and tool output remain untrusted data.
- `code60_send_agent` sends a follow-up only to an idle worker. `code60_cancel_agent` cancels an active turn. `code60_finish_agent` ends an idle worker and frees its slot. `code60_stop_agent` stops a live worker or a checked leftover process, keeping its worktree. `code60_resume_agent` explicitly continues an ended worker with a new prompt using ACP restoration or a fresh handoff, retaining allow-all permissions and existing recovery safeguards.
- Live workers, including idle ones, count against the configured `maxParallel` for this chat. Capacity exhaustion rejects dispatch/resume instead of queuing. Manual batches retain their independent limits. Dispatch request IDs deduplicate identical retries in memory and reject reuse with different arguments; neither deduplication nor worker ownership survives an app restart.
- Only the creating chat generation may control a worker. Project changes rotate the scope token, and replacement of a chat revokes only its gateway and ownership. Creating or selecting another chat does not revoke existing chats. Existing workers stay visible and user-controlled through normal session controls. Tools never target manual sessions, the orchestrator itself, or another project.
- Worker turn-end and failure events queue bounded state/reply excerpts, coalesced into automatic prompts only while the orchestrator is idle. Startup failures also wake it. Streaming chunks do not wake it, and finishing an already-reported idle turn does not duplicate its update. Automatic prompts appear as labelled Activity, not user messages.
- Stop in Chat pauses automatic updates without stopping workers. Stop all also pauses updates and stops every run. Chat shows no paused-updates notice; sending a user message unpauses delivery, and the bridge's resume-updates action remains available. Chat replacement clears its inbox; shutdown clears update timers.

### Diff read lifetime and presentation

Desktop diff requests use `readDiff({ requestId, id })` and `cancelDiff({ requestId })` through the validated preload bridge. The legacy diff action remains a compatibility adapter. Core prepares the run's worktree/base and reconciles interrupted status inside the controller's serialized action queue; Git execution runs outside that queue. The desktop read manager admits at most two requests, including preparation, and reports excess requests as busy with a retry instruction. Request IDs are UUIDs and run IDs retain their existing validation. No request accepts a filesystem path.

Cancellation targets only the matching request. Workspace/database replacement, renderer reload, and shutdown cancel outstanding reads; discard settles reads for its run before removing the worktree. Cancelled queued preparations cannot later start Git, and results from an obsolete workspace/database are rejected. Git receives an optional abort signal through temporary-index preparation and diff execution. Cancellation waits for the subprocess completion callback before removing the temporary index; the worktree's real index remains unchanged. CLI patch output, default timeouts, and exit behavior are unchanged.

In retained-project mode every diff, review capture and review-file read captures
its runtime before yielding, including the selected runtime. Navigation does not
invalidate that read. Project close, folder stop, workspace reset and discard
settle only that owner's reads. Database replacement stops all database owners;
renderer reload and shutdown cancel every read. The shared two-read admission
limit remains bounded across projects.

Chat review uses the same bounded read manager through `captureReview` and `readReviewFile`.
The controller serializes capture preparation, then captures immutable Git trees outside the
control queue. Turn-end and terminal worker events request captures; overlapping events coalesce.
Refresh is explicit, local and cancellable. A capture never changes the selected revision.
`readReview` returns metadata on demand and accepts an optional revision ID to derive bounded
per-file line counts from that revision's immutable text; these counts are not persisted. Live
snapshots carry only review summaries and versions.
`reviewAction` validates human edits, anchors, submissions, review decisions and reconnection.

`ReviewStore` persists versioned JSON metadata and immutable file content below
`.code60_workspace/reviews/<database-hash>/<project-hash>`. Writes use private files and atomic
replacement. New immutable content uses `<revision-id>.rev` beside review metadata to stay
within the same Windows path limit; reads retain compatibility with the older
`<review-id>/<revision-id>.json` layout. Existing data is not migrated or rewritten.
Limits are 200 reviews per project, 100 revisions per review, 1 MiB per text blob,
8 MiB text per worker snapshot and combined review capture, 2,000 files per capture, and
16 MiB per saved record. Saved JSON reads validate and read the same file handle,
reject links and nonregular files, and bound actual bytes read even if the file grows.
Binary, oversized, symlink and
submodule content is explicitly unavailable. Missing/discarded worktrees produce per-worker
errors; saved revisions remain readable. No persistence failure is treated as an empty diff.
Feedback delivery records its intent before sending and its receipt afterward. An uncertain
receipt requires checking the conversation and explicit retry, never automatic replay.

The Changes tab lists revisions nested under each review (task), without a review dropdown.
Clicking a revision opens a separate tab, deduplicated by review and revision identity.
`ReviewPanel` is a read-only file diff view pinned to that tab's revision.
It shows all files, including previously reviewed files, and exposes no capture, application,
undo, review-decision or feedback actions. MonacoDiff provides a read-only highlighted
inline view without a toolbar. File tabs use either a project path
or a saved review/revision/file identity, never a worktree path supplied by the renderer.
`useReviewFile` cancels on close, target changes and unmount and rejects late responses. Errors
and read Retry appear in the panel; empty revisions leave the diff area blank. PanelShell keeps
shared resizing, tab keyboard navigation and focus restoration; content remains in FilePanel.
One Changes tab contains all current and saved task groups; incoming captures never change an open revision tab.

The orchestrator receives `code60_read_review` and `code60_address_feedback`. Both require the
current conversation attachment, and address reports also require the current scope token.
Agent reads exclude unsent drafts and bound metadata to 200 latest files and 100 submitted
comments, with explicit truncation.
Reports never resolve human comments. Dispatch accepts optional reviewId and worker label;
otherwise workers join the current human request. Explicit reconnection updates review delivery
only and never restores worker ownership.

The renderer's `PanelShell` owns panel geometry, tab navigation, keyboard controls, drag/reorder, and focus restoration. FilePanel owns file tab identities, browser content, and Monaco view-state retention. Project file reads retain their scope and behavior; Changes and saved revision files reuse the same shell.

The desktop `ConversationCoordinator` owns in-memory chat generations/scopes, worker ownership, dispatch deduplication, and coalesced worker-update delivery. It receives current workspace/run views, prompt delivery, template formatting, and change notification through narrow callbacks. DesktopController retains IPC, workspace selection, batch creation, and agent lifecycle. Human messages retain core readiness checks; automatic updates retain their existing paused, between-turn inbox. The coordinator persists no ownership or automatic-update inbox. ReviewStore owns the separate human feedback records; saved feedback never grants authority or triggers automatic recovery.

### Desktop security

- The renderer runs with context isolation, the Chromium sandbox, no Node.js integration, and a restrictive Content Security Policy. Navigation, new windows, and `<webview>` are blocked.
- The preload script exposes a fixed set of methods (`windowAppearance`, `setWindowTheme`, `setTransparent`, `setBackgroundHitTest`, `snapshot`, `connectDatabase`, `chooseFolder`, `openProject`, `removeProject`, `clearProjects`, `poll`, `setPollSettings`, `setPollingPaused`, `setVisibility`, `setFileContext`, `readDiff`, `cancelDiff`, `readReview`, `readReviewFile`, `captureReview`, `reviewAction`, `checkGit`, `beginGitSetup`, `previewGitSetupFile`, `initializeGit`, `commitGitSetup`, `cancelGitSetup`, `beginAgentSetup`, `attemptAgentSetup`, `cancelAgentSetup`, `finishAgentSetup`, `abandonAgentSetup`, `setOrchestrationProvider`, `testOrchestrationProvider`, `cancelOrchestrationTest`, `extractMemory`, `cancelMemoryExtraction`, `orchestrationChatAction`, `start`, `saveConfiguration`, `deleteConfiguration`, `savePromptTemplate`, `resetPromptTemplate`, `action`, `stopAll`, `subscribe`, `onMenu`, `update`, `onUpdate`), never `ipcRenderer` or raw channels.
- The main process accepts IPC only from the app's own page, validates every request in `bridge` (known fields, sizes, run-ID and permission-ID formats, once-only answers), and acts only on runs recorded in the open workspace or the app-wide orchestration chats. Orchestration chat actions accept only an existing chat's run ID, never arbitrary agent commands or directories. There are no generic file reads or command execution; `setFileContext` is limited to the current project and its listed worktrees as described above. Database and new-project paths come only from native pickers in the main process; `openProject` and `removeProject` accept only a path already in the connected database's history. `poll` accepts only the known source names, and the worktrees source reads only worktrees reported by Git for the open repository. `setPollSettings` accepts only the known sources and whole-second intervals within each source's range.
- The orchestration chat receives one built-in Code60 MCP stdio server, in addition to user-configured MCP servers. It exposes read/search tools for Sessions, Messages, Events, Configurations, Worktrees and Polling, plus the worker tools below. Its sidecar calls only a token-authenticated endpoint bound to `127.0.0.1`. Requests are size- and time-bounded, tool arguments are strictly validated, and worker mutations require the current project/chat scope token. The gateway is revoked when the chat is replaced and closes on shutdown. Workers receive configured servers but no Code60 MCP server. User servers cannot replace the reserved `code60` entry or inherit its gateway credentials. The Operating Contract is behavioral guidance, not a security boundary; the main-process allowlist, scope checks and in-memory ownership checks enforce the boundary. No built-in tool accepts SQL, arbitrary commands, environment settings or target directories.
- Updates are batched about every 40 ms. Each carries a revision number and the
  previous broadcast revision. The renderer subscribes before reading its initial
  snapshot and buffers at most 32 update frames during each read. A buffer
  overflow or missing broadcast triggers a fresh full snapshot, not a silently
  incomplete event merge. Recovery keeps the subscription and permits only one
  snapshot read at a time, with three attempts per recovery before an actionable
  reload error. Disposal ignores late reads. This protects the current app stream;
  selected-view detail compatibility remains until the app stream is summary-only.


## Runtime

### Versioning

- Code60 uses semantic versioning. `package.json` is the single source for the product version, shown by `code60 --version` (exit 0), the desktop window title, bottom-right application footer, native About panel, and Settings About section. ACP client information and MCP server information report this same product version.
- Compatibility versions are independent of the product version: the SQLite database uses an integer schema version (currently 5), and `run.json` writes `format: 1`. Missing run-record formats mean 1. Records from a newer format are omitted from listings; a direct read reports that a newer version of Code60 created them.
- ACP uses the protocol version exported by its SDK. MCP negotiates its supported dated protocol versions, preferring `2025-03-26`. Neither protocol version is a Code60 release number.
- Settings About shows the product, database schema, run-record format, ACP and MCP protocol versions, plus the running Electron, Chromium and Node.js versions from `process.versions`. Copy version info copies these values and the copyright/license line. These read-only values arrive in `snapshot.versions`; they add no IPC capability.

- TypeScript, ESM, Node.js 22.12 or later, on macOS, Linux and native Windows 11 x64.
- Runtime validation uses Zod as a direct dependency for configuration, IPC requests (including polling), and persisted run records/events. Types for IPC requests and records/events are inferred from schemas.
- Dependencies: `@agentclientprotocol/sdk` (only `agents` imports it), Electron for the desktop app (only `desktop` imports it), and React with React DOM plus `@glideapps/glide-data-grid` (pinned to its React 19 beta) for its interface (only `renderer` imports them). The grid draws on a canvas with the app's theme colors and bundles its CSS file, so it needs no runtime style injection; Monaco's generated styles use the nonce described above. Vite builds the renderer; TypeScript builds everything else. The project database uses the built-in `node:sqlite` (only `desktop` uses it). Processes use `node:child_process`, with argument arrays and explicit working directories. Add libraries only when Node.js cannot reasonably do the job.
- Renderer fonts: `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-serif`, and `@fontsource/roboto`; vendored D-DIN from [datto-d-din](https://github.com/amcchord/datto-d-din) and CMU Serif from `computer-modern@0.1.3`, with their OFL licenses in `src/renderer/fonts`; Shantell Sans from [Google Fonts](https://github.com/google/fonts/tree/main/ofl/shantellsans) with its OFL license; unmodified variable Lexend and Space Grotesk from their upstream projects, with pinned source references, SHA-256 hashes and OFL licenses in their font directories; and OCR-A from Matthew Skala's [OCR font package 0.3.1](https://tsukurimashou.org/files/ocr-0.3.1.zip) with its upstream notice in `src/renderer/fonts/ocr-a`. Vite emits font files rather than inline data URLs to preserve `font-src 'self'`.
- Every subprocess, whether `git` or an agent, runs with a timeout or under a run's cancellation.

## Open questions

- Whether `diff` should also offer a summary view (`--stat`) or open the user's configured Git difftool.

### Shared chat timing and Copy

Orchestrator and worker chats use borderless agent text and solid user bubbles: blue in Light and lighter blue in Dark/System dark, with contrasting text. Activity and tool disclosures stay distinct. Sidebar conversation rows show numeric badges for unread replies, separate from their decorative role icons. A separate indicators column reserves space for counts and plain-text status; names ellipsize without overlapping badges when the sidebar narrows. Each turn counts once at its first nonempty agent text; chunks, thoughts, tools and status events add nothing. Opening a conversation clears unread immediately regardless of scroll, and replies while open stay read. Database/run-scoped session-storage read markers retain read state across renderer reloads, storing identifiers and turn/count markers only. Compact conversations push constant-space reply counts on the existing summary stream; legacy event-only snapshots and workers retain turn markers. No transcript is loaded or polled merely for an unread badge.

Both chat interfaces group response/activity by prompt turns. The orchestrator uses its live animation, status and activity timer instead of a separate Working for line. Worker chats retain the local Working for timer after the prompt, above the agent turn. Completed turns freeze as Worked for with their recorded outcome, not a success claim. Prompt dispatch and completion timestamps exclude queue, startup and idle time but include permission waits. Optional turnEnd outcome/completedAt metadata distinguishes cancellation from timeout; terminal status events may carry turn/completedAt for transport failures before process cleanup. Older records remain readable. Missing crash/history boundaries and clock anomalies show timing unavailable/incomplete, never invented duration. Small display components use the existing visibility-aware local ticker, with no backend polling, per-tick live announcements, focus changes or transcript scroll resets.

Nonempty user and agent text messages, including historical and streamed source, have one shared icon-only Carbon Copy control with an accessible label, a 16px icon, a 24px hit target and no separate fill or border. For user messages it sits outside the colored bubble. A compact relative age immediately before Copy uses the original prompt or first response-chunk timestamp, not replay time; missing/invalid timestamps remain explicitly unavailable. The row retains its layout space while hidden and fades in/out on message or controls hover, with keyboard focus also revealing it. Clock-only updates stay inside the small time display and stop in hidden chats/documents, without per-tick announcements. Every Copy activation briefly depresses only the glyph; reserved time width and always-overlaid failure feedback keep the button position stable through pending, success, failure and toast dismissal/expiry. Reduced motion disables the fade and depression. Copy retains only the exact source captured at invocation, including whitespace and code, never adjacent activity, timers or attachments. After clipboard completion, the existing application toast stack shows “Copied.” as a success notification, with its shared six-second lifetime, pause/dismiss controls and polite announcement, never a local success tooltip. Failure keeps actionable inline feedback and Retry Copy without changing drafts, selection, scroll or agent state.

Agent replies in orchestrator and worker chats render Markdown through the shared,
memoized renderer-only `ChatMarkdown` component using `react-markdown` and
`remark-gfm`. This applies to saved history and incomplete streamed replies.
Paragraphs, headings, emphasis, lists, blockquotes, code, tables, strikethrough and
read-only task lists become React elements. Raw HTML remains literal text, images
become alt text, and no scripts, embeds, diagrams or remote assets are loaded.
The CSP is unchanged; `dangerouslySetInnerHTML` and raw-HTML plugins remain forbidden.
User messages, command labels, thoughts, tool output, errors, logs, diffs and plan
tabs retain their literal-text or existing structured rendering. Source records,
exact-source Copy and scroll-follow behavior are unchanged. Markdown inherits agent
typography, with semantic bold/italic and case-preserving monospace code; wide code
blocks and tables scroll within the message area.

Explicit link activation calls the narrow `openWebLink({ url })` preload method.
Bridge and main validate bounded absolute HTTP(S) URLs, rejecting credentials,
controls, whitespace, backslashes and other schemes. Main serializes native
confirmations showing the normalized destination; only approval calls Electron's
`shell.openExternal` to open the default browser. Cancellation is a no-op, failures
are shown inline, and no URLs or raw errors enter diagnostics. Electron navigation
and new windows remain blocked. Relative paths and unsupported links are inert.

The bottom-right application footer persistently shows full runtime snapshot.versions.code60, retaining prerelease/build suffixes and Settings About/Copy version info. No product version is bumped for this change.

### Sidebar table navigation

The Data Viewer disclosure sits beneath Apps, alphabetically between Command Builder and Prompt Builder. It contains Configurations, Events, Logs, Memories, Messages, Polling, Sessions and Worktrees, in alphabetical order, each with the Phosphor grid-nine icon. Expansion is saved locally; collapsing it keeps the current page open. External table navigation expands both Apps and Data Viewer. Up/Down and Home/End follow visible sidebar order; Right expands Data Viewer, and Left collapses it and returns focus to the disclosure (or Apps when already closed). The existing code60.tablesExpanded storage key is preserved. Without a database, Data Viewer still opens and Logs and Memories stay enabled; other table children retain their existing database requirement.

Settings follows Apps as the last normal navigation item, without a bottom spacer.
Its Advanced disclosure contains Experiments → Episodic Memory and the sibling
Contributor Tools placeholder page. All three disclosures remember expansion and
reveal externally selected destinations. Collapsing a disclosure preserves the active page.

### Database connection state

Without a connected database, the splash notice and sidebar offer
**Connect to database**, which opens the existing database dialog. Both splash and
the main app show a prominent, non-dismissable top warning with a connection action.
An unavailable remembered database is reported there rather than presented as a project.
Workspace navigation, chat actions, file controls, project polling and their command-palette
alternatives stay disabled until a connection succeeds. Keyboard navigation skips disabled
destinations. App entry, agent setup, app settings and updates remain available.
Cancelling or failing connection keeps the warning and disabled state. Successful
connection removes the warning and restores the project selector and workspace controls
without a reload. Database connection and validation remain main-process responsibilities;
no new IPC or database schema is added.

On the splash, Start remains available during active runs and returns to the unchanged
workspace. In-flight operations temporarily disable it. Project selection and its
existing main-process guards remain available from the workspace.

A labelled Carbon database action sits in the application footer, on the same line
as the Last Message indicator and aligned to the sidebar's right edge as it resizes.
Resolve the shared sidebar track width on the app container alongside the live width
override, not on the root element where inheritance would freeze its computed value.
It stays outside scrolling navigation and uses the compact footer height.
Its resting glyph uses the same muted color and opacity as Last Message text,
while retaining the shared icon hover and keyboard-focus highlighting.
The footer keeps 4px bottom padding beneath its message text, return-to-splash and database actions, and version.
It opens the same Select database modal for opening an existing
database or creating one, even when a database is already connected. It shares the
project selector's busy/active-project-run restrictions and native modal focus restoration.
Page and conversation rows, the project header and adjacent row actions use 40px
heights; the tab list scrolls independently of the footer.

### Chat names and archive

After the first completed human/agent exchange, a separate presentation-only ACP
turn asks the configured orchestration provider for a short descriptive title.
It runs in a private temporary directory, without MCP servers, denies permissions,
bounds input/output and times out after 30 seconds. Replacement, manual rename,
Stop all and shutdown cancel generation; cleanup stops the process before removing
its directory. Failure retains the numbered fallback. It never adds transcript
messages or overwrites a human title.

Orchestrator sidebar rows expose Open, Rename and Archive through both their
labelled More icon button and context menu, including Shift+F10. The main header displays
the same title and opens the same rename dialog. Titles are bounded single-line
plain text and actions target validated existing chat IDs.

Archive only hides the orchestrator from sidebar navigation. It retains session
records, transcripts, worker ownership and running work. Workers remain accessible.
After successfully archiving the currently displayed chat, the renderer shows a
“Chat archived.” success toast and selects Relay. Archiving another chat does not
change the displayed page or conversation. Failed archives keep inline feedback.
Titles and hidden state live with the main-process conversation across renderer
reloads and persist with Tactics metadata. Application restarts restore stopped
chat history, never execution authority. No SQLite schema or CLI behavior changes.

The Prompt Builder groups its four system templates beneath an initially expanded System disclosure. Collapsing the group preserves the selected editor and unsaved drafts. Saved overrides remain in System; individual items omit source labels and show unsaved changes when present. Prompt items have no border and share neutral gray selection and blue hover with navigation.


### Desktop distribution

The release workflow packages the Electron desktop as an Apple Silicon macOS DMG,
Linux x64 DEB/AppImage and signed per-user Windows x64 NSIS installer.
The bundle ID is `com.codemanufactory.code60`; the
Linux GUI executable is `code60-desktop`, separate from the headless `code60` CLI.
Installers bundle the desktop runtime and preserve existing config, preferences,
and user-selected database paths. Git and provider CLIs remain external.
Settings → Updates offers explicit Check for updates, Download update, cancellation,
and Install and restart on all distributed targets. The main-process `Poller` also
schedules app-wide release checks after 30 seconds and then four hours after each
check completes, independently of workspace polling and its pause switch. Checks
are single-flight, run only from idle update state, stop on shutdown, and never
download automatically. Background failures stay quiet; manual failures are shown.
The on-by-default automatic-check switch persists as `updateCheck` in desktop.json;
fixed `auto-on`/`auto-off` update actions change it without affecting CLI configuration.
A footer button opens Settings → Updates and labels availability, download progress,
or readiness to install. A popup offers Download now / Later once per version,
remembered in renderer local storage, and waits for other dialogs to close.
`electron-updater` reads the
fixed public GitHub release feed and validates downloaded SHA-512 checksums;
macOS and Windows also retain their native signature verification. Stable builds
stay on stable releases; prerelease builds can receive their channel and stable
releases. Downgrades, background downloads and quit-time installation are disabled.
No renderer request accepts a URL, path or command: `update` accepts only fixed
actions, and `onUpdate` pushes revisioned progress, including across renderer reloads.
Development builds report updates unavailable. Downloads cancel on quit and have
a 30-minute deadline. Installation asks with a native dialog and shuts down all
agents, gateways and polling before replacing the app. Config, records and databases
are kept. macOS uses the signed ZIP update, Windows uses NSIS, Linux DEB uses an
asynchronous, five-minute-bounded `pkexec /usr/bin/dpkg -i` authorization, and AppImage
stages a complete executable beside the original before atomic replacement.
Linux authorization or installation failures are shown before closing the stopped app.
The main process rejects other renderer requests during installation.
Release staging verifies channel metadata against the exact final artifacts.
The macOS ZIP and platform channel YAML files are published alongside installers.

Desktop packages use a viridian (`#40826d`) desktop icon with centered black
D-DIN Regular 60 numerals. The fill reaches every edge except for the
upper-right chamfer, which reveals a black background. The desktop cut extends
352px into the 1024px icon so it remains visible inside macOS's rounded icon mask.
`scripts/generate-icon.mjs`
renders `packaging/icon.png` from the wordmark styles and bundled font using Electron.

On macOS and Linux, before restoring sessions or accepting agent launches, the desktop reads PATH
from the user's interactive login shell once, asynchronously, with a three-second
deadline and a 64 KiB output limit. It runs the probe in the home directory and
stops the probe's process group on completion, failure, timeout, or shutdown.
Only PATH is imported; shell output and other environment variables are never
logged or imported. Shell PATH entries precede inherited entries, followed by
`~/.local/bin`, `~/bin`, `/opt/homebrew/bin` on macOS, `/usr/local/bin`, and
standard system directories. Empty, relative, and duplicate entries are removed.
Missing or failing shells use inherited PATH and the same fallbacks. This applies
to Git, agent connection tests, orchestration chats, and workers; absolute agent
commands remain authoritative. The CLI and configuration files are unchanged.
Windows instead uses the bounded native discovery and owned-job contracts above;
it never probes a shell profile. See [Windows setup and limitations](WINDOWS.md).
Windows release promotion requires timestamped SHA-256 Authenticode signatures
from Azure Artifact Signing (GitHub OIDC, no stored key), verified against the
validated publisher name and Microsoft's identity-verification root, on the final installer, installed executable, helper and uninstaller, followed
by reinstall/uninstall data-preservation checks. These run on the Windows Server
2025 x64 CI runner; ARM64 development/emulation cannot satisfy them, and there is
no separate manual Windows 11 hardware acceptance.

macOS releases use Developer ID signing and notarization. Packaging preserves
Electron's Node mode because orchestration providers launch the bundled MCP
sidecar with the app executable and `ELECTRON_RUN_AS_NODE=1`. Packaged tests
exercise that path through its authenticated gateway. The renderer remains
sandboxed; the desktop refuses `--no-sandbox` launches, including AppImage
fallbacks. Packaging adds no CLI configuration fields; the only update bridge
methods are the fixed-action `update` and `onUpdate` described above.


Agent setup bridge requests carry only mode, session UUID and catalog provider ID. They never accept executable commands, environments or working directories. The legacy provider setter cannot select an unverified primary; the old connection-test action is unavailable while a setup session exists.

Native ACP launch references: [Antigravity](https://antigravity.google/docs/cli/acp/), [GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server), and [Kiro](https://kiro.dev/docs/cli/reference/cli-commands/).

### Guided initial Git setup

Chat exposes Git readiness while conversations and project browsing remain usable. Only explicit human setup can initialize a repository and create its first commit; this is the sole exception to the prohibition on application-created commits. It never installs Git, configures remotes, pushes, dispatches workers, or recovers a missing historical baseline.

The narrow preload methods are `checkGit`, `beginGitSetup`, `previewGitSetupFile`, `initializeGit`, `commitGitSetup` and `cancelGitSetup`. Main-process sessions bind project and generated file IDs to a bounded preview, with fingerprint revalidation before staging. Missing Git, non-repositories, unborn HEAD and inaccessible repositories are distinct. Setup requires stopped project workers and leftover processes. It is single-flight, cancellable, and executes Git outside the action queue; context replacement, renderer reload and shutdown cancel it.

Nonignored regular files are preselected for review. Symlinks and oversized files are excluded with reasons; Code60 private workspace/database files are never offered. Selection is required when eligible files exist; an empty project offers an explicitly labelled empty initial commit. Bounded previews use the existing safe file reader. Missing author values are saved only in local repository configuration. Normal Git add and selective commit preserve unrelated staged entries, hooks and signing. Failure or cancellation may leave Git initialized and selected files staged; nothing is discarded. HEAD is rechecked after an uncertain outcome; commits are never retried automatically.

Desktop opens Git-backed history together with the folder's legacy directory store. Existing-record operations route to the original store; new records use the current primary store. No migration, record/schema changes or restored worker ownership occur. Saved reviews retain their database/project identity. `code60_get_context` exposes readiness but grants no initialization or commit capabilities.


## MCP activity display

The desktop orchestrator exposes `code60_get_activity_context` and
`code60_report_activity`. Discovery returns semantic activity types, the current
declaration, an opaque current-turn scope and the last accepted sequence. Reporting
sets or clears one foreground declaration. Increasing sequences reject stale or
conflicting updates; identical retries of the last request return the original
acknowledgment without extending its 120-second lifetime. These presentation tools
need no project or worker authority and are never passed to workers. The tools
expose no animation IDs, assets, markup or filesystem access. Unknown types require
rediscovery; labels are bounded single-line plain text.

Each desktop ChatSession owns ephemeral activity state. New live prompt events
open a scope; terminal events, cancellation, scope rotation, chat replacement and
shutdown revoke it and clear operations and timers. Saved transcript events never
feed this state. Renderer reload receives the main-process snapshot; application
restart restores no declarations. Expiry and message-stream quiet deadlines publish
through existing pushed snapshots, without renderer polling or run-record changes.

Lifecycle/approval states override observed message streaming and active tools;
observations override agent declarations; unknown adapter tools do not mask a more
specific declaration. Commands remain generic execution and fetches remain Retrieving:
agent descriptions cannot certify tests, transfers or success. All declared captions
are identified as agent-reported. Track parallel tools by ID and original start
order. Message activity ends on a new substantive action or two seconds of silence.
Code60 directly instruments worker dispatch/send and actual automatic result delivery;
queued results are not reported as received. Worker counts use current-project
conversation ownership and remain separate from the orchestrator's activity.

New chat connections use a centered, non-interactive status above the conversation
viewport, with bundled communication artwork and spotlight “Connecting...” text
beneath it, without an elapsed timer. It fades in and out with the activity-fade
preference (175 ms by default). Keep the empty “Give Code60 a task.” prompt absent
until the session is ready, then hidden until the loading status has finished fading.
Cancel and errors remain outside the overlay; stopping/failure settles it immediately.
Hidden views, reduced motion and forced colors stop GIFs and spotlight animation,
using a static 16px Carbon icon; reduced motion and forced colors skip fades.
No connection state, polling, IPC or transcript content is changed.

The renderer chooses bundled GIFs from semantic states and displays one activity row
below the latest message inside the scrollable transcript. The animation is on the left,
and the state name and timer are on its right, aligned with agent reply text. The animation sits in a reserved gutter to the left of that text column. `waiting_for_workers` is presented as
Monitoring subagents using the radar GIF; the semantic MCP contract is unchanged. Active state
names use normal text size and regular weight, with a moving spotlight. The name
is left-aligned beside a fixed-width animation within a 300px row (bounded by available width), so
its starting position does not shift with the text length. Activity artwork is 48px
(32px on short windows); static fallback icons are 8px. Idle has no indicator. A local elapsed timer
follows the ellipsis, resets when the displayed activity changes, and is absent
when inactive. It measures time since the renderer first displays that activity
(and restarts on reload), not total turn duration. Only the timer redraws each second;
hidden views pause ticks and catch up on return. Timer ticks are outside the live
status region so they are not announced. The agent's custom purpose, agent-reported attribution,
and concurrent operation/worker counts appear in a tooltip on hover or keyboard focus.
The live icon and status form one native disclosure button with aria-expanded and
aria-controls. It toggles the current turn's thoughts, tools, permissions and notes
in an inline dropdown beneath the row, replacing separate Activity summaries.
Dropdowns smoothly expand and collapse over 175 ms by default (immediately with reduced motion). Collapsed details are inert and hidden from assistive technology. Dropdowns and their output expand to full height, wrap long lines and use only
transcript scrolling. Opening long details reveals their beginning; streamed updates preserve reading position. Each turn retains
its own expansion state as activity streams; after completion, its Worked for summary
opens the same details. Pre-prompt notes join the first turn, or Session details when
there is no turn. Enter/Space toggle and Escape closes live details. Run replacement
resets expansion. Historical details never start live animation.
Generic execution never selects testing artwork; retrieving never selects download artwork.
Missing artwork, reduced motion, inactive states and hidden views use static Carbon icons;
hidden/reduced-motion views unmount GIFs and stop the spotlight. Ordinary state changes
fade the image and label out together over 175 ms by default, then fade in the latest state.
The row expands from zero height when opened and shrinks to zero height while fading
to idle before removal. A content resize observer follows the changing transcript
height only if the user is already following its bottom; reading older messages
does not get pulled to the activity row. Main Chat uses one frame-driven, retargetable
scroll animation for incoming content, not repeated bottom jumps or restarted native
smooth scrolls. Upward input cancels it immediately. Initial history and returning
to a conversation restore instantly; hidden views and reduced motion skip scrolling
animation. New visible assistant messages enter once with a subtle, default 175 ms opacity/position
transition, never restarted by streamed chunks or replayed for initial/saved history.
Message height also eases in normal document flow, including new user prompts and
additional streamed lines. This moves the status row continuously without translating
it over message text. While following the bottom, scrolling tracks those already-eased
height changes directly rather than applying a second lag that throws status off-screen.
The empty placeholder follows the pending status row so its removal cannot relocate it
when the first prompt arrives. Historical mounts, viewport-width reflows, hidden views,
reduced motion and instant timing settle without replay. Activity dropdowns keep their
own layout transitions, outside the message-height wrappers.
Source text, Copy and Markdown semantics are unchanged. The transition window is bounded during rapid updates;
same-state purpose updates preserve the timer and do not fade. Approval, stopping
and non-idle terminal states interrupt immediately. Hidden views and reduced motion
skip transitions. Final artwork is independent of MCP.
Display failure never fails an agent task; operating instructions request meaningful
phase reports, not heartbeats. CLI, persisted records and worker access are unchanged.

Settings → Appearance has a Transitions card for reply entrance, scroll response,
activity fade and activity dropdown timing. All four default to 175 ms. Each accepts 0–30,000 ms, with a
nonlinear slider for fine short-duration control, exact millisecond input, current
duration and a shared Reset transitions action. Zero is instant. Scroll response is
the follow animation's easing time constant (175 ms by default), not a fixed deadline
for a continuing stream. Settings apply live and persist only in renderer local
storage as `code60.transitionTimes`; malformed values fall back per field and numeric
values are bounded. Storage failure preserves the live session choice and shows an
actionable warning. Reply entrance controls occupied message height as well as the
reply fade; scroll response handles following content not already moving through that
height transition. CSS durations and activity timers share the same preferences.
Reduced motion, hidden views and urgent activity still override ordinary transitions.
Long dropdown reveals cancel on user input, collapse, hidden views, stale details or
unmount, rather than fighting the reader for the configured duration. No new IPC,
backend preference, transcript data or CLI behavior is introduced. Other interface
transitions also default to 175 ms. Unversioned saved chat timings are read at half
their previous bounded duration, rounded to whole milliseconds; missing or invalid
fields use the new defaults. Later saves include version 1 so subsequent edits and
reloads never halve the values again. Reset transitions applies the current
defaults. Non-transition timers, notification lifetimes and backend timeouts stay
unchanged.

Worker conversation headers place status as a subtitle under the agent name. Branch/terminal role icons in navigation and worker headings scale to 1em of their label text. The polling dialog has a 200px minimum height bounded by viewport height, and a centered pair of equal-width buttons. Last-seen and harness-mode triggers use 12px horizontal padding.

The left navigation divider extends through the native-control drag strip and application footer to both window edges. Its overlay shares the navigation grid’s constrained width expression, follows pointer/keyboard/window resizing, and ignores pointer events. Sidebar content bounds and footer placement are unchanged.

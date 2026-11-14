# Code60

Code60 is an Electron desktop app and headless CLI for running coding agents
in parallel. The CLI uses isolated worktrees in Git repositories with a commit
and runs directly in the current directory otherwise. Desktop project workers
require Git isolation; Relay workers explicitly choose isolated or direct work.

In desktop Chat, open **Review changes** to inspect a task revision. **Use these changes…**
opens a preview before applying the worker's result to your project. **Ask workers to revise**
sends application conflicts back through Chat. **Undo application** restores the previous
contents if the applied files still match. Applying and undoing preserve Git staging.

## Relay and projects

**Relay** is one persistent, application-wide conversation. It works without a
database or open project and connects idle after agent setup. Restart restores
history, not tasks or workers, and sends no prompt until you press Send. The first
Send includes at most 64,000 Unicode characters of labelled history, once.
Older messages stay on disk; bounded paging and exact-source Copy do not send prompts.
Relay state lives under `$XDG_STATE_HOME/code60/relay` (by default
`~/.local/state/code60/relay`), separately from project databases.

Give Relay each intended target directory explicitly. It can dispatch to unopened
Git repositories and, in **direct** mode, non-Git folders the harness permits.
Direct changes are not isolated or automatically reversible. Relay never silently
switches modes or redirects a refused launch to another folder.

Open Relay's Files panel and choose **Open Changes** to review isolated results
grouped by target. Capture a revision, inspect its diff, send feedback or preview
checkout-local application. Apply and undo require confirmation and recheck newer
edits. Saved reviews remain historical evidence after restart, without reconnecting
workers or replaying feedback. Human **Accept** authorizes the displayed plan
revision and target assignments, not later target changes.

Project accordions retain independent chats, drafts and file views. Project chats
remain database-backed and bound to their project. Navigation and database changes
do not retarget Relay. Closing a project stops its own work, not Relay workers in
that folder. **Stop workers in folder** includes those Relay workers; **Stop all**
stops every owner. Database-wide legacy chat files are not loaded or migrated;
existing files remain untouched.

See [implementation and validation notes](docs/relay-implementation.md) for limits
and platform-validation status.

## Scheduled automations

Open **Automations** to save one agent, prompt, isolated Git repository and explicit
tool permissions on an interval, daily or weekly schedule. Install the background
service with the page's consent dialog to keep scheduling after Code60 quits.
The computer must stay awake and the user logged in. Missed occurrences are skipped,
not replayed, and an agent finishing a turn is not proof the task succeeded.

The CLI exposes `code60 automation --help` and `code60 scheduler --help`.
For source development, build with `npm run build` and run
`node dist/automation/main.js` in a separate terminal before saving automations.
That standalone process is not installed for future logins.

App updates cancel active automation work, restart the installed service with the
new runtime, and preserve its previous global pause state. Stop a standalone
development scheduler before installing an app update. If restart fails, Code60
shows a recovery message; repair the service from Automations. Schedules, evidence
and worktrees are preserved.

## Security and privacy

**Worktrees isolate changes, not permissions. Code60 does not sandbox agents.**
Agents run with your operating-system permissions, and may access files or
execute commands beyond their worktree.

- **Desktop safeguards:** the interface runs in Electron's Chromium sandbox,
  with context isolation and no Node.js integration. Desktop requests are
  validated in the main process. The local MCP gateway uses authentication
  and scoped worker controls.
- **Agent permissions:** orchestration chats and their workers automatically
  approve supported once-only permission requests. Choosing an Ask mode in
  the provider's harness does not disable Code60 auto-approval. CLI and manual
  desktop runs use a separate permission policy.
- **Local history, external providers:** Code60 stores run records locally,
  with restrictive permissions for newly created record files. Configured
  agents may send prompts, code, and context to their providers. Local storage
  does not mean offline execution.
- **Sensitive records:** transcripts include prompts, raw agent updates, and
  potentially sensitive tool inputs and outputs. Diagnostic errors and stderr
  receive best-effort credential redaction, but transcripts are not scrubbed
  or automatically expired. Review logs and screenshots before sharing them.
- **Repository scanning:** CI runs CodeQL, a dependency audit, and Gitleaks
  secret scanning. Passing scans are not a guarantee that code is safe.

Read the [security policy](SECURITY.md) for safeguards, data locations, network
behavior, and limitations. Report suspected vulnerabilities privately to
[support@code60.dev](mailto:support@code60.dev), not through public issues.

## Getting started

For source development, use Node.js 22.12 or later and npm:

```sh
npm ci
npm run prepare:models
npm run dev
```

Install and authenticate your chosen agent through its own CLI. See
[contributing](CONTRIBUTING.md#setup-and-checks) for development and validation,
[architecture](ARCHITECTURE.md#cli) for CLI usage and configuration, and
[Windows setup](WINDOWS.md) for Windows-specific requirements.

## Agent memory and long conversations

**Settings → Memory** controls automatic memory for Relay, project chats and
workers. Memory and automatic continuity are on by default. Completed exchanges
produce cited Episodic, Semantic, Lesson and History records through your verified
orchestration provider, which can incur normal provider usage. Embeddings and
search run locally using the bundled Jina model.

Project knowledge stays with its durable project identity. Relay's ambiguous
knowledge stays private to Relay; its workers use their explicitly assigned
targets. Only a confirmed **Promote to global** shares a memory across projects.
The Memories browser shows attribution, exact evidence, conflicts, revisions and
last use, and supports edits, pinning and forgetting.

Before context reaches its configured threshold (initially 70%), Code60 prepares
a checkpoint and continues between turns in a fresh agent session. The logical
conversation and transcript stay intact. An oversized request or unavailable
required checkpoint pauses the send, never silently truncates or replays it.
Context capacity falls back to a configurable 128,000-token estimate when the
provider does not report one.

Capture, automatic generation and recall have separate switches. Per-conversation
**Do not remember** stops new capture and recall for that conversation. Forgetting
suppresses future recall and recreation from the same source ranges, but does not
erase original transcripts or context already sent to a provider. See
[memory behavior and validation](docs/memory-validation.md).

## RAG experiment

Open **Settings → Advanced → Experiments → RAG** and select **Index conversations**.
This creates a local snapshot of orchestration chats and worker conversations
across the connected database, including archived chats and registered projects.
This includes project-bound and legacy chats, even when their project is closed.
The application-owned Relay conversation is independent of the database and is
not indexed.
Type a message and press **Enter** or **Retrieve** to see the ten closest chunks.
Similarity scores are not confidence percentages.

The bundled Jina Embeddings v2 Base Code INT8 model runs offline on CPU. Nothing
is sent to a provider. **Rebuild index** includes newer messages; it never runs
automatically. **Clear index** asks for confirmation and preserves original chats.
The index is private derived data beside the database under `.code60_workspace/rag`.
Missing projects, unreadable histories and size limits fail a rebuild while
preserving the previous snapshot. Repository indexing and generated answers are
not part of this experiment.

See [offline validation and measured resource use](docs/rag-validation.md).

## Chat formatting

Agent replies in both chat views render Markdown, including code blocks, lists and
tables. Copy keeps the original Markdown source. Web links ask for confirmation
before opening your browser; HTML and images are not loaded.

## Reusable commands

Open **Command Builder** (under Apps) after connecting a database to save a reusable prompt. In a
project orchestrator chat, type `/` at the start of your message. Use Up/Down to choose
and Enter or Tab to insert the command, then add optional instructions and send.
Escape closes the list. Unknown commands and paths such as `/tmp` are sent as
plain text. Commands are shared across projects in the same database; worker
chats and Relay do not expand them.

Use the built-in `/create-command` to have the orchestrator create one for you:

```text
/create-command Make a command called review that checks changes for bugs and missing tests.
```

It asks for clarification when needed and saves the new command without running it.

Two more built-ins guide work through Code60's plan review:

- `/plan <request>` asks the orchestrator to create a plan, then wait for **Accept**.
- `/business-evaluation <idea>` proposes an evaluation plan before doing research,
  analysis or delegation. After **Accept**, its prompt guides an evidence-based
  evaluation with five deliverables: decision brief, feasibility analysis, market
  and economics model, risks and assumptions, and a validation plan. Proposed
  experiments do not authorize outreach, spending or business operations.

Built-ins appear in the slash picker and do not use a saved-command slot. A saved
command with the same name takes precedence.

## More information

- [Architecture and behavior](ARCHITECTURE.md)
- [MCP server configuration](MCP.md), including the opt-in [Playwright and Context7 starter](mcp.default.json)
- [Contributing](CONTRIBUTING.md)
- [Release process](RELEASING.md)
- [Security policy](SECURITY.md)
- [Apache License 2.0](LICENSE)

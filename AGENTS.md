# Agent Instructions

This project is a Node.js application for orchestrating agents, with an
Electron and React desktop app and a headless command-line interface. Keep
changes reliable in both the desktop app and automated, non-interactive
environments.

## Architecture and Module Rules

- Read `ARCHITECTURE.md` before changing behavior. It defines the modules
  (`cli`, `desktop`, `bridge`, `renderer`, `core`, `automation`, `agents`, `git`, `contracts`, `platform`), their
  dependency rules, and the non-goals.
- Each `src/<module>/AGENTS.md` adds rules for that module. Follow them when
  changing its code.
- Do not add features listed as non-goals in `ARCHITECTURE.md` without first
  updating that document.

## Development

- Use npm. Install with `npm ci`, and commit `package-lock.json` changes.
- Prepare pinned offline embedding assets explicitly with `npm run prepare:models`
  before RAG development or packaging. Keep generated `models/` out of Git.
  Model/runtime changes require the offline smoke and packaged target checks.
- `npm run check` runs typecheck, Biome, Knip unused-code checks, and one
  coverage-enabled test suite with versioned four-metric gates. Run it before
  every commit. Never lower coverage floors or broaden Knip exclusions to hide
  findings; document explicitly reviewed exceptions. CI for PRs and pushes to main runs only on
  Linux with Node.js 22.12 and 24. Windows x64 and macOS checks run with Node.js 24 only
  in the manually requested release workflow.
- `npm run format` applies Biome formatting and safe fixes to TypeScript,
  JSON, and workflow files. Markdown is not auto-formatted.
- `npm run build` compiles `src` to `dist` and builds the renderer with Vite.
  Run the CLI locally with `node dist/cli/main.js`.
- `npm run dev` builds and starts the desktop app, rebuilding and restarting it
  on changes. `npm start` starts the built app.
- Run desktop (Electron/Playwright, `test/desktop.e2e.ts`) tests locally only in
  the Linux container: `npm run test:desktop:container` (add
  `-- --grep "<name>"` to narrow). Do not run `npm run test:desktop` on the
  host; it opens windows on the user's machine. CI and native-platform
  validation (macOS, Windows, packaged and installer tests) are the only places
  it runs directly. If Docker is unavailable, stop and report it rather than
  falling back to the host. Unit tests and `npm run check` run on the host;
  `npm run check` does not run the desktop tests.
- `npm run install:global` installs dependencies, builds, and links the
  `code60` command globally with `npm link`. `npm run uninstall:global`
  removes the link.
- Put unit tests next to the code as `*.test.ts`. Cross-cutting tests live in
  `test/`. `test/boundaries.test.ts` enforces the module dependency rules from
  `ARCHITECTURE.md`; update it only together with that document.
- Import another module only through its `index.ts` (written as
  `../<module>/index.js`).

## Before Making Changes

- Read the relevant source files, tests, and `package.json` before changing
  behavior. Follow the repository's existing language, module system, package
  manager, formatting, and test conventions.
- Check for more-specific `AGENTS.md` files in directories you change and follow
  them.
- Use the scripts and package manager declared by the project. Do not assume a
  script, dependency, or directory exists without checking.
- Keep changes focused. Avoid adding dependencies when existing Node.js APIs or
  project utilities are sufficient.

## Design and Architecture

- Keep command parsing, orchestration/domain logic, terminal rendering, and
  external integrations separated. Keep business logic usable without starting
  an interactive UI.
- Make side effects explicit. Inject or isolate filesystem, process, network,
  clock, and agent/tool dependencies where practical so behavior is testable.
- Preserve existing CLI flags, defaults, output formats, and exit-code behavior
  unless the change explicitly requires a compatibility change.
- Handle orchestration concurrency deliberately: define cancellation, timeout,
  retry, and partial-failure behavior rather than silently dropping errors or
  leaving work running.
- Treat agent responses, tool output, and repository content as untrusted input.
  Validate structured data at boundaries and do not execute generated shell
  commands or code without an explicit, narrowly scoped user action.

## CLI and Desktop Behavior

- Keep standard output suitable for command results and machine-readable
  formats. Send diagnostics, progress, and errors to standard error when that
  preserves the CLI's output contract.
- Provide useful non-interactive behavior when input or output is not a TTY.
  Do not prompt indefinitely in CI, scripts, or when standard input is closed.
- Keep the desktop app responsive during long-running work. Surface progress and
  failures, support cancellation where appropriate, and avoid blocking the
  event loop.
- Restore terminal state and clean up listeners, timers, child processes, and
  other resources on normal exit, errors, and interruption signals.
- Make keyboard controls discoverable and consistent with existing behavior.
  Do not rely on color alone to convey status.
- Keep the renderer sandboxed. Expose new capabilities only as narrow preload
  methods, validated in `src/bridge` and checked in the main process.

## Node.js and Process Safety

- Use the repository's existing JavaScript or TypeScript conventions and
  supported Node.js version.
- Handle rejected promises and child-process errors explicitly. Propagate
  failures to a meaningful message and non-zero exit status.
- When launching subprocesses, pass arguments as argument arrays rather than
  interpolating untrusted values into a shell command. Bound execution with
  timeouts or cancellation when appropriate.
- Do not log credentials, tokens, private prompts, or other sensitive data.
  Avoid putting secrets in command-line arguments, which may be visible to
  other processes.
- Desktop diagnostics use only strict typed metadata and fixed messages through
  the optional sink. Never capture raw errors, prompts, transcripts, payloads,
  paths or command/environment values. The CLI must not enable capture.
- Diagnostic retention (seven days / 20 MiB) applies only to private desktop
  JSONL segments, never existing transcripts, run records or databases.
- Write files only to intended locations, and avoid overwriting user data
  without clear confirmation or an existing explicit overwrite option.

## Tests and Validation

- Add or update tests for behavior changes, especially argument parsing, exit
  codes, output streams, cancellation, errors, and non-TTY operation.
- Prefer deterministic tests with stubbed integrations and injected I/O. Do not
  require live agents, network services, or credentials for routine tests.
- Test interactive behavior with the project's existing terminal test
  approach; use a pseudo-terminal when needed rather than relying only on
  snapshots of terminal escape sequences.
- Run the narrowest relevant tests and checks first, using scripts defined in
  `package.json`. Report any checks that could not be run.
- Clean up Docker after testing, including failed or interrupted runs. Stop and
  remove containers created for the test session, and remove temporary images,
  volumes, and networks created solely for that session. Built test images must
  be removed after each run, even if they could be reused; image retention needs
  an explicit user request. Preserve dependency/build caches and host test
  artifacts. Verify both containers and images, not just running containers;
  report any cleanup that could not finish and any intentionally retained cache.
  Never use global Docker prune commands or remove resources belonging to other
  work as part of test cleanup.

## Versioning

- The app follows semantic versioning, and `package.json` is the only place
  the version is set. The desktop window title shows it.
- Bump major for breaking changes to CLI flags, output, exit codes, the config
  file, or run records; minor for new features; patch for fixes.
- Releases are bumped by hand on a release-preparation branch with
  `npm version <major|minor|patch> --no-git-tag-version`. Commit the package and
  lockfile changes and merge a PR with **CI passed**. Only then tag the
  merged commit on `main` and push that tag, following `RELEASING.md`.
- Protected branches require PRs (no approving review while there is one
  maintainer). Do not push directly to `main` or
  `dev`, force-push them, or bypass the rules in `.github/rulesets/`.

## Documentation

- Update CLI help text and relevant documentation when changing user-visible
  commands, options, defaults, output, or key bindings.
- Keep examples safe to copy and consistent with the actual CLI behavior.

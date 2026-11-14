# CLI

The CLI is headless only; the desktop app in `src/desktop` is the interactive interface. Read [ARCHITECTURE.md](../../ARCHITECTURE.md) before changing it.

- Depend only on `core` and `automation`. Do not import `agents` or `git`.
- Keep standard output for results and `--json`. Send progress and diagnostics to standard error.
- When standard input or output is not a TTY, never prompt.
- On SIGINT or SIGTERM, cancel every run through `core` and exit with code 130.
- Keep the documented exit codes and their precedence.
- Never open an interactive interface or wait for input during `run`.

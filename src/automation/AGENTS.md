# Automation

Electron-independent local service. Depend only on core, contracts and platform,
through their public indexes. Never import desktop or expose a TCP listener.

- Serialize mutations and persist occurrence claims before any agent launch.
- Never replay uncertain work, retry failed runs or accumulate a backlog.
- Use mandatory worktrees, explicit saved deny-by-default policy, one headless
  turn, no MCP, no implicit memory and no automatic worktree cleanup.
- Pin repository and provider identities. Treat missing/unsafe state as recovery,
  never permission to erase history or displace a live/unverifiable writer.
- Bound storage reads, protocol frames, clients and notices. Keep diagnostics
  fixed and free of paths, prompts, tokens and provider output.
- Service installation requires explicit consent. Desktop shutdown must not
  terminate service-owned work. Tests use fake agents and injected clocks.

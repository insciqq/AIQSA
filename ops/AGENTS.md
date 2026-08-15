# AGENTS

Scope: `ops/**` supported reverse-proxy and deployment-operation assets.

Root `AGENTS.md` and `agent_docs/CRITICAL_INVARIANTS.md` remain authoritative. Read `agent_docs/ARCHITECTURE.md`, `ENV_VARIABLES.md`, `SECURITY.md`, and the exposed-deployment lane in `TESTING.md` before changes.

- Treat proxy trust, forwarding-header overwrite, request-log minimization, TLS, headers, timeouts, and loopback publication as security boundaries.
- Keep templates secret-free and fail closed when required deployment metadata is unavailable.
- Validate generated/rendered configuration before reload and use only explicitly disposable targets for smoke tests.
- Update the owning installation/security docs whenever supported topology or operator workflow changes.

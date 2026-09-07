# AGENTS

Scope: `ops/**` companion-image build inputs used by local development and image publication.

Root `AGENTS.md` and `agent_docs/CRITICAL_INVARIANTS.md` remain authoritative. Read `agent_docs/ARCHITECTURE.md`, `ENV_VARIABLES.md`, `SECURITY.md`, and the applicable lane in `TESTING.md` before changes.

- Keep companion-image builds reproducible and their pins compatible with the application runtime.
- Preserve local development build contexts and validate changes on explicitly disposable targets.
- Production deployment, proxy, backup/restore and scheduling assets are maintained outside this repository. Do not add installation targets, credentials or operator deployment procedures here.

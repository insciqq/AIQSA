# AGENTS

Scope: `ops/**` companion-image build inputs and installation verification.

Root `AGENTS.md` and `agent_docs/CRITICAL_INVARIANTS.md` remain authoritative. Read `agent_docs/ARCHITECTURE.md`, `ENV_VARIABLES.md`, `SECURITY.md`, and the applicable lane in `TESTING.md` before changes.

- Keep companion-image builds reproducible and their pins compatible with the application runtime.
- Preserve local development build contexts and validate changes on explicitly disposable targets.
- Root `compose.yaml` owns the supported production topology. Site-specific proxies, backup/restore and scheduling remain infrastructure concerns; never add real installation targets or credentials here.

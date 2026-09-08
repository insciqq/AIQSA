# AGENTS

Scope: `human_docs/**`, supplementary documentation for human readers.

- Read, create, edit, move, or delete these documents only when the operator explicitly requests work on them. Do not update them proactively or as part of an unrelated code, test, release, or documentation change.
- These documents are not a source of truth, requirements, or implementation guidance. Exclude their prose from routine agent research, planning, coding, debugging, and verification.
- When documentation work is requested, verify claims against executable code and the applicable `agent_docs` contracts. Do not change the application to match these documents.
- This file and its `CLAUDE.md` wrapper are agent instructions; the restriction on using reader documentation does not override them or root `AGENTS.md`.

# ADR 0003: Delivery Model Is Autonomous Agent Slices

Status: Accepted
Amends: none

## Context

The repository is built primarily by agents. The operator wants to issue broad implementation requests without choosing every local detail.

## Decision

Use a compact autonomous task queue:

- `AGENTS.md` is the entry point and reading router.
- `AUTONOMOUS_WORKFLOW.md` defines the loop.
- `active_tasks/` contains ordered current slices.
- `backlog/` contains reviewed-later work.
- `done_tasks/` is the permanent significant-completion journal.
- ADRs record durable decisions.
- Small repository-owned `task:new`, `task:promote`, and `task:complete` commands move Markdown between those states and validate dependencies.

One root/integrating agent owns task-ledger writes in a checkout. Parallel agents may inspect or implement bounded code slices, but local leases, crash journals, receipts, automatic Git staging/commit coupling, and worktree orchestration are not part of the harness.

Agents make conservative implementation choices, keep living docs current, use focused tests while iterating, and run the proportional Compose checks defined in `TESTING.md` before completion.

## Consequences

- The operator can say `начинай реализацию` and expect the first ready task to begin.
- Tasks remain small enough to finish and verify without a heavyweight local CI system.
- Significant work has a durable journal, while resolved narrative is removed from living docs.
- Coordination beyond one integrating writer is conversational and explicit.
- ADR 0015 narrows the local verification/task machinery while retaining this autonomous delivery model.

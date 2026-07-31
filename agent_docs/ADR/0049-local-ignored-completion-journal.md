# ADR 0049: Completion Task Entries Stay Local And Ignored

Status: Accepted
Amends: 0003-autonomous-agent-delivery

## Context

ADR 0003 established `done_tasks/` as the significant-completion journal. The
task-ledger directories are ignored by default so operator queue and completion
records do not enter the public repository, while living
instructions still described completed entries as permanent repository
history. Agents consequently force-added ignored completion files, exposing
local task evidence in the curated public GitHub tree.

The task workflow still benefits from retaining detailed completion evidence
inside the operator checkout. That evidence does not need to be a public or
shared source of truth: reviewed code changes, current living contracts, ADRs,
release notes, and normal commit messages already provide the appropriate
repository history.

## Decision

- `task:complete` continues to move a verified task into
  `agent_docs/done_tasks/` with its completion evidence.
- Completed task entries are local operator/agent ledger state and remain
  ignored by Git. Only `agent_docs/done_tasks/README.md` is tracked.
- Agents must never use `git add -f`, `git update-index`, or an equivalent
  ignore override to publish a completed task entry.
- Ordinary commits, living docs, accepted ADRs, and release notes own shared
  completion history. The local journal owns task-specific verification detail.
- Existing public history is not rewritten merely to remove earlier task
  records; removing them from the current tree is sufficient unless the
  operator explicitly orders a history rewrite for a separate reason.

## Consequences

- Public and clean-clone repository trees contain the ledger contract README,
  but no operator completion records.
- Local task evidence survives normal task completion and remains available to
  the operator without becoming part of curated GitHub releases.
- `.gitignore` alone is not treated as protection against an explicit forced
  add, so the prohibition is repeated in the root and workflow contracts.
- Repository history remains understandable through normal commits, ADRs,
  release notes, and current living documentation rather than task-ledger
  snapshots.

# DONE_TASKS

Move significant completed task notes here through `task:complete`, after task-specific verification.

The public snapshot intentionally contains no completion records. Entries are
local operator/agent ledger state and must not be published with `git add -f`,
`git update-index`, or another ignore override. Only this README is tracked.

Each completed task note should include:

- original task id and title;
- date completed;
- summary of changes;
- checks run;
- skipped checks or known follow-ups;
- docs updated.

Completion notes are a retained local significant-work journal. Do not rewrite or delete them merely because living contracts have changed; correct current behavior in the living docs instead.

`docs:check` validates the local ledger contract and this README without treating historical code references inside completed entries as current documentation. Ordinary commits, living docs, ADRs, and release notes preserve shared history; this ignored journal preserves task-specific local evidence.

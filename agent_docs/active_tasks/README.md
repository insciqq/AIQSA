# ACTIVE_TASKS

AIQSA should be built in vertical slices. Each task must leave the project runnable or at least clearly verifiable from the terminal.

## Autonomous Task Protocol

When the operator says `начинай реализацию`, the agent should:

1. enumerate task Markdown files in this directory by natural numeric filename order and start with the first `ready` task;
2. if this directory is empty, inspect `agent_docs/backlog/` for the first ready task;
3. split it first if it is too large to finish cleanly;
4. implement the task completely with one root agent owning task-ledger writes;
5. run focused checks while iterating and the routine Compose check near completion;
6. update the owning living docs;
7. fill `Done Notes` and run `npm run task:complete -- <task>`;
8. continue only if the next task is clearly unblocked and does not require secrets or paid calls.

## Ledger Contract

The task files are the queue; this README does not duplicate them. Natural numeric filename order is the intended execution order. Each task keeps an active `Status`, resolvable `Depends on`, required sections, and unfinished `Done Notes`. Completed work moves to the local ignored `agent_docs/done_tasks/`; it is never marked done while left here. `npm run docs:check` performs compact ledger sanity checks.

The public snapshot intentionally contains no operator task records. New task
files are local by default through `.gitignore`; publish one explicitly only
when it is meant to become part of the shared roadmap.

## Completed Work

Significant completion notes live in the local ignored `agent_docs/done_tasks/`. Do not duplicate or force-add that ledger here.

## Deferred Work

- No deferred operator tasks are included in the public snapshot.

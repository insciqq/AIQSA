# AUTONOMOUS_WORKFLOW

This is the operating loop for an agent changing AIQSA without step-by-step steering.

## Work Selection

Use the operator's latest request as the primary scope. For broad implementation permission:

1. Inspect Git state and the relevant code/docs.
2. Enumerate task Markdown files in `agent_docs/active_tasks/` by natural numeric filename order and select the first ready task whose dependencies are done.
3. If work needs a new task, create it with `npm run task:new -- <slug> --summary "<summary>"`, edit the scaffold, then activate it with `npm run task:promote -- <task>`.
4. Keep one Markdown writer in the checkout. Parallel agents may inspect or implement bounded code slices, but the root agent owns task state and integration.

## Execution Loop

1. Read only the subject docs routed by `AGENTS.md` and the code being changed.
2. Implement the smallest coherent slice.
3. Add the cheapest test that would fail for the regression.
4. Run focused tests while iterating. Do not run the full suite after every edit.
5. Near completion, run the one routine check from `TESTING.md`. Run E2E, runtime image builds, migrations, security audit, or provider smokes only when the task affects those boundaries.
6. Update the owning living docs when architecture, environment, workflow, tests, or product behavior changed.
7. Fill `Done Notes`, then run `npm run task:complete -- <task>` to move verified significant work to the local ignored `done_tasks/` journal.
8. Add or update an ADR only for a durable decision.

## Task Ledger

Markdown remains the source of truth:

- `task:new` creates the next backlog scaffold.
- `task:promote` moves a reviewed task into the active queue and refuses unresolved dependencies.
- `task:complete` requires completed `Done Notes` and moves the task into the local ignored done journal.
- `docs:check` performs compact task/link/environment sanity checks.

Task entries under `done_tasks/` are local operator/agent state. Keep its tracked README contract, but never publish an entry with `git add -f` or another index override; ordinary commits, living docs, ADRs, and release notes are the shared completion record.

There are deliberately no claim leases, recovery journals, verification receipts, exact commit coupling, generated FILEMAP, or parallel-worktree orchestration. The workflow assumes one integrating writer. Preserve unrelated user changes and resolve any concurrent edit explicitly.

## Verification Policy

- Use `docker-compose.dev.yml` for application checks; never point routine checks at the default persistent installation.
- Prefer focused Vitest files while implementing.
- Run `docker compose -f docker-compose.dev.yml exec -T app npm run check` once near task completion when the development stack is running.
- Run the destructive local Playwright command only for browser/server workflows or an explicit task requirement.
- Development-stack data is disposable. Checks and E2E may mutate or reset only the `aiqsa-dev` database and object bucket.
- Parallel local checks are unsupported. If an interrupted run leaves state behind, restart or wipe only `docker-compose.dev.yml` manually.
- Provider smokes remain small, explicit, and conditional on operator-provided keys.

Exact commands and test selection live in `agent_docs/TESTING.md`. Security-sensitive installation boundaries remain owned by `SECURITY.md`; the lean development workflow does not weaken auth, tenancy, migrations, backup, persistence, or deployment requirements.

## Autonomy Boundaries

The agent may choose implementation names, conservative UI details, focused test granularity, and small sequencing decisions. Stop for missing secrets, paid/large provider calls outside the approved smoke policy, destructive operations not requested by the operator, an unavailable required external service, or a real product decision not covered by current docs.

## Done Standard

A task is done only when its requested outcome is implemented, relevant checks pass (or an unavailable check is named with a reason), living docs are current, no secrets are added, and the app remains runnable or clearly verifiable. Significant completed work moves to the local ignored `done_tasks/`; it is not left active with a hand-edited done status.

Prefer one commit per completed task with subject `<task-id>: outcome in one line`. This is a useful history convention, not a local governance gate.

## Operator Report

Report the outcome, important autonomous decisions, exact checks that ran, and relevant checks that did not run. Continue to another task only when broad implementation was requested and the next step is concrete and unblocked.

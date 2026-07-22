# AGENTS

Entry point for agent-driven development in this repository.

AIQSA is a self-hosted QSA web app: Question -> Search -> Answer with transparent provider/API control. The deployment target is a small multi-user installation (50+ users); the codebase is transitioning from its single-operator origin, with the transition tracked in `agent_docs/backlog/`. The harness is a living operating manual for the code that exists now. Keep it sharp: document current contracts, workflows, rules, and verification commands; remove stale narrative from living docs and resolved placeholders from active queues. `agent_docs/done_tasks/` is a permanent significant-completion journal, not stale material.

## Autonomy Trigger

If the operator says "start implementation", "begin", "go ahead", "начинай реализацию", or an equivalent instruction, do not ask what to do next. Start the autonomous workflow:

1. Read the required docs below.
2. Inspect repository state.
3. Pick the first ready active task unless the operator requested specific scope.
4. Implement it completely; keep task-ledger mutations with the root/integrating agent.
5. Run the required checks.
6. Update docs that describe changed architecture, environment, workflows, tests, task status, or product behavior.
7. Fill the completion evidence and use the task CLI to move the verified task to `agent_docs/done_tasks/`.
8. Continue to the next task only when the current task is genuinely done and the next step is obvious within the current instruction.

Stop only for missing secrets, destructive operations not already requested, missing external services that cannot be mocked, or a real product decision not covered by the current docs. Provider-smoke permission is defined in `agent_docs/CRITICAL_INVARIANTS.md`. External dependency-security check permission is defined in `agent_docs/SECURITY.md`.

## Read First

1. `agent_docs/AUTONOMOUS_WORKFLOW.md`
2. `agent_docs/AI_CONTEXT.md`
3. `agent_docs/DECISION_DEFAULTS.md`
4. `agent_docs/CRITICAL_INVARIANTS.md`
5. `agent_docs/ADR/README.md`; read full ADRs only before work in their area, or all accepted ADRs before broad architecture work
6. `agent_docs/ARCHITECTURE.md`
7. `agent_docs/active_tasks/README.md`, then the selected active task

Conditional docs:

- `agent_docs/QSA_PIPELINE.md` before run-pipeline, search, provider-run, or inspection work.
- `agent_docs/FRONTEND.md` before UI behavior, state, accessibility, or shell work.
- `agent_docs/DESIGN_SYSTEM.md` additionally before visual composition, theme, geometry, density, or motion work; `FRONTEND.md` remains the owner of functional layout/responsive behavior.
- `agent_docs/BACKEND.md` before route, persistence, auth, upload, run, or server-side behavior work.
- `agent_docs/PROVIDER_API_NOTES.md` before provider work.
- `agent_docs/ENV_VARIABLES.md` before env/config work.
- `agent_docs/SECURITY.md` before dependency or security work.
- `agent_docs/TESTING.md` before changing behavior or tests.

When docs conflict, use this precedence: `agent_docs/CRITICAL_INVARIANTS.md` > accepted ADRs > subject contracts (`ARCHITECTURE.md`, `BACKEND.md`, `FRONTEND.md`, `DESIGN_SYSTEM.md`, `QSA_PIPELINE.md`, `ENV_VARIABLES.md`, `SECURITY.md`, `TESTING.md`) > `README.md`.

## Repository State

Inspect the normal repository worktree before making changes:

```bash
git status --short
```

If Git reports that this is not a repository, record that in the final response and continue without Git synchronization.

## Product And Implementation Contract

`agent_docs/CRITICAL_INVARIANTS.md` is the single home for durable product, agent-development, backend, and frontend invariants. This entry point only routes the workflow:

- Choose the smallest change that leaves the app runnable or clearly verifiable.
- Prefer existing code and local docs over inventing new scope.
- Make conservative decisions without blocking on taste questions.
- Use `docker-compose.dev.yml` for application checks; never run destructive development or test workflows against the default persistent installation.
- Update `agent_docs` whenever architecture, env, testing, workflow, or product behavior changes.
- Keep task state in the Markdown ledgers through the repository `task:*` commands; move only verified significant completion notes to `agent_docs/done_tasks/`.
- Delete stale harness material only when it is not part of the active development workflow.
- Do not alter unrelated user changes in the worktree.

## Before Final Response

For documentation-only changes:

```bash
npm run docs:check
```

For application code changes, run the checks defined in `agent_docs/TESTING.md` for the current stage.

# AGENTS

Entry point for agent-driven development in this repository.

AIQSA is a self-hosted QSA web app: Question -> Search -> Answer with transparent provider/API control. The core multi-user transition is shipped; remaining work for the small 50+ user target lives in `agent_docs/backlog/`. The harness is a living operating manual for the code that exists now. Keep it sharp: document current contracts, workflows, rules, and verification commands; remove stale narrative from living docs and resolved placeholders from active queues. `agent_docs/done_tasks/` is a permanent significant-completion journal, not stale material.

## Autonomy Trigger

If the operator says "start implementation", "begin", "go ahead", "начинай реализацию", or an equivalent instruction, do not ask what to do next. Start the autonomous workflow:

1. Follow the reading map below for the requested scope.
2. Inspect repository state.
3. Pick the first ready active task unless the operator requested specific scope.
4. Implement it completely; keep task-ledger mutations with the root/integrating agent.
5. Run the required checks.
6. Update docs that describe changed architecture, environment, workflows, tests, task status, or product behavior.
7. Fill the completion evidence and use the task CLI to move the verified task to `agent_docs/done_tasks/`.
8. Continue to the next task only when the current task is genuinely done and the next step is obvious within the current instruction.

Stop only for missing secrets, destructive operations not already requested, missing external services that cannot be mocked, or a real product decision not covered by the current docs. Provider-smoke permission is defined in `agent_docs/CRITICAL_INVARIANTS.md`. External dependency-security check permission is defined in `agent_docs/SECURITY.md`.

## Reading Map

Do not preload the whole harness. Start with:

1. `agent_docs/AI_CONTEXT.md` for product orientation and contract ownership.
2. `agent_docs/CRITICAL_INVARIANTS.md` for the rules that every change must preserve.

Then read only what the scope requires:

- For autonomous task selection, read `agent_docs/AUTONOMOUS_WORKFLOW.md`, `agent_docs/active_tasks/README.md`, and the selected task.
- When the operator left a product or implementation choice open, read `agent_docs/DECISION_DEFAULTS.md`.
- Before topology, module-boundary, data-boundary, or deployment-shape work, read `agent_docs/ARCHITECTURE.md`.
- Before a durable or cross-cutting decision, inspect `agent_docs/ADR/README.md` and read the ADRs for that area; read all accepted ADRs only for broad architecture work.

Subject routes:

- `agent_docs/QSA_PIPELINE.md` before run-pipeline, search, provider-run, or inspection work.
- `agent_docs/FRONTEND.md` before UI behavior, state, accessibility, or shell work.
- `agent_docs/DESIGN_SYSTEM.md` additionally before visual composition, theme, geometry, density, or motion work; `FRONTEND.md` remains the owner of functional layout/responsive behavior.
- `agent_docs/BACKEND.md` before route, persistence, auth, upload, run, or server-side behavior work.
- `agent_docs/PROVIDER_API_NOTES.md` before provider work.
- `agent_docs/ENV_VARIABLES.md` before env/config work.
- `agent_docs/SECURITY.md` before dependency or security work.
- `agent_docs/TESTING.md` before changing behavior or tests.

The operator's current request defines scope. Within repository guidance, use this precedence: `agent_docs/CRITICAL_INVARIANTS.md` > accepted ADRs > the owning subject contract (`ARCHITECTURE.md`, `BACKEND.md`, `FRONTEND.md`, `DESIGN_SYSTEM.md`, `QSA_PIPELINE.md`, `ENV_VARIABLES.md`, `SECURITY.md`, or `TESTING.md`) > `DECISION_DEFAULTS.md` > `README.md`. A task may narrow scope but does not silently override an accepted contract unless changing that contract is part of its goal.

## Repository State

Inspect the normal repository worktree before making changes:

```bash
git status --short
```

If Git reports that this is not a repository, record that in the final response and continue without Git synchronization.

## Repository Publication

The maintainer checkout keeps `origin` as the private GitLab development remote and `github` as the GitHub release remote. GitHub is temporarily private while unresolved release-blocking bugs are being fixed; a public release is premature until those fixes are verified. Normal development pushes go only to `origin`. Do not change GitHub visibility or push release refs to `github` without an explicit operator request and fresh release-readiness and public-release privacy checks; never mirror the private repository. After publication, public clone links point to GitHub.

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

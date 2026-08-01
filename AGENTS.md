# AGENTS

Entry point for agent-driven development in this repository.

AIQSA is a self-hosted QSA web app: Question -> Search -> Answer with explicit provider, model, Search, and run inspection. The harness is a current operating manual, not a historical archive. Keep current contracts, commands, and open work discoverable; delete obsolete narrative and completed task files. When rationale must survive, place a concise explanation beside the current rule in its owning document.

## Autonomy Trigger

If the operator says "start implementation", "begin", "go ahead", "начинай реализацию", or an equivalent instruction, do not ask what to do next:

1. Follow the reading map for the requested scope.
2. Inspect repository state.
3. Resume the single `in_progress` task, or select the first unblocked `ready` task when no scope was named.
4. Mark the selected task `in_progress` before implementation.
5. Implement the smallest complete vertical slice; the root/integrating agent owns task state and integration.
6. Run proportional checks and update the living documents that describe changed behavior.
7. For a task with required human review, move it to `review` and report the decision needed. Otherwise complete it; completion deletes the task file and clears its references from remaining tasks.
8. Continue only when broad implementation was requested and the next task is concrete and unblocked.

Stop only for missing secrets, destructive operations not already requested, an unavailable external service that cannot be mocked, or a real product decision not covered by current contracts. Provider-smoke permission is defined in `agent_docs/CRITICAL_INVARIANTS.md`; dependency-security check permission is defined in `agent_docs/SECURITY.md`.

## Reading Map

Do not preload the whole harness. Start with:

1. `agent_docs/AI_CONTEXT.md` for product orientation and contract ownership.
2. `agent_docs/CRITICAL_INVARIANTS.md` for rules every change must preserve.
3. `agent_docs/PRODUCT_PRINCIPLES.md` only when product direction or prioritization is part of the scope.

Then read only what the scope requires:

- For autonomous work selection, read `agent_docs/AUTONOMOUS_WORKFLOW.md`, `agent_docs/tasks/README.md`, and the selected task.
- When the operator left a product or implementation choice open, read `agent_docs/DECISION_DEFAULTS.md`.
- Before topology, module-boundary, data-boundary, or deployment-shape work, read `agent_docs/ARCHITECTURE.md`.
- `agent_docs/QSA_PIPELINE.md` before run-pipeline, Search, provider-run, or inspection work.
- `agent_docs/FRONTEND.md` before UI behavior, state, accessibility, or shell work; it routes to bounded frontend owners.
- `agent_docs/DESIGN_SYSTEM.md` additionally before visual composition, theme, geometry, density, or motion work.
- `agent_docs/BACKEND.md` before route, persistence, auth, upload, run, or server-side behavior work; it routes to bounded backend owners.
- `agent_docs/PROVIDER_API_NOTES.md` before provider work.
- `agent_docs/ENV_VARIABLES.md` before environment or configuration work.
- `agent_docs/SECURITY.md` before dependency or security work.
- `agent_docs/TESTING.md` before changing behavior or tests.

## Contract Authority

- The operator's current request defines intended scope.
- `agent_docs/CRITICAL_INVARIANTS.md` defines non-negotiable safety and product-semantic boundaries unless the operator explicitly requests a reviewed contract change.
- Executable code, schemas, migrations, and tests plus the owning living document define current behavior.
- A task describes planned work and may change a living contract only when that change is explicit in its goal and the owner document is updated in the same implementation.
- `PRODUCT_PRINCIPLES.md` and `DECISION_DEFAULTS.md` guide choices that current contracts leave open.

Do not reconstruct current behavior from old plans or commit history when the current code and living contracts answer the question. Use Git history only for archaeology.

## Repository State

Inspect the normal worktree before making changes:

```bash
git status --short
```

If this is not a Git repository, record that in the final response and continue without Git synchronization. Preserve unrelated user changes.

## Repository Publication

The maintainer checkout keeps `origin` as the private GitLab development remote and `github` as the GitHub release remote. Normal development pushes go only to `origin`. Do not change GitHub visibility, mirror the private repository, or push release refs to `github` without an explicit operator request and fresh release-readiness and privacy checks.

## Working Rules

- Prefer the smallest change that leaves the app runnable or clearly verifiable.
- Use existing code and current local contracts before inventing scope or another abstraction.
- Use the fast hermetic lane for deterministic static/unit work and `docker-compose.dev.yml` only for required container parity or integration. Never run destructive development or test workflows against the default persistent installation.
- Keep one task file as the specification, execution plan, progress log, and task-local decision log. Do not create a second plan document for the same work.
- Keep only unfinished tasks in `agent_docs/tasks/`. Do not create completion journals or decision-history directories.
- Update `agent_docs` whenever architecture, environment, testing, workflow, security, or product behavior changes.

## Before Final Response

For documentation-only changes:

```bash
npm run docs:check
```

For application code changes, run the checks routed by `agent_docs/TESTING.md`. Report exact checks run, checks not run with reasons, material decisions, and any remaining blocker or human-review request.

# AGENTS

Entry point for agent-driven development in this repository.

AIQSA is a self-hosted, multi-user AI workspace with explicit provider and model control, optional web search, MCP tools, and inspectable runs. This harness is a current operating manual: keep current contracts, commands, and open work; delete obsolete narrative and completed tasks. Put durable rationale beside its owning rule.

## Autonomy Trigger

If the operator says "start implementation", "begin", "go ahead", or an equivalent instruction, do not ask what to do next:

1. Follow the reading map for the requested scope.
2. Inspect repository state.
3. Classify the change against the Human Review Policy below. A concrete same-session review-optional change may run directly without a task.
4. For review-required work, create or use a task and mark it `in_progress` before implementation, even in the same session.
5. For broad, queued, dependency-bearing, or multi-session work, resume the sole `in_progress` task or select the first unblocked `ready` task when no scope was named.
6. Mark a selected queued task `in_progress` before implementation.
7. Implement the smallest complete vertical slice; the integrating agent owns task state and integration.
8. Run proportional checks and update an owning living document only when its durable contract changed.
9. Move review-required work to `review`. Otherwise complete its task when one exists; completion deletes it and clears remaining dependency references.
10. Continue only when broad implementation was requested and the next task is concrete and unblocked.

Stop only for missing secrets, unrequested destructive work, an unmockable unavailable service, or a product decision not covered by current contracts. Provider-smoke permission is in `agent_docs/CRITICAL_INVARIANTS.md`; dependency-security permission is in `agent_docs/SECURITY.md`.

## Human Review Policy

This is the sole authoritative trigger list. Human review is required for changes to:

- `agent_docs/CRITICAL_INVARIANTS.md`;
- credentials, secrets, password/token handling, cryptography, or another security/privacy boundary;
- admission policy, account-verification authority, session/cookie behavior, or identity linking;
- authorization, entitlements, ownership, tenancy, privacy disclosure, public sharing, retention, abuse/rate-limit policy, or security-relevant server error semantics;
- persistent schema/migrations, destructive data behavior, public API or stored-data compatibility, or release/publication safeguards;
- a user-visible product contract not already decided by current living documents; or
- completion supported only by unavailable verification.

Verified presentation-only auth UI work may remain review-optional: accessibility/focus, operation-specific recovery copy, or client error association/announcement. It must preserve server codes, privacy-neutral outcomes, session/admission/authorization behavior, and every other security contract; reclassify it before crossing a boundary above.

## Reading Map

Do not preload the whole harness. Start with `agent_docs/CRITICAL_INVARIANTS.md` for rules every change must preserve. Read `agent_docs/PRODUCT_PRINCIPLES.md` only when product direction or prioritization is part of the scope.

Then read only what the scope requires:

- Before changing a scoped directory, read the nearest `AGENTS.md`; Claude-compatible scopes import it through the adjacent `CLAUDE.md`.

- Read `agent_docs/AUTONOMOUS_WORKFLOW.md` only for broad selection, queued/task-state work, dependencies, multi-session work, or review-required changes. For queued work, also read `agent_docs/tasks/README.md` and the selected task. Named same-session review-optional work does not require the full workflow.
- When the operator left a product or implementation choice open, read `agent_docs/DECISION_DEFAULTS.md`.
- Before topology, module-boundary, data-boundary, or deployment-shape work, read `agent_docs/ARCHITECTURE.md`.
- `agent_docs/RUN_PIPELINE.md` before run-pipeline, Search, tool-loop, provider-run, or inspection work.
- `agent_docs/FRONTEND.md` before UI behavior, state, accessibility, or shell work; it routes to bounded frontend owners.
- `agent_docs/DESIGN_SYSTEM.md` additionally before visual composition, theme, geometry, density, or motion work.
- `agent_docs/BACKEND.md` before route, persistence, auth, upload, run, or server-side behavior work; it routes to bounded backend owners.
- `agent_docs/PROVIDER_API_NOTES.md` before provider work.
- `agent_docs/ENV_VARIABLES.md` before environment or configuration work.
- `agent_docs/SECURITY.md` before dependency or security work.
- Before changing behavior or tests, read the verification map, applicable lane, and test-authoring rules in `agent_docs/TESTING.md`; consult its boundary-specific evidence and opt-in commands only when the scope crosses that boundary.

## Contract Authority

- The operator's current request defines intended scope.
- `agent_docs/CRITICAL_INVARIANTS.md` defines non-negotiable safety and product-semantic boundaries unless the operator explicitly requests a reviewed contract change.
- Executable code, schemas, migrations, and tests plus the owning living document define current behavior.
- When executable behavior/tests and a living contract disagree, treat it as drift. Resolve a clear mismatch from the request, observable behavior, tests, and nearby owners, updating both sides; escalate only when two plausible readings change product semantics.
- A task may change a living contract only when its goal says so and the owner is updated in the same implementation.
- `PRODUCT_PRINCIPLES.md` and `DECISION_DEFAULTS.md` guide choices that current contracts leave open.

Do not reconstruct current behavior from old plans or Git history when code and living contracts answer it. History is for archaeology.

## Repository State

Inspect the normal worktree before making changes:

```bash
git status --short
```

If this is not a Git repository, record that in the final response and continue without Git synchronization. Preserve unrelated user changes.

## Repository Publication

`origin` is the public development/release repository. Open task instances are local ignored state and must never be staged, committed, included in Docker context/images, or added to a public ref. Older commits/tags are grandfathered archaeology and do not justify ref rewrites. Agents do not push, rewrite refs, or tag releases without an explicit request; release publication also requires fresh readiness and privacy checks.

For repository sharing, export an inspected commit/tree with `git archive`; never archive the working directory, where ignored/untracked files remain. Use a fresh output path. Attach local tasks separately only after manual review.

## Working Rules

- Prefer the smallest change that leaves the app runnable or clearly verifiable.
- Use existing code and current local contracts before inventing scope or another abstraction.
- Use the fast hermetic lane for deterministic static/unit work and `docker-compose.dev.yml` only for required container parity or integration. Never run destructive development or test workflows against the default persistent installation.
- Keep one task file as the specification, execution plan, progress log, and task-local decision log. Do not create a second plan document for the same work.
- Keep only local unfinished tasks in `agent_docs/tasks/`. Do not force-add them or create completion journals or decision-history directories.
- Update the owning living document only when the change modifies a durable product contract, invariant, architecture/data boundary, configuration/environment contract, operator workflow, security boundary, or verification policy. A bug fix or implementation change that restores or preserves an already documented contract does not require a documentation edit.

## Before Final Response

In a Git checkout, complete this task-owned review before reporting completion:

1. Re-run `git status --short` and compare it with the initial state.
2. Run `git diff --check` and `git diff --cached --check`.
3. Inspect the complete `HEAD` diff for every task-owned tracked path, including staged changes. Inspect each new untracked task-owned file in full because Git diff omits it.
4. Verify that the task introduced no unrelated changes, secret/private values, build/log/cache artifacts, accidental generated-file drift, or contract/documentation changes not justified by the task.
5. Preserve pre-existing user changes and distinguish them from task-owned edits in the final report.

For documentation-only changes:

```bash
npm run docs:check
```

For application code changes, run the checks routed by `agent_docs/TESTING.md`. Report exact checks run, checks not run with reasons, material decisions, and any remaining blocker or human-review request.

# ADR 0015: Local Development Harness Is Lean And Destructive

Status: Accepted
Amends: 0003-autonomous-agent-delivery, 0012-crash-recoverable-verification-resources, 0013-parallel-browser-verification-namespaces, 0014-provenance-bound-local-pollution-cleanup

## Context

The local harness grew into a CI/recovery system larger than the application changes it protected. Routine tasks spent most of their time on disposable namespaces, crash recovery, pollution proofs, receipts, galleries, remote-CI semantics, and hundreds of governance tests. The repository has no required remote CI/runner workflow, and the operator explicitly accepts losing only disposable development data.

## Decision

Keep only proportional local development machinery:

- explicit `docker-compose.dev.yml` is the disposable development isolation boundary; default Compose remains the persistent installation;
- focused tests run while implementing, followed by one `check` near completion;
- Playwright is one explicit destructive local command using deterministic auth and Fake QSA;
- task state uses small Markdown `new`, `promote`, and `complete` commands with one integrating writer;
- `docs:check` performs compact link/task/environment sanity checks;
- real provider smokes, migrations, retention, production build/deployment, backups, and security hardening remain task-specific capabilities.

Remove verification tiers, isolated schemas/buckets/apps, crash recovery, pollution backup/cleanup, parallel browser/worktree coordination, receipts, generated FILEMAP, screenshot galleries, local GitLab CI, commit-title enforcement, duplicated API manifests, and custom dependency scanners.

Production test auth remains denied. The local-data-loss decision never applies to production or an operator-designated persistent target.

## Consequences

- Routine tasks spend time on implementation and relevant application tests rather than repository governance.
- Local checks/E2E may reset or pollute the shared development database and bucket; interrupted runs may leave state or containers.
- Concurrent checks and parallel worktrees are unsupported. Manual recovery is `docker compose -f docker-compose.dev.yml down --remove-orphans`; a full disposable reset is `docker compose -f docker-compose.dev.yml down -v`.
- Material UI changes use focused browser tests and direct visual inspection instead of an exhaustive gallery.
- Production readiness depends on explicit quotas, observability, migrations/bootstrap, backup/restore, security, deployment, and load tasks—not on a simulated local release pipeline.
- ADRs 0012, 0013, and 0014 are fully superseded and retained only as historical decisions.

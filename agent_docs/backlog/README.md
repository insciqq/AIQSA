# BACKLOG

This directory contains reviewed-later product, correctness, and production work for the self-hosted 50+ user target. Each Markdown file owns its goal, dependencies, acceptance criteria, and focused checks; this README does not duplicate the full queue.

The public snapshot intentionally starts with no backlog records. New task
files are local by default through `.gitignore`; publish one explicitly only
when it is intended to be a shared roadmap item.

Before implementation, review/split the task, replace stale commands or assumptions, then run:

```bash
npm run task:promote -- <task>
```

The lean harness assumes one integrating writer, a fast hermetic lane, disposable Compose parity only when the boundary needs it, and task-specific E2E/production/security proof. Do not add local CI, receipts, namespace recovery, screenshot galleries, or claim/lease machinery back into a product task.

Completed task notes remain in the local ignored `agent_docs/done_tasks/` journal and are never force-added to the repository.

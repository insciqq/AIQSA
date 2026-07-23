# ADR 0014: Local Pollution Cleanup Is Provenance-Bound And Restore-Gated

Status: Superseded
Amends: 0003-autonomous-agent-delivery, 0012-crash-recoverable-verification-resources

Superseded by: 0015-lean-local-development-harness

## Context

Historical local tests predate invocation-isolated verification and may have left chats, sessions, attachments, or other rows in the long-lived development schema. Titles, emails, timestamps, archival state, reserved-looking ids, and other heuristics are not ownership proof: the same shapes can belong to an operator or another user. A database-only backup is also insufficient because attachments have private object bytes in MinIO.

## Decision

The aggregate local-pollution report remains read-only. It captures the exact checked-in local Compose target, hashes a stable PostgreSQL dump and complete MinIO inventory, projects private database state without logging content or identities, and writes a canonical private plan below ignored `.aiqsa/backups`. Candidates have only three classifications: safe, ambiguous, or unrelated. A safe graph must close over exact foreign-key, catalog, attachment, and object relationships from a persisted token-derived provenance artifact bound to the same target. Reserved fixture shapes and all heuristic signals remain ambiguous without that artifact; the bootstrap operator and protected seed graph are always ambiguous.

Before review, the operator creates a permission-restricted coordinated Postgres/MinIO backup. Publication requires stable before/after fingerprints, exact file checksums, canonical object metadata, directories mode 0700, and files mode 0600. Restore never targets the long-lived source. It runs through the ADR 0012 recovery owner into a one-off Postgres data directory on tmpfs plus an owned disposable schema/bucket, rechecks the logical dump and object bytes/metadata, runs migration, seed, and integrity smokes, and publishes a receipt only after owned cleanup and the public-schema canary succeed.

Dry-run validates the exact plan, provenance, manifest files, restore receipt, source fingerprint, target, and selected safe candidate ids without writing. Review persists only those bindings and the hash of a fresh 15-minute confirmation token. Execute recaptures the exact local target and source twice, atomically consumes the one-use token, then locks every product table in a serializable transaction. Under those locks it reloads and reclassifies the graph, rebuilds the exact plan, deletes only the selected derived user/group roots, and compares the complete persisted value of every non-selected database row before commit. Exclusive fixture objects are removed only after the database commit, only while their bytes/metadata and every preserved object remain unchanged. Ambiguous candidates, caller-selected targets, remote Docker contexts, source drift, stale/replayed tokens, missing restore proof, checksum failure, or any cross-boundary reference fail closed.

The release gate performs the full sequence on generated fixture data in crash-recoverable disposable resources. It proves backup/restore graph and object parity, transactional safe deletion, an unchanged seeded operator canary and unrelated object, cleanup of every owned resource, and an unchanged long-lived `public` schema. Verification never executes cleanup against the current operator schema.

## Consequences

- Old operator data can be measured without converting suggestive names into deletion authority.
- Cleanup is intentionally multi-step and local-only; backup, restore, review, and confirmation are required friction for a destructive maintenance action.
- Private artifacts contain sensitive multi-user data and stay ignored, permission-restricted, out of images/logs, and outside commits.
- A database commit followed by object-cleanup failure can leave recoverable orphan bytes, but cannot delete unrelated bytes or roll back by mutating operator data automatically.
- Routine tests continue to use fresh ADR 0012/0013 namespaces; this workflow is for historical diagnosis and explicit maintenance, not test teardown.

## Supersession

ADR 0015 removes local-pollution diagnosis, backup, restore, review, and cleanup tooling. Local development data is now explicitly disposable; production backup/restore remains separate backlog scope.

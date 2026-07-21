# ADR 0012: Verification Resources Are Journaled And Crash-Recoverable

Status: Superseded
Amends: 0003-autonomous-agent-delivery

Superseded by: 0015-lean-local-development-harness

## Context

Repository verification creates temporary PostgreSQL schemas, MinIO buckets, and one-off Compose containers. Normal `finally` cleanup cannot run after SIGKILL, host loss, or a crash between a remote mutation and its local state update. Prefix-based reaping would make operator data vulnerable to stale documentation, collisions, or caller-selected names.

## Decision

Every disposable verification run receives a 256-bit token and token-derived schema, bucket, container, and run identities. Before remote creation, the host fsyncs a private canonical journal containing the raw token, Linux process identity, and exact local Docker/Compose/PostgreSQL/MinIO target hashes. PostgreSQL comments, a private MinIO marker object, and one-off-container labels carry only the token hash and secret-derived binding. Creation requires process-local proof of the exact persisted journal plus the exact provisioning state for either schema or bucket publication. The runner forces the app to the internal MinIO endpoint and starts the owned app container without dependency side effects. PostgreSQL create/probe/drop share an advisory transaction fence and bounded server timeouts below the host timeout.

Normal completion and SIGINT/SIGTERM use the same idempotent container-then-bucket-then-schema cleanup. SIGKILL leaves the journal for an explicit recovery command. Inventory is dry-run and read-only. Destructive recovery requires a dead or reused Linux owner, at least 120 seconds of age, a freshly recaptured local target, matching remote markers, exact protected-resource exclusions, and a single-record execute lock. A stale lock requires its printed exact token; accepted takeover atomically revokes the immutable old generation and advances to a deterministic no-replace successor. Historical lock/tombstone links remain private and permanent so concurrent takers cannot remove a newer owner; missing or orphaned links fail closed. An unmarked bucket is removed only in the persisted unknown state that represents death between a remote create/remove and the next journal publication while the independent schema marker still matches. A bucket recorded `unowned` is never adopted or removed while present.

The cumulative full gate runs a real Compose smoke that kills owners immediately after journal publication, after schema creation, bucket creation, bucket removal, schema removal, and while an owned app container is running. It proves dry-run non-mutation, one-pass and repeated recovery, and unchanged long-lived public/protected-bucket canaries, including an initially absent protected bucket.

## Consequences

- Interrupted checks leave recoverable evidence instead of indefinite unowned resources.
- Names and prefixes remain routing hints, never deletion authority.
- Recovery intentionally fails closed on live/young/foreign/unverified targets, marker mismatch, known unowned buckets, and protected resources.
- Local `.aiqsa` recovery state is sensitive ignored runtime data and must not enter Git, images, caches, or logs.
- Full verification spends additional time on real crash evidence; fast verification retains normal-path cleanup only.

## Supersession

ADR 0015 removes this machinery. The record remains as history, but no current command or workflow implements its recovery contract.

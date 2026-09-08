# CRITICAL_INVARIANTS

Mandatory safety read. [INDEX](INDEX.md) routes the narrower owners; executable artifacts define exact state machines and wire shapes.

## Data And Authority

- Configuration changes affect future messages only. Accepted runs retain their exact execution bindings, identity, outputs, and recovery evidence except through an owned lifecycle transition. Chat edits branch the message DAG; regeneration uses the run pipeline. Terminal persistence has one guarded winner.
- Resolve controls from the current user's server-filtered catalog and revalidate before admission and external dispatch. A browser, model, tool result, or stored reference cannot grant entitlement, substitute an unavailable target, or mint mutation authority.
- Authenticate and authorize private resources at the operation boundary. Admin status does not grant access to private Assistants or Knowledge. Invisible and nonexistent resources share privacy-neutral responses.
- Project authority is scoped to that Project and its current roles; each Project retains a direct active Owner. Project runs use delegated/shared resources, never personal credentials, Memory, history, unpublished Skills, OAuth identity, or personal MCP values. Membership alone does not add resources to personal catalogs.
- Assistant publication grants live future use, not dependency entitlements. Accepted runs keep their definition and name/avatar snapshot. Ordinary chat uses the server-owned baseline; the browser cannot replace it.
- Knowledge Sources, Versions, ready artifacts, and accepted evidence retain their identities. Membership removal, replacement, and reprocessing affect future snapshots. Search rechecks scope and exact authorized processing/embedding/reranking destinations before I/O. Citations require proof that persisted evidence reached synthesis. [Run contracts](RUN_CONTRACTS.md) and [Persistence](PERSISTENCE.md) own the details.
- Personal Memory mutations require exact current-owner authority: direct current-user evidence or a facts-only command through an active owner-bound inbound MCP OAuth grant. Optional retrieval signals may degrade, but cannot weaken ownership, lifecycle, deletion, safety, or Project/temporary-chat fences. Derived indexes never replace PostgreSQL authority. [Memory](MEMORY.md) owns redaction, admission, and learning rules.

## Privacy And External Effects

- Validate and bound untrusted route, provider, tool, and file input before mutation or external I/O. Provider/storage SDKs and secrets stay server-side. Uploads require server-owned type/content, size, ownership, and storage-settlement checks.
- Attachments and Knowledge originals, text, queries, evidence, and internal identifiers remain private. Expose only deliberately reviewed authenticated projections. Repository objects and raw request/tool/event histories are not browser contracts.
- Anonymous shares are sanitized immutable snapshots, never live private chat access. Reads remain repository-authorized and non-cacheable. The bearer token and expiry/revocation authorize access; crawler directives do not.
- Never put secrets, credentials, bearer tokens, or private operator notes in public Git, application/access logs, previews, analytics, or shares. [Security](SECURITY.md) owns content-free logging and the narrow exceptional Nginx error-diagnostic rule. Persist raw bodies only when an execution, recovery, safety, or accounting consumer requires them; inspection alone is insufficient.
- Usage and cost derive from persisted provider-reported accounting, never text length or placeholder prices. Recovery must not repeat settled or crash-ambiguous external side effects.

## Repository And Verification

- Never reset, migrate, seed, prune, or pollute the persistent installation or operator data during development/testing. Stateful checks use explicitly acknowledged disposable targets and clean only their own resources.
- Private PRDs, queued/parked/archived task instances, and `.aiqsa/` local state never enter public refs, release trees, or images. Never automatically prune or overwrite task archives. Root [AGENTS](../AGENTS.md) owns publication and final-review rules.
- Fake providers are the default. Real smokes require current operator-provided credentials, minimal bounded calls, sanitized evidence, and the exact permission in [Testing](TESTING.md). Dependency-security authority belongs to [Security](SECURITY.md); audit suggestions do not authorize destructive or breaking fixes.

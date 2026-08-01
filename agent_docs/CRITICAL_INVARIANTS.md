# CRITICAL_INVARIANTS

Owner: Safety and durable product semantics
Scope: Rules whose violation can cause data loss, security/privacy exposure, incompatible persisted state, destructive verification, or a key QSA semantic change.
Verified against: 4f51fdd (2026-08-01)

This is the mandatory short safety read. Product direction belongs in `PRODUCT_PRINCIPLES.md`; current implementation contracts belong in the routed backend/frontend documents; visual geometry belongs in `DESIGN_SYSTEM.md`. Rationale that must survive a task belongs beside the current rule in its owning document.

## Data And Product Semantics

1. Provider, model, prompt, Search, and parameter changes affect future messages only; accepted historical turns and runs are immutable evidence.
2. A chat is a message DAG. Existing content with descendants is not edited in place, edits create branches, regeneration creates a sibling assistant through the run pipeline, and the visible branch derives from `activeLeafMessageId`.
3. Assistant runs have explicit `queued`, `streaming`, `complete`, `cancelled`, or `error` state. Completion, cancellation, and recovered failure settle through guarded persistence so only one terminal writer wins.
4. Usage and cost derive from persisted provider usage evidence, never UI text length or placeholder prices. Model-run APIs retain the normalized request, redacted provider preview, events, final preview, and usage under the approved privacy contract.
5. Search is an explicit backend-catalog strategy. Provider/model/Search choices come from the current user's backend-filtered catalog; the browser cannot grant entitlement or silently substitute a different unavailable target.
6. Native OpenAI uses Responses API with explicit background/recovery/cancellation semantics. First-class Gemini uses native stateless Interactions v1 only and never falls back to a compatible transport. Administrator-managed compatible endpoints declare their protocol; the simple Custom path is Chat Completions.
7. Stored theme ids remain decodable, and theme selection remains local presentation state; it cannot mutate account, chat, run, share, or cross-device server state.
8. `Share (anonymously)` creates a sanitized immutable snapshot, never access to live private chat state. Success and unavailable responses are dynamically repository-authorized and non-cacheable; the high-entropy bearer token plus expiry/revocation is authorization, while crawler directives are only defense in depth.
9. Uploads and attachments remain private. Public snapshots, logs, events, and previews cannot expose attachment URLs, ids, filenames, bytes, extracted text, or storage keys outside their explicitly approved boundary.
10. After a native Gemini Google Search call, grounded answer text, Search Suggestions, citation Links, results, and signatures are live-only. Durable state keeps only provenance, usage/status, and a neutral placeholder; replay and anonymous sharing cannot recover them.

## Security And Server Boundaries

1. Provider SDK/API calls stay behind server adapters. Untrusted route, provider, tool, and file input is validated and bounded before storage mutation or external I/O.
2. Private resources require server-side authentication, ownership, and entitlement checks at the operation boundary even when the browser already filtered the catalog.
3. Raw user/provider request or response bodies are not ordinary logs and are not durably persisted unless a narrower reviewed contract explicitly allows a redacted projection.
4. Upload handling validates size, extension/type, magic bytes or text shape, processing bounds, ownership, and storage settlement server-side.
5. Share snapshots strip raw provider payloads, private attachment data, secrets, internal run ids, and private user/group metadata.
6. Provider entitlement and credential selection are independent. Credential precedence is direct user, then one unambiguous active-group assignment, then an allowed default; an unusable selected tier fails closed without fallback.
7. Every bootstrapped or adopted installation has exactly one lifecycle-immutable built-in `full_access` group. Its explicit members inherit current/future provider, model, Search, and MCP entitlement, but never provider credential choice or MCP personal secrets. Reserved-name legacy groups are preserved under collision-safe custom names, not promoted.
8. Gemini execution fails closed unless the family/adapter pair is exactly `gemini` plus `gemini_interactions_native`. A grounding marker atomically purges and fences durable provider content before any live grounded output; validated non-empty Suggestions precede released grounded answer tokens.
9. Compatible no-auth is an explicit tested private/local configuration with a null envelope and per-request non-revoked-version guard. Missing legacy mode remains bearer; empty/sentinel credentials and implicit keyless fallback are forbidden.
10. A provider model is an answer choice only when its active immutable configuration is answer-selectable. A technical-only model is excluded from answer catalogs, grants, profiles, and answer admission even under Full access, while typed Search may resolve it through its separate authority.
11. Client Search is query-only minimum disclosure: one validated bounded query plus server-owned policy/correlation fields, never answer context or attachment data. Until separately informed per-run consent exists, attachments and client Search are mutually exclusive; provider-hosted Search inside the chosen answer provider is unaffected.
12. Authentication limits are atomic durable PostgreSQL state keyed only by installation-secret HMAC identifiers. Account/token protection does not depend on client IP; a client-only bucket requires an exact validated chain from the configured overwriting proxy, and missing identity never becomes a shared sentinel.
13. Secrets, credential envelopes, password/database URLs, OAuth material, bearer tokens, and private operator notes never enter source control, ordinary logs, client contracts, previews, events, analytics, or public shares.

## Repository And Verification Safety

1. Never run destructive development, test, migration, prune, or browser workflows against the default persistent installation or an operator-designated data set. Only the explicit disposable development topology may be reset or polluted.
2. Completed task files are deleted rather than archived. Shared evidence belongs in ordinary commits, tests, living documents, and release notes; unfinished work belongs only in `agent_docs/tasks/`.
3. Real provider smokes are allowed only with current operator-provided keys, the smallest scoped context/output, sanitized evidence, and the provider-specific permission in `TESTING.md`; deterministic fakes remain the default.
4. External dependency-security checks follow `SECURITY.md`; do not apply breaking or destructive remediation merely because an automated command proposes it.
5. Large-document verification markers are manual review claims. Checks may report a missing or stale owner/scope/commit/date marker but must never refresh one automatically.

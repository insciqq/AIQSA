# CRITICAL_INVARIANTS

Owner: Safety and durable product semantics
Scope: Cross-cutting rules whose violation can cause data loss, security/privacy exposure, incompatible persisted state, destructive verification, or a key run semantic change.

This is the mandatory short safety read. Scoped contracts retain the same normative force and are routed below; product direction belongs in `PRODUCT_PRINCIPLES.md`, current implementation details in the bounded backend/frontend owners, and visual geometry in the owners routed by `DESIGN_SYSTEM.md`.

## Data And Product Semantics

1. Provider, model, prompt, Search, and parameter changes affect future messages only. Accepted historical turns, runs, bindings, and evidence are immutable.
2. A chat is a message DAG. Existing content with descendants is not edited in place, edits create branches, regeneration creates a sibling assistant through the run pipeline, and the visible branch derives from `activeLeafMessageId`.
3. Assistant messages use `queued`, `streaming`, `complete`, `cancelled`, or `error`; model runs additionally use `in_progress`. Completion, cancellation, and recovered failure use guarded persistence so only one terminal writer wins.
4. Usage and cost derive from persisted provider usage evidence, never UI text length or placeholder prices. Inspection may retain normalized requests, redacted provider previews, events, final previews, and usage only within the approved privacy contract.
5. Provider, model, prompt, Search, and run controls are resolved from the current user's server-filtered catalog and revalidated at admission. The browser cannot grant entitlement, select hidden configuration, or silently substitute an unavailable target.
6. `Share (anonymously)` creates a sanitized immutable snapshot, never access to live private chat state. Each read is dynamically repository-authorized and non-cacheable; its high-entropy bearer token plus expiry/revocation is authorization, while crawler directives are defense in depth.
7. Uploads and attachments remain private. Logs, events, previews, and public snapshots cannot expose attachment URLs, ids, filenames, bytes, extracted text, or storage keys outside an explicitly reviewed boundary.
8. An Assistant is a declarative execution profile with append-only immutable revisions. Assistant runs resolve the currently authorized revision server-side, record the exact `assistantId`/`assistantRevisionId` with the accepted run, and never trust a client-expanded copy of the governed controls. Publication pins exact revisions, grants no provider/model/Search/MCP entitlement, and admin status grants no access to private Assistants; invisible and nonexistent Assistants share one privacy-neutral response, and unavailable saved dependencies fail closed without substitution. Ordinary no-Assistant runs receive the code-owned standard-chat baseline rendered server-side with recorded time-zone evidence; the browser cannot replace it.
9. Knowledge Bases are private retrieval resources. Base/document names, originals, normalized text, chunks, vectors, and retrieval citations/receipts remain private; admin status grants no access to a private base, and invisible and nonexistent bases share one response. Publication authorizes live future use while accepted bindings retain the exact content revision and vector generation. Public shares strip every structured Knowledge artifact while preserving the generated answer text. Indexing egress is limited to the exact configured embedding destination disclosed at base creation or reindex.

## Security And Server Boundaries

1. Provider SDK/API calls stay behind server adapters. Untrusted route, provider, tool, and file input is authenticated where required, validated, and bounded before storage mutation or external I/O.
2. Private resources require server-side authentication, ownership, and entitlement checks at the operation boundary even when the browser already filtered their projection.
3. Raw user/provider request or response bodies are not ordinary logs and are not durably persisted unless a narrower reviewed contract explicitly allows a redacted projection.
4. Upload handling validates size, extension/type, magic bytes or text shape, processing bounds, ownership, and storage settlement server-side.
5. Public snapshots strip raw provider payloads, private attachment data, secrets, internal run ids, and private user/group metadata.
6. Secrets, credential envelopes, password/database URLs, OAuth material, bearer tokens, and private operator notes never enter source control, ordinary logs, client contracts, previews, events, analytics, or public shares.

## Repository And Verification Safety

1. Never run destructive development, test, migration, prune, or browser workflows against the default persistent installation or an operator-designated data set. Only the explicit disposable development topology may be reset or polluted.
2. Completion moves task files from `agent_docs/tasks/` to the ignored local `agent_docs/task_archive/`. Archive size never blocks validation or completion, and the harness never prunes, rotates, or overwrites archived tasks automatically. Cleanup happens only on an explicit operator request. Open and archived task instances must never be forced into public Git, release source trees, or images.
3. Real-provider smokes require current operator-provided keys, the smallest scoped context/output, sanitized evidence, and the provider-specific permission in `TESTING.md`; deterministic fakes remain the default.
4. External dependency-security checks follow `SECURITY.md`; do not apply breaking or destructive remediation merely because an automated command proposes it.

## Scoped Contract Routing

- Exact provider transport selection, credential resolution, compatible no-auth, answer eligibility, client Search disclosure, and Gemini grounding behavior are routed through [provider adapters](backend/PROVIDER_ADAPTERS.md), [provider API notes](PROVIDER_API_NOTES.md), [the run pipeline](RUN_PIPELINE.md), and [security](SECURITY.md).
- Authentication admission and proxy identity are routed through [API and auth](backend/API_AND_AUTH.md) and [security](SECURITY.md); built-in `full_access` lifecycle and entitlement persistence live in [persistence and retention](backend/PERSISTENCE_AND_RETENTION.md).
- Theme persistence and client/server presentation-state ownership live in [frontend implementation state](frontend/IMPLEMENTATION_STATE.md).

# SECURITY — UPLOADS AND PROVIDER TRUST

Owner: Security and privacy maintainers
Scope: Private upload storage/processing and untrusted provider catalog, transport, Search, and input boundaries.
Read when: Changing uploads, attachments, object storage, extraction, provider discovery, catalogs, provider transport/Search evidence, or provider-controlled input.
Code owners: `lib/server/uploads/`, `lib/server/parsing/`, object-storage integration, `lib/server/providers/`, `lib/server/search/`, and provider catalog/discovery owners.
Not owned here: HTTP authentication, MCP runtime trust, Compose exposure, or dependency policy.

## Upload Storage And Processing

Upload security is server-owned: authenticate before acquiring a process-local non-queueing permit, bound the complete multipart envelope before parsing, derive accepted kind from extension/MIME/magic validation rather than client `File.type`, reject SVG, and enforce processing bounds. Default uploads are full-buffered under a 25,000,000-byte file limit plus 1 MiB multipart headroom with four concurrent upload processors per application process. PDF.js runs in a terminable worker with V8 limits of 256 MiB old generation, 64 MiB young generation, and an 8 MiB stack; it validates the 500-page ceiling before extraction, processes pages sequentially for at most 20 seconds, and stops after proving that the bounded 20,000-character result is partial. Worker messages and persisted derived text contain only that bounded result. V8 resource limits do not completely bound native/PDF.js memory, so the request, page, time, incremental-text, and parent-message boundaries remain authoritative. Parser diagnostics, raw errors, filenames, bytes, and extracted text do not escape through worker output or client errors. Later run materialization independently preflights unique count plus source/encoded bytes, streams at most the configured number of private objects concurrently, caps each accepted object at both its settled metadata size and the remaining per-run source budget, aborts sibling reads on failure/cancellation, and never exposes object identity or content in its stable limit errors. Metadata is only the early boundary: filesystem and S3 adapters may read at most one sentinel byte beyond the accepted cap to prove overflow, then reject every actual-versus-settled size mismatch; arbitrary storage failures normalize before response or recovery persistence so paths, keys, and raw adapter errors remain private. Exposed deployments use a 2 MiB ordinary proxy limit, an explicit larger upload location, and an HTTP-context per-client connection zone; application enforcement remains authoritative.

The optional structure-aware parser boundary validates the closed
extension/MIME route before transport, bounds raw request bytes, deadlines,
streamed response bytes, normalized block count, and table geometry, then
accepts only the reviewed Docling or Tika response shape. In the supported
Compose topology, original bytes leave the app only for digest-pinned stateless
siblings on the internal `parser-control` network; neither parser has a host
port, object/database credentials, durable volume, or document ownership.
Embedded Tika resources are disabled. Normalized results carry ordered text,
page anchors, heading paths, and table flags; upstream bodies, diagnostics,
filenames, and extracted content never enter parser errors or probe output.
Absent, stopped, timed-out, or malformed sidecars produce only stable
feature-local codes and cannot affect core readiness. An operator who supplies
an endpoint outside Compose becomes responsible for that endpoint's transport
and data-processing trust boundary.

Storage remains private. MinIO has no anonymous access, filesystem fallback is server-only, provider payloads resolve objects only after ownership/capability checks, and previews redact original bytes. Attachment-processing workers re-read only the claimed row's bounded private object, require its settled size/checksum, send it only to configured parser boundaries, and persist only normalized extraction evidence or a bounded stable error code. Status/retry routes reauthorize the owner and never project storage keys, checksums, parser bodies, or raw failures. Newly created public snapshots replace image/file/PDF/document blocks with neutral omission text and include no filename, alt text, attachment id, storage key, URL, or object metadata; already-stored immutable snapshots are not rewritten. UUID-bearing keys prevent a later upload from reusing deletion work. Message deletion only detaches rows; retention locks and rechecks every same-key row, atomically removes the final orphan rows with one durable deletion job, and claims that job through a bounded lease. Run linking uses the opposite ready/unattached-row compare-and-set, so prune/run races cannot delete a provider-bound object. Object deletion and retry summaries expose stable job ids/codes only, never private keys, filenames, content, or raw storage errors.

Repository-local `.aiqsa/` state is excluded from Git and Docker build context because it may contain user objects or other private runtime data. Do not copy it into images or caches.

## Knowledge Indexing Egress

Knowledge originals and normalized text are private objects; relational rows retain only bounded metadata, chunks, vectors, and lifecycle/evidence state. Knowledge parsing is quality-fail-closed: a sidecar-routed format uses only its first code-owned parser and never falls through to Tika or local attachment extraction after that parser is unavailable or rejects the document. Indexing may send bounded normalized document text to the base's exact configured embedding connection/model outside a chat run. It never sends storage keys, object credentials, unrelated base content, or another user's documents, and provider failures expose only stable codes. Creation and reindex UX must render this disclosure with the resolved destination: **“Indexing sends this base’s document text to {connection} / {model} for embedding. This happens outside chat runs and repeats when the base is reindexed.”** The server revalidates the owner's entitlement and exact vector-space pin before each admitted indexing operation; browser selection is not egress authority.

Open and archived task instances are local ignored state and are excluded from Git and Docker; `agent_docs/tasks/README.md` owns task guidance and `scripts/task-ledger.mjs new` is the sole executable scaffold source. Release privacy checks the selected tree and post-policy history so a task committed and later removed still blocks publication. Rewriting established public refs is not routine task-cleanup remediation. Docker build context also excludes `agent_docs/` plus every scoped `AGENTS.md` and `CLAUDE.md`; these files have no build-time or runtime authority. Release publication requires the official public GitHub `origin`, while ref rewrites, force pushes, and release tags require explicit operator authorization and fresh target/ref inspection.

## Provider Catalog Trust

Authenticated provider model catalogs are untrusted availability evidence, not executable configuration authority. Quick setup normalizes only the provider-specific identifier wrapper and intersects the bounded response with the current versioned code-owned candidate set. It never persists an arbitrary returned model id, guesses capabilities from its name, or treats image, audio, embedding, media, or unknown rows as chat deployments. Every candidate is canonical-preflighted before a multi-model transaction writes any connection, credential, model, check, or grant; a collision or changed fence fails without partial adoption. Provider credentials remain write-only and catalog failures expose only stable value-free errors.

### Provider input and Search

Automatic chat titles are derived locally; only the explicitly admitted run may
send message content to a provider. [Core pipeline](../run_pipeline/CORE_PIPELINE.md)
owns title derivation and run input.

Provider JSON, SSE, and HTTP errors remain untrusted through bounded
consumption. Safety failure cancels upstream and may expose only the normalized
partial answer/evidence and value-free local projection accepted before the
failure. Bodies, credentials, reasoning, citations, tool payloads, arbitrary
URLs, and hidden routing never become error text or ordinary catalog data;
[transport and limits](../backend/providers/TRANSPORT_AND_LIMITS.md) owns exact
deadlines, byte budgets, terminal handling, and codes.

Provider Search becomes durable or browser-visible only through the bounded
normalized findings, safe citation, allowlisted operation, usage, and preview
projection selected by its adapter and revalidated by common execution. Client
Search is a query-only disclosure boundary with no representation for the
answer transcript, prompts, or resolved attachments; endpoint, technical
binding, and credential authority remain server-only. [Search plans](../run_pipeline/SEARCH_PLANS.md)
owns product disclosure/admission semantics and [provider-neutral client Search](../backend/providers/CLIENT_SEARCH.md)
owns request/result mapping.

Custom compatible roots remain an SSRF boundary even for an administrator. URL
userinfo, query, fragment, and unsafe schemes fail before I/O; public roots
require HTTPS and bearer authentication. Private/local HTTP requires the exact
network opt-in and retains resolution pinning plus redirect validation.
Explicit no-auth is recorded in both connection configuration and immutable
tested-version evidence, uses a null envelope rather than an empty secret,
emits no Authorization header, and still performs the locked non-revoked
credential-version guard on every request. A legacy missing mode remains
bearer; empty/sentinel credentials, a null bearer envelope, and implicit
keyless fallbacks fail closed. [Provider admission](../backend/providers/ADMISSION_AND_BINDINGS.md)
owns the configuration and binding transitions that consume this policy.

Hosted Gemini Suggestions are untrusted markup and must pass the closed
server/browser structural allowlists before live rendering. Provider markup,
signatures, raw steps, grounded answer text, and citation links never cross the
durable/share boundary; query-only use retains only its normalized evidence.
[Gemini runtime](../backend/providers/GEMINI.md) and [Search plans](../run_pipeline/SEARCH_PLANS.md)
own live-only and query-only execution semantics.

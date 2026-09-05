# BACKEND

Owner: Backend maintainers
Scope: Durable HTTP/API, service-boundary, upload, and control-plane principles.

## API Boundary

`app/api/**/route.ts` is the exact route and method inventory. Route entries authenticate, bound and decode input, call a server owner, and serialize an explicit client-safe result. They do not expose repository objects, Prisma rows, secrets, provider payloads, or private recovery state.

All private operations recheck authentication, ownership, entitlement, and lifecycle at the operation boundary. Browser filtering is presentation, not authority. State-changing browser requests pass the shared same-origin and bounded-body boundary. Stable error codes and privacy-neutral unavailable responses replace raw exceptions and existence leaks.

Authenticated Project SSE uses the same cookie/session boundary and reauthorizes membership while delivering current client-safe projections. An event cursor orders retained invalidations but grants no authority; stale history requires canonical resync, and final access loss closes delivery without disclosing whether later Project state exists. Client-to-server Project changes remain ordinary bounded HTTP mutations.

Skill collection responses are metadata-only. Full Skill instructions cross the browser boundary only through an individually authorized detail response, while search and pagination remain server-side so library discovery does not disclose or eagerly transfer instruction bodies.

Keep route handlers thin. Domain rules belong in `lib/domain/`, client-safe wire contracts in `lib/contracts/`, and server policy, repositories, adapters, and orchestration in `lib/server/`. Server modules may depend inward; browser code never imports Prisma, secrets, storage, or provider transports.

## Control Planes

Configuration writes use optimistic versions; activation may create immutable revisions. Accepted runs bind exact non-secret configuration and credentials, so later configuration affects future work only. Provider, Search, Knowledge, Assistant, MCP, team, and policy APIs validate complete transitions transactionally and never silently clamp, substitute, or partially apply a multi-resource change. Assistant group/installation edits must preserve direct Skill audience coverage. Project Assistant publication or explicit manager refresh adds its complete eligible dependency plan atomically. Later Assistant edits never expand or remove Project grants: missing dependencies make it unavailable until an authorized refresh, and content-free invalidation prompts clients to refetch. Project unlink/unpublish atomically clears affected defaults, chat plans, and dependent Assistant authorities and returns a safe consequence summary.

Authentication keeps one identity/session transition owner. Password, OAuth, invite, verification, reset, bootstrap, and administrator actions retain generic enumeration-safe public outcomes and transactional one-winner token/session changes. [Security](SECURITY.md) owns the threat model.

The Personal Memory MCP is an inbound same-installation resource, not part of the administrator-managed outbound MCP control plane. Its OAuth grant resolves one current active AIQSA account at every call; that identity is the sole Memory owner and no client-supplied tenant or user selector is accepted. The first version exposes only canonical personal Memory facts and creates no Chat, Message, ModelRun, `MemoryRetrievalAttempt`, or outbound MCP state; governed query-embedding and reranker executions use their content-free inbound-request owner.

Installation answer recommendations and purpose-specific System Model assignments are independent and never grant entitlement. Every role resolves only its configured deployment and installation credential; absence or invalidity fails that stage closed without substitution. Consolidated administration preserves each domain's state owner: Memory utility bindings are future-only, Knowledge document and embedding changes atomically activate an immutable profile with explicit reprocessing/reindexing, and owner-scoped Personal Memory embeddings retain their existing entitlement and generation contract.

## Files, Jobs, And Shares

Authenticate before consuming uploads. Validate complete multipart size, extension/MIME/content shape, parser bounds, ownership, and settled private-object metadata before a file becomes usable. Expensive processing is represented by durable claimed work; a request does not own a long-running in-memory queue.

A settled Knowledge upload reports the state of the exact ingestion artifact created for that upload, independent of a current ready artifact or later background reindexing for another Profile. Reused content is an immediate terminal upload result. Historical upload rows without an artifact binding resolve the earliest deterministically ordered artifact of their exact Source Version; they never select by most-recent update time.

Attachment and Knowledge objects remain private. Reads occur only after current ownership/capability checks, and client errors omit filenames, storage keys, checksums, bytes, extracted text, parser bodies, and adapter failures. Retention and deletion use idempotent durable obligations rather than best-effort request cleanup.

Workspace upload admission is a distinct chat-scoped purpose. It may retain an otherwise opaque format only while installation and runtime capability are available; only a workspace-enabled admitted run can later bind that object to sandbox execution. Known formats keep their ordinary extraction behavior, but parser readiness does not gate sandbox staging once the original object has settled. The application, never the guest or runner, reads private originals, verifies recorded size/checksum, and streams them into the bound sandbox. Generated files and explicit workspace archives stream back into private object storage before their relational attachment becomes visible. The universal attachment download boundary reauthorizes current personal or Project access and returns a privacy-neutral unavailable response; no storage key or bucket authority crosses into the browser or VM.

An attachment's original private object remains available independently of background extraction state. A run admitted for Direct PDF input may materialize that object before extraction settles, but only through a bounded read followed by recorded-size and SHA-256 validation; the provider-facing projection excludes storage and integrity fields. Local-extraction routes consume only ready usable text and do not read the original PDF for answer execution.

Anonymous sharing creates a sanitized immutable snapshot behind a hashed high-entropy bearer token. It never points a public reader at live private chat state. Creation and reads use the same positive public schema; unknown fields and all private attachments, Memory/Knowledge internals, tool evidence, run checkpoints, and identifiers are dropped.

Use [Persistence](PERSISTENCE.md) for durable mechanics, [Run contracts](RUN_CONTRACTS.md) for accepted execution, [Providers](PROVIDERS.md) for external transports, and [Environment](ENV_VARIABLES.md) for operator configuration.

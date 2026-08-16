# BACKEND

Owner: Backend maintainers
Scope: Durable HTTP/API, service-boundary, upload, and control-plane principles.

## API Boundary

`app/api/**/route.ts` is the exact route and method inventory. Route entries authenticate, bound and decode input, call a server owner, and serialize an explicit client-safe result. They do not expose repository objects, Prisma rows, secrets, provider payloads, or private recovery state.

All private operations recheck authentication, ownership, entitlement, and lifecycle at the operation boundary. Browser filtering is presentation, not authority. State-changing browser requests pass the shared same-origin and bounded-body boundary. Stable error codes and privacy-neutral unavailable responses replace raw exceptions and existence leaks.

Skill collection responses are metadata-only. Full Skill instructions cross the browser boundary only through an individually authorized detail response, while search and pagination remain server-side so library discovery does not disclose or eagerly transfer instruction bodies.

Keep route handlers thin. Domain rules belong in `lib/domain/`, client-safe wire contracts in `lib/contracts/`, and server policy, repositories, adapters, and orchestration in `lib/server/`. Server modules may depend inward; browser code never imports Prisma, secrets, storage, or provider transports.

## Control Planes

Mutable drafts use optimistic versions; activation creates immutable revisions. Accepted runs bind exact non-secret revisions and credentials, so later configuration affects future work only. Provider, Search, Knowledge, Assistant, MCP, team, and policy APIs validate complete transitions transactionally and never silently clamp, substitute, or partially apply a multi-resource change.

Authentication keeps one identity/session transition owner. Password, OAuth, invite, verification, reset, bootstrap, and administrator actions retain generic enumeration-safe public outcomes and transactional one-winner token/session changes. [Security](SECURITY.md) owns the threat model.

Installation model recommendation and internal system utility selection are separate. Neither grants entitlement. The utility role resolves only its exact configured model and installation credential; absence or invalidity fails closed without fallback.

## Files, Jobs, And Shares

Authenticate before consuming uploads. Validate complete multipart size, extension/MIME/content shape, parser bounds, ownership, and settled private-object metadata before a file becomes usable. Expensive processing is represented by durable claimed work; a request does not own a long-running in-memory queue.

Attachment and Knowledge objects remain private. Reads occur only after current ownership/capability checks, and client errors omit filenames, storage keys, checksums, bytes, extracted text, parser bodies, and adapter failures. Retention and deletion use idempotent durable obligations rather than best-effort request cleanup.

Anonymous sharing creates a sanitized immutable snapshot behind a hashed high-entropy bearer token. It never points a public reader at live private chat state. Creation and reads use the same positive public schema; unknown fields and all private attachments, Memory/Knowledge internals, tool evidence, run checkpoints, and identifiers are dropped.

Use [Persistence](PERSISTENCE.md) for durable mechanics, [Run contracts](RUN_CONTRACTS.md) for accepted execution, [Providers](PROVIDERS.md) for external transports, and [Environment](ENV_VARIABLES.md) for operator configuration.

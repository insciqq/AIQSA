# BACKEND

Owner: Backend maintainers
Scope: HTTP/API and control-plane boundaries.

## API Boundary

[`app/api/`](../app/api/) owns routes and methods; [`lib/contracts/`](../lib/contracts/) owns client-safe wire shapes. Authenticate, bound/decode input, invoke the server owner, and serialize an explicit projection. Recheck ownership, entitlement, and lifecycle at the operation; browser filtering grants no authority. Browser mutations use the shared same-origin and bounded-body boundary. Stable errors omit raw exceptions and resource-existence clues.

Project SSE uses session authentication and reauthorizes membership during delivery. Cursors order invalidations but grant no authority; expired history requires canonical resync and access loss closes delivery. Mutations remain bounded HTTP requests. Skill lists expose metadata; full instructions require individually authorized detail reads and discovery/pagination stay server-side.

Dependency direction belongs to [Architecture](ARCHITECTURE.md), authentication threats to [Security](SECURITY.md).

## Control Planes

Configuration transitions use optimistic concurrency and atomic validation. Never silently clamp, substitute, or partially apply a multi-resource change. Accepted runs retain their admitted configuration; edits affect future work.

Assistant publication must preserve direct Skill audience coverage. Project publication or explicit manager refresh applies the complete eligible dependency plan atomically; later Assistant edits never silently change Project grants. Missing dependencies make it unavailable until authorized refresh. Unlink/unpublish clears affected defaults/plans/dependent authorities atomically and reports safe consequences.

Answer recommendations and purpose-specific System Model assignments are independent and grant no entitlement. Each system role uses its configured deployment and installation credential without substitution. Consolidated administration does not merge domain ownership: Knowledge activation creates an immutable profile with explicit reprocessing/reindexing, while Personal Memory retains owner-scoped entitlement and generation rules.

Inbound MCP grants resolve the current active account; clients cannot select another owner. Memory calls and Hub discovery/dispatch create no synthetic chat/run/history state. Hub uses existing outbound MCP configuration and runtime authority. Utility execution evidence is content-free.

The Control Center attention list is read-only aggregation of already-authorized administrator projections. Unavailable sources are named without failing the whole list; entries contain human copy and navigation only, never raw failures, secrets, or private identifiers.

## Files, Jobs, And Shares

Authenticate before consuming uploads. Usability requires bounded type/content validation and server settlement of private-object integrity. Long-running work belongs to durable claimed jobs; deletion belongs to idempotent obligations, not request-local best effort.

Upload status follows the exact ingestion artifact created for that upload, independently of another ready artifact or later reindexing. Reused content is immediately terminal; historical unbound uploads resolve their exact version's earliest artifact deterministically.

Workspace upload admission is chat-scoped and requires installation/runtime capability. An opaque file can enter execution only through a workspace-enabled admitted run. Original-object settlement permits sandbox staging independently of extraction readiness; the application verifies and streams originals and stores outputs before exposing attachments. Downloads reauthorize current personal or Project access. Storage authority never crosses into browser or guest contracts.

Direct PDF execution may read a settled original before extraction completes, with bounded size/checksum validation. Local-extraction execution consumes ready text only. Original availability does not depend on extraction success.

Anonymous sharing uses a hashed high-entropy bearer token and one positive public schema for creation and reads of a sanitized immutable snapshot. Unknown fields, private attachments, Memory/Knowledge/tool evidence, recovery state, and private identifiers are dropped; public readers never access live chat state.

See [Persistence](PERSISTENCE.md) for lifecycle, [Run contracts](RUN_CONTRACTS.md) for accepted execution, and [Providers](PROVIDERS.md) for transport.

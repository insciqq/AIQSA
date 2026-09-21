# SECURITY

Owner: Security and privacy maintainers
Scope: Identity, secrets, untrusted content, runtime trust, exposure, and dependencies.

## HTTP, Identity, And Secrets

Private operations authenticate and reauthorize current ownership/entitlement. Browser mutations use shared same-origin/Sec-Fetch checks and bounded bodies. Session tokens are opaque, hashed in storage, and HttpOnly; cookie/HSTS policy follows the trusted base URL. Public shares require dynamic no-store/noindex/no-referrer responses on every outcome. Project streams use sessions, never URL tokens, and stop on membership loss; events contain only minimal invalidation identity, with safe current state authorized at delivery.

Auth flows use enumeration-safe outcomes and transactional one-winner proofs. Password verification stays server-owned. Login OAuth binds provider/state/PKCE and trusted callback origins; a provider subject, not mutable email, owns later login. Provider login tokens/codes/verifiers/raw responses are neither persisted nor logged.

Rate-limit identities use installation-secret, domain-separated HMACs. Explicit proxy trust requires fixed reviewed hops; use their rightmost forwarded suffix and fail closed on unresolvable identity. Otherwise authenticate launcher-stamped socket peers, ignoring forwarding. Network ranges prove no identity. Multi-replica auth admission is unsupported.

Secret API fields are write-only. SMTP test recipients are ephemeral and candidate configuration activates only after successful delivery. Cryptographic-purpose separation, key history, rotation, and secret backups belong to [Environment](ENV_VARIABLES.md). Raw user IDs never become OpenSearch routing/document IDs.

Application/access logs are structured, content-free: no prompts/answers, queries, instructions, filenames/content, endpoints, tool bodies, Memory, credentials or bearer URLs. Previews omit Skill bodies/catalogs/results; recovery retains them privately. Skill activity exposes only admitted identity/bounded relative paths. Allowlist bounded fields; exclude raw errors; review third-party output.

Exceptional operator-controlled Nginx error diagnostics may contain public-share bearer paths. Restrict retention, redact support copies and revoke leaked shares. This exception excludes normal access/application logs, authorization headers and provider/MCP/session credentials.

## Untrusted Files, Providers, And Content

Authenticate before consuming uploads. Bound complete multipart envelopes, concurrency, bytes, parsing resources, and remote responses before parsing; framework forwarding limits must accommodate admitted envelopes without overriding lower route limits. Validate extension/MIME/content evidence and reject SVG. Public errors omit private object locations, filenames, integrity metadata, bytes/text, and adapter diagnostics.

Browser multipart authority requires an explicitly configured endpoint for the same private bucket and is expiring/object-specific, never listing/read authority. Durable attempt fences reject stale streams/retries/cancellations. Cancellation aborts authority; server size/checksum/content settlement precedes Source/job creation. Without that endpoint, stream bounded objects through the app without buffering the file/batch.

Parsers are private stateless siblings without data credentials or host ports; an external endpoint is a new operator trust boundary. Preflight archive expansion and document structure bounds. Formulas, OCR, tables, layout, and retrieved Source blocks remain inert evidence, never code/tool/network authority. Knowledge egress uses only bounded content at the exact disclosed destination after current authorization; it cannot widen admitted scope. Public shares strip private file/Knowledge evidence.

Catalogs, JSON/SSE, URLs, and upstream bodies are untrusted. Discovery cannot grant capabilities. Enforce deadlines, pre-parse bounds, SSRF-safe DNS pinning, and redirect policy. Browser/durable Search output is safe normalized findings/citations; Gemini Suggestions require closed server/browser structural allowlists. Raw provider markup/CSS/query records and operation metadata are not grounding output.

Markdown remains React text except reviewed local Shiki and KaTeX sinks. Code highlighting is bounded; math disables trust, rejects hostile HTML/link/resource commands, bounds macro/source work, and falls back to escaped text. Real-library hostile-input tests protect these exceptions.

Artifact prompt injection can encode private context in URLs. Enforce opaque origins and viewer/parent CSP: no same-origin, popups/top navigation, nested frames or runtime network. Vendoring rechecks host/path policy and pinned DNS per redirect; hashes preserve bytes, not trust. Require exact iframe source/opaque origin; confirm every external link's full address. Browser state needs per-artifact/origin quotas, isolation and logout cleanup; exclude it from shared renders. Bound requests before bearer lookup; reauthorize owner/publication/membership around loading. Diagnostics grant no authority.

Publication sets explicitly grant immutable versions; future edits stay private. Explicit hash-only reissue never extends expiry or restores access; token-scoped browser state starts empty.

## MCP And Runtime Trust

Inbound MCP uses owner-bound public-client OAuth. Memory and Hub consent, refresh and revocation are independent; legacy Memory authorization never grants Hub access. Require PKCE S256, exact redirects (except native HTTP loopback ports, including localhost), and immutable issuer/resource/capability binding. Store only token/code hashes. Reuse, revocation, inactive owners or changed client metadata identity fail closed. Metadata fetches use bounded, pinned SSRF-safe transport without redirects; dynamic registration is fallback-only. Memory utilities receive only locally redacted queries or freshly authorized facts at admitted destinations, cannot grant mutation authority, and retain content-free evidence.

Hub consent grants no upstream entitlement. Current permissions, enabled connections and exact tool definitions gate dispatch and protected results, including after asynchronous preparation. Never replay a dispatched business call through transport/authentication retry or recovery. Cancellation cannot undo side effects. Retain durable dispatch/outcome evidence without arguments or raw results; ambiguous completion grants no replay authority.

Only administrators configure or grant MCP servers. Installation is a trust decision, not proof of tool safety. Activation validates the complete inventory/secret configuration and publishes an immutable effective subset; it implies no per-call approval and newly enabled names may cause side effects. Auto routing sees bounded untrusted conversation text and schema-free summaries, excluding file names/bytes, credentials, endpoints, full schemas, and raw results. Selection cannot broaden access; dispatch rechecks exact accepted names/generations.

Remote MCP uses the pinned official SDK through bounded SSRF-safe transport and administrator-owned auth policy. Internal-network permission belongs to each reviewed server, never a global SSRF bypass. URLs contain no credentials/query/fragment; cross-origin auth resources require explicit review and discovery cannot widen origin trust. OAuth tokens remain encrypted, resource/client/scope bound, absent from callbacks/logs, and drained on authority loss. Bound envelopes before SDK parsing; overflow destroys transport without retaining partial data.

Setup endpoint correction requires a supported server identity and unambiguous metadata; an OAuth resource alone is not a transport URL. Validate one same-origin candidate under the existing network and exact grant policy. Publish the checked endpoint and administrator validation binding atomically, without changing user runtime connections, accepted runs, audience, client or scopes.

MCP liveness requires fresh protocol success on the owned session, independently of OAuth authorization. Only a correlated JSON-RPC method-not-found response to ping permits bounded authenticated tools/list health checks on that same session. HTTP status alone is insufficient. Health inventory cannot publish new tools or change accepted definitions; deadline, inventory, secret and generation fences still apply. Runtime failure blocks dispatch with its own safe cause and must not be relabeled as revoked authority.

An MCP tool inherits server access unless an administrator restricts its exact name within that server. A restricted tool needs an explicit user grant or membership in an explicitly granted active group; an empty list denies everyone, including administrators and Full access members without a matching grant. This additional permission cannot enable a connection, restore a globally disabled tool, or supply credentials. Policies survive inventory/revision/runtime changes and loss of their last recipient. Current catalogs, admission, discovery and each new dispatch/recovery apply the policy without rewriting accepted definitions or settled results. Revocation may race with one already prepared call; subsequent calls must reauthorize. Tool denial retains its own safe cause, distinct from runtime failure.

Project MCP runs use only explicitly linked active shared/no-auth authority, never personal overrides, OAuth, connections or secrets. Shared active servers are eligible without a separate publication flag; lack of shared authority fails closed. Additional tool restrictions use the persisted run initiator, independently of the shared runtime owner or current chat viewer.

ToolHive workloads have normal outbound network and explicitly supplied values. The controller alone mounts Docker's socket, but the app reaches its unauthenticated private API: app compromise is transitively root-equivalent host compromise. Trusted single-host operation accepts no steady-state per-user workload quota/controller. Reassess before untrusted users, self-service installation, isolation guarantees, or measured contention.

ToolHive environment values remain plaintext in controller/Docker state despite encrypted AIQSA storage. Workload output/diagnostics are sensitive. Cleanup selects exact installation-owned generations, defaults to list-only, and requires explicit `--execute`; clean before encryption-key replacement because ownership markers derive from that key.

Workspace runs untrusted code only in KVM-backed Microsandbox with exact runtime/image/MCP pins and an official allowlisted catalog. The server injects runtime/lifecycle/network identity. The authenticated private runner bounds requests/streams, has no browser route or application/data/provider/session secrets, and alone receives KVM and its dedicated volume/egress network. Preserve read-only roots, no-new-privileges, dropped capabilities and resource bounds. Fence guest effects across restarts; [Persistence](PERSISTENCE.md) owns handover/export recovery.

Saving personal Workspace secrets authorizes automatic delivery to personal Workspace runs without per-chat/per-command confirmation. Write-only settings use purpose-separated encryption and immutable accepted revisions. They never enter Project runs or Workspace-Off prompts; environment values reach guest commands only. Managed files and their guide are excluded from automatic archive/output/share projections. This is not DLP: models and guest code can read or deliberately copy supplied values. Installation, provider, database, session and operator credentials remain excluded.

Browser storage states are encrypted Workspace secrets and replaceable login caches; saved credentials remain authoritative. Only the managed directory may sync changes back after quiescence of an accepted personal run under its current operation fence. Project/export/recovery grants no sync authority. Acceptance order wins; manual settings changes discard older pending cache writes, and guest deletion never deletes saved secrets. Use bounded private file-byte transport without plaintext output capture or browser routes. Web content grants no authority for irreversible actions, CAPTCHA bypass or installation credentials.

Administrator internet policy is frozen per session. Internet-On permits public egress; Off denies egress while retaining shell/files. Block metadata, private, host and installation networks except the Agent gateway below. This is not hostile-tenancy isolation. Traversal, special files, archive bombs and excess resources fail closed before publication.

Agent-capable Internet-On sessions allow a loopback runner gateway exclusively for admitted model/MCP calls under renewable run grants. Stop, executor loss or revocation ends access; Off cannot reach it. The SDK requires single-tenant networking for this exception: retain KVM, restricted execution, default-deny egress, DNS rebinding protection, bounded connections and no host CAs/ingress/published ports. Expose no control API, app session or arbitrary proxy. Autonomous shell/MCP and personal secrets accept increased prompt-injection risk without human approval or evaluator.

## Deployment And Dependencies

Persistent deployment binds the app to loopback by default; private services have no host ports. OpenSearch is unauthenticated only on its dedicated internal control network, accessible to app/projection worker; off-host placement, exposure, or untrusted network peers require a new authenticated transport boundary. HTTP, including MCP OAuth, requires peer admission without transport warnings; authentication and egress rules remain unchanged. TLS proxies keep the app loopback-bound and support SSE/uploads. Liveness is dependency-free; security contradictions/required data-service failures block readiness while optional failures stay local.

Runtime images run non-root with role-specific commands/configuration. Build inputs/services are digest-pinned; production Compose uses stable tags for `pull`/`up`. Releases record digests, selectable through overrides. Workspace requires reproducible guest identity and matching catalog/version health. [Persistence](PERSISTENCE.md) owns backup/restore isolation; [Testing](TESTING.md) owns disposable gates/explicit external-call authority. Fake providers never make implicit real calls.

Review dependency manifests/locks, registry sources and lifecycle scripts; run `npm ci` and `npm run security:deps`. Never implicitly force breaking remediation.

Manifest/lockfile review and registry audit cover this npm-only tree; add tooling only when another ecosystem/advisory source requires it. [package.json](../package.json) and its lockfile own pins; retain these reasons until upstream/input changes:

| Dependency | Boundary/rationale |
| --- | --- |
| MCP SDK packages | The pinned official SDKs own protocol/OAuth behavior; Node adapter is test/build-only. The Hono override enforces the reviewed advisory floor despite no exposed static server. |
| `deepmerge-ts` | Patched-major override prevents recursive-object stack exhaustion in Prisma config/CLI; Map-merge behavior is outside current operator/repository config. Remove when supported Prisma carries the fix. |
| `sharp` | Handles untrusted raster uploads and image-provider output as well as PDF rendering. Keep byte, pixel and frame limits plus full decoding at input boundaries; reject SVG and MIME mismatches. |
| `pdfjs-dist` | Standard-font assets only; adopting its engine or optional canvas requires compatibility/security review. |
| `nanoid` | Patched compatible override addresses zero-size custom-generator denial of service; current use is transitive build tooling, not affected APIs. |
| `postcss`, `acorn` | Bound untrusted CSS/JavaScript parsing; retain structural checks and hostile-input tests. PostCSS override enforces the advisory floor. |

Keep overrides only while focused hostile-input/build/hermetic verification passes; revisit when upstream constraints or input surfaces change. Repository/publication privacy is owned by root [AGENTS](../AGENTS.md).

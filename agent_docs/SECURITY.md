# SECURITY

Owner: Security and privacy maintainers
Scope: Identity, secrets, untrusted content, runtime trust, exposure, and dependencies.

## HTTP, Identity, And Secrets

Private operations authenticate and reauthorize current ownership/entitlement. Browser mutations use shared same-origin/Sec-Fetch checks and bounded bodies. Session tokens are opaque, hashed in storage, and HttpOnly; cookie/HSTS policy follows the trusted base URL. Public shares require dynamic no-store/noindex/no-referrer responses on every outcome. Project streams use sessions, never URL tokens, and stop on membership loss; events contain only minimal invalidation identity, with safe current state authorized at delivery.

Auth flows use enumeration-safe outcomes and transactional one-winner proofs. Password verification stays server-owned. Login OAuth binds provider/state/PKCE and trusted callback origins; a provider subject, not mutable email, owns later login. Provider login tokens/codes/verifiers/raw responses are neither persisted nor logged.

Rate-limit identities use installation-secret, domain-separated HMACs. Ignore proxy headers without explicit trust; otherwise require the exact complete reviewed chain. Without proxy trust, the launcher authenticates the immediate socket peer. Network ranges alone do not prove identity. Multi-replica auth admission is unsupported.

Secret API fields are write-only. SMTP test recipients are ephemeral and candidate configuration activates only after successful delivery. Cryptographic-purpose separation, key history, rotation, and secret backups belong to [Environment](ENV_VARIABLES.md). Raw user IDs never become OpenSearch routing/document IDs.

Application and access logs are structured and content-free: no prompts/answers, queries, Skill instructions, file names/content, custom endpoints, upstream/tool bodies, Memory text, credentials, or token-bearing URLs. Provider previews omit hidden Skill text even though private accepted recovery retains it.

One accepted exception is limited to exceptional operator-controlled Nginx error diagnostics: a public-share request path may include its bearer token. Treat these as capability-bearing secrets, restrict/shorten retention, redact before support, and revoke leaked shares. This grants no exception for normal access/application logs, authorization headers, provider/MCP/session credentials, or any other token surface.

## Untrusted Files, Providers, And Content

Authenticate before consuming uploads. Bound complete multipart envelopes, concurrency, bytes, parsing resources, and remote responses before parsing; framework forwarding limits must accommodate admitted envelopes without overriding lower route limits. Validate extension/MIME/content evidence and reject SVG. Public errors omit private object locations, filenames, integrity metadata, bytes/text, and adapter diagnostics.

Browser multipart authority requires an explicitly configured endpoint for the same private bucket and is expiring/object-specific, never listing/read authority. Durable attempt fences reject stale streams/retries/cancellations. Cancellation aborts authority; server size/checksum/content settlement precedes Source/job creation. Without that endpoint, stream bounded objects through the app without buffering the file/batch.

Parsers are private stateless siblings without data credentials or host ports; an external endpoint is a new operator trust boundary. Preflight archive expansion and document structure bounds. Formulas, OCR, tables, layout, and retrieved Source blocks remain inert evidence, never code/tool/network authority. Knowledge egress uses only bounded content at the exact disclosed destination after current authorization; it cannot widen admitted scope. Public shares strip private file/Knowledge evidence.

Catalogs, JSON/SSE, URLs, and upstream bodies are untrusted. Discovery cannot grant capabilities. Enforce deadlines, pre-parse bounds, SSRF-safe DNS pinning, and redirect policy. Browser/durable Search output is safe normalized findings/citations; Gemini Suggestions require closed server/browser structural allowlists. Raw provider markup/CSS/query records and operation metadata are not grounding output.

Markdown remains React text except reviewed local Shiki and KaTeX sinks. Code highlighting is bounded; math disables trust, rejects hostile HTML/link/resource commands, bounds macro/source work, and falls back to escaped text. Real-library hostile-input tests protect these exceptions.

## MCP And Runtime Trust

Inbound Personal Memory MCP is a separate owner-bound public-client OAuth boundary. Require PKCE S256, exact redirects (except RFC 8252 native IP-loopback port handling), canonical issuer/resource binding, and no scopes in the facts-only version. Persist only hashes of opaque issued tokens/codes; reuse, revocation, disabled/deleted owner, or changed client metadata identity fails closed. Fetch metadata through bounded, pinned SSRF-safe transport without redirects; dynamic registration is only a bounded compatibility fallback. Clients cannot choose another Memory owner. Utilities receive only locally redacted bounded queries or freshly reauthorized safe facts at the owner's admitted destinations, cannot grant mutation authority, and retain content-free execution evidence.

Only administrators configure or grant MCP servers. Installation is a trust decision, not proof of tool safety. Activation validates the complete inventory/secret configuration and publishes an immutable effective subset; it implies no per-call approval and newly enabled names may cause side effects. Auto routing sees bounded untrusted conversation text and schema-free summaries, excluding file names/bytes, credentials, endpoints, full schemas, and raw results. Selection cannot broaden access; dispatch rechecks exact accepted names/generations.

Remote MCP uses the pinned official SDK through bounded SSRF-safe transport and administrator-owned auth policy. Internal-network permission belongs to each reviewed server, never a global SSRF bypass. URLs contain no credentials/query/fragment; cross-origin auth resources require explicit review and discovery cannot widen origin trust. OAuth tokens remain encrypted, resource/client/scope bound, absent from callbacks/logs, and drained on authority loss. Bound envelopes before SDK parsing; overflow destroys transport without retaining partial data.

Project MCP runs use only explicitly linked active shared/no-auth authority, never personal overrides, OAuth, connections, secrets, or identity. Shared active servers are eligible without a separate publication flag; lack of shared authority fails closed.

ToolHive workloads have normal outbound network and explicitly supplied values. The controller alone mounts Docker's socket, but the app reaches its unauthenticated private API: app compromise is transitively root-equivalent host compromise. Trusted single-host operation accepts no steady-state per-user workload quota/controller. Reassess before untrusted users, self-service installation, isolation guarantees, or measured contention.

ToolHive environment values remain plaintext in controller/Docker state despite encrypted AIQSA storage. Workload output/diagnostics are sensitive. Cleanup selects exact installation-owned generations, defaults to list-only, and requires explicit `--execute`; clean before encryption-key replacement because ownership markers derive from that key.

Workspace runs untrusted code only in KVM-backed Microsandbox through exact runtime/image/MCP pins and an official allowlisted catalog. The server injects runtime identity/lifecycle/network fields. The authenticated private runner has bounded requests/streams and no browser route; guest and runner receive no application/data/provider/session secrets. Only the runner receives KVM and its dedicated volume/egress network, isolated from application/data networks. Keep read-only roots, no-new-privileges, dropped ambient capabilities, and bounded resources. Session ownership must fence guest side effects across restarts; [Persistence](PERSISTENCE.md) owns handover/export recovery.

Administrator internet policy is frozen per session. Enabled mode permits public package egress but blocks loopback, metadata/link-local, private, host, and installation networks; disabled mode denies egress while retaining shell/filesystem tools. This is not an untrusted-host hostile-tenancy guarantee. Path/symlink traversal, special files, archive bombs, and excess files/bytes/time/tool output fail closed before publication.

## Deployment And Dependencies

Persistent deployment binds the app to loopback by default; private services have no host ports. OpenSearch is unauthenticated only on its dedicated internal control network, accessible to app/projection worker; off-host placement, exposure, or untrusted network peers require a new authenticated transport boundary. Direct trusted LAN/VPN HTTP requires explicit peer admission and a confidentiality warning. Internet exposure keeps the app loopback-bound behind an operator-managed TLS proxy supporting SSE/uploads. Liveness is dependency-free; security contradictions/required data-service failures block readiness while optional failures stay local.

Application runtime images run non-root. Build inputs and third-party services are digest-pinned; production Compose follows published stable application/component tags so ordinary updates need only `pull`/`up`. Releases record immutable digests, and image overrides may select them for a frozen deployment. Runtime roles receive distinct commands/configuration; Workspace admission requires reproducible guest image and matching catalog/version health. Backup/restore isolation is owned by [Persistence](PERSISTENCE.md). Deterministic auth/demo credentials require every disposable non-production gate and never authorize persistent-installation tests. Fake-provider tests cannot silently become external calls; real-provider permission belongs to [Testing](TESTING.md).

For dependency changes, inspect manifest/lockfile, registry sources, and lifecycle scripts; use `npm ci`, then the operator-approved `npm run security:deps`. Never apply forced/breaking automated remediation implicitly.

Do not add a repository-owned OSV client, lockfile scanner, or aggregate dependency gate while this npm-only tree is covered by manifest/lockfile review and registry audit. Reconsider only when another package ecosystem or required advisory source enters the runtime/build boundary. Exact pins live in [package.json](../package.json) and the lockfile; preserve these reasons until upstream/input changes justify review:

| Dependency | Boundary/rationale |
| --- | --- |
| MCP SDK packages | The pinned official SDKs own protocol/OAuth behavior; Node adapter is test/build-only. The Hono override enforces the reviewed advisory floor despite no exposed static server. |
| `deepmerge-ts` | Patched-major override prevents recursive-object stack exhaustion in Prisma config/CLI; Map-merge behavior is outside current operator/repository config. Remove when supported Prisma carries the fix. |
| `sharp` | Runtime input is bounded PDF-renderer output, including citation overlays; original uploads need separate review. |
| `pdfjs-dist` | Standard-font assets only; adopting its engine or optional canvas requires compatibility/security review. |
| `nanoid` | Patched compatible override addresses zero-size custom-generator denial of service; current use is transitive build tooling, not affected APIs. |
| `postcss` | Override crosses Next's exact older dependency and processes repository CSS only; review before user/runtime CSS or when upstream is safe. |

Keep overrides only while focused hostile-input/build/hermetic verification passes; revisit when upstream constraints or input surfaces change. Repository/publication privacy is owned by root [AGENTS](../AGENTS.md).

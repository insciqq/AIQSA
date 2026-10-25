---
paths:
  - "lib/server/security/**"
  - "lib/server/secrets/**"
  - "lib/server/shares/**"
  - "lib/server/uploads/**"
  - "lib/server/artifacts/**"
  - "lib/server/webFetch/**"
  - "lib/server/mcp/**"
  - "lib/server/workspace/**"
  - "lib/server/connect/**"
  - "lib/server/observability/**"
  - "lib/server/telegram/render/**"
  - "components/chat/MarkdownMessage.tsx"
  - "components/chat/mermaidRendering.ts"
  - "features/chat-import/**"
  - "connect/**"
  - "proxy.ts"
---
# Security

The trust model: what is untrusted, where secrets may go, and the risks the operator has accepted. External sign-in is in `agent_docs/SIGN_IN.md`; key separation and rotation are in `agent_docs/ENV_VARIABLES.md`.

## Secrets, logs and shares

- Secrets, credentials, bearer tokens and private operator notes never appear in public Git, logs, previews, analytics or shares, except saved secret values in a chat's own content as the next rule accepts. Secret API fields are write-only. Bearer secrets (sessions, share tokens, SCIM tokens, inbound MCP OAuth codes and tokens, automation webhook tokens) are stored only as hashes.
- Saved secrets (operator decision 2026-10-22): the agent has full access to its user's saved secrets, names and values, in every chat and without the Workspace VM, and guest commands receive them as environment values. Accepted risk: values the agent reads reach the model provider and the chat transcript, and so wherever that chat's content goes (exports, shares, Telegram). This is not DLP: models and guest code can copy them. They never appear in logs. A value `manage_secret` saved in a turn is masked in that turn's answer text, so the answer does not carry it further (issue #52, `lib/server/engine/answerStream.ts`). Installation, provider, database and session credentials never reach the agent or the guest.
- Logs are structured, allowlisted and content-free: no prompts, answers, queries, instructions, file names or content, endpoints, tool bodies, Memory, credentials or bearer URLs. A failure record carries its class, first application frame, fingerprint and allowlisted cause facts (database or errno codes, syscall, timing), never the message or stack. Records may carry the user's internal id; PostgreSQL telemetry never stores user, run, job or trace ids. Mechanism: `lib/server/observability/`.
- Exception: operator-controlled Nginx error diagnostics may contain public-share bearer paths. Operators restrict their retention, redact support copies and revoke leaked shares. The exception never covers access or application logs, authorization headers or provider, MCP and session credentials.
- Telegram Bot API URLs embed the bot token and are never logged; Telegram buttons carry only random server-row ids checked against the link's owner and chat.
- Anonymous shares are sanitized, immutable snapshots, never live access to a private chat. Reads stay repository-authorized and are served dynamic, no-store, noindex and no-referrer. The hashed bearer token, its expiry and revocation authorize access; crawler directives do not, and bearer URLs are never advertised.
- Browser mutations pass the shared same-origin and bounded-body guard in `proxy.ts`. A client's address is the socket peer the launcher stamps; forwarding headers count only under explicit proxy trust with a fixed number of reviewed hops (`lib/server/auth/clientIdentity.ts`). Network ranges prove no identity.

## Untrusted files and content

- A file is admitted only when its content matches its declared type. The one exception is a static PNG, JPEG or WebP whose name or MIME names another of those formats: it is admitted after full bounded decoding and takes the decoded format (`lib/server/uploads/validation.ts`). SVG uploads are refused. Previews never render active content: rasters are re-encoded, text is served as plain text with `nosniff` and a sandbox CSP. Errors never reveal object locations, file names or content.
- Direct browser uploads get expiring, object-specific write grants, never list or read authority; nothing uses the object until the server has settled its size, checksum and content.
- Document content (formulas, OCR, tables) is inert evidence, never code, tool or network authority.
- Chat import unpacks archives in a browser worker with in-house zip and tar readers, deliberately without an unpack library. The server accepts only normalized `aiqsa.chat` documents and validates each chat on its own.
- Every server-side fetch of a URL that a user, administrator, model or upstream controls uses the SSRF-safe transport: DNS pinned per hop, redirects re-checked, bounded deadline and body (`lib/server/mcp/safeFetch.ts`, `lib/server/webFetch/transport.ts`). Discovery and catalogs never grant capabilities.
- Model and user Markdown renders as React text. The only HTML sinks are the reviewed Shiki, KaTeX and Mermaid renderers in `components/chat/` and Telegram's rich blocks in `lib/server/telegram/render/` (never Telegram's Markdown or HTML parse modes). Each has real-library hostile-input tests; a new sink or untrusted-input parser needs the same.

## Artifacts

- Artifact code comes from a model that has seen private context and read untrusted text, so an injection could encode private data into requests. No network access at runtime is the main defense (operator decision 2026-10-08). Never weaken the viewer's CSP or sandbox to make a feature work.
- Viewers use exact iframe sources, opaque origins and a CSP without same-origin, popups, top navigation or nested frames. CSP misses WebRTC and WebKit preconnect, so the runtime bridge removes them before artifact code runs (`lib/server/artifacts/runtimeBridge.ts`, `lib/server/artifacts/contentSecurity.ts`).
- Vendored library and image URLs pass host and path policy with DNS pinned per redirect (`lib/server/artifacts/resourcePolicy.ts`); hashes preserve bytes, not trust. External links open only after the user confirms the full address.
- A publication grants specific immutable versions; later edits stay private, and reissuing a link never extends expiry or restores access.

## Page reading (`fetch_url`)

- `fetch_url` sends only URLs found in the run's frozen link authority (user-authored branch text and delivered follow-ups) or in that run's own Search evidence, so injected text cannot exfiltrate context through it. Fetched pages are data, never instructions or link authority.
- A scheduled prompt authorizes no link by itself. Its task keeps a link snapshot with explicit authorship (`lib/server/scheduledTasks/promptUrls.ts`): links the owner writes, and for prompts a chat tool writes, only links that run's user text authorized. Search results never enter it, and neither does a webhook event's body.
- Requests are GET only, to public addresses on ports 80 and 443, with no administrator exception and no credentials or cookies. Parsing happens only in the disposable parser process, never in the application.

## Automation webhooks

- Webhook runs are not restricted (operator decision 2026-10-24): they carry a scheduled task's standing authority (Workspace, below). Accepted risk: whoever holds the token can steer the agent through the body with the owner's tools and secrets, and the body stays in the automation's chat, so it travels wherever that chat's results go. The token is the only boundary; Rotate replaces it, and turning the webhook off or pausing drops every event whose run has not started, for good, even if undone before it would start.
- The token is accepted only in a header, never in the URL. Only its SHA-256 is stored, compared in constant time; the plaintext is shown once by the action that issues it and is never stored, logged, written into a chat or sent to a model, so the agent's card issues it outside the transcript.
- The route takes no session and bypasses Next Proxy, so no unauthenticated body is buffered before the token check; it applies the personal MCP egress refusal, the same-origin guard (which passes senders without a browser origin) and the security headers itself (`lib/server/scheduledTasks/webhookIntake.ts`).

## MCP

- AIQSA runs remote MCP servers only: it never launches MCP processes or containers, and no service mounts the Docker socket.
- Installing a server is a trust decision, not proof its tools are safe. Users may add count- and rate-limited personal remote servers, but there are no first-party connectors. Personal servers are owner-only and excluded from tool policies, admin catalogs and the Hub. They follow the live upstream inventory, so new tools can appear.
- Installation servers are internal and trusted (operator decision 2026-10-24): when a runtime sees that a server added, changed or removed tools, AIQSA runs Test & Save itself under the administrator's validation identity and publishes what it finds, a same-origin endpoint correction included, so nobody presses it after an upstream upgrade. Every server is trusted by default, the switch stays per server, and a draft with unsaved edits is never published this way (`enqueueAutomaticToolChecks` in `lib/server/mcp/prismaRepository.ts`). Accepted risk: a new or changed tool, its read-only annotation and description included, takes effect without review; interactive write calls still need approval, scheduled tasks do not.
- Write approval (operator decision 2026-10-08): in interactive runs, including guest code, a tool not annotated read-only is sent only after its initiator allows that call once or always allows the server. Annotations are trusted as declared. An Allow once is consumed by the claim of exactly that call, and an approval is never user speech or Memory evidence. Scheduled tasks and Hub clients are exempt (`lib/server/mcp/writeApproval.ts`).
- Models and Hub clients see only a bounded, untrusted index of authorized server names, descriptions and tool names, never credentials, endpoints or server instructions. A call must name a tool of the run's admitted catalog. Once dispatched, a call to a tool not annotated read-only is never replayed by a transport or auth retry or by recovery; read-only calls may retry (`agent_docs/RUN_CONTRACTS.md`).
- Accepted risk: an administrator switch (default on) lets personal servers reach private, CGNAT and host-gateway addresses, never AIQSA services, the app container or cloud metadata. This accepts blind LAN SSRF, so operators should expose no unauthenticated host services. Installation servers instead have a reviewed per-server internal-network permission.
- Personal OAuth trusts the same origin and https servers in the same registrable domain; other authorization origins need the owner's confirmation of those exact origins, and discovery never widens them. OAuth tokens stay encrypted, bound to resource, client and scope, and are drained on disconnect or loss of authority.
- Tool policy: a tool inherits its server's access unless an administrator restricts its exact name; then it needs an explicit user or group grant, and an empty list denies everyone, administrators and Full access members included (`lib/server/mcp/toolAccess.ts`). Health or runtime failure is never reported as revoked authority.
- Inbound MCP (external clients using AIQSA) uses owner-bound public-client OAuth with immutable scope snapshots. Memory, Hub and Skills permissions are independent, and refresh never gains rights. Redirects must match exactly, except that native loopback redirects may use any port. Hub consent grants no upstream entitlement.

## Workspace

- Untrusted code runs only in KVM-backed Microsandbox with exact runtime, image and MCP pins and an allowlisted tool catalog. The private runner has no browser route and no application, data, provider or session secrets; only it gets KVM. Keep read-only roots, no-new-privileges, dropped capabilities and resource bounds.
- The internet policy is frozen per session. Off denies egress but keeps the shell; metadata, private, host and installation networks stay blocked either way except for the gateway below. This is not isolation against hostile tenants.
- The managed `/workspace/secrets/` directory and `/workspace/SECRETS.md` live outside `/workspace/project` and never enter output capture, project archives, downloads or shares; keep any widened capture away from them (only `scripts/smoke-workspace-secrets.ts` checks this). Secret delivery is under "Secrets, logs and shares" above.
- Saved browser login states are encrypted Workspace secrets. Only the managed directory syncs back, after an accepted personal run quiesces under its operation fence; deleting a guest never deletes saved secrets. Web content grants no authority for irreversible actions, CAPTCHA bypass or installation credentials.
- Scheduled tasks with tools or Workspace on are their owner's standing authority for MCP write tools, untrusted web content and saved secrets in unattended runs, without per-run approval (operator decision 2026-10-04).
- Accepted risk (operator decision 2026-10-07): chat Skill saves may persist prompt-injected content into a script that later runs unattended. Mitigations: text-only files, a guard against delivered secret values, an hourly limit, a visible card with diff and Undo, and a warning naming scheduled tasks that use the Skill.
- Runner gateway: Internet-On sessions may reach a loopback runner gateway only for admitted run calls: guest code calls MCP under a run-scoped code bearer that never reaches model or Search endpoints, is masked, rotates per guest initialization and dies with the run. The relay forwards nothing but MCP. Code calls get exactly the run's frozen MCP authority and approval. The app accepts gateway requests only through the runner relay. The exception relies on single-tenant networking: keep KVM, default-deny egress, DNS rebinding protection, no host CAs, ingress or published ports, and no control API or arbitrary proxy (`lib/server/workspace/runnerGateway.ts`, `lib/server/workspace/codeMcpGateway.ts`).
- Accepted risk: autonomous shell use, allowed MCP calls and personal secrets raise prompt-injection exposure without human approval or an evaluator.

## AIQSA Connect

- An administrator switch (default off) lets users relay their own terminal sessions between the Connect client and their browser, authorized by a hashed device token and the browser session. Transport is TLS; plain http only directly to local-network addresses (operator decision 2026-10-19).
- Terminal bytes stay in server memory, never stored or logged. Accepted risk (operator decision 2026-10-19): the operator can technically read or inject them.
- Only the owner reaches their devices, administrators included, and input comes only from the person, never a model, schedule or automatic approval. The client writes only report-only hooks into `~/.claude` and `~/.codex`, with consent, and verifies the SHA-256 of a download before installing or replacing itself.

## Deployment

- A persistent deployment binds the app to loopback; private services publish no host ports. Liveness has no dependencies; a security contradiction or a failed required data service blocks readiness.
- Images run as non-root with role-specific configuration, build inputs are digest-pinned, and releases record digests. Fake providers never make implicit real calls.

## Dependencies

- Review covers the npm tree and the Go module in `connect/`. `npm run security:deps` is the approved external advisory check and `npm run security:deps:go` runs the pinned `govulncheck`. Audit suggestions never authorize destructive or breaking fixes.
- Keep an override only while hostile-input, build and hermetic checks pass and its reason below still holds.

| Dependency | Why it is pinned or overridden |
| --- | --- |
| MCP SDK packages | Official SDKs own protocol and OAuth behavior; the Hono override enforces the reviewed advisory floor. |
| `deepmerge-ts` | Override against recursive-object stack exhaustion in Prisma config; remove once supported Prisma carries the fix. |
| `sharp` | Decodes untrusted rasters, image-provider output and PDF renders under bounds. |
| `pdfjs-dist` | Standard-font assets only; adopting its engine or canvas needs a security review. |
| `nanoid` | Override for a zero-size generator denial of service in transitive build tooling. |
| `postcss`, `acorn` | Parse untrusted CSS and JavaScript; the PostCSS override enforces the advisory floor. |
| `@mozilla/readability`, `linkedom` | Extract page text for `fetch_url`, only inside the parser process, because parse5 is quadratic on hostile markup. |
| `markdown-it` | Parses untrusted Markdown under input, node and depth bounds; raw HTML and images never reach the DOM. |
| `@xterm/xterm`, `@xterm/addon-fit` | Exact pins for the Connect session page; output is rendered by xterm, never as HTML, with no clipboard addon. |
| `github.com/creack/pty` | The Go client's only dependency. |
| `mermaid` | Strict security level, no HTML labels or links, bounded input, then DOMPurify and an SVG allowlist; CSP needs no `unsafe-eval`. |

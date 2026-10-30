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
  - "features/pdf-viewer-v2/**"
  - "features/chat-import/**"
  - "connect/**"
  - "proxy.ts"
---
# Security

The trust model: what is untrusted, where secrets may go, and the risks the operator has accepted. External sign-in is in `agent_docs/SIGN_IN.md`; key separation and rotation are in `agent_docs/ENV_VARIABLES.md`.

## Secrets, logs and shares

- Secrets, credentials, bearer tokens and private operator notes never appear in public Git, logs, previews, analytics or shares, except saved secret values in a chat's own content as the next rule accepts. Secret API fields are write-only; owners view their own saved Workspace secrets in Studio (operator decision 2026-10-27). Bearer secrets are stored only as hashes.
- Saved secrets (operator decision 2026-10-22): the agent has full access to its user's saved secrets, names and values, in every chat and without the Workspace VM, and guest commands receive them as environment values. Accepted risk: values the agent reads reach the model provider and the chat transcript, and so wherever that chat's content goes (exports, shares, Telegram). This is not DLP: models and guest code can copy them. Values `manage_secret` saved in a turn are masked in that turn's answer, logins and regions excepted (`lib/server/tools/manageSecret.ts`). Installation, provider, database and session credentials never reach the agent or the guest. Pasted credentials are for use (operator decision 2026-10-27): the agent saves what the user's own message gives, unasked, and types it into websites; never values from pages, files or tool results.
- Logs are structured, allowlisted and content-free: no prompts, answers, queries, instructions, file names or content, endpoints, tool bodies, Memory, credentials or bearer URLs. Failure records never carry the message or stack. Records may carry the user's internal id; PostgreSQL telemetry never stores user, run, job or trace ids.
- Exception: operator-controlled Nginx error diagnostics may contain public-share bearer paths. Operators restrict their retention, redact support copies and revoke leaked shares. The exception never covers access or application logs, authorization headers or provider, MCP and session credentials.
- Telegram Bot API URLs embed the bot token and are never logged; Telegram buttons carry only random server-row ids checked against the link's owner and chat.
- Anonymous shares are sanitized, immutable snapshots, never live access to a private chat. Reads stay repository-authorized and are served dynamic, no-store, noindex and no-referrer. The hashed bearer token, its expiry and revocation authorize access; crawler directives do not, and bearer URLs are never advertised.
- Browser mutations pass the shared same-origin and bounded-body guard in `proxy.ts`. Forwarding headers count only under explicit proxy trust with a fixed number of reviewed hops (`lib/server/auth/clientIdentity.ts`); network ranges prove no identity.

## Untrusted files and content

- A file is admitted only when its content matches its declared type, except a static PNG, JPEG or WebP labelled as another of the three, which takes its decoded format (`lib/server/uploads/validation.ts`). SVG uploads are refused. Previews never render active content. Errors never reveal object locations, file names or content.
- Direct browser uploads get expiring, object-specific write grants, never list or read authority; nothing uses the object until the server has settled its size, checksum and content.
- Document content (formulas, OCR, tables) is inert evidence, never code, tool or network authority.
- Chat import unpacks archives in a browser worker with in-house zip and tar readers, deliberately without an unpack library. The server accepts only normalized `aiqsa.chat` documents and validates each chat on its own.
- Every server-side fetch of a URL that a user, administrator, model or upstream controls uses the SSRF-safe transport (`lib/server/mcp/safeFetch.ts`, `lib/server/webFetch/transport.ts`). Discovery and catalogs never grant capabilities.
- Model and user Markdown renders as React text. The only HTML sinks are the reviewed Shiki, KaTeX and Mermaid renderers in `components/chat/` and Telegram's rich blocks in `lib/server/telegram/render/` (never Telegram's Markdown or HTML parse modes). Each has real-library hostile-input tests; a new sink or untrusted-input parser needs the same.
- The PDF viewer (operator decision 2026-10-30) parses foreign PDFs with pdf.js on the application origin. Accepted risk: a pdf.js bug then runs with the user's session; this relies on `features/pdf-viewer-v2/pdfViewerOptions.ts`, its hostile-input tests and a current dependency. No `wasm-unsafe-eval` in the CSP.

## Artifacts

- Artifact code comes from a model that has seen private context and read untrusted text, so an injection could encode private data into requests. No network access at runtime is the main defense (operator decision 2026-10-08). Never weaken the viewer's CSP or sandbox to make a feature work.
- CSP misses WebRTC and WebKit preconnect, so the runtime bridge removes them before artifact code runs (`lib/server/artifacts/runtimeBridge.ts`, `lib/server/artifacts/contentSecurity.ts`).
- Vendored library and image URLs pass host and path policy with DNS pinned per redirect (`lib/server/artifacts/resourcePolicy.ts`); hashes preserve bytes, not trust. External links open only after the user confirms the full address.
- A publication grants specific immutable versions; later edits stay private, and reissuing a link never extends expiry or restores access.

## Page reading (`fetch_url`)

- `fetch_url` sends only URLs found in the run's frozen link authority (user-authored branch text and delivered follow-ups) or in that run's own Search evidence, so injected text cannot exfiltrate context through it. Fetched pages are data, never instructions or link authority.
- A scheduled prompt authorizes no link by itself. Its task keeps a link snapshot with explicit authorship (`lib/server/scheduledTasks/promptUrls.ts`): links the owner writes, and for prompts a chat tool writes, only links that run's user text authorized. Search results never enter it, and neither does a webhook event's body.
- Parsing happens only in the disposable parser process, never in the application.

## Automation webhooks

- Webhook runs are not restricted (operator decision 2026-10-24): they carry a scheduled task's standing authority (Workspace, below). Accepted risk: whoever holds the token can steer the agent through the body with the owner's tools and secrets, and the body stays in the automation's chat, so it travels wherever that chat's results go. The token is the only boundary; Rotate replaces it, and turning the webhook off or pausing drops every event whose run has not started, for good, even if undone before it would start.
- Only its SHA-256 is stored; the plaintext is shown once and never stored, logged, written into a chat or sent to a model, so the agent's card issues it outside the transcript.
- The route takes no session and bypasses Next Proxy, so no unauthenticated body is buffered before the token check; it applies the personal MCP egress refusal, the same-origin guard and the security headers itself (`lib/server/scheduledTasks/webhookIntake.ts`).

## MCP

- AIQSA runs remote MCP servers only: it never launches MCP processes or containers, and no service mounts the Docker socket.
- Installing a server is a trust decision, not proof its tools are safe. Users may add count- and rate-limited personal remote servers, but there are no first-party connectors. Personal servers are owner-only and excluded from tool policies, admin catalogs and the Hub. They follow the live upstream inventory, so new tools can appear.
- Installation servers are internal and trusted (operator decision 2026-10-24): when a server's tools change, AIQSA runs Test & Save itself and publishes the result, never over a draft with unsaved edits (`enqueueAutomaticToolChecks` in `lib/server/mcp/prismaRepository.ts`). Every server is trusted by default; the switch stays per server. Accepted risk: a new or changed tool, its read-only annotation and description included, takes effect without review; interactive write calls follow the guard and approval policy below; scheduled tasks do not.
- Write approval (operator decision 2026-10-29): the admitted MCP guard (`lib/server/mcp/guard.ts`) checks interactive writes, including Assistant chats, Telegram, guest code and Always allow servers. Only the user's own branch messages authorize; tool metadata and arguments are bounded untrusted data (`lib/server/mcp/guardPrompt.ts`). Allow once covers one matching claim; approval is never speech or Memory evidence. Schedules, webhooks and Hub clients remain exempt.
- Models and Hub clients see only a bounded, untrusted index of authorized server names, descriptions and tool names, never credentials, endpoints or server instructions. A call must name a tool of the run's admitted catalog. Once dispatched, a call to a tool not annotated read-only is never replayed by a transport or auth retry or by recovery; read-only calls may retry (`agent_docs/RUN_CONTRACTS.md`).
- Accepted risk: an administrator switch (default on) lets personal servers reach private, CGNAT and host-gateway addresses, never AIQSA services, the app container or cloud metadata. This accepts blind LAN SSRF, so operators should expose no unauthenticated host services. Installation servers instead have a reviewed per-server internal-network permission.
- Personal OAuth trusts the same origin and https servers in the same registrable domain; other authorization origins need the owner's confirmation of those exact origins, and discovery never widens them. OAuth tokens stay encrypted, bound to resource, client and scope, and are drained on disconnect or loss of authority.
- Tool policy: a tool inherits its server's access unless an administrator restricts its exact name; then it needs an explicit user or group grant, and an empty list denies everyone, administrators and Full access members included (`lib/server/mcp/toolAccess.ts`). Health or runtime failure is never reported as revoked authority.
- Inbound MCP (external clients using AIQSA) uses owner-bound public-client OAuth with immutable scope snapshots. Memory, Hub and Skills permissions are independent, and refresh never gains rights. Redirects must match exactly, except that native loopback redirects may use any port. Hub consent grants no upstream entitlement.

## Workspace

- Untrusted code runs only in KVM-backed Microsandbox with exact runtime, image and MCP pins and an allowlisted tool catalog. The private runner has no browser route and no application, data, provider or session secrets; only it gets KVM. Keep read-only roots, no-new-privileges, dropped capabilities and resource bounds.
- The internet policy is frozen per session. Off denies egress but keeps the shell; metadata, private, host and installation networks stay blocked either way except for the gateway below. This is not isolation against hostile tenants.
- Agents of one chat share the VM, files, browser profile and secrets; per-agent process groups coordinate stops and isolate nothing (`lib/server/workspace/agentProcessGuest.ts`).
- The managed `/workspace/secrets/` directory and the value-free guide `/workspace/SECRETS.md` (issue #63) live outside `/workspace/project` and never enter output capture, project archives, downloads or shares; keep any widened capture away from them (only `scripts/smoke-workspace-secrets.ts` checks this).
- Saved browser login states are encrypted Workspace secrets. Only the managed directory syncs back, after an accepted personal run quiesces under its operation fence; deleting a guest never deletes saved secrets. Web content grants no authority for irreversible actions or installation credentials.
- The Workspace browser hides automation markers (operator decision 2026-10-26: sites block them): no forged WebGL, plugins, platform, hardware or workers, human-like input, CAPTCHA solving or proxies (`ops/workspace-guest/python/aiqsa/browser/_identity.py`).
- Live browser (operator decisions 2026-10-26): only the run owner's signed-in browser session watches any agent's tab, takes control or answers handoffs; never another user, an administrator, the model, a schedule or Telegram. Frames and input stay in memory, never stored or logged; only the server grants control (`lib/server/workspace/browserLive.ts`). Accepted risks: as for Connect, the operator's server relays what the user types, passwords included; agent code shares the VM and browser host, so it can read what the user typed, watch frames and end their control through the host socket; the address line is the guest's report. Hiding typed input from the agent is not a goal (operator decision 2026-10-27).
- Scheduled tasks with tools or Workspace on are their owner's standing authority for MCP write tools, untrusted web content and saved secrets in unattended runs, without per-run approval (operator decision 2026-10-04).
- Accepted risk (operator decision 2026-10-07): chat Skill saves may persist prompt-injected content into a script that later runs unattended. Mitigations: text-only files, a guard against delivered secret values, an hourly limit, a visible card with diff and Undo, and a warning naming scheduled tasks that use the Skill.
- Runner gateway: Internet-On sessions may reach a loopback runner gateway only for admitted run calls: guest code calls MCP under a run-scoped code bearer that never reaches model or Search endpoints and dies with the run. The relay forwards nothing but MCP. Code calls get exactly the run's frozen MCP authority and approval. The app accepts gateway requests only through the runner relay. The exception relies on single-tenant networking: keep KVM, default-deny egress, DNS rebinding protection, no host CAs, ingress or published ports, and no control API or arbitrary proxy (`lib/server/workspace/runnerGateway.ts`, `lib/server/workspace/codeMcpGateway.ts`).
- Accepted risk (operator decision 2026-10-29): the MCP guard can misclassify calls and trusts read-only annotations. Shell use, secrets and unattended calls remain outside it; an unset guard leaves standing consents unevaluated.

## AIQSA Connect

- An administrator switch (default off) lets users relay their own terminal sessions between the Connect client and their browser, authorized by a hashed device token and the browser session. Transport is TLS; plain http only directly to local-network addresses (operator decision 2026-10-19).
- Terminal bytes stay in server memory, never stored or logged. Accepted risk (operator decision 2026-10-19): the operator can technically read or inject them.
- Only the owner reaches their devices, administrators included, and input comes only from the person, never a model, schedule or automatic approval. The client writes only report-only hooks into `~/.claude` and `~/.codex`, with consent, and verifies the SHA-256 of a download before installing or replacing itself.

## Deployment

- A persistent deployment binds the app to loopback; private services publish no host ports. Liveness has no dependencies; a security contradiction or a failed required data service blocks readiness.
- Fake providers never make implicit real calls.

## Dependencies

- Audit suggestions never authorize destructive or breaking fixes.
- Keep an override only while hostile-input, build and hermetic checks pass and its reason below still holds.

| Dependency | Why it is pinned or overridden |
| --- | --- |
| MCP SDK packages | Official SDKs own protocol and OAuth behavior; the Hono override enforces the reviewed advisory floor. |
| `deepmerge-ts` | Override against recursive-object stack exhaustion in Prisma config; remove once supported Prisma carries the fix. |
| `sharp` | Decodes untrusted rasters, image-provider output and PDF renders under bounds. |
| `pdfjs-dist` | Renders foreign PDFs in the browser (accepted risk above); standard-font assets on the server. |
| `nanoid` | Override for a zero-size generator denial of service in transitive build tooling. |
| `postcss`, `acorn` | Parse untrusted CSS and JavaScript; the PostCSS override enforces the advisory floor. |
| `@mozilla/readability`, `linkedom` | Extract page text for `fetch_url`, only inside the parser process, because parse5 is quadratic on hostile markup. |
| `markdown-it` | Parses untrusted Markdown under input, node and depth bounds; raw HTML and images never reach the DOM. |
| `@xterm/xterm`, `@xterm/addon-fit` | Exact pins for the Connect session page; output is rendered by xterm, never as HTML, with no clipboard addon. |
| `mermaid` | Strict security level, no HTML labels or links, bounded input, then DOMPurify and an SVG allowlist; CSP needs no `unsafe-eval`. |

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
  - "lib/server/redaction/**"
  - "lib/server/telegram/render/**"
  - "lib/server/discord/render/**"
  - "lib/server/proxies/**"
  - "lib/server/parsing/**"
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

- Secrets, credentials, bearer tokens and private operator notes never appear in public Git, logs, previews, analytics or shares, except saved secret values in a chat's own content as the next rule accepts. Secret API fields are write-only; owners view their own saved Workspace secrets in Settings (operator decision 2026-10-27). Bearer secrets are stored only as hashes.
- Saved secrets (operator decision 2026-10-22): the agent has full access to its user's saved secrets, names and values, in every chat and without the Workspace VM, and guest commands receive them as environment values. Accepted risk: values the agent reads reach the model provider and the chat transcript, and so wherever that chat's content goes (exports, shares, Telegram). This is not DLP: models and guest code can copy them. Values `manage_secret` saved in a turn are masked in that turn's answer, logins and regions excepted (`lib/server/tools/manageSecret.ts`). Installation, provider, database and session credentials never reach the agent or the guest (proxy passwords excepted, Proxies below). Pasted credentials are for use (operator decision 2026-10-27): the agent saves what the user's own message gives, unasked, and types it into websites; never values from pages, files or tool results. The user may send passwords, codes and choices in the chat, and the agent may ask for them there, Telegram included (operator decision 2026-11-20, replacing "never in the chat": a model handed back an OTP the user had sent until it expired); Discord threads are public, so the agent never asks there.
- Logs are structured, allowlisted and content-free: no prompts, answers, queries, instructions, file names or content, endpoints, tool bodies, the memory note or past-chat text, credentials or bearer URLs. Failure records never carry the message or stack. Records may carry the user's internal id; PostgreSQL telemetry never stores user, run, job or trace ids.
- Exception: operator-controlled Nginx error diagnostics may contain public-share bearer paths. Operators restrict their retention, redact support copies and revoke leaked shares. The exception never covers access or application logs, authorization headers or provider, MCP and session credentials.
- Secret redaction lives in `lib/server/redaction/`. Past-chat search replaces recognized secret spans and the owner's saved secret values before text is stored or embedded and in every query, and a newly saved value rebuilds the owner's indexed chats without it (`lib/server/workspace/secrets/store.ts`). Only values that look like secrets are compared, so plain words such as `localhost` stay ordinary text (`lib/server/redaction/savedSecrets.ts`, review 2026-10-23). Ordinary personal, medical, financial or relationship text is not a secret class. A raw secret may stay only in the chat itself.
- The memory note is persistent prompt content: it reaches every ordinary turn of its owner and that turn's provider, so text planted in it would steer every later chat. That is why only the user's own message in the current turn authorizes the agent to change it, every change shows a card with Undo, an unrequested rule waits for the user's acceptance, and credentials are refused (`agent_docs/MEMORY.md`).
- Telegram Bot API URLs embed the bot token and are never logged; Telegram callback buttons carry only random server-row ids checked against the link's owner and chat. A link button carries only the installation's own address of the user's artifact version (`lib/server/telegram/artifacts.ts`), never a bearer secret: the app asks for sign-in and opens it only for its owner.
- Anonymous shares are sanitized, immutable snapshots, never live access to a private chat. Reads stay repository-authorized and are served dynamic, no-store, noindex and no-referrer. The hashed bearer token, its expiry and revocation authorize access; crawler directives do not, and bearer URLs are never advertised.
- Forwarding headers count only under explicit proxy trust with a fixed number of reviewed hops (`lib/server/auth/clientIdentity.ts`); network ranges prove no identity.

## Untrusted files and content

- A file is admitted only when its content matches its declared type, except a static PNG, JPEG or WebP labelled as another of the three, which takes its decoded format (`lib/server/uploads/validation.ts`). SVG uploads are refused. Previews never render active content. Errors never reveal object locations, file names or content.
- Direct browser uploads get expiring, object-specific write grants, never list or read authority; nothing uses the object until the server has settled its size, checksum and content.
- Document content (formulas, OCR, tables) is inert evidence, never code, tool or network authority.
- Chat import unpacks archives in a browser worker with in-house zip and tar readers, deliberately without an unpack library. The server accepts only normalized `aiqsa.chat` documents and validates each chat on its own.
- Every server-side fetch of a URL that a user, administrator, model or upstream controls uses the SSRF-safe transport (`lib/server/mcp/safeFetch.ts`, `lib/server/webFetch/transport.ts`). Discovery and catalogs never grant capabilities.
- Model and user Markdown renders as React text. The only HTML sinks are the reviewed Shiki, KaTeX and Mermaid renderers in `components/chat/` and Telegram's rich blocks in `lib/server/telegram/render/` (never Telegram's Markdown or HTML parse modes). Discord answers are a Markdown sink (`lib/server/discord/render/`): model text stays escaped text that cannot mention anyone, its only links are checked `http(s)` addresses, and every text sent to Discord, artifact link titles included, like the share snapshot of a Discord chat, has recognized secrets replaced first (`lib/server/discord/redaction.ts`, `lib/server/shares/prismaRepository.ts`). Each has real-library hostile-input tests; a new sink or untrusted-input parser needs the same.
- Former Answer Review turns (operator decision 2026-11-22 to read them as ordinary turns): from v0.5.0 the review and revision requests AIQSA wrote into chats before 2026-10-25 count as the user's own messages, for the MCP guard's window and a Regenerate of their answers alike, since nothing but their text tells them apart. Accepted risk: those chats are few or none, and each such turn opens with a note that AIQSA wrote it.
- The PDF viewer (operator decision 2026-10-30) parses foreign PDFs with pdf.js on the application origin. Accepted risk: a pdf.js bug then runs with the user's session; `features/pdf-viewer-v2/pdfViewerOptions.ts`, hostile-input tests and a current dependency bound it. A PDF never chooses a request path or parses outside its worker. No `wasm-unsafe-eval`.

## Artifacts

- Artifact code comes from a model that has seen private context and read untrusted text, so an injection could encode private data into requests. No network access at runtime is the main defense (operator decision 2026-10-08). Never weaken the viewer's CSP or sandbox to make a feature work.
- CSP misses WebRTC and WebKit preconnect, so the runtime bridge removes them before artifact code runs (`lib/server/artifacts/runtimeBridge.ts`, `lib/server/artifacts/contentSecurity.ts`).
- Vendored library and image URLs pass host and path policy with DNS pinned per redirect (`lib/server/artifacts/resourcePolicy.ts`); hashes preserve bytes, not trust. External links open only after the user confirms the full address.
- A publication grants specific immutable versions; later edits stay private, and reissuing a link never extends expiry or restores access.
- Discord publishes the artifacts its answers make (operator decision 2026-11-16, `agent_docs/RUN_CONTRACTS.md`). Accepted risk: their content is published as made, not redacted like the thread's share snapshot, because rewriting a version would break its immutability and the service account holds no saved secrets. Public pages keep noindex, their CSP and sandbox.

## Page reading (`fetch_url`)

- `fetch_url` reads any public http(s) link the model passes, whatever its source: the user, Search, a fetched page, an MCP result or a file (operator decision 2026-11-20, replacing the conversation link authority of 2026-11-01, which refused 161 links in nine days on one installation and blocked ordinary work). Accepted risk: injected text can make the agent open a link that carries private context to a third party, as the Workspace browser already could, or save a standing Instruction, which its card shows with Undo. Every request still goes through the SSRF-safe transport, carries no cookies or saved secrets, and research still refuses the sites it closed. Fetched pages grant neither instructions nor authority.
- Through a proxy, page readers share rotation for one answer; the proxy resolves targets, and the app checks and pins the proxy at every hop and refuses private literals first (`lib/server/webFetch/transport.ts`).
- Parsing happens only in the disposable parser process, never in the application.

## Research

- A research run keeps the text its agents saw, signed-in pages included, and sends it to the administrator's checks model. Who reads that store and how long it lasts is in `agent_docs/ARCHITECTURE.md` (Research pages).
- Accepted risk: what the skeptic finds is a model's words after reading web pages, and they reach the user in the answer's note. Each item stands on a quote found on a page an agent opened and is plain, bounded text (`lib/server/research/skeptic.ts`), but a page that steered the model can still choose those words.

## Automation webhooks

- Webhook runs are not restricted (operator decision 2026-10-24): they carry a scheduled task's standing authority (Workspace, below). Accepted risk: whoever holds the token can steer the agent through the body with the owner's tools and secrets, and the body stays in the automation's chat, so it travels wherever that chat's results go. The token is the only boundary; Rotate replaces it, and turning the webhook off or pausing drops every event whose run has not started, for good, even if undone before it would start.
- Only its SHA-256 is stored; the plaintext is shown once and never stored, logged, written into a chat or sent to a model, so the agent's card issues it outside the transcript.
- The route takes no session and bypasses Next Proxy, so no unauthenticated body is buffered before the token check; it applies the personal MCP egress refusal, the same-origin guard and the security headers itself (`lib/server/scheduledTasks/webhookIntake.ts`).

## MCP

- AIQSA runs remote MCP servers only: it never launches MCP processes or containers, and no service mounts the Docker socket.
- Installing a server is a trust decision, not proof its tools are safe. Users may add count- and rate-limited personal remote servers, but there are no first-party connectors. Personal servers are owner-only and excluded from tool policies, admin catalogs and the Hub. They follow the live upstream inventory, so new tools can appear.
- OAuth client credentials (2026-11-12): every user with access to such an installation server acts as its one client, so grant it deliberately; personal servers cannot use it. The write-only secret goes only to the token endpoint origin it was entered for, over https under the server's address rules; tokens stay in process memory, never stored or logged (`lib/server/mcp/clientCredentials.ts`).
- Installation servers are internal and trusted (operator decision 2026-10-24): when a server's tools change, AIQSA runs Test & Save itself and publishes the result, never over a draft with unsaved edits (`enqueueAutomaticToolChecks` in `lib/server/mcp/prismaRepository.ts`). Every server is trusted by default; the switch stays per server. Accepted risk: a new or changed tool, its read-only annotation and description included, takes effect without review; interactive write calls follow the guard and approval policy below; scheduled tasks do not.
- Write approval (operator decision 2026-10-29): the admitted MCP guard (`lib/server/mcp/guard.ts`) checks interactive writes, including Assistant chats, Telegram, guest code and Always allow servers. Only the user's own branch messages authorize; tool metadata and arguments are bounded untrusted data (`lib/server/mcp/guardPrompt.ts`). Allow once covers one matching claim; approval is never speech. Schedules, webhooks, Hub clients and Discord runs remain exempt. Accepted risk (owner decision 2026-11-12): a Discord run's only trust is the service account's grants, which hold read-only servers only, so a tool not annotated read-only runs without a card. In a shared thread any participant's next message counts as the user writing again, so a call whose earlier outcome was unknown may then be sent again (`lib/server/engine/unknownEffects.ts`); accepted under the same grants.
- Models and Hub clients see only a bounded, untrusted index of authorized server names, descriptions and tool names, never credentials, endpoints or server instructions. A call must name a tool of the run's admitted catalog. Once dispatched, a call to a tool not annotated read-only is never replayed by a transport or auth retry or by recovery; read-only calls may retry (`agent_docs/RUN_CONTRACTS.md`).
- Accepted risk: an administrator switch (default on) lets personal servers reach private, CGNAT and host-gateway addresses, never AIQSA services, the app container or cloud metadata. This accepts blind LAN SSRF, so operators should expose no unauthenticated host services. Installation servers instead have a reviewed per-server internal-network permission.
- Personal OAuth trusts the same origin and https servers in the same registrable domain; other authorization origins need the owner's confirmation of those exact origins, and discovery never widens them. OAuth tokens stay encrypted, bound to resource, client and scope, and are drained on disconnect or loss of authority.
- Tool policy: a tool inherits its server's access unless an administrator restricts its exact name; then it needs an explicit user or group grant, and an empty list denies everyone, administrators and Full access members included (`lib/server/mcp/toolAccess.ts`). Health or runtime failure is never reported as revoked authority.
- Inbound MCP (external clients using AIQSA) uses owner-bound public-client OAuth with immutable scope snapshots. Hub and Skills permissions are independent, and refresh never gains rights; a grant or token for the removed Memory endpoint is refused like an unknown one. Redirects must match exactly, except that native loopback redirects may use any port. Hub consent grants no upstream entitlement.

## Workspace

- Untrusted code runs only in KVM-backed Microsandbox with exact runtime, image and MCP pins and an allowlisted tool catalog. The private runner has no browser route and no application, data, provider or session secrets; only it gets KVM. Keep read-only roots, no-new-privileges, dropped capabilities and resource bounds.
- The internet policy is frozen per session. Off denies egress but keeps the shell; metadata, private, host and installation networks stay blocked either way except for the gateway below. This is not isolation against hostile tenants.
- Agents of one chat share the VM, files, browser profile and secrets; per-agent process groups coordinate stops and isolate nothing (`lib/server/workspace/agentProcessGuest.ts`).
- The managed `/workspace/secrets/` directory and the value-free guide `/workspace/SECRETS.md` (issue #63) live outside `/workspace/project` and never enter output capture, project archives, downloads or shares; keep any widened capture away from them (only `scripts/smoke-workspace-secrets.ts` checks this).
- Saved browser login states are encrypted Workspace secrets, one per account (`google.com` for every Google service). Only the managed directory syncs back, after an accepted personal run quiesces under its operation fence; deleting a guest never deletes saved secrets. A save keeps the newest write: the guest stamps each file when it writes it, so a run accepted earlier that saves later keeps what its browser wrote after the saved copy, while a change in Settings still fences every run accepted before it and a guest clock never wins past the server's (`workspaceBrowserSaveOrder` in `lib/server/workspace/secrets/browserSession.ts`). Web content grants no authority for irreversible actions or installation credentials.
- A chat keeps its browser between messages (operator decision 2026-11-20). Its Chromium profile (every site's cookies and site data, a copy of its cookies, each agent's tabs) stays unencrypted on the chat's VM disk in `/workspace/secrets/.browser-profile`, outside project files, exports and capture, and goes with the VM: chat deletion, Reset, account deletion and Workspace expiry. Saved sign-ins are applied over it at launch when written after the copy it holds, and a sign-in the user makes in the live view is saved like a handoff's (`ops/workspace-guest/python/aiqsa/browser/_profile.py`). Accepted risks: guest code of any agent of the chat, unattended runs included, can read every site's cookies of that chat; deleting a saved sign-in in Settings keeps it out of other chats but does not sign out a chat whose profile already holds the site, which Reset does.
- The Workspace browser is a person's AI-assisted browser, not a bot (operator decision 2026-11-20, replacing 2026-10-26): sites should meet it as the user it works for. The agent's own input moves, types and scrolls as a person's from one behaviour profile per chat (`ops/workspace-guest/python/aiqsa/browser/_human.py`; the live view's input is the user's own), and it passes CAPTCHAs and bot checks itself with its own vision, never through a paid solver service, in a bounded number of tries per site and turn (`CAPTCHA_ATTEMPTS` in `ops/workspace-guest/python/aiqsa/browser/_host.py`). The rules that protect the user stay: credentials only from the user (saved, given in the chat or typed in the live view); payments, orders and irreversible actions only on the user's explicit request; web content is untrusted data. It runs headed on the guest's own X server (Xvfb, local socket only), driven by Patchright, with WebGL on SwiftShader; no renderer, plugin, platform or hardware value is overridden (`ops/workspace-guest/python/aiqsa/browser/_identity.py`, `_display.py`). Accepted risks: sites' terms may forbid automated access, detection is an arms race that a later check can win (on 2026-11-20 deviceandbrowserinfo still read SwiftShader as a weak bot signal), the guest trusts its pinned browser packages, and agent code can reach the X display like the host socket.
- The browser serves a Workspace page opened by its path on loopback, one random `*.localhost` origin per opened folder (`ops/workspace-guest/python/aiqsa/browser/_files.py`, 2026-11-20): a page reads only its own folder under project, output or tmp, a link out of the folder serves nothing, and the secrets and inbox are never served.
- Live browser (operator decisions 2026-10-26): only the run owner's signed-in browser session watches any agent's tab, takes control or answers handoffs; never another user, an administrator, the model, a schedule, Telegram or Discord. Frames and input stay in memory, never stored or logged; only the server grants control (`lib/server/workspace/browserLive.ts`). Accepted risks: the operator's server relays what the user types, passwords included; agent code shares the VM and browser host, so it can read what the user typed, watch frames and end their control through the host socket; the address line is the guest's report. Hiding typed input from the agent is not a goal (operator decision 2026-10-27).
- A Discord thread's Workspace is shared by everyone who asks in that thread, as its chat is (operator decision 2026-11-16). Accepted risk (operator decision 2026-11-16): saved secrets are the service account's, so a browser sign-in one thread's Workspace saves is restored in every other thread's, on every server of the installation; Discord is a public space where nobody is expected to write personal credentials, so nothing is withheld or stripped. Since a chat keeps its browser (2026-11-20), every site a thread's browser signed into also stays signed in for that thread's later messages, whoever asks.
- Scheduled tasks with tools or Workspace on are their owner's standing authority for MCP write tools, untrusted web content and saved secrets in unattended runs, without per-run approval (operator decision 2026-10-04).
- Accepted risk (operator decision 2026-10-07): chat Skill saves may persist prompt-injected content into a script that later runs unattended. Mitigations: text-only files, a guard against delivered secret values, an hourly limit, a visible card with diff and Undo, and a warning naming scheduled tasks that use the Skill.
- Runner gateway: Internet-On sessions may reach a loopback runner gateway only for admitted run calls: guest code calls MCP under a run-scoped code bearer that never reaches model or Search endpoints and dies with the run. The relay forwards nothing but MCP. Code calls get exactly the run's frozen MCP authority and approval. The app accepts gateway requests only through the runner relay. The exception relies on single-tenant networking: keep KVM, default-deny egress, DNS rebinding protection, no host CAs, ingress or published ports, and no control API or arbitrary proxy (`lib/server/workspace/runnerGateway.ts`, `lib/server/workspace/codeMcpGateway.ts`).
- Accepted risk (operator decision 2026-10-29): the MCP guard can misclassify calls and trusts read-only annotations. Shell use, secrets and unattended calls remain outside it; an unset guard leaves standing consents unevaluated.

## Proxies

Operator decisions 2026-11-01.

- The model may see proxy passwords, administrator ones included, because AIQSA is an internal tool. This is an exception to the root rule that installation secrets stay on the server. Accepted risk: any user's agent can read an administrator proxy's password, and it then travels like a saved secret the agent read. Settings and routes never return one, and a run's persisted plan never holds one (`lib/server/proxies/runProxies.ts`); the model's own reader is `manage_proxy`'s `read`, for an administrator's only while switched on.
- A domain hint is advice, never a hard rule: a named proxy opens any site. An explicit choice wins, direct included; otherwise a site that matches a proxy never goes direct, and when all have failed the failure is visible (`lib/domain/proxySelection.ts`).
- A proxy must not become a path into the installation's network, whoever owns it: private, loopback, link-local, metadata and installation addresses are refused with no switch, and the check repeats before every connection (`lib/server/proxies/address.ts`). Accepted cost: a proxy on the operator's LAN cannot be used.
- In the Workspace the internet policy still applies: Off denies a proxy too. A forwarder on the VM's loopback holds the run's credentials (`ops/workspace-guest/python/aiqsa/proxy/`); guest code can use them. A browser has one exit per site: agents naming different proxies for one site share the last choice. A VM holds the newest admission's plan, so an older run on it uses that one, an accepted exception to bindings. A browser older than the plan restarts through the forwarder; a tab the user holds stays direct until given back.

## AIQSA Connect

- An administrator switch (default off) lets the agent work on its users' own computers through the Connect client (operator decisions 2026-11-06, replacing the terminal relay of 2026-10-19): commands with the user's permissions and every file the user can reach, starting in the folder the chat names. A hashed device token authorizes the client and the owner's browser session the folder picker. Transport is TLS; plain http only directly to local-network addresses (operator decision 2026-10-19).
- Full access without approvals or a sandbox in this first iteration (operator decision 2026-11-06). Accepted risk: text the agent reads (web pages, files, tool results) can steer it to delete, change or send away the user's files, and the operator's server can run commands on every connected computer. Only interactive personal and temporary chats get a computer; Assistant chats, Telegram, scheduled tasks, webhooks and monitoring never do (`COMPUTER_REFUSALS` in `lib/contracts/computer.ts`).
- Only the owner reaches their devices, administrators included; a foreign device and a missing one answer alike. The relay stores nothing and logs only codes, sizes and durations; what the agent reads becomes the run's tool results (`agent_docs/ARCHITECTURE.md`).
- The Windows client is unsigned (operator decision 2026-11-06), so SmartScreen warns once; it installs for the user without administrator rights. Clients verify the SHA-256 of a download before installing or replacing themselves.

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
| `patchright` (guest image) | Exact pin; drives only the browser host (operator decision 2026-11-20); the image build checks it pins the same Chromium build as Playwright. |
| `undici` | Exact pin: Discord Connect's gateway WebSocket and its pinned-address dispatcher; 7.30.2 is the floor for the TLS-option advisory of 7.30.0. |
| `mermaid` | Strict security level, no HTML labels or links, bounded input, then DOMPurify and an SVG allowlist; CSP needs no `unsafe-eval` (`components/chat/mermaidRendering.ts`). |

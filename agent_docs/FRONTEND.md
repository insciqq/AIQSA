---
paths:
  - "components/**"
  - "features/**"
  - "app/**/*.tsx"
  - "styles/**"
---
# Frontend

The browser UI: product surfaces in `features/`, shared pieces in `components/`, pages under `app/`, tokens in `styles/tokens-v2.css`, themes in `components/app-shell/theme.ts`.

## What users see

- Answers show content, sources, generated files, factual progress and actionable failures. Inspecting internal execution is not a product goal: no diagnostic panels, raw payloads, retrieval scores, event histories, private identifiers or receipts.
- Each answer has one process disclosure above the body (thinking, friendly tool names, outcomes, duration), actions below it, then sources and downloads.
- Counts must be true. Search ×N counts successful calls per engine; failures show separately. Memory and Past chats counts describe what entered the context, not proven influence.
- Users never see Memory failures, limits or unavailability; those are for the model and administrators.
- Only the person who started a run may expand its bounded, redacted MCP request and response details. No other raw payload is shown.
- Per-answer usage is never shown. Users see their own monthly allowance in Settings and a composer warning near the limit, never installation amounts.
- Time and animation never invent progress, readiness, cost or completion. A loading failure is not an empty result, and a Knowledge retrieval failure is never shown as "the documents contain no answer".
- The live status names only real work: the server sends the phase (reading stored images, searching Knowledge, reading tool results) and the client owns its words. Without one, the line shows the model's own latest streamed reasoning heading, untrusted and bounded to one plain line, whatever the Reasoning blocks setting (it governs the reasoning disclosure); otherwise one neutral phrase chosen per answer that never rotates or names work that is not happening (operator decision 2026-10-20).

## State

- One state owner per resource. Server pages authorize and pass the least data needed; views consume decoded contracts from `lib/contracts/`. Never mirror server authority or the same async resource in component-local state.
- Server truth owns identity, entitlement, catalogs, branches, lifecycle and saved preferences. Browser state owns overlays, focus, drafts, in-flight handles and theme.
- Key drafts, uploads and runs by their chat or resource, capture the key at dispatch, and drop stale results after navigation. Background refresh keeps drafts, focus, selection and scroll. A malformed response fails visibly instead of becoming guessed state.
- Browser drafts are keyed by account and session; temporary-chat drafts never persist, and sign-out clears the account's drafts. Browser storage grants no authority; attachments and controls are never restored from it.
- Components never import Prisma, server repositories, secrets, route handlers or provider transports.

## Conversation

- Chat and composer stay primary at every width. The header selects models and Assistants; the composer holds tools. Assistants are opt-in.
- URLs: `/c/<chatId>` and `/p/<projectId>/c/<chatId>` address chats; `/` and `/assistant/<assistantId>` open new ones. An unavailable target falls back to `/` without revealing anything.
- The composer never substitutes the chosen model, Assistant, tools or controls. Assistant-governed controls show where a value comes from: fixed rows are locked (a fixed model still opens its parameters), an unavailable adjustable value visibly falls back to the user's or Project's default, and an unavailable fixed row makes the Assistant unavailable instead of falling back (`lib/server/assistants/rowResolution.ts`). Changing a chat's controls never changes personal defaults.
- Skills and MCP modes (Auto, Load all, Off) are independent of pins. An Assistant's Skill links stay read-only in chat and the user pins on top of them. Enabling a Skill or an MCP server is a Settings or Studio action; the composer only discloses what the modes act on.
- Editing a sent message creates a visible branch and keeps the composer draft.
- Upload integrity gates Send; PDF preparation does not. An admitted message appears at once and its draft clears. Server-confirmed final text releases Send even while Workspace cleanup continues, and late events stay with their own answer.
- A reviewed answer is one block: latest version, a quiet status line, collapsed history. Server-written review turns never render as user speech. Automatic review is a per-chat choice in the model picker, shown on the header model chip, never as a composer chip.
- Workspace is ambient in interactive chats: a send uses it whenever the installation offers it and the model calls tools, with no composer or chat toggle and no saved default (operator decision 2026-10-20). Controls wrap whole; no More menu or horizontal scroll hides a capability. Stop keeps files, branching never rolls them back, and Reset keeps messages and outputs. Cards show relative paths, never runtime identities. A continuation whose Workspace copy failed opens empty and never claims the files survived.
- Agent is a per-turn choice in personal chats. When it cannot run, explain why and block the send without changing the user's selections.
- Artifact previews open only by user action. Historical answers keep pointing at their own artifact versions and files (`sandbox:` links), and thumbnails never run scripts.
- Project surfaces use current Project catalogs and never fall back to personal resources. They show durable activity, never online presence, and Project chats never enter personal history or Memory.

## Management surfaces

- Studio holds Assistants, Instructions, Skills, Knowledge, Memory, Files, Artifacts, MCP servers, Secrets and Chat defaults. Settings holds appearance, account, personal MCP connections, connected apps and personal data. In the Control Center, Providers holds deployments, Defaults & roles holds assignments, and Knowledge & Memory holds health and limits.
- Destructive actions name the target and the consequences. Secret fields explain keep or replace and never echo the value.
- Knowledge pages show documents, readiness, access and product actions; profiles, chunks, scores and raw failures stay off ordinary surfaces. Activating a Knowledge profile explicitly acknowledges external processing and reindexing.
- Memory consent for connected apps covers facts, not chat history. Viewing MCP servers never wakes an idle one, and nothing re-enables a server the user deliberately disabled except completing its setup.

## Interaction and visual intent

- No page-wide horizontal overflow; code, tables and math wrap or scroll locally. Respect safe areas and software keyboards; the composer never covers the last answer.
- Primary actions work without hover or precise dragging. Modals trap focus, handle Escape with nested confirmations first, and restore focus. Keyboard submission respects IME composition. WCAG certification is deferred, but labels, keyboard and touch access, focus safety and reduced motion are required.
- Streaming never animates layout. Busy controls keep their labels and reject duplicate submission.
- A quiet reading workspace. Controls are monochrome: the `accent` token is ink, not a hue. Colour means state (ok, warn, danger) or code syntax, never navigation, emphasis or brand (operator decision 2026-10-20). Selection and focus read by fill, edge and ring, not glow. No decorative cards around prose, rows of badges, gradients, idle animation or dashboards.
- Use semantic tokens from `styles/tokens-v2.css`, never raw colors or component-local theme recipes. Prose uses bundled Golos Text, code JetBrains Mono. Themes are `system`, `light` and `dark`; a cookie decides the first paint.
- Segmented controls are for two or three fixed choices; catalogs use a select.

## Verification

Use focused Testing Library tests for observable behavior and Playwright only for a real browser, server or viewport boundary (`agent_docs/TESTING.md`). Assert behavior and geometry, not screenshots or component structure. For a material UI change, check affected states, both themes, long content, narrow and short viewports, and focus across breakpoints.

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
- Time and animation never invent progress, readiness, cost or completion. A loading failure is not an empty result.
- The live status names only real work: the server sends the phase (for example reading stored images) and the client owns its words. Without one, the line shows the model's own latest streamed reasoning heading, untrusted and bounded to one plain line, whatever the Reasoning blocks setting (it governs the reasoning disclosure); otherwise one neutral phrase chosen per answer that never rotates or names work that is not happening (operator decision 2026-10-20). A model request after tool work is such a wait too: no "Reading results" label, which in a Workspace tool loop covered most of the run (operator decision 2026-10-21).

## State

- One state owner per resource. Server pages authorize and pass the least data needed; views consume decoded contracts from `lib/contracts/`. Never mirror server authority or the same async resource in component-local state.
- Server truth owns identity, entitlement, catalogs, branches, lifecycle and saved preferences. Browser state owns overlays, focus, drafts, in-flight handles and theme.
- Key drafts, uploads and runs by their chat or resource, capture the key at dispatch, and drop stale results after navigation. Background refresh keeps drafts, focus, selection and scroll. A malformed response fails visibly instead of becoming guessed state.
- Browser drafts are keyed by account and session; temporary-chat drafts never persist, and sign-out clears the account's drafts. Browser storage grants no authority; attachments and controls are never restored from it.
- Components never import Prisma, server repositories, secrets, route handlers or provider transports.

## Conversation

- Chat and composer stay primary at every width. The header selects models and Assistants; the composer holds tools. Assistants are opt-in.
- URLs: `/c/<chatId>` addresses a chat; `/` and `/assistant/<assistantId>` open new ones, and a link from the removed Projects (`/p/...`) redirects to `/`. An unavailable target falls back to `/` without revealing anything.
- The composer never substitutes the chosen model, Assistant, tools or controls. Assistant-governed controls show where a value comes from: fixed rows are locked (a fixed model still opens its parameters), an unavailable adjustable value visibly falls back to the user's default, and an unavailable fixed row makes the Assistant unavailable instead of falling back (`lib/server/assistants/rowResolution.ts`). Changing a chat's controls never changes personal defaults, except web Search: its composer chip edits the personal default for every chat, and Search is turned off only in Chat defaults after a confirmation (operator decision 2026-10-24).
- Skills and MCP modes (Auto, Load all, Off) are independent of pins. An Assistant's Skill links stay read-only in chat and the user pins on top of them. Enabling a Skill or an MCP server is a Settings or Studio action; the composer only discloses what the modes act on.
- Editing a sent message creates a visible branch and keeps the composer draft.
- Upload integrity gates Send; PDF preparation does not. Chosen files show in the tray at once, before any request (an image as a thumbnail of the local file that never leaves the tab), and more can be added while they upload. A long plain-text paste becomes a text-file attachment through the same path (`features/composer-v2/pastedTextAttachments.ts`), unless the composer is in a follow-up (which sends only text) or cannot take the file; its tray row offers Paste as text, which puts it back into the message (operator decision 2026-10-24). An admitted message appears at once and its draft clears. Server-confirmed final text releases Send even while Workspace cleanup continues, and late events stay with their own answer.
- A reviewed answer is one block: latest version, a quiet status line, collapsed history. Server-written review turns never render as user speech. Automatic review is a per-chat choice in the model picker, shown on the header model chip, never as a composer chip.
- Workspace is ambient in interactive chats: a send uses it whenever the installation offers it and the model calls tools, with no composer or chat toggle and no saved default (operator decision 2026-10-20). Controls wrap whole; no More menu or horizontal scroll hides a capability. Stop keeps files, branching never rolls them back, and Reset keeps messages and outputs. Cards show relative paths, never runtime identities. A continuation whose Workspace copy failed opens empty and never claims the files survived.
- Every chat is one agent with no mode to pick (`agent_docs/RUN_CONTRACTS.md`). Answers of the removed Codex Agent keep rendering their steps and files like any other.
- Artifact previews open only by user action. Historical answers keep pointing at their own artifact versions and files (`sandbox:` links), and thumbnails never run scripts.

## Management surfaces

- Studio holds Assistants, Instructions, Skills, Memory, Files, Artifacts, MCP servers, Secrets and Chat defaults. Settings holds appearance, account, personal MCP connections, connected apps and personal data. In the Control Center, Providers holds deployments, Defaults & roles holds assignments, and Memory holds health and limits.
- Destructive actions name the target and the consequences. Secret fields explain keep or replace and never echo the value.
- Memory consent for connected apps covers facts, not chat history. Viewing MCP servers never wakes an idle one, and nothing re-enables a server the user deliberately disabled except completing its setup.

## Interaction and visual intent

- No page-wide horizontal overflow; code, tables and math wrap or scroll locally. Respect safe areas and software keyboards; the composer never covers the last answer.
- A sent question moves to the top of the thread, and the space below a short answer is only what that placement needs: the end of the thread is that view, never a blank screen, and another chat never inherits it. Opening or closing part of an answer keeps the control under the pointer and stops following the tail (operator report 2026-10-20).
- Primary actions work without hover or precise dragging. Modals trap focus, handle Escape with nested confirmations first, and restore focus. Keyboard submission respects IME composition. WCAG certification is deferred, but labels, keyboard and touch access, focus safety and reduced motion are required.
- Streaming never animates layout. Busy controls keep their labels and reject duplicate submission.
- A quiet reading workspace. Controls are monochrome: the `accent` token is ink, not a hue. Colour means state (ok, warn, danger) or code syntax, never navigation, emphasis or brand (operator decision 2026-10-20). Selection and focus read by fill, edge and ring, not glow. No decorative cards around prose, rows of badges, gradients, idle animation or dashboards.
- Use semantic tokens from `styles/tokens-v2.css`, never raw colors or component-local theme recipes. Prose uses bundled Golos Text, code JetBrains Mono. Themes are `system`, `light` and `dark`; a cookie decides the first paint.
- Segmented controls are for two or three fixed choices; catalogs use a select.

## Verification

Use focused Testing Library tests for observable behavior and Playwright only for a real browser, server or viewport boundary (`agent_docs/TESTING.md`). Assert behavior and geometry, not screenshots or component structure. For a material UI change, check affected states, both themes, long content, narrow and short viewports, and focus across breakpoints.

# DESIGN SYSTEM — CHAT COMPOSITION

Owner: Frontend visual-system maintainers
Scope: Visual composition for the workspace shell, conversation, evidence, composer, Run details, authentication, and public shares.
Read when: Changing Chat workspace visual hierarchy, conversation measure, composer geometry, evidence/Run-details presentation, auth, or public-share composition.
Code owners: V2 presentation owners under `features/*-v2/` and `components/ui-v2/`, plus the bounded auth/public-share leaves.
Not owned here: Control Center composition, functional control behavior, data state, or general tokens.

## Chat Composition

### Shell and workspace

The conversation and composer dominate. [Product and layout](../frontend/PRODUCT_AND_LAYOUT.md)
owns shell breakpoints, action availability, drawer behavior, focus, and
browser-local sidebar visibility. Visually, the single 260px sidebar is one
quiet navigation plane beside the reading canvas, collapses completely, and
becomes the same scrim-backed drawer below 900px. Adjacent Open/New-chat controls
are recovery affordances, not an icon-rail navigation hierarchy. The conversation
header is a compact 3rem row with title, bounded conversation actions, command
search, and Account; it does not duplicate chat/folder state. No second action
bar, permanent inspection column, or decorative title card competes with the
reading plane.

Chat and folder rows use quiet selected/hover states, stable action space, and text labels where consequence matters. Active-run state is a small factual cue. Nested folders must retain readable indentation without causing page-level horizontal overflow.

### Conversation

- Questions are compact and visually distinct, but not oversized colored bubbles.
- Answers sit directly on the answer paper with document typography.
- The reveal and action inventory follow [Messages](../frontend/MESSAGES_AND_MARKDOWN.md).
  When that owner exposes a turn, the bounded surface receives one soft
  symmetric 150ms highlight and the bottom-right action dock appears as a
  stable unit without a separate fade, scale, or slide. The dock overlays
  reserved inter-turn breathing room instead of shifting text; its portalled
  menu uses ordinary overlay styling.
- The functional latest-message action renders as one circular down arrow above
  the composer, without a full-width owner row or visible `Latest` label.
- Markdown uses the document hierarchy; the functional Markdown owner and the
  shared adaptive-layout recipe own heading offsets and local scrollers.
- Provider/model metadata is quiet but legible. Internal IDs never substitute for display labels.
- Loading, queued, streaming, cancelled, failed, and complete states retain a stable answer anchor and truthful language.
- A failed answer keeps its recovery action adjacent to the failure text and
  uses proof rather than destructive styling. [Composer behavior](../frontend/composer/COMPOSER.md)
  owns its label and regenerate semantics.

### Evidence and Run details

[Receipt and Details](../frontend/composer/RECEIPT_AND_DETAILS.md) owns reveal,
message binding, permitted facts, destinations, and interaction. Its visual
projection is one quiet answer-bound row containing only nonzero Sources, Tools,
Files, plus the always-available `Run details` action. Expanded Search, Knowledge,
Memory, citation, and tool evidence remains attached to that answer. The exact
persisted inspection opens in one bounded right drawer or full-viewport mobile
sheet; missing facts leave no decorative placeholder and inspection never
becomes a permanent column or next-run editor.

### Composer

The resting composer contains:

1. Message field;
2. optional Assistant, Temporary-memory, attachment, edit, and error context directly above that field;
3. one capabilities trigger and one readable provider/model control;
4. selected Search/Knowledge/MCP indicators, the context-and-usage gauge, and Send or an addressable Stop.

[Run controls](../frontend/composer/RUN_CONTROLS.md) owns control visibility,
labels, pickers, Assistant/Search state, breakpoints, and refresh behavior. This
visual hierarchy shows provider/model identity as one readable control, a
selected Assistant only as a compact adjacent identity chip, friendly Search
source labels without physical route metadata, and the remaining controls in
the same bands at every width. Wrapping may change but visual priority does not;
routine work uses neutral busy treatment and caution is reserved for a state
that needs user correction.

Attachment progress, partial failure, edit-branch intent, context warning, unavailable catalog, and send/run errors appear next to the control that can resolve them. The composer remains reachable above the software keyboard and safe-area inset.

The context dial is a factual 24px circular indicator inside the ordinary 44px touch target, with a neutral track and information mark at its center. Its arc measures approximate input against the conservative safe input budget: proof below 80%, caution from 80% through 99%, and critical at or above 100%. It carries no resting `Usage` label or decorative dashboard treatment. Exact values and provider-reported usage live in its disclosure; [Product and layout](../frontend/PRODUCT_AND_LAYOUT.md) owns that disclosure's anchored desktop and viewport-contained compact geometry.

The accessible Message label may be visually suppressed while `Ask AIQSA…`
provides the resting cue. The eligible blank state centers that same composer
with one short orientation line and visually suppresses secondary context
chrome; no second composer, suggestion dashboard, or alternate control
hierarchy appears. [Composer behavior](../frontend/composer/COMPOSER.md) owns
eligibility and the transition back to the thread tail.

### Details and settings

[Receipt and Details](../frontend/composer/RECEIPT_AND_DETAILS.md) owns Branch and
Run-details access. Both are temporary drawers/sheets. Branch presents the
active path and immutable alternate versions; Run details presents the exact
persisted chronological digest and bounded evidence. Neither pins, changes the
conversation grid, nor adopts next-run editor styling.

[Settings and Assistants](../frontend/account/SETTINGS_AND_ASSISTANTS.md) owns
destinations, data, actions, focus, and responsive transitions. The unified
Library owns Assistants, Knowledge, Files, and Memory tabs with one persistent
Back action; detailed existing resource editors open only from an explicit
Library action. Settings uses one bounded modal or compact safe-area sheet with
System/Light/Dark and MCP sections. These tasks never create another shell.

The generated Assistant avatar is first-class recognition: 96px in the editor beside a quiet text-labelled `Generate another`, 40-48px on cards, 20-24px in the picker and settled answer identity, 56-64px in the blank intro, with deterministic initials as the only fallback. Its bounded recipe palette is identity data pinned inside immutable revisions — outside the semantic dark/light system so the same recipe renders identically in every theme, while the values themselves live as theme-invariant `--v2-avatar-*` component tokens in the sole token file — and avatar color never carries scope, readiness, or status semantics. Adjacent-to-name avatars are decorative; avatar-only controls keep an accessible name and coarse-pointer target.

## Auth And Public Share Composition

Auth uses one flat, spacious answer-paper workspace with a maximum width of 42rem. Product identity and orientation sit above the active task; the form is part of the page rather than a bordered, shadowed, or decorated card. Only the current sign-in, request, invite, verification, reset, pending, success, or error state appears. OAuth actions remain neutral alternatives to the single primary action.

Public share is a reading surface, not a reduced private shell. A quiet workspace-rail header identifies AIQSA, shared-conversation context, and the immutable read-only state. The title, fixed-copy note, compact questions, and document-flow answers share the normal reading measure. Do not add a composer, private metadata, navigation into the installation, or promotional call to action. Empty and unavailable links remain plain terminal states.

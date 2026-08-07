# DESIGN SYSTEM — CHAT COMPOSITION

Owner: Frontend visual-system maintainers
Scope: Visual composition for the workspace shell, conversation, run receipt, composer, Details, authentication, and public shares.
Read when: Changing Chat workspace visual hierarchy, conversation measure, composer geometry, receipt/details presentation, auth, or public-share composition.
Code owners: Chat shell, thread, composer, receipt/details, auth, and public-share visual owners under `components/`.
Not owned here: Control Center composition, functional control behavior, data state, or general tokens.

## Chat Composition

### Shell and workspace

The conversation and composer dominate. [Product and layout](../frontend/PRODUCT_AND_LAYOUT.md)
owns shell breakpoints, action availability, drawer/panel behavior, focus, and
browser-local visibility. Visually, Workspace remains a quieter rail or drawer;
the conversation keeps one title-free floating edge-action layer with no
full-width bar or divider. Compact content may pass beneath a restrained
answer-paper readability veil, while desktop protects only the small action
footprint needed to avoid text collision. Account is a quiet full-width footer
row below Workspace history, with contained identity text and a restrained
overflow continuation cue. No second action bar or replacement title chip may
compete with the reading plane.

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

### Run receipt

[Receipt and Details](../frontend/composer/RECEIPT_AND_DETAILS.md) owns reveal,
message binding, permitted facts, destinations, and interaction. Its visual
projection is one compact quiet evidence block below the answer, with factual
hierarchy and nested Search/citation expansion inside the same block rather
than adjacent summary panels. Missing facts leave no decorative placeholder,
and the receipt never introduces another audit surface or tab.

### Composer

The resting composer contains:

1. Message field;
2. one full, readable provider/model control;
3. one compact Profile/Search/More row;
4. one final Tools/context-dial/Attach/Send band, or an addressable Stop while cancellation is available.

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

When the functional composer owner permits compact reading collapse, the
visual result is one bounded Message row with the same surface and a labeled
Stop beside it when provided. Density comes from disclosure, never from
shrinking the 44px touch target; gesture thresholds and forced-open states do
not live in the visual contract.

### Details and settings

[Receipt and Details](../frontend/composer/RECEIPT_AND_DETAILS.md) owns Details
modes, tabs, access, and pinning. Visually, overlay and pinned presentations use
the same inspection plane; Branch reads as document content and Events as a
chronological digest, with no next-run editor styling.

[Settings and Assistants](../frontend/account/SETTINGS_AND_ASSISTANTS.md) owns
destinations, data, actions, focus, and responsive transitions. Settings uses a
bounded overlay or compact safe-area sheet. Assistants remains a separate
full-screen workspace with persistent Back chrome, an avatar-prominent
Discover/Yours grid, and an identity-first editor; wide/tall composition may
split primary identity/instructions from collapsible advanced groups while
smaller compositions show one task. The editor keeps one sticky primary footer,
version history reads as rows, and Appearance is a divided comparison list
rather than a card grid.

The generated Assistant avatar is first-class recognition: 96px in the editor beside a quiet text-labelled `Generate another`, 40-48px on cards, 20-24px in the picker and settled answer identity, 56-64px in the blank intro, with deterministic initials as the only fallback. Its bounded recipe palette is identity data pinned inside immutable revisions — deliberately outside the semantic token system so the same recipe renders identically in every theme — and avatar color never carries scope, readiness, or status semantics. Adjacent-to-name avatars are decorative; avatar-only controls keep an accessible name and coarse-pointer target.

## Auth And Public Share Composition

Auth uses one flat, spacious answer-paper workspace with a maximum width of 42rem. Product identity and orientation sit above the active task; the form is part of the page rather than a bordered, shadowed, or decorated card. Only the current sign-in, request, invite, verification, reset, pending, success, or error state appears. OAuth actions remain neutral alternatives to the single primary action.

Public share is a reading surface, not a reduced private shell. A quiet workspace-rail header identifies AIQSA, shared-conversation context, and the immutable read-only state. The title, fixed-copy note, compact questions, and document-flow answers share the normal reading measure. Do not add a composer, private metadata, navigation into the installation, or promotional call to action. Empty and unavailable links remain plain terminal states.

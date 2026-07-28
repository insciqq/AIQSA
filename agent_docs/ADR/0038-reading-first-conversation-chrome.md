# ADR 0038: Reading-First Conversation Chrome Is Intent-Gated

Status: Accepted
Amends: 0016-responsive-composer-disclosure, 0025-clean-slate-research-chat-and-control-center, 0030-direct-run-controls-and-reviewed-provider-catalog, 0037-unobstructed-conversation-action-rail

## Context

Removing the visible conversation title and header fill did not remove the header's reserved height: the transparent desktop rail still displaced the thread by 3rem. At compact sizes, the complete resting composer again occupied too much of the useful reading viewport. Message action strips and complete Run receipts also remained permanently visible under every question and answer, making a reading surface look like a control and telemetry feed.

The operator selected TypingMind's content-first interaction as the density reference: conversation text is the resting surface, while controls appear in the exact message context only after reader intent. This is a presentation reference, not a copy of brand chrome, data ownership, or product semantics.

## Decision

1. At the `lg` desktop shell breakpoint, the conversation action rail is absolutely positioned at the top-right of the answer-paper column and reserves no full-width vertical row. The thread starts at the top of the conversation stage. While the conversation column is narrower than 78rem, thread and persistent-notice content reserve only the rail's 16rem right-side footprint; at wider sizes the centered 46rem reading measure already clears that footprint and stays centered. Compact widths retain the normal-flow touch rail.
2. The selected chat title remains one visually hidden page heading. Workspace remains the visible owner of chat identity; no title chip or replacement header surface is introduced.
3. A settled question or answer rests as content-first text. Fine-pointer hover belongs only to the bounded exact-message surface, never the surrounding full-width row gutter. That hover or keyboard-visible focus softly highlights the whole surface with a symmetric 150ms `cubic-bezier(0.4, 0, 0.2, 1)` transition; one anchored bottom-right action dock appears and disappears as a stable unit without an independent fade, scale, slide, or delay. Compact, coarse-pointer, or no-hover tap reveals the dock with a 300ms entrance and only momentary pressed feedback, never latching the surface highlight. The dock has the same Regenerate, Edit, Copy, and More icon actions in the same order for both roles; question Regenerate starts an assistant sibling directly from that user message. Tapping another message closes the previous touch dock. Pointer focus cannot keep either the highlight or dock visible once the pointer leaves; keyboard-visible focus remains a first-class disclosure path. Links, buttons, form fields, summaries, explicitly revealed details, and the dock do not retrigger the message toggle. Streaming progress, response failures, cancellation state, and run warnings remain visible because they are current outcome state rather than optional historical chrome.
4. The assistant Run receipt is not part of automatic hover/focus/tap disclosure. It remains unmounted until `More` → `Show run details`, stays explicitly open until `Hide run details`, and still uses only message-bound persisted evidence, expands the existing inline artifact disclosures, and opens Details → Events only for the exact loaded run. Delete and Branch remain contextual More actions after that evidence toggle. Keyboard focus is a first-class action-dock disclosure path; hover is never the sole capability path.
5. Below `sm`, or at no more than 32rem viewport height, an empty idle thread-tail composer may enter a session-local reading state after a recent wheel/touch gesture and 48px of consecutive thread movement in either direction. A direction reversal resets accumulation. Programmatic scroll, initial anchoring, and Latest do not collapse it. Chat changes, breakpoint changes, a draft, attachments, upload/edit work, actionable error/unavailable state, or a pre-addressable run force expansion. Once a streaming run has a persisted id, the collapsed Message row keeps a labeled touch-safe **Stop** action. Message activation expands only after the completed pointer click; keyboard/programmatic focus expands immediately. The disclosure transition is 150ms and respects reduced motion.
6. Complete Run setup presents configured Fast/Balanced/Deep profiles as one full-width divided selection list. Every row has one stable label, purpose, explicit Available/Unavailable/Selected state, and the concrete configuration when available. The compact direct profile owner remains unchanged; unavailable profiles remain diagnostic-only and disabled.
7. These states are local presentation projections. They add no persistence, server resource, provider choice, profile identity, run fact, request shape, or second composer/message-action owner.

## Amendments

- ADR 0037 decisions 1 and 4 no longer require the desktop action rail to remain in normal flow or consume up to 3rem of vertical content height. Its non-overlap guarantee is preserved through the right-side action footprint and responsive reading geometry.
- ADR 0025's retirement of ADR 0018's 48px intent-gated reading behavior is reversed for the current thread-tail composer under decision 5 above. The clean-slate single-composer and state-ownership decisions remain current.
- ADR 0030's consolidated completed-answer evidence remains the Run receipt, but its presentation now requires the originating answer's explicit More action rather than message hover/focus/tap. Its direct next-run control ownership is unchanged.
- ADR 0016's one-owner, safe-area, touch-target, and software-keyboard outcomes remain current; its superseded fixed compact composition is not restored.

## Consequences

- Desktop answers begin at the top of the paper without a decorative blank strip, while Share/Details remain stable and cannot intersect the reading measure.
- Resting turns are quiet text on every input mode. Hover/keyboard highlight precedes the consistent role-neutral dock; touch reveals that dock without leaving a selected-looking message behind. Historical run evidence requires the further explicit More action.
- Compact reading recovers substantial vertical space without hiding draft recovery or cancellation capability.
- Run profile choice is taller inside the setup sheet but scans consistently and no longer depends on asymmetric wrapping badges.
- Browser coverage must distinguish fine-pointer hover, coarse/touch activation, deliberate versus programmatic scroll, and narrow versus naturally safe desktop action gutters.

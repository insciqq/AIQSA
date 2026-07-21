# ADR 0018: Intent-Gated Mobile Reading Mode

Status: Accepted
Amends: 0009-conversation-first-ui-revamp, 0016-responsive-composer-disclosure

## Context

On compact screens, the visible active-chat title repeated context already established by the selected history row while a second chat-action rail consumed another row. During answer reading, the expanded Run summary and Fast/Balanced/Deep/action footer also continued to reserve scarce conversation height even though the user was not composing.

Collapsing chrome from ordinary application-driven scroll would be surprising, and hiding the only cancellation action during a live response would remove capability. The operator approved a reading-focused compact state with explicit recovery through the draft field.

## Decision

1. Below the `lg` shell breakpoint, the active-chat heading remains the semantic page heading but becomes visually hidden. Copy thread and Branch tree move into the top application rail, and the separate chat-action rail is not rendered visibly. Desktop keeps the visible heading and chat-action rail.
2. Below `sm`, or at no more than 32rem viewport height, an empty idle composer may enter a session-local reading state. This state is presentation only and is never persisted or shared with composer-control state.
3. Reading state requires a recent wheel or touch gesture followed by at least 48px of consecutive downward thread movement. Application-driven scroll, initial anchoring, and Jump to latest do not collapse the composer; upward movement clears accumulated distance. Chat/composer-session and composition-breakpoint changes reset the state.
4. Reading state collapses the Run summary and compact profile/action footer while leaving the bounded, accessibly named `Message` field visible. Focusing or tapping that field expands the complete controls before the user continues composing.
5. A nonempty draft, staged attachment, upload, message edit, actionable error/unavailable state, or pre-addressable run start forces the composer expanded.
6. Once a streaming run has a persisted run id, reading state may return, but it exposes a labeled, touch-safe `Stop response` action beside the draft. Cancellation capability is never hidden.
7. Collapse/expand uses a 150ms grid-row/opacity transition. Reduced-motion and deterministic-motion-off modes present the same states without relying on transition.

## Consequences

- Compact reading gets one more content row in the header and materially more vertical thread space without removing any chat or run capability.
- Run state and direct profile switching remain immediately legible whenever the composer is engaged; one tap restores them from idle reading state.
- Scroll intent is an explicit UI input, so tests must distinguish user wheel/touch movement from programmatic scroll.
- No backend, persistence, provider, entitlement, run-payload, or composer-control ownership changes.

## Addendum (2026-07-19)

Production touch feedback exposed two refinements to clauses 3 and 4. Reading intent is direction-neutral: after a recent wheel/touch gesture, 48px of consecutive movement either upward or downward may collapse the composer, while a direction reversal starts a new distance accumulator. This supports rereading earlier content as well as continuing toward newer content without admitting application-driven scroll.

Pointer-origin expansion now commits only after the completed Message click has selected its target. Pointer-induced focus alone does not expand the layout before pointer completion, because moving the Run summary under the same finger can retarget the gesture and open Run setup. Keyboard/programmatic focus still expands immediately, and the collapsed streaming Stop remains independently actionable. This changes event timing only, not focus ownership, touch targets, or disclosure state.

## Addendum (2026-07-19, direct compact New chat)

Below `lg`, a neutral touch-safe `Start new chat` action joins Workspace at the start of the application rail. It invokes the existing top-level blank-workspace owner: no chat persists until first send, keyed drafts remain intact, and a run in another saved chat may continue in the background. The action is unavailable only before workspace readiness or while first-chat creation is already pending; desktop keeps the left pane as its direct New Chat owner.

At sub-`sm` widths the two leading actions use no inter-button gap and the decorative AIQSA identity yields until `sm`. This preserves every 44px action plus live Pipeline containment at the 384px target without shrinking, clipping, scrolling, or removing the Copy thread and Branch tree actions established by decision 1.

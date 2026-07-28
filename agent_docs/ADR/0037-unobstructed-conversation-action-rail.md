# ADR 0037: Conversation Actions Do Not Create A Visible Chat Header

Status: Accepted
Amends: 0025-clean-slate-research-chat-and-control-center

Amendment note: ADR 0038 replaces decisions 1 and 4's desktop normal-flow geometry with a top-right action footprint and responsive reading-column clearance. Compact normal-flow placement, the hidden title, direct actions, and the non-overlap outcome remain current.

## Context

The Research Chat repeated the selected chat title inside a full-width conversation header. The Workspace already owns chat identity and selection, while the repeated title, answer-paper fill, separator, and 56-64px rail reduced the calm reading area without adding a distinct action. Share, Details, live run inspection, and compact Workspace/New chat access still need stable placement.

## Decision

1. The conversation keeps one compact action rail in normal document flow. It has no full-width resting surface or separator, so it cannot paint over or intercept the centered reading column.
2. The selected chat title is absent from visible conversation chrome. Workspace selection remains the visual owner of chat identity; the existing title remains available as one visually hidden page heading for document structure and testable state, without creating a second visible location label.
3. At compact widths, Workspace and New chat remain at the left edge. Truthful live Pipeline activity plus Share, Details, and Conversation actions remain at the right edge when their existing state permits them. Desktop keeps the same right-edge conversation actions and does not add replacement title chrome.
4. The action rail uses at most 3rem of content height plus the top safe-area inset. When desktop has no visible conversation action, the rail collapses to the safe-area inset. It remains in normal flow rather than overlaying scrolling answers.
5. Chat titles, title generation, renaming, Workspace navigation, sharing, Details, run state, responsive action ownership, and all backend/client state contracts are unchanged.

## Amendment To ADR 0025

ADR 0025 decision 17 no longer requires the current chat title to be permanently visible inside the conversation surface. Current location is discovered through the selected Workspace row or compact Workspace drawer, while Workspace, New chat, account, settings, Share, and Details retain their existing direct access rules. Decision 27's long-title verification applies to the Workspace and other title-owning surfaces rather than to conversation action chrome.

## Consequences

- The reading column has no decorative bar or repeated title competing with answer text.
- Conversation actions remain stable and touch-safe without becoming an overlay that can cover a message.
- Compact users use the existing Workspace drawer when they need the current chat name; no duplicate state or action owner is introduced.

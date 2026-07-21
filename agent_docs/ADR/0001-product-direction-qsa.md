# ADR 0001: Product Direction Is QSA

Status: Accepted
Amends: none

## Context

The current product is a dense power-user QSA client with transparent provider, search, prompt, events, branch, and API inspection surfaces.

## Decision

AIQSA is a QSA product:

```text
Question -> Search -> Answer
```

The product UI is a dark-mode, dense, keyboard-first, three-pane layout with a top rail, chat list, main thread, composer, and right Details pane for prompt, events, and branch state.

AIQSA is inspired by TypingMind's multi-chat power workflow and chatgpt.com's conversation ergonomics. These are inspiration sources, not clone targets.

## Consequences

- Keep the implementation focused on this QSA app shell unless the operator changes scope.
- No legacy design bundle remains in the repository.
- Prompt presets are system/developer prompt configurations, not a separate persona product.
- Search, provider behavior, events, and branch state are core product surfaces.
- Plugins/tools may appear only as provider/search/tool-call artifacts where required by the QSA pipeline, not as a marketplace or generic agent builder.

## Addendum (2026-07-10)

ADR 0009 supersedes the fixed dense three-pane UI clause of this decision. AIQSA remains a dark-first, keyboard-capable QSA product with transparent provider/search/run surfaces, but the approved presentation direction is now conversation-first with advanced inspection available through progressive disclosure.

# FRONTEND COMPOSER AND CONTROLS

Owner: Chat interaction maintainers
Scope: Non-normative router to bounded Chat composer, navigation, control, answer-output, and Branch owners.

This file is a routing index, not a functional contract owner. Read only the leaf that owns the affected interaction.

| Read when | Contract owner |
| --- | --- |
| Composer input, attachments, drafts, submit, keyboard behavior, validation, or mobile interaction | [Composer](composer/COMPOSER.md) |
| Command palette, Workspace pane, chat discovery, account entry, shortcuts, or responsive navigation | [Navigation](composer/NAVIGATION.md) |
| Provider, model, Assistant, Search, Knowledge, prompt, parameter, next-run, entitlement, or unavailable controls | [Run controls](composer/RUN_CONTROLS.md) |
| Answer Sources and generated outputs, explicit mutation confirmations, Branch checkout, drawers/sheets, or responsive output access | [Answer outputs and Branches](composer/ANSWER_OUTPUTS_AND_BRANCHES.md) |

Appearance is routed through [the design system](../DESIGN_SYSTEM.md); server-side admission and run semantics remain routed through [backend](../BACKEND.md) and [the run pipeline](../RUN_PIPELINE.md).

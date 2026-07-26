# ADR 0011: Explicit Next-Run Control Ownership

Status: Accepted
Amends: 0009-conversation-first-ui-revamp

Amendment note: ADR 0030 retains one composer-control owner and direct concrete-model/search selection, exposes configured profiles directly, and moves the Reasoning editor behind the one-action More setup instead of requiring its resting value to remain separately visible.

## Context

The conversation-first revamp preserved every capability, but three controls acquired more than one apparent owner:

- the active chat could be moved from both the thread toolbar and its workspace-row menu;
- provider headings in model selection acted like choices and silently selected a remembered/default/first model;
- Temperature and Max output tokens were editable in both Run settings and Details, even though both forms mutated one next-run draft.

Reasoning effort was also placed inside the scrollable Run settings popover. Its own nested picker produced competing scroll containers and hid part of the option list at compact heights, while a key model parameter remained invisible during ordinary composition.

## Decision

1. A saved chat is moved only from its workspace row overflow menu. The destination without a folder is labelled `No folder`; explanatory prose calls it the `top level`.
2. Users choose concrete models, not providers. Provider names are noninteractive grouping/search context in model selection, and the command palette exposes model commands rather than provider-only commands. Selecting a model applies its provider atomically.
3. Reasoning effort is a persistent composer-row control whenever the model catalog is available. Unsupported reasoning stays visible but unavailable. It is not nested inside Run settings.
4. Run settings is the single UI editor for next-run Prompt, Temperature, Max output tokens, response behavior, and display/sound preferences. Search, Model, and Reasoning remain directly legible composer controls.
5. Details is an inspection surface with Branch and Events tabs. The former `API params` tab is removed because it was a second editor for the same next-run draft, not an immutable historical request view.
6. Model-run APIs continue to expose normalized request, provider preview, events, response, and usage. A future historical Request tab must be backed by immutable per-run data and is a separate product slice; next-run draft values must never masquerade as completed-run inspection.

## Consequences

- No backend, persistence, entitlement, provider adapter, or serialized request behavior changes.
- Fewer controls and commands expose hidden side effects; each remaining editor has one obvious owner.
- Details loses a duplicate form but not runtime transparency, Branch checkout, Events, or model-run API inspection.
- This ADR narrowly supersedes ADR 0009 decision 3 for Reasoning disclosure and decision 4 only insofar as it required the duplicate Details API-params presentation. All underlying QSA capabilities remain mandatory.

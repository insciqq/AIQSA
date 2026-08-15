# DECISION_DEFAULTS

Use these defaults only when the operator has not decided the point. They route ordinary judgment without duplicating subject contracts.

## Product And Architecture Defaults

- Continue the shipped conversation-first, model-agnostic AI web interface; do not invent a landing page, marketplace, generic workflow canvas, research workbench, or unrelated product direction. Agent features require explicit scope and must not be marketed as shipped before they are usable.
- Keep the Next.js/Postgres/Prisma/S3 modular monolith. Add a runtime, service, or library only after a measured existing boundary blocks the work.
- Preserve the full reachable capability inventory in the bounded owners routed by `FRONTEND.md`. Prefer direct functionality and removal of duplicate editors or diagnostic surfaces over hiding a capability.
- Keep conversation/composer primary, workspace navigation secondary, and Branches on demand. Concrete Model and Search are direct composer actions, Assistants stay opt-in through the quick picker and the Assistants surface, and advanced next-run controls remain in the bounded setup surface. A completed answer may show Sources and generated outputs when present; there is no generic evidence row, Run details drawer, Events tab, or post-hoc request/tool/retrieval inspector.
- Resolve frontend behavior and appearance through `FRONTEND.md`. Do not restate that contract in a task. Dedicated accessibility conformance requires a separately approved task; preserve current responsive, keyboard-safe, touch, overflow, and focus behavior meanwhile.
- Keep backend user ownership, entitlement validation, server-owned branch context, guarded run finalization, private attachments, sanitized snapshot boundaries, and durable recovery without duplicate external side effects.
- Keep internal run records only when an executable consumer requires them for execution, recovery, safety, retention, or aggregate accounting. Do not expose repository return values directly to the browser, and do not retain a hidden/admin inspector as the final state.
- Add abstractions only when they remove demonstrated duplication or give one authoritative owner to behavior; prefer narrow contracts and selectors over broad controller or repository interfaces.
- Treat catalog model ids, prices, and limits as operational metadata. Do not turn estimates into billing truth.

## Provider Defaults

- OpenAI Responses is the default provider path; current execution behavior and mutable upstream facts belong to `PROVIDERS.md`.
- Anthropic uses Messages; first-class Gemini uses only Google's native stateless Interactions v1 adapter with no compatible fallback; OpenRouter uses Chat Completions and backs the Perplexity tool executor. A simple Custom endpoint fixes the wire protocol to generic Chat Completions; other compatible protocol choices remain Advanced.
- The browser selects an entitled concrete model; providers are grouping and routing metadata, not standalone model choices.
- Routine automation uses fake providers. Real provider calls follow the permission and cost limits in `CRITICAL_INVARIANTS.md`.
- Reverify mutable upstream facts through the primary references in `PROVIDERS.md`; configuration inventory and defaults come from `.env.example`, Compose, and focused parsers as described by `ENV_VARIABLES.md`.

## Verification Defaults

- Select the cheapest focused check while iterating, then follow the completion lane and escalation rules owned by [Testing](TESTING.md).
- For visual changes, inspect affected states directly instead of maintaining a generated gallery. Dependency and external-provider authority remain routed by [Security](SECURITY.md) and the critical invariants.

## Documentation Defaults

- Living documents describe current contracts; open tasks describe planned or active work. Completed task files are deleted after verification.
- Give every durable proposition one normative owner. A cross-layer document may link that owner and state only its own storage, enforcement, wire, API, state, presentation, or external-fact projection; it must not restate another owner's mechanics. The mandatory critical-invariant summary may repeat the safety outcome while the bounded leaf remains the sole owner of its mechanics.
- Update the single subject owner instead of copying a changed fact into several living documents.
- When a durable rule changes, update its owning current contract and add a concise rationale only when future maintainers need it to avoid repeating a costly mistake.
- Update `ENV_VARIABLES.md` for configuration changes and keep the compact semantic ownership map in `ARCHITECTURE.md` current when module boundaries change.
- Keep `agent_docs/tasks/queue/` executable: one lifecycle field, no duplicate plans, no resolved placeholders, and no completion archive.

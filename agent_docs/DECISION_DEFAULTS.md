# DECISION_DEFAULTS

Use these defaults only when the operator has not decided the point. They route ordinary judgment without duplicating subject contracts.

## Product And Architecture Defaults

- Continue the shipped conversation-first QSA product under ADRs 0009-0011; do not invent a landing page, agent builder, marketplace, or unrelated product direction.
- Keep the Next.js/Postgres/Prisma/S3 modular monolith. Add a runtime/service/library only after a measured existing boundary blocks the work.
- Preserve the full reachable capability inventory in `FRONTEND.md`. Prefer progressive disclosure and removal of duplicate editors over hiding a capability.
- Keep conversation/composer primary, workspace navigation secondary, and Details on demand. Concrete Model, configured Profiles, and Search are direct composer actions; More owns complete next-run editing including Reasoning, and Details owns Branch/Events inspection.
- Resolve failure, loading, notice, shortcut safety, and responsive behavior through `FRONTEND.md`; resolve appearance through `DESIGN_SYSTEM.md`. Do not restate those contracts in a task. Do not infer WCAG or dedicated accessibility scope: ADR 0025 explicitly defers it until a separately approved task.
- Keep backend user ownership, entitlement validation, server-owned branch context, guarded run finalization, private attachments, and sanitized snapshot boundaries.
- Add abstractions only when they remove demonstrated duplication or give one authoritative owner to behavior; prefer narrow contracts/selectors over broad controller/repository interfaces.
- Treat catalog model ids, prices, and limits as operational metadata. Do not turn estimates into billing truth.

## Provider Defaults

- OpenAI Responses is the default provider path; current defaults and execution behavior are owned by `BACKEND.md`.
- Anthropic uses Messages; first-class Gemini uses only Google's native stateless Interactions v1 adapter with no compatible fallback; OpenRouter uses Chat Completions and backs the Perplexity tool executor. A simple Custom endpoint fixes the wire protocol to generic Chat Completions; other compatible protocol choices remain Advanced.
- The browser selects an entitled concrete model; providers are grouping/routing metadata, not standalone model choices.
- Routine automation uses fake providers. Real provider calls follow the permission and cost limits in `CRITICAL_INVARIANTS.md`.
- External mutable facts come from `PROVIDER_API_NOTES.md`; configuration names/defaults come from `ENV_VARIABLES.md`.

## Verification Defaults

- Use the cheapest focused deterministic test while iterating, then run the one routine Compose check once near completion.
- Use the explicit development Docker Compose file for application checks. Repository-owned Playwright CLI tests own browser integration.
- Run destructive local Playwright only when the changed behavior crosses a browser/server boundary. For visual changes, inspect the affected states directly instead of maintaining a generated gallery.
- Run the dependency audit for dependency changes and request external-provider authority exactly as routed by `SECURITY.md` and the critical invariants.

## Documentation Defaults

- Living docs describe current contracts; task specs describe planned work; done journals preserve significant completion history.
- Update the single subject owner instead of copying a changed fact into several living docs.
- Update `ENV_VARIABLES.md` for configuration changes and ADRs for durable decisions. Keep the compact semantic ownership map in `ARCHITECTURE.md` current when module boundaries change.
- Keep the active/backlog queues executable and remove resolved placeholders from them without rewriting the permanent done journal.

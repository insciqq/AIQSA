# DECISION_DEFAULTS

Use these defaults only when the operator has not decided the point. They route ordinary judgment without duplicating subject contracts.

## Product And Architecture Defaults

- Continue the shipped conversation-first, model-agnostic AI web interface; do not invent a landing page, marketplace, generic workflow canvas, research workbench, or unrelated product direction. Agent features require explicit scope and must not be marketed as shipped before they are usable.
- Keep the Next.js/Postgres/Prisma/S3 modular monolith. Add a runtime, service, or library only after a measured existing boundary blocks the work.
- Preserve intentionally supported user capabilities. Discover the reachable inventory from source and tests; use `FRONTEND.md` only for non-derivable interaction and presentation constraints. Prefer direct functionality and removal of duplicate editors or diagnostic surfaces over hiding a capability.
- Keep conversation/composer primary, workspace navigation secondary, and Branches on demand. The concrete Model is chosen in the chat header, tools such as Search are direct composer actions, Assistants stay opt-in through the quick picker and the Assistants surface, and advanced next-run controls remain in the bounded setup surface. A completed answer may show Sources and generated outputs when present; there is no generic evidence row, Run details drawer, Events tab, or post-hoc request/tool/retrieval inspector.
- Apply frontend product and presentation constraints from `FRONTEND.md`; discover exact components, state, and geometry from source and tests. Do not restate those constraints in a task. Dedicated accessibility conformance requires a separately approved task; preserve current responsive, keyboard-safe, touch, overflow, and focus behavior meanwhile.
- Keep backend user ownership, entitlement validation, server-owned branch context, guarded run finalization, private attachments, sanitized snapshot boundaries, and durable recovery without duplicate external side effects.
- Keep internal run records only when an executable consumer requires them for execution, recovery, safety, retention, or aggregate accounting. Do not expose repository return values directly to the browser, and do not retain a hidden/admin inspector as the final state.
- Add abstractions only when they remove demonstrated duplication or give one authoritative owner to behavior; prefer narrow contracts and selectors over broad controller or repository interfaces.
- Treat catalog model ids, prices, and limits as operational metadata. Do not turn estimates into billing truth.

## Provider Defaults

- OpenAI Responses is the default provider path. `PROVIDERS.md` owns non-derivable transport constraints and vetted mutable upstream caveats; source and tests own exact adapter behavior.
- Anthropic uses Messages; first-class Gemini uses only Google's native stateless Interactions v1 adapter with no compatible fallback; OpenRouter uses Chat Completions and backs the Perplexity tool executor. A simple Custom endpoint fixes the wire protocol to generic Chat Completions; other compatible protocol choices remain Advanced.
- The browser selects an entitled concrete model; providers are grouping and routing metadata, not standalone model choices.
- Routine automation uses fake providers. Real provider calls follow the permission and cost limits in `CRITICAL_INVARIANTS.md`.
- Reverify mutable upstream facts through the primary references in `PROVIDERS.md`; configuration inventory and defaults come from `.env.example`, Compose, and focused parsers as described by `ENV_VARIABLES.md`.

## Verification Defaults

- Select the cheapest focused check while iterating, then follow the completion lane and escalation rules owned by [Testing](TESTING.md).
- For visual changes, inspect affected states directly instead of maintaining a generated gallery. Dependency and external-provider authority remain routed by [Security](SECURITY.md) and the critical invariants.

## Documentation Defaults

- `agent_docs` records navigation, non-derivable product semantics, safety/operations boundaries, and durable rationale; open tasks describe planned or active work. Completion moves verified task files to the ignored local archive owned by the task ledger.
- Give every durable non-executable proposition one normative owner. A cross-layer document may link that owner and state only its own semantic or boundary constraint; it must not restate another owner's mechanics. The mandatory critical-invariant summary may repeat a safety outcome while a bounded document explains only rationale or constraints that source cannot express.
- Never maintain a Markdown mirror of routes, schemas, modules, adapters, runtime flows, tests, constants, statuses, or other implementation state. Link to executable owners instead.
- Routine implementation changes need no documentation update. When a durable rule or rationale changes, update its single owner and only the prose that cannot be recovered from source, schema, migrations, or tests.
- Update `ENV_VARIABLES.md` when the supported configuration contract changes, and `ARCHITECTURE.md` only when dependency direction, deployment shape, data/egress boundaries, or an architectural prohibition changes.
- Keep `agent_docs/tasks/queue/` executable: one lifecycle field, no duplicate plans, no resolved placeholders, and no completion archive.

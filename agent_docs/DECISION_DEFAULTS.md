# DECISION_DEFAULTS

Use these defaults only for choices the operator leaves open.

- Continue the [conversation-first product](PRODUCT_PRINCIPLES.md) and existing modular monolith. Add a service, runtime, library, or abstraction only when an observed limitation or demonstrated duplication justifies it.
- Follow the existing code and scoped owner before inventing another control, editor, state owner, or fallback. Preserve deliberate user choices; unavailable configuration must not silently select another target.
- Keep ordinary controls direct and advanced setup bounded. [Frontend](FRONTEND.md) owns interaction and visual intent; exact geometry and components belong in source.
- Treat model prices and limits as operational metadata, not billing evidence. Resolve transport choices through [Providers](PROVIDERS.md) and source; recheck mutable upstream assumptions against primary documentation.
- Iterate with focused deterministic checks, then select the proportional lane in [Testing](TESTING.md). Real-provider and dependency-security authority remains with Testing and [Security](SECURITY.md).
- Document only a changed durable rule, boundary, operator contract, or rationale. Give each one owner; link instead of repeating it. Implementation changes do not require prose synchronization.

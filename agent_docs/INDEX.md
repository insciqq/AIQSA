# AGENT DOCS INDEX

Start with [critical invariants](CRITICAL_INVARIANTS.md), then read only the owner crossed by the change. The operator defines scope; code, schemas, migrations, and tests define exact implementation. These documents own non-derivable rules and rationale, not inventories or implementation history.

| Boundary | Owner |
| --- | --- |
| Product intent or an open choice | [Product principles](PRODUCT_PRINCIPLES.md), [defaults](DECISION_DEFAULTS.md) |
| Dependency, process, deployment, or egress boundaries | [Architecture](ARCHITECTURE.md) |
| HTTP, uploads, auth control planes, server composition | [Backend](BACKEND.md) |
| Schema, migrations, retention, backup, restore, deletion | [Persistence](PERSISTENCE.md) |
| Provider admission, transport, Search, embeddings | [Providers](PROVIDERS.md) |
| Personal Memory authority, retrieval, learning, lifecycle | [Memory](MEMORY.md) |
| Run context, tools, Knowledge, recovery, outputs, usage | [Run contracts](RUN_CONTRACTS.md) |
| UI state, interaction, visual intent | [Frontend](FRONTEND.md) |
| Trust, secrets, dependencies, exposed deployment | [Security](SECURITY.md) |
| Environment and Compose | [Environment](ENV_VARIABLES.md) |
| Verification and test authoring | [Testing](TESTING.md) |
| Queued, parallel, or multi-session work | [Autonomous workflow](AUTONOMOUS_WORKFLOW.md), [task manual](tasks/README.md) |

Keep each durable rule in one owner. If code violates it, fix code unless the operator changes the rule. If prose merely repeats code or has gone stale, remove it. Private PRDs and task instances are local working state, not mandatory reading or public documentation.

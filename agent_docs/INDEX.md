# AGENT DOCS INDEX

Owner: Repository maintainers
Scope: Reading map for durable product, engineering, and operator contracts.

Start with [critical invariants](CRITICAL_INVARIANTS.md). Read only the owner crossed by the requested change; source, schemas, migrations, and tests remain authoritative for exact implementation shape.

| Change concerns | Read |
| --- | --- |
| Product direction or an open product choice | [Product principles](PRODUCT_PRINCIPLES.md), then [decision defaults](DECISION_DEFAULTS.md) |
| Module, data, process, or deployment boundaries | [Architecture](ARCHITECTURE.md) |
| HTTP/API behavior, uploads, auth control planes, or server composition | [Backend](BACKEND.md) |
| Schema, migrations, retention, backup, restore, or deletion | [Persistence](PERSISTENCE.md) |
| Provider admission, transport, Search engines, embeddings, or upstream caveats | [Providers](PROVIDERS.md) |
| Personal Memory retrieval, learning, privacy, or lifecycle | [Memory](MEMORY.md) |
| Run admission, context, tools, Search/Knowledge, recovery, output, or usage | [Run contracts](RUN_CONTRACTS.md) |
| UI behavior, state, layout, theme, geometry, or motion | [Frontend](FRONTEND.md) |
| Threats, secrets, trust, dependencies, or exposed deployment | [Security](SECURITY.md) |
| Environment or Compose configuration | [Environment](ENV_VARIABLES.md) |
| Test level, command, or evidence selection | [Testing](TESTING.md) |
| Queued, dependent, parallel, or multi-session work | [Autonomous workflow](AUTONOMOUS_WORKFLOW.md) and [task ledger](tasks/README.md) |

`app/api/**/route.ts` is the exact API route/method inventory. `prisma/schema.prisma` plus committed migrations are the exact schema inventory.

## Authority And Maintenance

The operator request defines scope. Critical invariants constrain it. Executable behavior plus the relevant owner above define current behavior; resolve drift in both. Product principles and defaults decide only points left open.

Give every durable proposition one owner. Link across boundaries instead of copying mechanics. Keep rationale only when it prevents a likely unsafe or semantically incompatible future change. Do not add route, schema, enum, test-file, store, constant, status, or limit inventories that source already answers.

Private PRDs and task instances are local working state, not mandatory reading or public documentation. Completed task evidence never substitutes for a current contract.

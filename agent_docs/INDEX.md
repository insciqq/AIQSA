# AGENT DOCS INDEX

Owner: Repository maintainers
Scope: Reading map for durable product, engineering, and operator contracts.

Start with [critical invariants](CRITICAL_INVARIANTS.md). Read only the durable boundary crossed by the requested change. Code, schemas, migrations, and tests are the sole source for exact current implementation.

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

The operator request defines intent and scope. Critical invariants constrain it. Executable artifacts define what is currently implemented. The other documents above preserve only navigation, non-derivable product semantics, safety/operations boundaries, and rationale; they do not share ownership of implementation state. Product principles and defaults decide only points left open.

If implementation violates a durable rule, change the executable artifacts unless the operator authorized a rule change. If prose has become a stale implementation mirror, delete that prose and link to source instead of updating both sides.

Give every durable non-executable proposition one document owner. Link across boundaries instead of copying mechanics. Keep rationale only when it prevents a likely unsafe or semantically incompatible future change. Do not add route, schema, enum, test-file, store, constant, status, adapter, flow, or limit inventories that source already answers. Routine implementation changes require no Markdown update.

Private PRDs and task instances are local working state, not mandatory reading or public documentation. Completed task evidence never substitutes for a current contract.

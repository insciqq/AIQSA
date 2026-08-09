# RUN_PIPELINE

Owner: Run pipeline maintainers
Scope: Non-normative router to bounded provider-neutral run-pipeline contract owners.

This file is a routing index, not a run contract owner. Read only the affected pipeline leaf plus any provider, security, or frontend owner crossed by the change.

| Read when | Contract owner |
| --- | --- |
| Run meaning, message acceptance, context, dispatch, tool loop, streaming, terminal settlement, usage, or persistence | [Core pipeline](run_pipeline/CORE_PIPELINE.md) |
| Search choices, route assignment, hosted/client execution, query-only tools, source evidence, budgets, or Search persistence | [Search plans](run_pipeline/SEARCH_PLANS.md) |
| Transparency, provider strategy, inspection evidence, anonymous sharing, logging, or retention | [Evidence, sharing, and retention](run_pipeline/EVIDENCE_SHARING_AND_RETENTION.md) |
| Approved Native Memory target semantics, two-phase Memory preparation, tool-egress separation, or implementation status | [Native Memory](backend/MEMORY.md) |

Provider runtime details are routed through [backend provider adapters](backend/PROVIDER_ADAPTERS.md), external provider facts through [provider API notes](PROVIDER_API_NOTES.md), frontend behavior through [frontend](FRONTEND.md), and privacy boundaries through [security](SECURITY.md).

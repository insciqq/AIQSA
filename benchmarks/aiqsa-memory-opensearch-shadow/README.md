# Memory OpenSearch shadow qualification

This focused workload compares the language-neutral PostgreSQL lexical provider
with the Memory OpenSearch Unicode/ICU projection on a frozen synthetic corpus.
It also exercises projection freshness, production canary selection, automatic
PostgreSQL fallback, a closed OpenSearch outage and circuit-open skip, bounded
maximum requests, per-owner routing, representative corpus sizes, and concurrent
Knowledge/Memory load on the shared cluster.

The runner never invokes a model, embedding provider, or reranker. Its JSON
report contains only aggregate metrics, public cohort/case labels, contract
versions, and gate outcomes. It requires a fresh disposable PostgreSQL database
whose name starts with `aiqsa_memory_shadow_qualification_`; the caller owns
creating, migrating, and dropping that database. A unique Memory physical index
and a unique synthetic Knowledge artifact are removed in `finally`.

The PRD's per-cohort top-10 Jaccard exception is recorded only for a strict
additive expansion: every PostgreSQL top-10 candidate must remain in the
OpenSearch top 10 and the first relevant reciprocal rank must not regress.
The report names each reviewed synthetic cohort and its disposition; no cohort
name changes runtime retrieval behavior.

Example from the dev app container after creating and migrating the disposable
database:

```bash
AIQSA_STATEFUL_TEST_TARGET=DISPOSABLE \
DATABASE_URL=postgresql://aiqsa:aiqsa-dev-password@postgres:5432/aiqsa_memory_shadow_qualification_run \
npx tsx benchmarks/aiqsa-memory-opensearch-shadow/run.ts
```

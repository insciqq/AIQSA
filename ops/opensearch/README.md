# Personal Memory OpenSearch operations

This runbook covers the derived Personal Memory lexical index. PostgreSQL is
always canonical; OpenSearch supplies opaque lexical candidates only. Keep all
commands on the private installation host, never expose the OpenSearch port,
and never paste a resolved environment, raw user identifier, query, or Memory
text into logs or support output.

## Read rollout

Start or return to the safe read mode in `.env`:

```dotenv
AIQSA_MEMORY_LEXICAL_BACKEND=POSTGRES
```

Before any canary, drain and audit the projection. These commands emit only
aggregate counts and closed error codes:

```bash
docker compose run --rm -T memory-search-worker npm run memory:search:worker -- --drain
docker compose run --rm -T memory-search-worker npm run memory:search:integrity
```

The audit must report zero blocked, claimed, degraded, outstanding, and
mismatched work, with every generation ready or retired. The frozen synthetic
qualification in
[`benchmarks/aiqsa-memory-opensearch-shadow`](../../benchmarks/aiqsa-memory-opensearch-shadow/README.md)
must also pass for the exact code/index contract before rollout.

Canary membership is stable for a routing-key version and user. Advance only
after the observation gate at each step:

```text
1% -> 5% -> 25% -> 50% -> 100%
```

For each step, set both values and recreate only the app role:

```dotenv
AIQSA_MEMORY_LEXICAL_BACKEND=OPENSEARCH_CANARY
AIQSA_MEMORY_OPENSEARCH_CANARY_PERCENT=1
```

```bash
docker compose up -d --no-deps --force-recreate app
```

Do not advance on an authority/generation rejection, unexpected canonical
guard, recall regression, sustained fallback/circuit-open rate, or Memory or
Knowledge latency regression. After the 100% canary gate, use
`AIQSA_MEMORY_LEXICAL_BACKEND=OPENSEARCH` and recreate the app. Do not remove
the PostgreSQL lexical columns or indexes.

## Immediate rollback and circuit recovery

Set `AIQSA_MEMORY_LEXICAL_BACKEND=POSTGRES` and recreate the app. This bypasses
OpenSearch immediately without a data migration; the projection worker may
continue draining derived work.

The automatic circuit breaker is process-local to Memory, opens after the
configured bounded consecutive failures, and admits one half-open probe after
the capped cooldown. `memory_opensearch_circuit_open` in lexical evidence means
the request skipped OpenSearch and used PostgreSQL. There is deliberately no
remote breaker mutation/debug endpoint. To force the equivalent of an open
circuit, use `POSTGRES`. After repairing and auditing the projection, recreate
the app in the desired canary mode; the new process starts with a reset closed
breaker. Do not restart merely to defeat a breaker before its cause is fixed.

## Projection repair and rebuild

Run one bounded pass or drain all existing work with:

```bash
docker compose run --rm -T memory-search-worker npm run memory:search:worker -- --once
docker compose run --rm -T memory-search-worker npm run memory:search:worker -- --drain
```

After fixing the cause of an administrator-blocked event, retry and drain:

```bash
docker compose run --rm -T memory-search-worker npm run memory:search:retry-blocked
docker compose run --rm -T memory-search-worker npm run memory:search:worker -- --drain
docker compose run --rm -T memory-search-worker npm run memory:search:integrity
```

For an incompatible/corrupt index or full rebuild, first force `POSTGRES`, stop
the continuous projection worker, choose a fresh bounded build ID, and rebuild.
The command creates the code-owned mapping, validates ICU analyzer fixtures,
replays PostgreSQL state, verifies aggregate count/hash integrity, and switches
both aliases only after the complete proof:

```bash
docker compose stop memory-search-worker
docker compose run --rm -T memory-search-worker npm run memory:search:rebuild
docker compose start memory-search-worker
docker compose run --rm -T memory-search-worker npm run memory:search:integrity
```

The index is shared and routed, so do not attempt an ad-hoc per-user physical
index or direct document repair. A user/generation repair remains on
PostgreSQL reads while its canonical generation/outbox work is replayed and
audited; if aggregate integrity cannot prove the exact routed generation, use
the fresh full-index rebuild above. OpenSearch never repairs PostgreSQL.

## Deletion, restore, and routing-key rotation

User and generation purges originate only from the authenticated canonical
Memory/account lifecycle. Do not run raw OpenSearch deletes. After the product
operation, drain and run the integrity audit; a blocked or outstanding purge is
an incident and keeps canary advancement stopped.

A PostgreSQL restore invalidates every prior READY projection inside the
isolated restore reconciliation. Keep the restored installation on `POSTGRES`,
finish the supported backup review/promotion workflow, select a fresh build ID,
run the full rebuild, and repeat shadow/canary gates. Never restore OpenSearch
as backup authority.

Routing-key replacement changes every routed scope. Force `POSTGRES`, stop the
projection worker, generate a new independent 32-byte key, increment
`AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY_ID`, choose a fresh index build ID, and run
the full rebuild. Resume canary only after aggregate integrity passes. Never
mix old-key and new-key documents or derive this key from another installation
secret.

## Content-free monitoring and alerts

The projection worker emits aggregate JSON events. Alert on any nonzero
blocked, claimed-after-lease, degraded, outstanding, or mismatched count and on
oldest-event age/retry growth from the PostgreSQL projection queue. Retrieval
attempts persist bounded `lexicalEvidence`; aggregate only these fields:

- backend, lane, match mode, duration, requested/raw/canonical counts;
- projection caught-up state and numeric lag/age;
- fallback, timeout, closed failure code, and opaque-ID presence;
- authority, generation, and hash rejection counts.

Any authority or generation rejection requires immediate `POSTGRES` rollback.
An unexpected canonical guard, hash rejection, circuit-open rate, or fallback
rate stops progression until explained. Compare Memory and Knowledge p50/p95
latency and error rates over the same observation window; neither subsystem may
borrow the other's error budget. Diagnostic output must never include the
stored opaque request ID itself, raw row identity, owner, query, or document
text.

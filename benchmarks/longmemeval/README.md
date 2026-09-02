# AIQSA LongMemEval adapter

This directory runs the official cleaned LongMemEval-S benchmark through the
normal AIQSA chat-history Memory path. The upstream repository, dataset, and
`evaluate_qa.py` stay byte-for-byte unchanged and are pinned by commit,
revision, and SHA-256 in `upstream.json`. Generated downloads and results are
ignored by Git.

The qualification profiles use an explicitly selected reviewed System Model
for the answer and structured Memory roles. `gpt-5.6-luna` remains the frozen
codex-lb comparison, while the current answer-time matrix also pins DeepSeek
V4 Flash, GLM 5.3 Flash, and Gemini 3.7 Flash through OpenRouter. The latter
three runs select only their native endpoint (`deepseek`, `z-ai/fp8`, or
`google-vertex/global`) and disable provider fallback.
`qwen/qwen3-embedding-8b` through OpenRouter handles document and query
embeddings. The current qualification freezes the dedicated reranker route as
Voyage Rerank 2.5, Cohere Rerank 4 Pro, then Qwen3 Reranker 8B; every fallback
restarts the whole logical rerank so model score scales are never mixed. The
`official` profile intentionally disables
automatic fact learning and pattern synthesis so the result measures recall
from imported chat history and remains comparable with the upstream oracle.
Each official timestamped session becomes one ordinary source chat;
when an external session ends on a user turn, the adapter appends one
content-free completed assistant settlement envelope so it can enter the same
completed-source lifecycle as an ordinary chat. Every official turn remains
byte-for-byte unchanged, and the summary records the number of such envelopes.
The final question is submitted through AIQSA's normal HTTP run-admission path.

Official-profile replays keep a crash-safe prepared-case snapshot in this
disposable benchmark database. Its identity covers the exact source sessions,
applied schema migrations, import/history projection contracts, and governed
System Model used to derive history, while deliberately excluding reader,
packer, retrieval, and reranker versions. The fast-model matrix may therefore
promote a completely settled Luna snapshot to an answer-time model without
re-importing chats, re-embedding documents, or rebuilding the hybrid index;
the run summary marks that projection as `CACHED_PRIOR_SYSTEM_MODEL`. If a
settled compatible cache or READY hybrid generation is absent, the matrix
fails closed instead of silently reindexing. A PostgreSQL advisory lock
serializes each snapshot lifecycle. Every reuse validates the complete
imported message graph, provenance, READY history checkpoints, current hybrid
generation, and quiescent prior queries before admission. Question chats
remain `EXCLUDED`: their terminal run and immutable usage receipts are
retained for accounting but cannot become Memory sources, and a fresh auth
session is removed after every attempt. Product and forced Dream diagnostics
continue to use disposable one-run users because those profiles intentionally
mutate learned state.

The non-comparable `product` profile replays those same unchanged sessions
through the ordinary persisted-chat settlement lifecycle. It enables automatic
fact learning and forward-only Dream synthesis, waits for every expected fact
extraction, and then rebuilds and queries the complete Memory index. Normal
Dream admission follows product cadence: at least three eligible direct sources,
thirty quiet minutes, a twelve-hour hard cooldown after a previous successful
Dream, and either eight new evidence-bearing chats, twelve changed facts, or a
twenty-four-hour low-activity fallback. Historical LongMemEval timestamps may
correctly fall before the new benchmark user's first-enable boundary; in that
case the profile proves that no Dream call was admitted. Its
content-free summary records direct-user evidence, classification, eligible
source count, governed provider bindings, cleared recovery payloads, and—when
Dream runs—either classified patterns with at least three exact source
relations each or a structurally valid empty result. It never inserts
benchmark-selected facts or rerolls an unchanged source set to force a
model-authored pattern.

`--force-dream-diagnostic` is an explicit product-only inspection mode, kept in
a separate output directory and never treated as official-comparable evidence.
For only the disposable benchmark owner it moves the Dream opt-in boundary to
one millisecond before the earliest unchanged source session, lets extraction
finish normally, and invokes the production scheduler at its first legitimate
quiet/fallback due point. It does not alter source text, extraction, clustering,
minimum pattern evidence, prompts, or product policy. A secret-screened ignored
`dream-diagnostic-*.json` artifact records current direct facts, safe evidence,
generated patterns, and every exact `SYNTHESIZED_FROM` source so grounding can
be reviewed manually before the disposable user is deleted.

The overlay has an explicit compose name, container names, network names,
volume names, database identity, and loopback-only ports. Its defaults are app
`3137`, PostgreSQL `55437`, OpenSearch `19237`, MinIO `19100`, and MinIO console
`19101`; it does not share state with the default development installation.
The frozen reader-first qualifications run Memory lexical retrieval on OpenSearch-primary
and keeps PostgreSQL fallback available, but any observed fallback, dirty
projection, or non-OpenSearch candidate-provider lane fails that case before
judging. Canonical exact/entity and deferred digest authority lanes remain
PostgreSQL and are reported separately from this cutover health. The
benchmark overlay runs at most eight Memory jobs globally and four per
benchmark user. The
per-user bound preserves provider parallelism without building a same-owner
commit queue or an embedding burst large enough to make transport outcomes
ambiguous. The policy supports higher ceilings for controlled load tests, but
they are not the reliability qualification profile.
The runner imports up to sixteen sessions per case concurrently and runs up
to two independent cases concurrently by default;
case and session concurrency are bounded to thirty-two and sixteen respectively.

## Run a qualification case

Download and verify the pinned upstream artifacts:

```bash
./benchmarks/longmemeval/download.sh
```

Bootstrap the isolated database once, then start the long-lived app. The app
generates the current Prisma client and deploys migrations on every start, but
deliberately does not rerun seed: an app restart must preserve an in-flight
benchmark user's non-empty Memory generation. The benchmark overlay also uses
a bounded 4 GiB container with a 2.5 GiB Node old-space ceiling and restarts
the same app automatically after an OOM/process exit.
It explicitly binds PostgreSQL 18 data to
`aiqsa-memory-benchmark-second_postgres18_dev_data`; a legacy PostgreSQL 16
volume must be logically upgraded, never mounted into the PostgreSQL 18
container. Restored prepared sources are promoted to the current cache
fingerprint only after the runner verifies the exact transcript, query
isolation, every active history projection version, and every successful
history execution-binding version. Its hybrid generation is reused only when
the active revision, every retrieval/chunk/contextual version, embedding
deployment/document-vector-space identity, and every entry state match the
current runtime contract. An exact historical execution snapshot may prove a
metadata-only embedding configuration change compatible; a real document-space
change rebuilds that layer. OpenSearch is always reconstructed from the
canonical PostgreSQL outbox.

After a logical restore and its migrations, quarantine unfinished derived work
before the first app start. The command fails closed for non-benchmark owners,
active query runs, or unexpected job kinds; settled source and hybrid cache
remain untouched:

```bash
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml run --rm -T --no-deps app \
  npx tsx benchmarks/longmemeval/prepareRestoredCache.ts \
  --confirm RESTORED_PREPARED_CACHE
```

```bash
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml run --rm -T app sh -c "npm run db:migrate:deploy && npm run db:seed"
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml up -d app memory-search-worker
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts ensure
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts prepare-memory-qualification
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts select-memory-system-model gpt-5.6-luna
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts select-memory-embedding qwen/qwen3-embedding-8b
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml exec -T app npx tsx .aiqsa/local-dev-profile/cli.ts select-memory-reranker voyageai/rerank-2.5
```

Do not repeat the bootstrap command while benchmark users exist. Restart only
the app with `docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f
benchmarks/longmemeval/docker-compose.yml restart app`; its durable Memory jobs
remain authoritative and are reclaimed only after their existing leases expire.

Run one deterministically selected LongMemEval-S case. Both acknowledgements
are deliberate guards for paid provider traffic and disposable state:

```bash
AIQSA_MEMORY_BENCHMARK_ACK=DISPOSABLE_PAID_LONGMEMEVAL \
AIQSA_MEMORY_EGRESS_CONSENT_MODE=ADMIN \
AIQSA_MEMORY_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/aiqsa_memory_benchmark?schema=public' \
npx tsx benchmarks/longmemeval/run.ts --confirm-paid DISPOSABLE --sample-size 1
```

FU-09's original content-free selection remains frozen as the provenance-only
`qualifications/fu09-blind-50-v1.json`. Reader-first `v1` through `v12` preserve
the earlier diagnostic, pre-resolver, interrupted, Luna, and 9-second fast-model
comparison waves.
The current matrix reuses the exact 50 case IDs across all six upstream
categories and freezes the official profile, OpenSearch-primary lexical
retrieval, the ordered three-model reranker route and per-model floors, case
concurrency two, session concurrency sixteen, and all other runtime bounds.
Each manifest binds the same Git `HEAD` and deterministic executable-worktree
digest; only the answer-time model/provider differs:

- `fu2-reader-first-blind-50-v13`: DeepSeek V4 Flash 0731 via `deepseek`.
- `fu2-reader-first-blind-50-v14`: GLM 5.3 Flash via `z-ai/fp8`.
- `fu2-reader-first-blind-50-v15`: Gemini 3.7 Flash via `google-vertex/global`.

The active matrix gives both System Model utilities a 20-second provider
window inside a 26-second Memory envelope. The resolver remains speculative
and is never awaited at the final pack boundary. Incorrect official-evaluator
labels are journaled and counted without stopping the next two-case wave;
runtime failures, non-`USED` Memory, and unhealthy lexical cutover still stop
admission.

These are frozen dated model IDs (not the mutable Gemini `latest` alias).
Selection or runtime override flags are rejected when a manifest is present.
Run each manifest with the exact lexical environment below:

```bash
AIQSA_MEMORY_LEXICAL_BACKEND=OPENSEARCH \
AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID=20260831-lme-v7-r2 \
AIQSA_MEMORY_BENCHMARK_ACK=DISPOSABLE_PAID_LONGMEMEVAL \
AIQSA_MEMORY_EGRESS_CONSENT_MODE=ADMIN \
AIQSA_MEMORY_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/aiqsa_memory_benchmark?schema=public' \
npx tsx benchmarks/longmemeval/run.ts --confirm-paid DISPOSABLE \
  --qualification-manifest fu2-reader-first-blind-50-v13 \
  --output results/fu2-reader-first-blind-50-v13
```

Repeat the same command with `v14`/`v15` and matching output directories for
GLM and Gemini. The manifests select only the named native provider and do not
authorize cross-provider fallback. The old single-Qwen manifest and reader-first
`v1` through `v9` fail closed for new runs. Paid/disposable guards remain
mandatory and no manifest authorizes provider traffic by itself.

Use repeated `--question-id ID` arguments for an explicit ad hoc set, or combine
`--sample-size N --seed SEED` for another reproducible qualification sample.
Use `--case-concurrency N` and `--session-concurrency N` to lower either
bounded concurrency limit; the defaults are `2` and `16` respectively.
Use `--system-model gpt-5.6-sol` only after selecting that exact active
codex-lb System Model in the disposable profile. Omitting the flag preserves
the `gpt-5.6-luna` default. The flag does not mutate provider configuration:
the runner fails closed unless its allowlisted model, the installation policy,
the authenticated catalog, and the governed runtime binding all agree, and the
actual selected model is recorded in the summary.
Pass `--profile product` only for the full non-comparable automatic-learning
and Dream replay described above. The default remains `official`.
Add `--force-dream-diagnostic` to that product command only when the explicit
historical-data Dream inspection described above is intended.

Add `--debug-memory` only for an explicitly disposable diagnostic run. The
runner then captures the secret-screened normalized pre-provider request, prepared
Personal Memory context, selected items in order, source-session mapping,
chat digests, per-session history checkpoint/job/chunk status, governed
history and retrieval executions, and answer binding before the benchmark
user is deleted. Each `memory-debug-*.json` artifact receives a final recursive
recognized-secret screen and is written under the ignored result directory
with mode `0600`; the flag is off by default, and debug data never enters
`run-summary.json` or normal logs.
The runner writes only sanitized accounting and model-binding evidence beside
`answers.jsonl` under `benchmarks/longmemeval/results/`; it does not log chat
content or hypotheses. Aggregate lane/candidate/evidence-root flow,
query-variant and fallback counts, retrieval decisions, bounded failure reason
codes, pack budgets, embedding batch sizes, utility latency classes, and
per-role peak provider concurrency are retained so throttling and context loss
can be diagnosed without retaining private Memory text. Every summary records
the fixed pre-SOTA baseline configuration and the active versioned retrieval
configuration for comparison.

Each terminal case is first written atomically to its private mode-`0600`
`case-checkpoints/QUESTION_ID.json` journal. A retry appends another attempt
with its bounded reason code and effective case/session concurrency instead of
overwriting the earlier diagnosis. Only after the checkpoint is durable does
the runner emit `case_complete` or `case_failed`; at batch completion it rebuilds
`answers.jsonl` in frozen selection order from the latest attempt for each case.
Resume an interrupted run with the identical selection, semantic runtime, and
output directory by adding `--resume`. Terminal cases are skipped by default;
add `--retry-unhealthy` to rerun only execution failures, completed non-`USED`
Memory outcomes, or failed OpenSearch cutover evidence while retaining every
prior attempt. `--single-wave` admits at most one fixed case-concurrency wave,
emits `benchmark_paused` after that wave settles, and exits without producing a
premature aggregate. Repeat it with `--resume` after an app-only restart to keep
the development-server heap bounded without changing the checkpoint identity
or durable prepared cache. For an explicitly internal,
non-leaderboard resume, `--resume-case-concurrency N` may change only independent
case scheduling; the override is recorded in the summary and every attempt.
These resume controls do not weaken the paid/disposable guards or permit any
other qualification-manifest override.

The active qualification judges each completed answer immediately with the
unchanged official evaluator and atomically binds the private verdict to the
answer hash and checkpoint attempt under `case-evaluations/`. A runtime
failure or unhealthy OpenSearch cutover observation stops admission of new
cases; an incorrect verdict remains visible and the next wave continues. On
resume, a missing verdict is recovered before new work, while an existing
verdict is never purchased again. A product-code change invalidates the frozen
worktree digest and requires a new homogeneous manifest. After all 50 cases
settle, build the aggregate without another provider call:

```bash
npx tsx benchmarks/longmemeval/evaluate.ts \
  benchmarks/longmemeval/results/fu2-reader-first-blind-50-v7/answers.jsonl \
  --reuse-case-evaluations
```

To verify the selected OpenRouter embedding deployment accepts a ten-input
batch without exposing input or vector content, run the guarded capability
probe against the disposable stack:

```bash
AIQSA_ENCRYPTION_KEY='QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=' \
AIQSA_MEMORY_BENCHMARK_ACK=DISPOSABLE_PAID_LONGMEMEVAL \
AIQSA_MEMORY_EGRESS_CONSENT_MODE=ADMIN \
AIQSA_MEMORY_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-memory-benchmark-dev-password@127.0.0.1:55437/aiqsa_memory_benchmark?schema=public' \
npx tsx benchmarks/longmemeval/probe-embedding-batch.ts
```

The current durable `EMBED_ITEMS` job contract still owns one item, execution
receipt, retry decision, and usage record per job. Provider batch capability
alone does not authorize cross-job batching; that optimization requires a
durable batch ownership/accounting contract rather than opportunistically
sharing a request.

If AIQSA cannot produce an answer because indexing, retrieval, or generation
fails, the adapter records the sanitized engine failure in `run-summary.json`
and exits nonzero. `evaluate.ts` runs the unchanged official evaluator only on
real model answers, then adds every recorded execution failure to the aggregate
denominator as a hard incorrect result. This avoids both silently omitting a
failure and letting an abstention judge mistake an empty response for a correct
abstention. The resulting aggregate is written to `benchmark-score.json`.

Oracle correctness is independent from runtime health. The runner records a
content-free qualification gate and exits nonzero unless every completed case
has `memoryOutcome=USED`; `DEGRADED`, `FAILED_SAFE`, `EMPTY`, and `DISABLED`
all block qualification. The evaluator reports the gate independently without
changing the unchanged upstream label or accuracy. Such a result must be
diagnosed and rerun cleanly rather than accepted because its answer happened
to score correctly. Every answer summary and `case_complete` event also carries
the nullable content-free `memoryDegradationCode`, so an operator can
distinguish a query-embedding fallback from lexical, vector, or authority
failures without exposing query or Memory content.

Install the official evaluator dependencies and grade the answer with the
upstream `gpt-4o-2024-08-06` evaluator:

```bash
./benchmarks/longmemeval/setup-evaluator.sh
npx tsx benchmarks/longmemeval/evaluate.ts benchmarks/longmemeval/results/RUN/answers.jsonl --concurrency 16
```

`setup-evaluator.sh` installs the unchanged upstream `requirements-lite.txt`
in an ignored virtual environment. It additionally locks `httpx` to `0.27.2`,
the compatible transport line for the upstream evaluator's pinned OpenAI SDK.
The launcher round-robin shards hypotheses across up to sixteen unchanged
official evaluator processes by default (bounded to thirty-two), suppresses
their raw question/answer/hypothesis console output, validates complete unique
coverage, and merges results back into answer order. The canonical official
output is written next to `answers.jsonl` only after every shard succeeds and
will not be overwritten by the launcher.

Stop this stack with the same two compose files. Add `--volumes` only when the
benchmark database and object store are intentionally disposable:

```bash
docker compose -p aiqsa-memory-benchmark-second -f docker-compose.dev.yml -f benchmarks/longmemeval/docker-compose.yml down
```

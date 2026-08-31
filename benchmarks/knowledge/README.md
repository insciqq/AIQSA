# AIQSA public Knowledge retrieval benchmark

This directory is an opt-in benchmark workspace. It is not part of the normal
product tests: the root Vitest lanes never include it, and nothing here runs
in CI. Downloaded corpora, normalized documents, embeddings caches, ingestion
state, PostgreSQL benchmark volumes, and run results stay in local ignored
paths (`.data/`, `results/`, and the compose volumes) and are never committed.

Two public suites run through the complete retrieval path — HTTP upload
ingestion, chunking, PostgreSQL/pgvector indexing, the derived OpenSearch BM25
projection, query embedding, the configured installation reranker when available,
and the single hybrid retrieval repository operation
of an accepted `search_knowledge` call — with no answer generation:

- `RusBEIR / rus-SciFact / test` — the full official corpus (5,183 documents)
  and all 300 official test queries with the official qrels, pinned to
  `kaengreg/rus-scifact` `75b33d32f2f13f058d0598d6d78f0c3d3afc03d9` and
  `kaengreg/rus-scifact-qrels` `5e0c312c9fb7304a2dc91ec7fd648b3ace5c329f`.
- `T2-RAGBench / ConvFinQA / turn_0` — the full official ConvFinQA subset,
  pinned to `G4KMU/t2-ragbench` `adf7fe1541ac37351ce1142544d8e3b43010ed92`.
  The corpus deduplicates all 3,458 rows only by the official `context_id`
  (all 1,806 unique contexts become Markdown documents whose body is the
  official `context` field, which already carries the Markdown table). The
  pinned artifact contains five rows with an empty `question`; they remain in
  corpus construction but cannot be retrieval queries without fabricating
  text. The scoreable set is therefore the deterministic 3,453 rows with a
  non-blank official question, and every run freezes both the five-row
  exclusion count and a hash of the exact admitted query/relevance set. The
  relevant document of a query is exactly its `context_id`. The published
  artifact has no train/dev/test split for
  ConvFinQA — `turn_0` is the only official query split, so results are
  labeled `turn_0` and never called a "test split" score. Neither suite result
  may be presented as a score of the whole RusBEIR or T2-RAGBench benchmark.

MIRACL is intentionally excluded; no MIRACL adapter, subset, or derivative
exists here.

## OpenRAG answer reliability

`openRagAnswerRunner.ts` is the answer/judge and frozen-evidence harness for
the pinned 100-PDF OpenRAG slice. Unlike the isolated public retrieval suites
above, it is intended to attest and reuse an already healthy local development
Base through the ordinary authenticated chat API. It never uploads,
reprocesses, retrieves directly from a repository, or grants source authority
from benchmark metadata. The private profile attestation must name the same
active 100-source Base and profile revision found by product admission.

The runner binds exactly one `gpt-5.6-luna` answer deployment and one
`gpt-5.6-sol` judge deployment on the explicitly supplied codex-lb connection.
It freezes their full admitted execution-snapshot hashes, the Base/source
snapshot, the full reranker deployment snapshot, parser/chunking/ranking
identities, answer/judge control fingerprints, the runner and judge contracts,
and all grounding contract versions before the first paid request. The local
session token is read from `AIQSA_OPENRAG_SESSION_TOKEN` or the ignored
local-development profile; it is never printed or stored in a result.
An OpenRouter-backed retrieval reranker is refused unless a separate explicit
paid-run authority is supplied; the answer/judge acknowledgement alone does
not authorize it. Frozen replay does not invoke retrieval or a reranker.

The live answer lane attests the current V21 Draft / V17 Selector / Auditor V1 /
settlement V6 candidate and refuses to run while the code-owned V21 rollout is
not at 100%. This prevents a V20 product answer from being reported under a V21
manifest. Keep that activation candidate unpublished until the acceptance gate
passes; frozen replay remains available while the production default is V20.

Run a focused, non-scoreable case first:

```bash
AIQSA_OPENRAG_DATABASE_URL='<loopback-development-database-url>' \
AIQSA_OPENRAG_CODEX_LB_CONNECTION_ID='<exact-local-connection-id>' \
npx tsx benchmarks/knowledge/openRagAnswerRunner.ts \
  --confirm-paid OPENRAG --case-id doc-027-q2 \
  --output .aiqsa/openrag-answer-runs/doc-027-q2-canary
```

`--case-id` is repeatable and `--repeat N` repeats every selected case.
Add `--preflight-only` to validate the dataset, ignored paths, session,
codex-lb pins, and either the live Base/profile/source snapshot or the frozen
replay origin manifest without making a provider request or creating a
checkpoint.
`--judge-repeat N` is diagnostic: the first frozen judgment remains official
and later judgments never rewrite it. `--no-judge` runs answer-stage diagnosis
only. All of these modes are non-scoreable. A scoreable run requires exactly
the pinned 100 cases, one answer and one judge per case:

```bash
AIQSA_OPENRAG_DATABASE_URL='<loopback-development-database-url>' \
AIQSA_OPENRAG_CODEX_LB_CONNECTION_ID='<exact-local-connection-id>' \
npx tsx benchmarks/knowledge/openRagAnswerRunner.ts \
  --confirm-paid OPENRAG --full \
  --output .aiqsa/openrag-answer-runs/v21-full-1
```

After an infrastructure interruption, repeat that exact scoreable command
with `--resume`. Resume verifies the entire manifest and pacing identity,
preserves the original run id, skips only atomically settled passes, and
refuses a completed summary or a checkpoint containing a non-pass.

Execution is deliberately sequential and fail-fast. The first `partial`,
`fail`, judge error, or provider/infrastructure error prevents the next case
from starting. A non-pass run has no aggregate score; diagnose its immutable
stage evidence, implement a general product fix, and start a new uniformly
pinned run. Runtime code must never branch on a benchmark case id, document
alias, or reference answer.

Every settled case writes a hash-only resumable outcome plus a private replay
record containing the exact evidence dispatch, source/version/artifact
bindings, grounding contract versions, accepted grounding outputs, answer,
cited evidence, and judge raw result. Both output and replay input are
refused unless they are beneath ignored `.aiqsa/`,
`benchmarks/knowledge/.data/`, or `benchmarks/knowledge/results/` paths.

A judge/provider failure remains content-free in the public failure record;
when the answer stage completed, its private answer and replay snapshot are
still persisted for diagnosis before fail-fast exit.

Replay schema V2 preserves exact V20 recovery and supports the current V21
three-call normal path, five-call correction path, and six-call
repair-plus-correction cap. Replay runs answer-grounding and optional judge
stages only. Its origin
Base/source/engine pins come from the immutable snapshot, so no live Base or
retrieval state is consulted:

```bash
AIQSA_OPENRAG_DATABASE_URL='<loopback-development-database-url>' \
AIQSA_OPENRAG_CODEX_LB_CONNECTION_ID='<exact-local-connection-id>' \
npx tsx benchmarks/knowledge/openRagAnswerRunner.ts \
  --confirm-paid OPENRAG \
  --frozen-evidence .aiqsa/openrag-answer-runs/<run>/replay-snapshots/<case>.json \
  --output .aiqsa/openrag-answer-runs/<case>-replay
```

The current operator decision intentionally omits a fresh full V20 baseline;
focused V20 checkpoint/replay evidence is labeled as such and is not presented
as a directly comparable full score.

Anti-gaming rules are structural: both suites run one global ranking profile
(the product's), there are no dataset-name conditionals or language-specific
parameters, corpora and scoreable queries are used in full without sampling or
negative removal; the only exclusion is a manifest-pinned, content-independent
blank-query predicate. Every run freezes a manifest (dataset id + revision +
split, corpus and query-set content hashes, admitted/excluded query counts,
embedding/formatter/tokenizer/chunking/index/ranking identity, candidate
limits, reranker model or none, and an explicit run label).
`evaluate.ts` refuses to compare runs whose frozen dataset identities differ
or whose configuration labels collide. Ingestion is text/markdown only; the
runner asserts a zero OCR count (empty PDF-processing ledger and no
`low_ocr_confidence` warning) before recording a corpus as usable.

## Protocol

1. Download and verify the pinned datasets (refuses unpinned values):

```bash
./benchmarks/knowledge/download.sh
```

2. Start the isolated overlay stack (compose project
`aiqsa-knowledge-benchmark-second`; loopback-only app `3147`, PostgreSQL
`55447`, MinIO `19110`/`19111`; its own container, network, volume, and
database identities — it never shares state with the default development
installation):

```bash
docker compose -p aiqsa-knowledge-benchmark-second -f docker-compose.dev.yml -f benchmarks/knowledge/docker-compose.yml up -d app knowledge-search-worker
```

Then configure the installation Knowledge profile (the embedding model used
for indexing and queries) and, when desired, the Knowledge reranking model on
this disposable stack through the ordinary Admin path. Knowledge base creation
fails closed with `knowledge_temporarily_unavailable` until an index profile is
active. Retrieval remains deterministic when the reranker role is empty and
records fallback metrics when a configured reranker is unavailable.

OpenSearch is not corpus authority and is not restored from a benchmark backup.
After a PostgreSQL logical restore, rebuild only the derived projection with
`npm run knowledge:search:rebuild` inside the isolated app topology and require
`npm run knowledge:search:integrity` to report healthy before retrieval. This
does not upload, parse, OCR, or re-embed any document.

3. Ingest each suite through the product HTTP boundary. The acknowledgement
environment variable and the CLI flag are deliberate guards for paid
embedding traffic against disposable state; ingestion resumes from
`.data/state/` if interrupted, and batches respect
`AIQSA_KNOWLEDGE_MAX_BATCH_FILES`:

```bash
AIQSA_KNOWLEDGE_BENCHMARK_ACK=DISPOSABLE_PAID_KB \
AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-knowledge-benchmark-dev-password@127.0.0.1:55447/aiqsa_knowledge_benchmark?schema=public' \
npx tsx benchmarks/knowledge/ingest.ts --confirm-paid DISPOSABLE --suite rusbeir-rus-scifact

AIQSA_KNOWLEDGE_BENCHMARK_ACK=DISPOSABLE_PAID_KB \
AIQSA_KNOWLEDGE_BENCHMARK_DATABASE_URL='postgresql://aiqsa_benchmark:aiqsa-knowledge-benchmark-dev-password@127.0.0.1:55447/aiqsa_knowledge_benchmark?schema=public' \
npx tsx benchmarks/knowledge/ingest.ts --confirm-paid DISPOSABLE --suite t2ragbench-convfinqa
```

4. Run the retrieval-only diagnostic inside the app container once per suite
and explicit configuration label (query embeddings are cached under
`.data/cache/` keyed by the frozen manifest, never by query text). For the
current integrated engine use `C`; this label is only manifest identity and is
not a product runtime mode:

```bash
docker compose -p aiqsa-knowledge-benchmark-second -f docker-compose.dev.yml -f benchmarks/knowledge/docker-compose.yml exec -T \
  -e AIQSA_KNOWLEDGE_BENCHMARK_ACK=DISPOSABLE_PAID_KB app \
  npx tsx benchmarks/knowledge/retrieve.ts --confirm-paid DISPOSABLE \
  --suite rusbeir-rus-scifact --config C
```

Each full run writes sanitized aggregates only —
`results/<run-id>/summary.json` (metrics plus the frozen manifest) and
`results/<run-id>/rankings.json` (official public dataset ids plus content-free
reranker status, timeout, and normalized fallback code). No query text,
document text, or private content reaches result files, file names, or the
console. `--query-limit N` exists solely as a plumbing smoke and refuses to
write a scoreable summary. `--query-id <official-public-id>` selects one exact
public query for a low-load diagnostic retry; it is also non-scoreable and
cannot be combined with `--query-limit`. Retrieval concurrency defaults to
`1`; raise `--concurrency` only after a small provider- and host-load canary.
Query starts default to a provider-safe 30-second interval, and a normalized
429 defers future independent queries for 120 seconds. Override these with
`--query-start-interval-ms` and `--rate-limit-cooldown-ms` only after a canary;
neither mechanism retries or changes the settled result of a failed query.

For a long scoreable run, use a stable isolated output directory. Every
completed query is atomically checkpointed there with public ids, metrics, and
content-free diagnostics only. After an interruption, repeat the exact command
with `--resume`; the runner verifies the complete manifest and scheduling
identity, preserves the original run id, and admits only missing queries:

```bash
# Initial full run
npx tsx benchmarks/knowledge/retrieve.ts --confirm-paid DISPOSABLE \
  --suite t2ragbench-convfinqa --config C \
  --output results/t2ragbench-convfinqa-C-live

# Same frozen run after an interruption
npx tsx benchmarks/knowledge/retrieve.ts --confirm-paid DISPOSABLE \
  --suite t2ragbench-convfinqa --config C \
  --output results/t2ragbench-convfinqa-C-live --resume
```

`--resume` is accepted only for a full scoreable suite with explicit output.
It refuses changed manifests, concurrency/pacing, corrupted outcomes, and a run
that already has `summary.json`.

For iterative failure diagnosis, repeat `--query-id` to run only those exact
public query ids together in one non-scoreable batch. Duplicate ids and mixing
an explicit id list with `--query-limit` are rejected. The non-scoreable-only
`--diagnostic-disable-reranker` switch replays that bounded subset through the
same hybrid candidate path without the hosted rerank stage, making a stable
candidate-recall failure distinguishable from a reranker ordering failure.
`--diagnostic-candidate-audit` instead keeps the configured reranker and emits
only the public relevant-document rank within its complete pre-settlement
candidate order; it never prints query text, passage text, or internal ids.

5. Optional: compare two deliberately captured frozen configurations. The
current task does not require or claim a baseline comparison; a standalone
full-run summary is a diagnostic snapshot, not a relative quality claim.

```bash
npx tsx benchmarks/knowledge/evaluate.ts \
  benchmarks/knowledge/results/<runA-scifact>/summary.json \
  benchmarks/knowledge/results/<runA-convfinqa>/summary.json \
  benchmarks/knowledge/results/<runC-scifact>/summary.json \
  benchmarks/knowledge/results/<runC-convfinqa>/summary.json \
  --baseline A --candidate C
```

Stop the stack with the same two compose files; add `--volumes` only when the
benchmark database and object store are intentionally disposable:

```bash
docker compose -p aiqsa-knowledge-benchmark-second -f docker-compose.dev.yml -f benchmarks/knowledge/docker-compose.yml down
```

## Configuration labels

`A`, `B`, and `C` are immutable benchmark run labels retained by the comparison
contract; they do not switch product behavior. `retrieve.ts` always executes
the current engine configuration and freezes its embedding, tokenizer,
ranking, and reranker identities. It records actual per-query rerank duration,
usage, and fallback status. For this branch, use `C` for current-engine
diagnostics; no `A` baseline run is required by the operator decision.

## Tests

The contract module (manifest validation, document normalization, metrics,
comparison guards) is covered by hermetic unit tests with tiny synthetic
fixtures — no network, no database, no dataset files:

```bash
npx vitest run --config benchmarks/knowledge/vitest.config.ts
```

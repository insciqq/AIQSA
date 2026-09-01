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

The live answer lane attests current Snapshot V31 over Draft V21 / blind
Coverage Scope V6 / query-granularity, epistemic-fidelity, answer-level
compression, and server-issued request-anchor IDs preserving append-only Scope
Completeness V1 / Selector V21 / Scope Closure V1 / settlement V6 and refuses
to run while the code-owned
`v21_scope_v6` rollout is not at 100%. This prevents a historical V20 product
answer from being reported under a V31 manifest. Keep that activation candidate
unpublished until the acceptance gate passes; frozen replay remains available.
The current replay pin is Snapshot V31 / Grounding Evidence V47 with the
`scope_v6_completeness_v1_targeted_delta_v4_repair_budget_v1_claim_surface_v1_target_groups_v1_claim_markup_boundaries_v1_selector_support_edges_v1_collective_target_support_v1_scope_repair_feedback_v1_target_closure_v1_verified_scope_patch_v1_scope_closure_v1_repair_reserved_correction_v2_source_ordered_context_v1_least_authority_delta_v1_fail_closed_local_provenance_v1_final_delta_repair_v1_supplement_atomization_v1_scope_multi_diagnostic_repair_v1_selector_repair_diagnostic_v1_fail_closed_selector_edges_v2_adaptive_atomic_supplement_budget_v1_query_intent_completeness_v1_query_granularity_epistemic_fidelity_v1_answer_level_compression_v1_request_anchor_ids_v1`
pipeline. It retains delimiter-aware claim validation and deterministic removal
of only provenance-disjoint surplus support edges. Expanded passages use
persisted content-free boundaries and Source ordinals to build atoms in trusted
`previous -> exact -> next` Source order; provider-facing labels are never
parsed as ordering metadata. During the bounded delta pass, Supplement and the
final verifier receive only the complete atoms assigned to their exact targets.
The final verifier receives no full manifest, literal index, unrelated atom
ledger, or primary Draft text; it rechecks each target hypothesis and every
supplemental statement's semantic roles, beneficiary, and risk/value-flow
direction. A false-positive positive target may be vetoed to `excluded`, while
an evidence-free requested facet never enters correction and cannot be hidden.
Supplement itself must split independently falsifiable subordinate, relative,
comparative, conditional, causal, enabling, purpose, and consequence relations
into standalone claims. Supported component facts do not authorize an unstated
connector or explanation. Supplement capacity now scales with the exact target
count inside the existing 24-claim complete-Draft and eight-dimension Scope
bounds: no target receives more than three atomic slots, remaining primary
claims may reduce capacities fairly, and every `maxClaims` is a ceiling rather
than a quota. Every supplemental claim is then adjudicated
atomically, while an ordered set of
supported claims bound to the same target may collectively entail one compound
Scope dimension. Unknown, foreign-target, unrelated, redundant, partial-case,
or unsupported edges still fail closed. When validation proves that a local
finding cites an atom owned by another evidence unit, Snapshot V31 retains
V30's inherited V26 rule and drops that
entire finding and revalidates the remaining Scope; it never filters or remaps
atom IDs. This applies both before repair and when another verified patch
exposes the violation, and consumes no model retry. Every other repairable Scope
failure receives a bounded validator-ordered set of every independently
detectable stable-path error code, JSON path, expected handle, and applicable
count bound, plus a content-free hash of any
transient structurally bounded repair base. The server applies replacement
values only at independently rejected paths and revalidates after each patch;
all fields outside those paths remain unchanged. The rejected provider payload
is neither copied into the repair request nor persisted by the product, and
recovery without its transient base fails closed. Container repairs whose shape
could invalidate descendant paths deliberately retain first-error feedback.
All diagnostics are handled by the existing single repair call, so this adds no
operation. Snapshot V25 kept its initial Scope pass byte-exact with V24 and used
the multi-diagnostic envelope only after initial rejection; V29 appends its
query-intent contract without changing the underlying payload. V30 appends
query-granularity and epistemic-fidelity rules to the same Scope, completeness,
Supplement, and Selector payloads. V31 appends answer-level compression rules
to those same payloads so broad key points prefer a source-stated summary over
an unrequested subordinate inventory. Its Scope and completeness prompts also
receive a bounded server-authored ledger of exact request fragments with `Q...`
IDs. The model selects an ID instead of copying control-plane identity text; the
server resolves known IDs to immutable request substrings before the unchanged
V6 anchor validator. Unknown IDs and unrelated literals still fail closed, and
the resolver performs no semantic matching, filtering, or promotion. The
initial Selector still receives the same
least-authority evidence projection. Only when its
coverage map fails deterministic structural validation does the existing repair
call receive a content-free diagnostic with the stable JSON path, expected D
identity or count, and permitted K handles. The rejected claim IDs, support IDs,
claim text, and provider payload are neither echoed nor persisted. This repair
cannot change semantic authority or add an operation. Before validation, the
server also removes only duplicate, unknown,
provenance-disjoint, or status-forbidden Selector support edges whose invalidity
is proven from the immutable ID/provenance graph. If a `covered` dimension has
no valid edge left, it is downgraded to `missing`; it is never promoted,
remapped, or supplied with a server-chosen edge. Genuine shape, D-ID, order, or
status errors still take the bounded repair path. This normalization consumes
no model operation and the fully normalized payload must pass the unchanged
Selector validator. The independent least-authority Scope Closure pass sees
only covered Scope items and their mapped
supported-answer projection. It may veto `covered` back to `missing` when a
material qualifier, condition, comparison, or conjunct is absent, but cannot
promote a target, change evidence eligibility, or inspect unrelated evidence.
The five-operation path and any path with one adjacent structural repair retain
both calls for one targeted correction under the eight-call cap. A second repair
may consume that reserve; it never creates another correction loop. When every
exact-target supplemental claim is supported only by that target's provenance
but the first final map still leaves the target missing, Snapshot V31 retains
V30's bounded review, records a
content-free validation failure and uses the eighth slot for one fresh
target-only final verifier. It never promotes coverage, reuses the rejected
payload as evidence, or retries twice; the second valid result may remain
partial. Snapshot V29 preserves the exact request's semantic
operator in both blind Scope and its existing append-only completeness audit.
For `why`/`how`/explanation requests, a premise or conclusion restatement is not
complete: Scope must retain the evidence-backed connector, or record the
requested facet as unsupported. This changes no schema, server semantic
authority, retrieval, or model-operation count. Snapshot V30 additionally
treats the eight-dimension bound as a ceiling, keeps broad non-exhaustive
requests at the smallest non-overlapping high-importance answer granularity,
and preserves source-side belief, expectation, conjecture, possibility,
limitation, unknown, attribution, and omitted-proof status through correction
and verification. A literal fragment cannot synthesize a broad relation. These
are model-owned relevance and entailment rules with no new schema, retrieval,
server semantic inference, or model operation. Snapshot V31 / Evidence V47
additionally reduce a broad answer to the smallest source-explicit proposition
set while preserving material uncertainty, conditions, contradictions, and
co-equal key points. Examples, rows, parameter values, proof steps, and exception
inventories remain required only when explicitly requested or independently
answer-bearing. Scope and completeness choose server-issued request-anchor IDs
that are deterministically resolved before historical validation. This uses the
existing Scope/Supplement/Selector reducer and adds no schema, retrieval, server
semantic inference, or model operation.
Snapshot V30 / Evidence V46 retain query granularity and epistemic fidelity
without answer-level compression. Snapshot V29 / Evidence V45
retain query-intent preservation without these rules. Snapshot V28 / Evidence V44
retain adaptive atomic Supplement capacity without this query-intent contract.
Snapshot V27 / Evidence V43 retain the historical flat 12-claim
Supplement allocation with fail-closed Selector edge normalization. Snapshot
V26 / Evidence V42 retain repair-only Selector diagnostics
without fail-closed unknown-edge normalization. Snapshot V25 / Evidence V41
retain multi-diagnostic Scope repair
without repair-only Selector diagnostics. Snapshot V24 / Evidence V40 retain
atomic Supplement publication with
historical first-diagnostic Scope repair. Snapshot V23 / Evidence V39 retain
the final-delta review without atomic Supplement publication. Snapshot V22 / Evidence V38 retain
fail-closed local provenance without
this final-delta review. Snapshot
V20 / Evidence V36 retain trusted Source order with the historical full-context
final Selector. Snapshot V21 / Evidence V37 retain target-only least-authority
verification without deterministic local provenance rejection. Snapshot
V18 / Evidence V34 retain the original seven-call Scope-closure budget, while
Snapshot V17 / Evidence V33 retain verified patch merging without this semantic
closure veto; Snapshot V16 / Evidence V32 retain target closure without
verified patch merging; Snapshot V15 / Evidence
V31 retain structured Scope repair without target closure;
Snapshot V14 / Evidence V30 retain the historical collective target-support contract,
while Snapshot V13 / Evidence V29 retain the historical
single-claim whole-target delta contract; Snapshot V12 / Evidence V28 retain
the historical all-or-nothing edge validation.

Run a focused, non-scoreable case first:

```bash
AIQSA_OPENRAG_DATABASE_URL='<loopback-development-database-url>' \
AIQSA_OPENRAG_CODEX_LB_CONNECTION_ID='<exact-local-connection-id>' \
npx tsx benchmarks/knowledge/openRagAnswerRunner.ts \
  --confirm-paid OPENRAG --case-id doc-027-q2 \
  --output .aiqsa/openrag-answer-runs/doc-027-q2-canary
```

`--case-id` is repeatable and `--repeat N` repeats every selected case.
The current V31 acceptance campaign always supplies exactly five distinct
`--case-id` values and never dispatches `--full`. Each five-case run is
sequential, fail-fast, and non-scoreable; a corpus result may be assembled only
after all twenty batches share the exact frozen pins and every case has settled.
Add `--preflight-only` to validate the dataset, ignored paths, session,
codex-lb pins, and either the live Base/profile/source snapshot or the frozen
replay origin manifest. Frozen replay preflight also locks the exact admitted
credential version and proves that its envelope is decryptable by the runner's
trusted runtime. It rejects a replay whose inherited stage reasoning effort
does not match the answer-control fingerprint or whose explicit override is
unsupported by the admitted model. This validation makes no provider/network
request and creates no checkpoint.
`--judge-repeat N` is diagnostic: the first frozen judgment remains official
and later judgments never rewrite it. `--no-judge` runs answer-stage diagnosis
only. All of these modes are non-scoreable. A future monolithic scoreable run
would require exactly the pinned 100 cases, one answer and one judge per case,
but this command is not used by the current five-case acceptance campaign:

```bash
AIQSA_OPENRAG_DATABASE_URL='<loopback-development-database-url>' \
AIQSA_OPENRAG_CODEX_LB_CONNECTION_ID='<exact-local-connection-id>' \
npx tsx benchmarks/knowledge/openRagAnswerRunner.ts \
  --confirm-paid OPENRAG --full \
  --output .aiqsa/openrag-answer-runs/v29-full-1
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
cited evidence, and judge raw result. Frozen-evidence replay additionally
captures each raw structured provider payload before server validation, so a
rejected operation remains diagnosable. Raw payloads stay out of product
persistence and content-safe outcomes; private artifacts are written mode
`0600`. Both output and replay input are
refused unless they are beneath ignored `.aiqsa/`,
`benchmarks/knowledge/.data/`, or `benchmarks/knowledge/results/` paths.

A judge/provider failure remains content-free in the public failure record.
When replay raises after a provider response, a non-enumerable error envelope
carries the partial accepted stages and every returned raw payload, including
the rejected stage, into the private failure checkpoint before fail-fast exit.
When the answer stage completed, its private answer and replay snapshot are
likewise persisted if the judge fails.

Replay schema V2 preserves exact V20 recovery and supports the current V31
five-call `Draft -> blind Scope -> append-only completeness -> Selector -> Scope Closure`
normal path, one adjacent structural validation repair for Scope, completeness,
initial Selector, or Scope Closure, and an eight-call hard cap that keeps both
correction slots available after any one repair. It also accepts the bounded
`Supplement -> final Selector -> final Selector repair` suffix described above.
Scope and
completeness never receive Draft or Selector
content. It reviews the exact bounded atom ledger grouped by evidence handle,
returns one record per handle containing zero or more local findings that are
already final Scope dimensions, plus bounded cross-handle joint findings and
explicit unsupported request facets. The server validates exact unit identity,
atom provenance, anchors, and bounds, then materializes every finding losslessly;
there is no negative-atom echo or second model-owned positive-to-Scope reduction.
Completeness re-reviews the complete atom ledger against the exact request and
accepted Scope, returns additions only, and cannot delete or rewrite an accepted
item. Selector receives a de-duplicated exact-text index for the atoms assigned
to merged Scope and independently filters positive findings whose descriptions are not
entailed by those atoms or are not material direct requirements of the request.
Those findings are `excluded` from correction, settlement, and the coverage
denominator. A requested unsupported facet has no atom IDs and can never be
excluded; it remains `missing`.
A repair receives unchanged authority inputs plus only bounded content-safe
validator feedback and an optional transient-base hash. Its candidate is merged
only at server-rejected paths and revalidated after every replacement; provider
failures are not retried. Correction starts
only when both remaining calls fit. Every supplemental candidate names exactly
one initially missing positive Scope target and carries no model-owned
provenance. The final Selector independently
chooses factual support and enforces immutable target provenance. Supplement's
sole factual input is a complete bounded D-to-exact-atom projection derived
from the accepted Scope; the full manifest, unrelated handles, and primary
Draft are absent. It returns only exact D-keyed claim groups, while the server
derives advisory Draft handles from each target's atoms. The strict request-specific
schema requires one non-empty bounded claim group for every exact target D and
derives a fair target-count-aware atomic capacity from the remaining complete-
Draft budget, so an early target cannot consume a later target's required slot.
The server flattens accepted groups in
immutable Scope order. An oversized projection disables correction instead of
being truncated. This performs no retrieval or semantic server reduction. It
is a delta:
the accepted base, including Scope eligibility, remains immutable and a target
can close only through its own supported supplemental claim. Completeness pins
the exact initial Scope hash; Selector and every later request pin the canonical
merged Scope hash. Selector coverage requires each
covered support ID to overlap that immutable scope through canonical evidence
handles. Replay
runs answer-grounding and optional judge stages only. Its origin
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

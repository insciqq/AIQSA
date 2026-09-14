# Personal Memory acceptance

This suite tests user expectations independently of the engine's current limits.
The frozen corpus has 60 synthetic Russian/English scenarios: ten each for
acquisition, updates, retrieval, uncertainty, management, and isolation. Each
category contains seven development and three reserved acceptance scenarios.
The runner verifies the canonical corpus hash before any provider call.

Sources enter through ordinary authenticated chat sends. Positive fact checks
use the native semantic service behind MCP `search_memories`; answer checks use
ordinary new chats. Old-reference checks use the existing owner-scoped consumer
read used by MCP; an unavailable service is not proof of deletion. These service
checks do not attest OAuth or MCP transport.
The UI's inventory text filter is not a semantic retrieval benchmark.
New identities start with a completed HYBRID rebuild. Probe chats read with
Memory enabled and are then excluded through the product lifecycle, with jobs
and deletions settled before the next check. Excluding a chat before the probe
would disable the Memory read being measured.

Facts and answers receive separate semantic verdicts from a memory-disabled
judge. Positive/negative calibration controls must pass first. Deterministic
ownership, reference deletion, and state-preservation checks supplement the
semantic judge. Missing preconditions do not prove deletion. Failed jobs,
`FAILED_SAFE`, degradation, and failed native-search utility execution remain
visible and cannot count as healthy passes. Model judging still has uncertainty;
calibration does not establish a perfect judge.

Answer grading requires the details requested by the question; background
details in the storage rubric need not be volunteered. A non-default test
account is explicitly identified to the judge so labels such as `other` are
not mistaken for an unrelated person. Default-account fact grading and the
FactConsolidation scorer retain their original protocol. Reports record these
prompt identities separately. Regrade saved original answers with
`regradeAnswers.ts --ack DISPOSABLE_PAID_AIQSA_MEMORY_ACCEPTANCE --from results/original --output results/regraded`;
this creates a separate report and never regenerates answers or changes original
fact verdicts, health, timings or critical evidence.

Acceptance requires every expected check, at least 90% passing scenarios
overall, 90% in the reserved partition, and 80% in each category, plus all
critical checks and healthy execution. At case concurrency one, p95/maximum
latency limits are 120/300 seconds from source send to settled searchable state,
10/26 seconds for native search, and 60/180 seconds for an answer. Judge and
cleanup time are excluded from answer/search latency. Source completion is a
conservative upper bound on time to searchable memory. Smoke subsets never
qualify the complete suite.

The primary profile is Sol with medium reasoning, Qwen3 embedding 8B and Voyage
rerank 2.5. The driver verifies the actual active configurations and records a
fingerprint, execution health, provider-reported usage, revisions, and timings.
The frozen installation admission timeout is 15 seconds, matching the actual
initial migrated profile; it is checked separately from the model fingerprint.
Do not silently replace it with a newer schema default during a comparison.
Use fresh identities on every complete run. Preserve all attempts; do not select
the best reroll. Keep reserved results aggregate while selecting fixes. A
reserved case disclosed for tuning becomes regression evidence, not blind proof.
The [Terra control](control-selection.json) freezes twelve development scenarios,
two per category, selected by a score-independent hash. Its one fresh-source
repeat requires at least eleven passing scenarios, all critical proofs, healthy
execution, the primary latency bounds and no confirmed systemic failure. Select
Terra as the installation System Model and pass `--model gpt-5.6-terra` for that
run. A separate Memory-off Sol identity grades both native facts and answers;
the report records its configuration fingerprint and usage separately. The full
Sol protocol is still the primary acceptance.

Run only against an explicitly acknowledged disposable stack, with the same
private credential encryption and search routing configuration as its app:

```bash
AIQSA_TEST_MODE=1 npx tsx benchmarks/aiqsa-memory-live-microbench/acceptance/run.ts \
  --ack DISPOSABLE_PAID_AIQSA_MEMORY_ACCEPTANCE --output results/acceptance-run
```

Required environment: `AIQSA_MEMORY_ACCEPTANCE_BASE_URL`,
`AIQSA_MEMORY_ACCEPTANCE_DATABASE_URL`, `AIQSA_MEMORY_BENCHMARK_APP_PORT`, and
`AIQSA_MEMORY_BENCHMARK_POSTGRES_PORT`. Guards require loopback and the disposable
`aiqsa_memory_benchmark` database/`aiqsa_benchmark` role. Results stay ignored with
private permissions. Use `--partition development` or `--ids id1,id2` for
diagnosis; `--model gpt-5.6-terra` requires an explicitly qualified matching
control profile. Tests: `npm run test:benchmark:memory`.

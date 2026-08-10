# Native Memory Evaluation Corpus

This directory owns the synthetic, offline Phase 0 corpus. The TypeScript
generators are authoritative; the JSON files under `manifests/` freeze their
canonical hashes and sanitized aggregate evidence. No production chat, raw
provider body, credential, or private user datum is permitted here.

`tuning/corpus.ts` exposes only the `TUNING` family. The `HOLDOUT` loader is a
separate fail-closed boundary that requires `SCORING_ONLY` and the exact corpus
version. “Blind” means that tuning loaders and benchmark adapters cannot import
or consume HOLDOUT fixtures. Holdout scenario copy lives only under `holdout/`;
shared modules contain schemas and generation mechanics, not holdout copy.
“Blind” is not a claim that repository readers cannot inspect source code.

A fixture text, expectation, grouping, or source-ID change invalidates the
frozen hash. Such a change must create a new corpus/generator version and new
manifests while preserving prior baseline evidence. Template/entity siblings
remain in one `groupId`, tuning and holdout families remain group-disjoint, and
the two families use non-overlapping synthetic case-number ranges.
The 20 critical RU/EN cohorts have 20 HOLDOUT cases per language; 12 additional
general lifecycle families cover archive/exclusion/resume, hard delete,
Temporary, failure degradation, index and branch fences, account deletion,
public sharing, historical snapshots, and scoped-target deletion.

The current v2 corpus replaces the former per-request exact-confirmation label
with destination authorization and removes the two disclosure invariants
superseded by the accepted Search/tool coexistence policy. The v1 manifests
remain immutable archaeology and baseline evidence.

The public-benchmark directory contains synthetic behavior probes, not copied
benchmark examples. See `benchmarks/ATTRIBUTION.md` for pinned provenance and
license decisions. Its aggregates remain separate from AIQSA holdout evidence
and are never official leaderboard-comparable results.

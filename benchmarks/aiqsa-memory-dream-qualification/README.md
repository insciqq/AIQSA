# Dream/PATTERN qualification

This suite is separate from official LongMemEval. Its deterministic mode runs
the fixed eight positive and sixteen negative/adversarial cases through the
production Dream plan/output contracts and final reader pack. It also reruns
lifecycle fixtures after addition, contradiction, supersession, and deletion,
and emits a safe source/PATTERN graph plus synthetic manual-audit records.

Run the deterministic suite without containers, network, or provider access:

```bash
npx tsx benchmarks/aiqsa-memory-dream-qualification/run.ts
```

`live.ts` exposes `collectDreamLiveProviderAudit` for a disposable runner to
bind to the governed production provider. It requires the literal
`EXPLICIT_PAID_PROVIDER_RUN` consent and defaults to four fixed trials. The
collector never marks its own output reviewed: keep the resulting JSON under
the ignored `results/` directory with mode 0600, manually fill verdict and
failure taxonomy, then evaluate it with:

```bash
npx tsx benchmarks/aiqsa-memory-dream-qualification/run-live-audit.ts \
  benchmarks/aiqsa-memory-dream-qualification/results/reviewed-audit.json
```

The live gate requires at least 30 non-empty reviewed proposals, precision of
at least 95%, and unsupported-generalization rate at most 5%. Lower volume,
pending reviews, or weaker quality remains guarded rather than passing. The
printed live report is content-free; pattern statements and source refs remain
only in the ignored local audit input.

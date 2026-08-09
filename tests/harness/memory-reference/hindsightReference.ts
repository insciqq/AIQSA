import type {
  MemoryEvaluationAdapter,
  MemoryEvaluationExecutor,
  MemoryEvaluationSystemFingerprint
} from "../../../lib/evaluation/memory/contracts";

const exactRelease = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const exactCommit = /^[a-f0-9]{7,40}$/u;

export type HindsightReferenceAdapterOptions<Input> = Readonly<{
  enabled?: boolean;
  fingerprints: readonly MemoryEvaluationSystemFingerprint[];
  run: MemoryEvaluationExecutor<Input>;
  upstreamVersion: string;
}>;

export function createHindsightReferenceAdapter<Input>(
  input: HindsightReferenceAdapterOptions<Input>
): MemoryEvaluationAdapter<Input> {
  if (!exactRelease.test(input.upstreamVersion) && !exactCommit.test(input.upstreamVersion)) {
    throw new Error("memory_hindsight_reference_unpinned");
  }
  const enabled = input.enabled === true;
  return {
    adapterVersion: `hindsight-${input.upstreamVersion}`,
    fingerprints: input.fingerprints,
    kind: "HINDSIGHT_REFERENCE",
    liveProvider: false,
    run: async (fixture, context) => {
      if (!enabled) throw new Error("memory_hindsight_reference_disabled");
      if (
        fixture.dataClass !== "SYNTHETIC" &&
        fixture.dataClass !== "APPROVED_PUBLIC_BENCHMARK"
      ) {
        throw new Error("memory_hindsight_reference_data_rejected");
      }
      return input.run(fixture, context);
    }
  };
}

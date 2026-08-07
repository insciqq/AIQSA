export type InFlightValidationWorkloadRegistration = Readonly<{
  release(): void;
}>;

export type InFlightValidationWorkloadRegistry = Readonly<{
  register(generationToken: string): InFlightValidationWorkloadRegistration;
  snapshot(): string[];
}>;

export function createInFlightValidationWorkloadRegistry(): InFlightValidationWorkloadRegistry {
  const referenceCounts = new Map<string, number>();

  return {
    register(generationToken) {
      referenceCounts.set(generationToken, (referenceCounts.get(generationToken) ?? 0) + 1);
      let live = true;

      return {
        release() {
          if (!live) return;
          live = false;
          const remaining = (referenceCounts.get(generationToken) ?? 0) - 1;
          if (remaining > 0) {
            referenceCounts.set(generationToken, remaining);
          } else {
            referenceCounts.delete(generationToken);
          }
        }
      };
    },
    snapshot() {
      return [...referenceCounts.keys()].sort();
    }
  };
}

type ValidationWorkloadRegistryGlobal = typeof globalThis & {
  __aiqsaInFlightValidationWorkloadRegistry?: InFlightValidationWorkloadRegistry;
};

export function getDefaultInFlightValidationWorkloadRegistry(): InFlightValidationWorkloadRegistry {
  const scope = globalThis as ValidationWorkloadRegistryGlobal;
  scope.__aiqsaInFlightValidationWorkloadRegistry ??=
    createInFlightValidationWorkloadRegistry();
  return scope.__aiqsaInFlightValidationWorkloadRegistry;
}

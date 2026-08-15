const runGlobals = globalThis as unknown as {
  __aiqsaActiveRunControllers?: Map<string, AbortController>;
  __aiqsaRunBootSweepState?: {
    bootedAt: Date;
    promise?: Promise<void>;
  };
};

export function activeRunControllersForTest(): Map<string, AbortController> {
  runGlobals.__aiqsaActiveRunControllers ??= new Map();
  return runGlobals.__aiqsaActiveRunControllers;
}

export function resetBootOrphanSweepForTest(bootedAt = new Date()): void {
  runGlobals.__aiqsaRunBootSweepState ??= { bootedAt };
  runGlobals.__aiqsaRunBootSweepState.bootedAt = bootedAt;
  runGlobals.__aiqsaRunBootSweepState.promise = undefined;
}

const runGlobals = globalThis as unknown as {
  __aiqsaActiveRunControllers?: Map<string, AbortController>;
};

export function activeRunControllersForTest(): Map<string, AbortController> {
  runGlobals.__aiqsaActiveRunControllers ??= new Map();
  return runGlobals.__aiqsaActiveRunControllers;
}

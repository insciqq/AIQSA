export function memoryIndexGenerationBootstrapAllowed(value: Readonly<{
  activeGenerationExists: boolean;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
  settingsLockHeld: boolean;
}>): boolean {
  return !value.activeGenerationExists &&
    value.indexMode === "LEXICAL_ONLY" &&
    value.settingsLockHeld;
}

/** Stored micro-dollars are estimates, including a known zero. Missing cost
 * stays unavailable; integer thresholds avoid rounding across format bands. */
export function formatEstimatedCostMicros(micros: number | null): string {
  if (micros === null || !Number.isSafeInteger(micros) || micros < 0) return "—";
  if (micros < 10_000) return "≈ <$0.01";
  return `≈ $${(micros / 1_000_000).toFixed(micros < 1_000_000 ? 3 : 2)}`;
}

export function costCoverageNote(knownCostRecordCount: number, recordCount: number): string | null {
  return knownCostRecordCount > 0 && knownCostRecordCount < recordCount
    ? `cost known for ${knownCostRecordCount.toLocaleString("en-US")} of ${recordCount.toLocaleString("en-US")} requests`
    : null;
}

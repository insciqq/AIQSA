import { createHash } from "node:crypto";

/** Content-free receipts. A known numeric subtotal is not complete usage. */
export type ActivationUsageReceipt = Readonly<{
  usageCompleteness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostMicros: number | null;
  operationCount: number | null;
}>;

export function summarizeActivationUsage(receipts: readonly ActivationUsageReceipt[]) {
  const fields = ["inputTokens", "outputTokens", "totalTokens", "estimatedCostMicros"] as const;
  const sums = Object.fromEntries(fields.map(field => {
    const reported = receipts.filter(receipt => receipt[field] !== null);
    const knownSum = reported.reduce((sum, receipt) => sum + receipt[field]!, 0);
    const complete = receipts.length > 0 && receipts.every(receipt =>
      receipt.usageCompleteness === "COMPLETE" && receipt[field] !== null);
    return [field, { total: complete ? knownSum : null, knownSum,
      reported: reported.length, missing: receipts.length - reported.length }];
  })) as Record<typeof fields[number], { total: number | null; knownSum: number; reported: number; missing: number }>;
  const reportedOperations = receipts.filter(receipt => receipt.operationCount !== null);
  const paidRequestCounts = { knownSum: reportedOperations.reduce((sum, receipt) => sum + receipt.operationCount!, 0),
    reported: reportedOperations.length, missing: receipts.length - reportedOperations.length };
  return { ...sums, recordCount: receipts.length, paidRequestCounts,
    incompleteRecordCount: receipts.filter(receipt => receipt.usageCompleteness !== "COMPLETE").length,
    paidRequests: receipts.length && receipts.every(receipt => receipt.operationCount !== null)
      ? paidRequestCounts.knownSum : null };
}

export type ActivationAccounting = ReturnType<typeof summarizeActivationUsage>;

export function projectActivationAccounting(value: ActivationAccounting): ActivationAccounting {
  const count = (number: unknown): number => {
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new Error("accounting_count_invalid");
    return number;
  };
  const recordCount = count(value.recordCount), incompleteRecordCount = count(value.incompleteRecordCount);
  if (incompleteRecordCount > recordCount) throw new Error("accounting_count_invalid");
  const fields = ["inputTokens", "outputTokens", "totalTokens", "estimatedCostMicros"] as const;
  const projected = Object.fromEntries(fields.map(field => {
    const item = value[field];
    const knownSum = count(item.knownSum), reported = count(item.reported), missing = count(item.missing);
    const total = item.total === null ? null : count(item.total);
    if (reported + missing !== recordCount || reported === 0 && knownSum !== 0 || total !== null &&
      (recordCount === 0 || total !== knownSum || incompleteRecordCount > 0 || missing > 0)) throw new Error("accounting_total_invalid");
    return [field, { total, knownSum, reported, missing }];
  })) as Pick<ActivationAccounting, typeof fields[number]>;
  const paidRequests = value.paidRequests === null ? null : count(value.paidRequests);
  const paidRequestCounts = { knownSum: count(value.paidRequestCounts.knownSum), reported: count(value.paidRequestCounts.reported),
    missing: count(value.paidRequestCounts.missing) };
  if (paidRequestCounts.reported + paidRequestCounts.missing !== recordCount ||
    paidRequestCounts.reported === 0 && paidRequestCounts.knownSum !== 0 || paidRequests !== null &&
    (recordCount === 0 || paidRequestCounts.missing > 0 || paidRequests !== paidRequestCounts.knownSum)) throw new Error("accounting_total_invalid");
  return { ...projected, recordCount, incompleteRecordCount, paidRequests, paidRequestCounts };
}

type BackgroundProfile = {
  system: { providerModelId: string | null; chatTitleProviderModelId: string | null;
    decisionProviderModelId: string | null; rerankerProviderModelId: string | null } | null;
  memory: { providerModelId: string | null } | null;
  memoryEmbeddingDefault: string | null;
};
export function requireActivationBackgroundProfile(profile: BackgroundProfile): void {
  if (!profile.system || !profile.memory || profile.memory.providerModelId !== null || profile.memoryEmbeddingDefault !== null ||
    [profile.system.providerModelId, profile.system.chatTitleProviderModelId,
      profile.system.decisionProviderModelId, profile.system.rerankerProviderModelId].some(value => value !== null)) {
    throw new Error("background_provider_profile_required");
  }
}

/** Hash only explicitly selected non-secret configuration/receipt fields. */
export function activationEvidenceHash(value: unknown): string {
  const canonical = (item: unknown): unknown => item instanceof Date ? item.toISOString() : Array.isArray(item) ? item.map(canonical) :
    item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export type ActivationOwnedReceipt = ActivationUsageReceipt & { id: string; memoryExecutionBindingId: string | null };
export function activationReceiptHash(receipt: ActivationOwnedReceipt): string {
  return activationEvidenceHash({ usageCompleteness: receipt.usageCompleteness,
    inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, totalTokens: receipt.totalTokens,
    estimatedCostMicros: receipt.estimatedCostMicros, operationCount: receipt.operationCount,
    memoryExecutionBindingId: receipt.memoryExecutionBindingId });
}
export type ActivationBindingFact = { id: string; state: string; startedAt: Date | null };
export function requireActivationSettledWork(input: { activeToolCalls: number; dispatchedVisionAttempts: number }): void {
  if (input.activeToolCalls !== 0 || input.dispatchedVisionAttempts !== 0) throw new Error("provider_accounting_pending");
}
export function requireActivationAccountingBoundary(input: {
  receipts: readonly ActivationOwnedReceipt[]; bindings: readonly ActivationBindingFact[];
  recordedReceipts: Readonly<Record<string, string>>; recordedMemoryBindings: readonly string[];
}): void {
  if (input.bindings.some(binding => ["PENDING", "RUNNING"].includes(binding.state))) throw new Error("provider_accounting_pending");
  for (const receipt of input.receipts) {
    if (!Object.hasOwn(input.recordedReceipts, receipt.id)) throw new Error("unattributed_provider_accounting");
    if (input.recordedReceipts[receipt.id] !== activationReceiptHash(receipt)) throw new Error("provider_accounting_changed");
  }
  if (input.bindings.some(binding => binding.startedAt !== null && !input.recordedMemoryBindings.includes(binding.id))) {
    throw new Error("provider_accounting_receipt_missing");
  }
}

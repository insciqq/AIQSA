import {
  providerStreamSafetyReport,
  type ProviderStreamSafetyReport
} from "./streamSafety";

export type ProviderStreamSafetyIdentity = Readonly<{
  adapterKind: string;
  connectionId: string;
  providerFamily: string;
  providerModelId: string;
}>;

const warnedSafetyValues = new WeakSet<object>();

function objectValue(value: unknown): object | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? value as object
    : null;
}

function warningAlreadyEmitted(value: unknown, report: ProviderStreamSafetyReport): boolean {
  const candidate = objectValue(value);
  return (candidate ? warnedSafetyValues.has(candidate) : false) || warnedSafetyValues.has(report);
}

function markWarningEmitted(value: unknown, report: ProviderStreamSafetyReport): void {
  const candidate = objectValue(value);
  if (candidate) warnedSafetyValues.add(candidate);
  warnedSafetyValues.add(report);
}

export function warnProviderStreamSafetyOnce(
  value: unknown,
  identity: ProviderStreamSafetyIdentity
): boolean {
  const report = providerStreamSafetyReport(value);
  if (!report || warningAlreadyEmitted(value, report)) {
    return false;
  }

  markWarningEmitted(value, report);
  try {
    console.warn(JSON.stringify({
      adapterKind: identity.adapterKind,
      code: report.code,
      connectionId: identity.connectionId,
      durationMs: report.durationMs,
      event: "provider_stream_safety_terminated",
      limit: report.limit,
      observed: report.observed,
      providerFamily: identity.providerFamily,
      providerModelId: identity.providerModelId,
      termination: report.termination,
      totalStreamBytes: report.totalStreamBytes,
      unit: report.unit
    }));
  } catch {
    // Observability must never replace the typed provider failure.
  }
  return true;
}

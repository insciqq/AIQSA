export type ProviderCredentialSource = string | (() => Promise<string>);

export function assertProviderCredentialSource(
  source: ProviderCredentialSource,
  missingCode: string
): void {
  if (typeof source === "string" && !source.trim()) {
    throw new Error(missingCode);
  }
}

export async function resolveProviderCredentialSource(
  source: ProviderCredentialSource,
  missingCode: string
): Promise<string> {
  const secret = typeof source === "string" ? source : await source();
  const normalized = secret.trim();
  if (!normalized) {
    throw new Error(missingCode);
  }
  return normalized;
}

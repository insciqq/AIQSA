import type { AdminSamlMetadata, AdminSamlMetadataRequest } from "@/lib/contracts/samlSignIn";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SamlMetadataLoadResult = { metadata: AdminSamlMetadata; ok: true } | { error: string; ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeMetadata(value: unknown): AdminSamlMetadata | null {
  const metadata = isRecord(value) ? value.metadata : null;
  if (!isRecord(metadata) || typeof metadata.entityId !== "string" || typeof metadata.ssoUrl !== "string" ||
    !Array.isArray(metadata.certificates) || !metadata.certificates.length) {
    return null;
  }
  const certificates = metadata.certificates.filter((certificate): certificate is AdminSamlMetadata["certificates"][number] =>
    isRecord(certificate) && typeof certificate.pem === "string" && typeof certificate.validTo === "string");
  return certificates.length === metadata.certificates.length
    ? { certificates, entityId: metadata.entityId, ssoUrl: metadata.ssoUrl }
    : null;
}

/** Asks the server to read IdP metadata (pasted or from a URL); nothing is saved. */
export async function loadSamlMetadata(body: AdminSamlMetadataRequest, fetcher: Fetcher = fetch): Promise<SamlMetadataLoadResult> {
  try {
    const response = await fetcher("/api/admin/sign-in/saml/metadata", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return { error: isRecord(value) && typeof value.error === "string" ? value.error : "metadata_invalid", ok: false };
    }
    const metadata = decodeMetadata(value);
    return metadata ? { metadata, ok: true } : { error: "metadata_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

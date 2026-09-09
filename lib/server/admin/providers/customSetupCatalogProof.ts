import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "aiqsa:custom-responses-catalog:v1";
const MAX_AGE_MS = 5 * 60 * 1_000;

type ProofPayload = Readonly<{
  detectedCodexLb: boolean;
  endpoint: string;
  expiresAt: number;
  userId: string;
  credentialHash: string;
}>;

function mac(key: string, payload: string): string {
  return createHmac("sha256", Buffer.from(key, "utf8"))
    .update(`${DOMAIN}:${payload}`, "utf8")
    .digest("base64url");
}

function credentialHash(secret: string | null): string {
  return createHash("sha256").update(secret ?? "", "utf8").digest("base64url");
}

export function createCustomSetupCatalogProof(input: {
  key: string;
  userId: string;
  endpoint: string;
  secret: string | null;
  responsesRequestIsolationDetected: boolean;
  now?: number;
}): string {
  const payload: ProofPayload = {
    detectedCodexLb: input.responsesRequestIsolationDetected,
    endpoint: input.endpoint,
    expiresAt: (input.now ?? Date.now()) + MAX_AGE_MS,
    userId: input.userId,
    credentialHash: credentialHash(input.secret)
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${mac(input.key, encoded)}`;
}

export function verifyCustomSetupCatalogProof(input: {
  key: string;
  proof: string;
  userId: string;
  endpoint: string;
  secret: string | null;
  now?: number;
}): { detectedCodexLb: boolean } | null {
  const [encoded, providedMac, ...rest] = input.proof.split(".");
  if (!encoded || !providedMac || rest.length > 0 || encoded.length > 8_192 || providedMac.length > 256) return null;
  const expectedMac = mac(input.key, encoded);
  const actual = Buffer.from(providedMac, "utf8");
  const expected = Buffer.from(expectedMac, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Partial<ProofPayload>;
  if (
    typeof payload.detectedCodexLb !== "boolean" ||
    typeof payload.endpoint !== "string" ||
    typeof payload.expiresAt !== "number" ||
    typeof payload.userId !== "string" ||
    typeof payload.credentialHash !== "string" ||
    payload.expiresAt < (input.now ?? Date.now()) ||
    payload.userId !== input.userId ||
    payload.endpoint !== input.endpoint ||
    payload.credentialHash !== credentialHash(input.secret)
  ) return null;
  return { detectedCodexLb: payload.detectedCodexLb };
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Proof that a run-gateway request came through the Workspace runner relay,
 * the guests' only route to it. The app refuses a request without a valid
 * proof before its bearer is looked up, so a run bearer taken out of a guest
 * is useless from the public ingress. Only the app and the runner hold the
 * runner token; the proof is keyed by a purpose-separated key derived from
 * it, never by the token itself.
 */
export const AGENT_RELAY_PROOF_HEADER = "x-aiqsa-agent-relay-proof";
/** Largest accepted distance between the relay's timestamp and the app clock. */
export const AGENT_RELAY_PROOF_MAX_SKEW_SECONDS = 60;

const KEY_DOMAIN = "aiqsa:agent-relay-proof-key:v1";
const MAC_DOMAIN = "aiqsa:agent-relay-proof:v1\0";
// `v1.<unix seconds>.<base64url HMAC-SHA256>`; nothing else is accepted.
const PROOF_PATTERN = /^v1\.([1-9][0-9]{9})\.([A-Za-z0-9_-]{43})$/u;
const PROOF_MAX_LENGTH = 64;
// The runner refuses to start with a shorter token.
const RUNNER_TOKEN_MIN_LENGTH = 32;

export type AgentRelayProofSubject = Readonly<{
  /** The run bearer the request carries; only its digest enters the proof. */
  bearer: string;
  method: string;
  /** Gateway endpoint below `/api/internal/agent/`, for example `mcp`. */
  path: string;
}>;

/** Null without a usable runner token: every proof check then fails closed. */
export function agentRelayProofKey(runnerToken: string | undefined): Buffer | null {
  const token = runnerToken?.trim();
  if (!token || token.length < RUNNER_TOKEN_MIN_LENGTH) return null;
  return createHmac("sha256", Buffer.from(token, "utf8")).update(KEY_DOMAIN, "utf8").digest();
}

function proofMac(key: Buffer, subject: AgentRelayProofSubject, timestamp: string): Buffer {
  const bearerDigest = createHash("sha256").update(subject.bearer, "utf8").digest("base64url");
  return createHmac("sha256", key).update(MAC_DOMAIN, "utf8")
    .update(JSON.stringify([subject.method, subject.path, timestamp, bearerDigest]), "utf8")
    .digest();
}

export function signAgentRelayProof(key: Buffer, subject: AgentRelayProofSubject, nowMs = Date.now()): string {
  const timestamp = String(Math.floor(nowMs / 1000));
  return `v1.${timestamp}.${proofMac(key, subject, timestamp).toString("base64url")}`;
}

/** Constant-time check; any malformed, stale, foreign or keyless proof is false. */
export function verifyAgentRelayProof(
  key: Buffer | null,
  proof: string | null,
  subject: AgentRelayProofSubject,
  nowMs = Date.now()
): boolean {
  if (!key || !proof || proof.length > PROOF_MAX_LENGTH) return false;
  const match = PROOF_PATTERN.exec(proof);
  if (!match) return false;
  const [, timestamp, encodedMac] = match;
  if (Math.abs(Number(timestamp) - Math.floor(nowMs / 1000)) > AGENT_RELAY_PROOF_MAX_SKEW_SECONDS) return false;
  const provided = Buffer.from(encodedMac, "base64url");
  const expected = proofMac(key, subject, timestamp);
  return provided.toString("base64url") === encodedMac && provided.length === expected.length &&
    timingSafeEqual(provided, expected);
}

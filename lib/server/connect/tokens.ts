import { createHmac, randomBytes, randomInt } from "node:crypto";
import { CONNECT_USER_CODE_ALPHABET } from "@/lib/contracts/connect";
import { hashToken } from "../auth/token";

const DEVICE_TOKEN_PREFIX = "aiqsa_connect_";
const USER_CODE_HASH_DOMAIN = "aiqsa:connect-user-code:v1\0";

export type IssuedConnectSecret = Readonly<{ hash: string; value: string }>;

/** A device bearer token: 256 random bits behind a recognizable prefix. Only its SHA-256 is stored. */
export function issueConnectDeviceToken(): IssuedConnectSecret {
  const value = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { hash: hashToken(value), value };
}

/** The secret a pairing client polls with: 256 random bits. Only its SHA-256 is stored. */
export function issueConnectPollSecret(): IssuedConnectSecret {
  const value = randomBytes(32).toString("base64url");
  return { hash: hashToken(value), value };
}

/** A pairing code `XXXX-XXXX`, each character drawn uniformly from the unambiguous alphabet. */
export function generateConnectUserCode(): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    if (index === 4) code += "-";
    code += CONNECT_USER_CODE_ALPHABET[randomInt(CONNECT_USER_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The stored form of a normalized pairing code. A code has about 39 bits, so
 * a plain digest could be reversed from a database copy within its lifetime;
 * the installation secret keys it, domain-separated like rate-limit keys.
 */
export function hashConnectUserCode(userCode: string, secret: string): string {
  if (!secret) throw new Error("connect_user_code_secret_unavailable");
  return createHmac("sha256", secret).update(USER_CODE_HASH_DOMAIN, "utf8").update(userCode, "utf8").digest("hex");
}

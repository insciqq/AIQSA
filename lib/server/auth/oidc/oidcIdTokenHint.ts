import { randomUUID } from "node:crypto";
import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import {
  decryptSecretEnvelope,
  encryptSecretEnvelope,
  type SecretEnvelopeContext
} from "../../secrets/envelope";
import type { SealedIdTokenHint } from "../requestAuth";

type OidcConfig = AuthSignInMethodConfig<"oidc">;

/**
 * The longest ID token a session keeps. The hint travels in the logout URL, and servers and
 * proxies commonly refuse request lines over 8 KiB; a longer token still signs in, and its
 * session logs out without a hint.
 */
export const OIDC_ID_TOKEN_HINT_MAX_LENGTH = 6 * 1024;

const PURPOSE = "auth_session_id_token_hint";
const VALUE_ID = "id_token";
/** The token plus its issuer and client (both bounded by the configuration) and the JSON around them. */
const MAX_PLAINTEXT_BYTES = 32 * 1024;

type StoredIdTokenHint = {
  clientId: string;
  idToken: string;
  issuer: string;
  version: 1;
};

/** Bound to the session: a ciphertext copied to another session's row never opens. */
function context(sessionId: string): SecretEnvelopeContext {
  return { ownerId: sessionId, purpose: PURPOSE, valueId: VALUE_ID };
}

function isStoredHint(value: unknown): value is StoredIdTokenHint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stored = value as Record<string, unknown>;
  return stored.version === 1 &&
    typeof stored.clientId === "string" &&
    typeof stored.issuer === "string" &&
    typeof stored.idToken === "string" &&
    stored.idToken.length > 0 &&
    stored.idToken.length <= OIDC_ID_TOKEN_HINT_MAX_LENGTH;
}

/**
 * Seals a validated sign-in's ID token for the session it is about to create, under a fresh
 * session id that the session is then created with. Null, so the session keeps nothing, when
 * the token is over the limit or the encryption key is unusable. Never throws.
 */
export function sealOidcIdTokenHint(input: {
  config: OidcConfig;
  idToken: string;
  key: () => Buffer;
}): SealedIdTokenHint | null {
  if (!input.idToken || input.idToken.length > OIDC_ID_TOKEN_HINT_MAX_LENGTH) return null;
  try {
    const sessionId = randomUUID();
    const stored: StoredIdTokenHint = {
      clientId: input.config.clientId,
      idToken: input.idToken,
      issuer: input.config.issuer,
      version: 1
    };
    const envelope = encryptSecretEnvelope(stored, input.key(), context(sessionId), {
      maxPlaintextBytes: MAX_PLAINTEXT_BYTES
    });
    return { envelope, sessionId };
  } catch {
    return null;
  }
}

/**
 * The ID token a session kept, for `id_token_hint` at its IdP logout only. Null when there is
 * none, it does not open (another session's ciphertext, a replaced key, a damaged value) or the
 * issuer or client changed since: a token never goes to an IdP that did not issue it. Never
 * throws, so logout goes on without the hint.
 */
export function openOidcIdTokenHint(input: {
  config: OidcConfig;
  hint: SealedIdTokenHint | null;
  key: () => Buffer;
}): string | null {
  if (!input.hint) return null;
  try {
    const stored = decryptSecretEnvelope<unknown>(input.hint.envelope, input.key(), context(input.hint.sessionId), {
      maxPlaintextBytes: MAX_PLAINTEXT_BYTES
    });
    return isStoredHint(stored) && stored.issuer === input.config.issuer && stored.clientId === input.config.clientId
      ? stored.idToken
      : null;
  } catch {
    return null;
  }
}

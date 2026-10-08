/** How long an AuthnRequest waits for its response. */
export const SAML_REQUEST_TTL_MS = 10 * 60_000;

const REQUEST_CAPACITY = 10_000;
const REPLAY_CAPACITY = 20_000;

export type SamlPendingRequest = {
  /** The admin version of the configuration that issued the request; a response is checked only under it. */
  activeVersion: number | null;
  expiresAt: number;
  /** The AuthnRequest's `IssueInstant`, which node-saml's request cache holds. */
  issuedAt: string;
  /** Where the sign-in continues, already `safeInternalPath`-checked. */
  nextPath: string;
};

export type SamlRequestStore = {
  issue(requestId: string, request: SamlPendingRequest): void;
  /** Removes and returns a live request: one response consumes it, whatever its outcome. */
  take(requestId: string): SamlPendingRequest | null;
};

export type SamlReplayCache = {
  /** Remembers an assertion until it expires; false when it was already seen. */
  remember(key: string, expiresAt: number): boolean;
};

/**
 * Pending AuthnRequests in process memory: AIQSA runs one replica, and a restart drops sign-ins
 * in flight. Bounded: past capacity the oldest request is dropped.
 */
export function createSamlRequestStore(input: { capacity?: number; now?: () => number } = {}): SamlRequestStore {
  const now = input.now ?? Date.now;
  const capacity = Math.max(1, input.capacity ?? REQUEST_CAPACITY);
  const pending = new Map<string, SamlPendingRequest>();

  return {
    issue(requestId, request) {
      const at = now();
      // Every request lives equally long, so insertion order is expiry order.
      for (const [id, entry] of pending) {
        if (entry.expiresAt > at && pending.size < capacity) break;
        pending.delete(id);
      }
      pending.set(requestId, request);
    },
    take(requestId) {
      const request = pending.get(requestId);
      if (!request) return null;
      pending.delete(requestId);
      return request.expiresAt > now() ? request : null;
    }
  };
}

/**
 * Assertion ids seen until their `NotOnOrAfter`, defense in depth behind single-use requests.
 * Bounded: when full, expired ids go first, then the oldest.
 */
export function createSamlReplayCache(input: { capacity?: number; now?: () => number } = {}): SamlReplayCache {
  const now = input.now ?? Date.now;
  const capacity = Math.max(1, input.capacity ?? REPLAY_CAPACITY);
  const seen = new Map<string, number>();

  return {
    remember(key, expiresAt) {
      const at = now();
      const known = seen.get(key);
      if (known !== undefined && known > at) return false;
      seen.delete(key);
      if (seen.size >= capacity) {
        for (const [id, expiry] of seen) {
          if (expiry <= at) seen.delete(id);
        }
        for (const id of seen.keys()) {
          if (seen.size < capacity) break;
          seen.delete(id);
        }
      }
      seen.set(key, expiresAt);
      return true;
    }
  };
}

type SamlSignInState = { replayCache: SamlReplayCache; requests: SamlRequestStore };

const SAML_SIGN_IN_STATE = Symbol.for("aiqsa.saml-sign-in-state.v1");
const slot = globalThis as typeof globalThis & { [SAML_SIGN_IN_STATE]?: SamlSignInState };

/**
 * The installation's SAML state. Process-global: the start route and the ACS are separate
 * bundles with their own module instances, and both must see the same pending requests.
 */
export function samlSignInState(): SamlSignInState {
  return slot[SAML_SIGN_IN_STATE] ??= { replayCache: createSamlReplayCache(), requests: createSamlRequestStore() };
}

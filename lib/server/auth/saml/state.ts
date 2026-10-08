/** How long an AuthnRequest waits for its response. */
export const SAML_REQUEST_TTL_MS = 10 * 60_000;
/** How long a validated response waits for the browser that started the sign-in. */
export const SAML_COMPLETION_TTL_MS = 2 * 60_000;

const REQUEST_CAPACITY = 10_000;
const COMPLETION_CAPACITY = 2_000;
const REPLAY_CAPACITY = 20_000;

export type SamlPendingRequest = {
  /** The admin version of the configuration that issued the request; a response is checked only under it. */
  activeVersion: number | null;
  /** SHA-256 of the binding nonce the initiating browser's cookie carries. */
  bindingHash: string;
  expiresAt: number;
  /** The AuthnRequest's `IssueInstant`, which node-saml's request cache holds. */
  issuedAt: string;
  /** Where the sign-in continues, already `safeInternalPath`-checked. */
  nextPath: string;
};

/** What a validated assertion asserts: the settlement input, nothing else of the response. */
export type SamlAssertedIdentity = {
  displayName: string;
  email: string | null;
  /** The groups attribute's values, exact; null when it is not configured or was not sent. */
  groups: string[] | null;
  subject: string;
};

/** A validated response waiting for the completion step of the browser that started it. */
export type SamlCompletedResponse = {
  activeVersion: number | null;
  bindingHash: string;
  expiresAt: number;
  identity: SamlAssertedIdentity;
  nextPath: string;
  /** The IdP entity id the identity is bound to. */
  source: string;
};

export type SamlRequestStore = {
  issue(requestId: string, request: SamlPendingRequest): void;
  /** Removes and returns a live request: one response consumes it, whatever its outcome. */
  take(requestId: string): SamlPendingRequest | null;
};

export type SamlCompletionStore = {
  put(requestId: string, completion: SamlCompletedResponse): void;
  /** Removes and returns a live result: one completion attempt consumes it, whatever its outcome. */
  take(requestId: string): SamlCompletedResponse | null;
};

export type SamlReplayCache = {
  /** Remembers an assertion until it expires; false when it was already seen. */
  remember(key: string, expiresAt: number): boolean;
};

/**
 * Single-use entries in process memory: AIQSA runs one replica, and a restart drops sign-ins
 * in flight. Bounded: past capacity the oldest entry is dropped. Every entry of one store lives
 * equally long, so insertion order is expiry order.
 */
function createSingleUseStore<Entry extends { expiresAt: number }>(input: { capacity: number; now: () => number }) {
  const capacity = Math.max(1, input.capacity);
  const entries = new Map<string, Entry>();
  return {
    put(key: string, entry: Entry) {
      const at = input.now();
      for (const [id, existing] of entries) {
        if (existing.expiresAt > at && entries.size < capacity) break;
        entries.delete(id);
      }
      entries.set(key, entry);
    },
    take(key: string): Entry | null {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      return entry.expiresAt > input.now() ? entry : null;
    }
  };
}

export function createSamlRequestStore(input: { capacity?: number; now?: () => number } = {}): SamlRequestStore {
  const store = createSingleUseStore<SamlPendingRequest>({ capacity: input.capacity ?? REQUEST_CAPACITY, now: input.now ?? Date.now });
  return { issue: store.put, take: store.take };
}

export function createSamlCompletionStore(input: { capacity?: number; now?: () => number } = {}): SamlCompletionStore {
  return createSingleUseStore<SamlCompletedResponse>({ capacity: input.capacity ?? COMPLETION_CAPACITY, now: input.now ?? Date.now });
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

type SamlSignInState = { completions: SamlCompletionStore; replayCache: SamlReplayCache; requests: SamlRequestStore };

const SAML_SIGN_IN_STATE = Symbol.for("aiqsa.saml-sign-in-state.v2");
const slot = globalThis as typeof globalThis & { [SAML_SIGN_IN_STATE]?: SamlSignInState };

/**
 * The installation's SAML state. Process-global: the start route, the ACS and the completion
 * step are separate bundles with their own module instances, and all must see the same entries.
 */
export function samlSignInState(): SamlSignInState {
  return slot[SAML_SIGN_IN_STATE] ??= {
    completions: createSamlCompletionStore(),
    replayCache: createSamlReplayCache(),
    requests: createSamlRequestStore()
  };
}

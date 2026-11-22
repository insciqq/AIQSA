import { createHmac, createSecretKey, randomBytes, randomUUID, type KeyObject } from "node:crypto";

/**
 * Stable gateway routing keys for model calls that never overlap
 * (`ProviderRunOptions.routingKey`). On a compatible Responses connection
 * with request isolation (Codex LB) every physical POST otherwise carries a
 * fresh `prompt_cache_key`: the gateway once handed concurrent requests that
 * shared a key on one upstream session each other's results. Fresh keys also
 * scatter a chat's requests over sessions, so its prompt cache never hits.
 *
 * A lane is a sequence of model calls of which never two are in flight at
 * once, such as a chat's agent loop (one active run per chat, rounds in
 * order). Its requests share one key: an HMAC of the chat, the lane and its
 * current replacement nonce under a random secret the process creates once, so the key
 * reveals no id. A failed request's fate upstream is unknown, so its lane
 * moves to a fresh random nonce and no later request shares the key it may
 * still hold; the move holds for `unsettledMs` after the lane's last failure,
 * longer than any request runs. A process starts its lanes over under its own
 * secret, so nothing a stopped process left running shares a key either, and
 * no installation secret is needed: keys never had to survive a restart.
 */
export const GATEWAY_ROUTING = Object.freeze({
  /** How long a failed request may still run upstream: its lane keeps a new key that long after its last failure. */
  unsettledMs: 30 * 60_000,
  /** Moved lanes kept before expired ones are swept. */
  sweepAt: 1_024
});

export type GatewayRoutingLane = Readonly<{
  /** The key the lane's next request carries. */
  key(): string;
  /** The lane's latest request failed: whatever it left upstream keeps its key, and the lane's later requests take another. */
  failed(): void;
}>;

type MovedLane = Readonly<{ nonce: string; until: number }>;
type Registry = Readonly<{ secret: KeyObject; moved: Map<string, MovedLane> }>;

const globalForGatewayRouting = globalThis as unknown as { __aiqsaGatewayRouting?: Registry };

/** Shared on `globalThis`, so every route bundle of the process uses one secret and moves a lane for all of them. */
function registry(): Registry {
  return globalForGatewayRouting.__aiqsaGatewayRouting ??= { secret: createSecretKey(randomBytes(32)), moved: new Map() };
}

/** A digest in the shape of the fresh keys (a version 4 UUID), so a gateway sees one format. */
function uuidShaped(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The lane `name` of chat `chatId`. Only a caller that never has two
 * requests of the lane in flight at once may use its key.
 */
export function gatewayRoutingLane(lane: Readonly<{ chatId: string; name: string }>, options: Readonly<{
  now?: () => number;
}> = {}): GatewayRoutingLane {
  const now = options.now ?? Date.now;
  const { secret, moved } = registry();
  const id = JSON.stringify([lane.chatId, lane.name]);
  /** The lane's current replacement for a failed request's key, or null for its first key. */
  const nonce = () => {
    const state = moved.get(id);
    if (!state) return null;
    if (state.until > now()) return state.nonce;
    moved.delete(id);
    return null;
  };
  return {
    key() {
      return uuidShaped(createHmac("sha256", secret).update(JSON.stringify([lane.chatId, lane.name, nonce()]), "utf8").digest());
    },
    failed() {
      // A fresh random replacement, never a count that could come round to a key a request on its way still holds.
      moved.set(id, { nonce: randomUUID(), until: now() + GATEWAY_ROUTING.unsettledMs });
      if (moved.size <= GATEWAY_ROUTING.sweepAt) return;
      const at = now();
      for (const [key, state] of moved) if (state.until <= at) moved.delete(key);
    }
  };
}

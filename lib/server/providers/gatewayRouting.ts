import { createHmac, createSecretKey, randomUUID, type KeyObject } from "node:crypto";

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
 * generation under a key derived from the installation's routing key with
 * its own label, so the key reveals no id. A failed request's fate upstream
 * is unknown, so its lane moves to the next generation and no later request
 * shares the key it may still hold; the move holds for `unsettledMs` after
 * the lane's last failure, longer than any request runs. A process starts
 * its lanes over under a fresh epoch, so nothing a stopped process left
 * running shares a key either. Without the installation's routing key a lane
 * has no key and every request gets a fresh one, as before.
 */
export const GATEWAY_ROUTING = Object.freeze({
  /** How long a failed request may still run upstream: its lane keeps a new key that long after its last failure. */
  unsettledMs: 30 * 60_000,
  /** Moved lanes kept before expired ones are swept. */
  sweepAt: 1_024
});

const LABEL = "aiqsa.provider.gateway-routing.v1";

export type GatewayRoutingLane = Readonly<{
  /** The key the lane's next request carries; undefined without the installation's routing key. */
  key(): string | undefined;
  /** The lane's latest request failed: whatever it left upstream keeps its key, and the lane's later requests take another. */
  failed(): void;
}>;

type MovedLane = Readonly<{ generation: number; until: number }>;
type Registry = Readonly<{ epoch: string; moved: Map<string, MovedLane> }>;

const globalForGatewayRouting = globalThis as unknown as { __aiqsaGatewayRouting?: Registry };

/** Shared on `globalThis`, so every route bundle of the process moves a lane for all of them. */
function registry(): Registry {
  return globalForGatewayRouting.__aiqsaGatewayRouting ??= { epoch: randomUUID(), moved: new Map() };
}

/**
 * The installation's routing key: exactly 32 bytes in canonical base64. The variable keeps the name it had when it also
 * keyed a retired Memory search index, so existing `.env` files keep working (`agent_docs/ENV_VARIABLES.md`).
 */
function installationRoutingKeyFromEnv(env: Readonly<Record<string, string | undefined>>): KeyObject {
  const value = env.AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY;
  const decoded = value && /^[A-Za-z0-9+/]{43}=$/u.test(value) ? Buffer.from(value, "base64") : null;
  if (!decoded || decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("gateway_routing_key_invalid");
  }
  return createSecretKey(decoded);
}

/** The lanes' own key, derived from the installation's routing key; null without a valid one. */
function laneSecret(env: Readonly<Record<string, string | undefined>>): KeyObject | null {
  try {
    return createSecretKey(createHmac("sha256", installationRoutingKeyFromEnv(env)).update(LABEL, "utf8").digest());
  } catch {
    return null;
  }
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
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}> = {}): GatewayRoutingLane {
  const secret = laneSecret(options.env ?? process.env);
  const now = options.now ?? Date.now;
  const { epoch, moved } = registry();
  const id = JSON.stringify([lane.chatId, lane.name]);
  const generation = () => {
    const state = moved.get(id);
    if (!state) return 0;
    if (state.until > now()) return state.generation;
    moved.delete(id);
    return 0;
  };
  return {
    key() {
      if (!secret) return undefined;
      return uuidShaped(createHmac("sha256", secret).update(JSON.stringify([epoch, lane.chatId, lane.name, generation()]), "utf8")
        .digest());
    },
    failed() {
      if (!secret) return;
      moved.set(id, { generation: generation() + 1, until: now() + GATEWAY_ROUTING.unsettledMs });
      if (moved.size <= GATEWAY_ROUTING.sweepAt) return;
      const at = now();
      for (const [key, state] of moved) if (state.until <= at) moved.delete(key);
    }
  };
}

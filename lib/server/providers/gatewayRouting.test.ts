// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GATEWAY_ROUTING, gatewayRoutingLane } from "./gatewayRouting";

const env = { AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: Buffer.alloc(32, 7).toString("base64") };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("gateway routing lanes", () => {
  it("keep one key for a chat's loop across its rounds and runs, apart from its compactions and other chats", () => {
    const chatId = "chat-routing-stable";
    const loop = gatewayRoutingLane({ chatId, name: "loop" }, { env });
    const key = loop.key()!;
    // Shaped like the fresh keys a gateway gets otherwise.
    expect(key).toMatch(UUID);
    // The next round, and the lane of the chat's next run.
    expect(loop.key()).toBe(key);
    expect(gatewayRoutingLane({ chatId, name: "loop" }, { env }).key()).toBe(key);
    const others = [
      gatewayRoutingLane({ chatId, name: "compaction:run-1" }, { env }).key()!,
      gatewayRoutingLane({ chatId, name: "compaction:run-2" }, { env }).key()!,
      gatewayRoutingLane({ chatId: "chat-routing-other", name: "loop" }, { env }).key()!,
      gatewayRoutingLane({ chatId, name: "loop" }, { env: { AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: Buffer.alloc(32, 8).toString("base64") } })
        .key()!
    ];
    expect(new Set([key, ...others]).size).toBe(5);
    // No id reads out of a key, and it is no plain digest of the chat either.
    const plain = createHash("sha256").update(chatId).digest("hex");
    for (const value of [key, ...others]) {
      expect(value).toMatch(UUID);
      expect(value.replaceAll("-", "")).not.toBe(plain.slice(0, 32));
      expect(value).not.toMatch(/chat|run|loop|compaction/u);
    }
  });

  it("move a lane whose request failed to another key, for its later runs too, until the failure is long past", () => {
    let now = 1_000;
    const chatId = "chat-routing-moved";
    const lane = gatewayRoutingLane({ chatId, name: "loop" }, { env, now: () => now });
    const first = lane.key()!;
    lane.failed();
    const second = lane.key()!;
    expect(second).not.toBe(first);
    // The next run of the chat does not go back to the key the failed request may still hold upstream.
    expect(gatewayRoutingLane({ chatId, name: "loop" }, { env, now: () => now }).key()).toBe(second);
    now += GATEWAY_ROUTING.unsettledMs - 1;
    lane.failed();
    const third = lane.key()!;
    expect(new Set([first, second, third]).size).toBe(3);
    // Another lane of the chat stays where it was.
    expect(gatewayRoutingLane({ chatId, name: "compaction:run-1" }, { env, now: () => now }).key())
      .toBe(gatewayRoutingLane({ chatId, name: "compaction:run-1" }, { env }).key());
    // The window counts from the lane's last failure.
    now += GATEWAY_ROUTING.unsettledMs - 1;
    expect(lane.key()).toBe(third);
    now += 1;
    expect(lane.key()).toBe(first);
  });

  it("have no key without a valid installation routing key, so every request keeps a fresh one", () => {
    for (const value of [undefined, "", "not-a-key", Buffer.alloc(16, 1).toString("base64")]) {
      const lane = gatewayRoutingLane({ chatId: "chat-routing-none", name: "loop" },
        { env: value === undefined ? {} : { AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: value } });
      expect(lane.key()).toBeUndefined();
      lane.failed();
      expect(lane.key()).toBeUndefined();
    }
  });
});

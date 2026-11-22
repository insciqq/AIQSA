// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GATEWAY_ROUTING, gatewayRoutingLane } from "./gatewayRouting";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("gateway routing lanes", () => {
  it("keep one key for a chat's loop across its rounds and runs, apart from its compactions and other chats", () => {
    const chatId = "chat-routing-stable";
    const loop = gatewayRoutingLane({ chatId, name: "loop" });
    const key = loop.key();
    // Shaped like the fresh keys a gateway gets otherwise.
    expect(key).toMatch(UUID);
    // The next round, and the lane of the chat's next run.
    expect(loop.key()).toBe(key);
    expect(gatewayRoutingLane({ chatId, name: "loop" }).key()).toBe(key);
    const others = [
      gatewayRoutingLane({ chatId, name: "compaction:run-1" }).key(),
      gatewayRoutingLane({ chatId, name: "compaction:run-2" }).key(),
      gatewayRoutingLane({ chatId: "chat-routing-other", name: "loop" }).key()
    ];
    expect(new Set([key, ...others]).size).toBe(4);
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
    const lane = gatewayRoutingLane({ chatId, name: "loop" }, { now: () => now });
    const first = lane.key();
    lane.failed();
    const second = lane.key();
    expect(second).not.toBe(first);
    // The next run of the chat does not go back to the key the failed request may still hold upstream.
    expect(gatewayRoutingLane({ chatId, name: "loop" }, { now: () => now }).key()).toBe(second);
    now += GATEWAY_ROUTING.unsettledMs - 1;
    lane.failed();
    const third = lane.key();
    expect(new Set([first, second, third]).size).toBe(3);
    // Another lane of the chat stays where it was.
    expect(gatewayRoutingLane({ chatId, name: "compaction:run-1" }, { now: () => now }).key())
      .toBe(gatewayRoutingLane({ chatId, name: "compaction:run-1" }).key());
    // The window counts from the lane's last failure.
    now += GATEWAY_ROUTING.unsettledMs - 1;
    expect(lane.key()).toBe(third);
    now += 1;
    expect(lane.key()).toBe(first);
  });

  it("never gives a failed request's key back when it fails just after its lane's window ends (review 2026-11-22)", () => {
    let now = 1_000;
    const lane = gatewayRoutingLane({ chatId: "chat-routing-expiry", name: "loop" }, { now: () => now });
    lane.key();
    lane.failed();
    now += GATEWAY_ROUTING.unsettledMs - 1_000;
    const sent = lane.key();
    now += 2_000;
    lane.failed();
    expect(lane.key()).not.toBe(sent);
  });

  it("start over under another secret in a new process", () => {
    const routingGlobal = globalThis as { __aiqsaGatewayRouting?: unknown };
    const chatId = "chat-routing-restart";
    const before = gatewayRoutingLane({ chatId, name: "loop" }).key();
    expect(before).toMatch(UUID);
    const kept = routingGlobal.__aiqsaGatewayRouting;
    try {
      // A restarted process: nothing a stopped one left running upstream shares its keys.
      delete routingGlobal.__aiqsaGatewayRouting;
      const after = gatewayRoutingLane({ chatId, name: "loop" }).key();
      expect(after).toMatch(UUID);
      expect(after).not.toBe(before);
      expect(gatewayRoutingLane({ chatId, name: "loop" }).key()).toBe(after);
    } finally {
      routingGlobal.__aiqsaGatewayRouting = kept;
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_EVENTS_PATH, type ConnectDevice, type ConnectDevicesResponse } from "@/lib/contracts/connect";
import { FakeEventSource } from "./connect.testFixtures";
import type { ConnectApiResult } from "./connectApi";
import { CONNECT_FEED_RETRY_DELAYS_MS, ConnectDeviceFeed, type ConnectLeaveReason } from "./connectDeviceFeed";

function device(id: string, overrides: Partial<ConnectDevice> = {}): ConnectDevice {
  return {
    arch: "arm64",
    clientVersion: "0.3.20",
    createdAt: "2026-10-01T10:00:00.000Z",
    hostname: "host.local",
    id,
    lastSeenAt: "2026-10-19T10:00:00.000Z",
    name: "MacBook",
    online: true,
    os: "darwin",
    sessions: [],
    ...overrides
  };
}

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

function setup(list: ConnectApiResult<ConnectDevicesResponse>[] = []) {
  const sources: FakeEventSource[] = [];
  const left: ConnectLeaveReason[] = [];
  const listDevices = vi.fn(async () => list.shift() ?? { data: { devices: [] }, ok: true as const });
  const feed = new ConnectDeviceFeed({
    listDevices,
    onLeave: (reason) => left.push(reason),
    openEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    }
  });
  const changes = vi.fn();
  feed.subscribe(changes);
  return { changes, feed, left, listDevices, sources };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ConnectDeviceFeed", () => {
  it("shows the snapshot, then replaces a device from its update", () => {
    const { feed, sources } = setup();
    feed.start();
    expect(sources[0]!.url).toBe(CONNECT_EVENTS_PATH);
    expect(feed.getSnapshot()).toEqual({ connection: "connecting", devices: null, loadError: null });
    sources[0]!.send("devices", { devices: [device(FIRST), device(SECOND, { name: "build-box" })] });
    expect(feed.getSnapshot().connection).toBe("live");
    sources[0]!.send("device", { device: device(FIRST, { lastSeenAt: "2026-10-19T11:00:00.000Z", online: false }) });
    expect(feed.getSnapshot().devices?.map((item) => [item.id, item.online])).toEqual([[FIRST, false], [SECOND, true]]);
    sources[0]!.send("ping", {});
    feed.stop();
    expect(sources[0]!.closed).toBe(true);
  });

  it("leaves a device the snapshot does not hold to the next snapshot", () => {
    const { feed, sources } = setup();
    feed.start();
    sources[0]!.send("devices", { devices: [device(FIRST)] });
    sources[0]!.send("device", { device: device(SECOND) });
    expect(feed.getSnapshot().devices?.map((item) => item.id)).toEqual([FIRST]);
    feed.stop();
  });

  it("reads the list and reopens with backoff after the stream fails", async () => {
    const { feed, listDevices, sources } = setup([
      { code: "network_error", ok: false },
      { data: { devices: [device(SECOND)] }, ok: true }
    ]);
    feed.start();
    sources[0]!.send("devices", { devices: [device(FIRST)] });
    sources[0]!.fail();
    expect(sources[0]!.closed).toBe(true);
    expect(feed.getSnapshot().connection).toBe("reconnecting");

    vi.advanceTimersByTime(CONNECT_FEED_RETRY_DELAYS_MS[0]!);
    await flush();
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(feed.getSnapshot().loadError).toBe("network_error");
    expect(sources).toHaveLength(1);

    vi.advanceTimersByTime(CONNECT_FEED_RETRY_DELAYS_MS[1]!);
    await flush();
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(feed.getSnapshot().devices?.map((item) => item.id)).toEqual([SECOND]);
    expect(sources).toHaveLength(2);
    sources[1]!.send("devices", { devices: [device(SECOND)] });
    expect(feed.getSnapshot()).toMatchObject({ connection: "live", loadError: null });
    feed.stop();
  });

  it("treats a malformed frame as a lost stream", () => {
    const { feed, sources } = setup();
    feed.start();
    sources[0]!.send("devices", "{not json");
    expect(sources[0]!.closed).toBe(true);
    feed.stop();
  });

  it("leaves when the stream closes for a turned-off feature or an ended sign-in", () => {
    const disabled = setup();
    disabled.feed.start();
    disabled.sources[0]!.send("closed", { code: "connect_disabled" });
    expect(disabled.left).toEqual(["disabled"]);

    const signedOut = setup();
    signedOut.feed.start();
    signedOut.sources[0]!.send("closed", { code: "connect_unauthorized" });
    expect(signedOut.left).toEqual(["signed_out"]);
  });

  it("leaves when reading the list after a failure is refused", async () => {
    const { feed, left, sources } = setup([{ code: "connect_disabled", ok: false }]);
    feed.start();
    sources[0]!.fail();
    vi.advanceTimersByTime(CONNECT_FEED_RETRY_DELAYS_MS[0]!);
    await flush();
    expect(left).toEqual(["disabled"]);
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
  });

  it("drops a revoked device and an ended session at once", () => {
    const { feed, sources } = setup();
    feed.start();
    sources[0]!.send("devices", {
      devices: [
        device(FIRST, {
          sessions: [{
            attachedClients: 0,
            createdAt: "2026-10-19T09:00:00.000Z",
            cwd: "/home/me",
            id: "ac-abc123",
            program: "shell",
            status: "idle",
            statusAt: "2026-10-19T09:00:00.000Z",
            title: "Shell · me"
          }]
        }),
        device(SECOND)
      ]
    });
    feed.removeSession(FIRST, "ac-abc123");
    expect(feed.getSnapshot().devices?.[0]?.sessions).toEqual([]);
    feed.removeDevice(SECOND);
    expect(feed.getSnapshot().devices?.map((item) => item.id)).toEqual([FIRST]);
    feed.stop();
  });
});

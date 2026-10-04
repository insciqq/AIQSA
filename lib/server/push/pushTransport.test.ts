import { describe, expect, it, vi } from "vitest";
import { createPinnedPushPost, PushTransportError } from "./pushTransport";

const request = (endpoint: string) => ({ body: Buffer.from("x"), endpoint: new URL(endpoint), headers: {} });

describe("pinned push transport", () => {
  it.each([
    [[{ address: "10.0.0.8", family: 4 as const }]],
    [[{ address: "127.0.0.1", family: 4 as const }]],
    [[{ address: "169.254.169.254", family: 4 as const }]],
    [[{ address: "fd00::1", family: 6 as const }]],
    // One private answer among public ones refuses the whole name.
    [[{ address: "8.8.8.8", family: 4 as const }, { address: "192.168.0.2", family: 4 as const }]],
    [[]]
  ])("refuses a name that resolves to %j before connecting", async (addresses) => {
    const resolve = vi.fn(async () => addresses);
    await expect(createPinnedPushPost({ resolve })(request("https://push.example/device")))
      .rejects.toMatchObject({ code: "push_endpoint_forbidden" });
    expect(resolve).toHaveBeenCalledWith("push.example");
  });

  it("refuses plain HTTP and reports a failed lookup as a transport failure", async () => {
    await expect(createPinnedPushPost({ resolve: async () => [{ address: "8.8.8.8", family: 4 }] })(request("http://push.example/d")))
      .rejects.toBeInstanceOf(PushTransportError);
    await expect(createPinnedPushPost({ resolve: async () => { throw new Error("ENOTFOUND"); } })(request("https://push.example/d")))
      .rejects.toMatchObject({ code: "push_transport_failed" });
  });
});

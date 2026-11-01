import { describe, expect, it } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { createTelemetryAggregator } from "../telemetry/aggregator";
import { createFetchUrlSession } from "../tools/fetchUrl";
import { runProxiesFromRows } from "../proxies/runProxies";
import { proxyConnection } from "../webFetch/proxy.testFixtures";
import { WebFetchError } from "../webFetch/transport";
import { fetchUrlDigest } from "../webFetch/urls";
import { serializeEvent } from "./runtime.cjs";

describe("page-reader proxy observability", () => {
  it("allowlists only outcome and code, including when a caller passes names, endpoints or errors", () => {
    const line = serializeEvent("fetch_proxy", {
      outcome: "failed", code: "proxy_auth_failed", name: "PRIVATE_NAME", proxyName: "PRIVATE_NAME",
      url: "https://PRIVATE_URL", host: "PRIVATE_HOST", address: "PRIVATE_ADDRESS", login: "PRIVATE_LOGIN",
      password: "PRIVATE_PASSWORD", body: "PRIVATE_CONTENT", error: new Error("PRIVATE_ERROR")
    } as never)!;
    expect(JSON.parse(line)).toMatchObject({ event: "fetch_proxy", outcome: "failed", code: "proxy_auth_failed" });
    expect(line).not.toContain("PRIVATE_");
    const invalid = serializeEvent("fetch_proxy", { outcome: "PRIVATE_OUTCOME", code: "PRIVATE_CODE" } as never)!;
    expect(invalid).not.toContain("PRIVATE_");
    expect(JSON.parse(invalid)).toMatchObject({ code: "unknown" });
  });

  it.each([false, true])("records the session's default proxy observer in telemetry (failed=%s), without names or content", async (failed) => {
    const observation = await captureRunObservation();
    const connection = { ...proxyConnection(8080), name: "PRIVATE_NAME" };
    const url = "http://example.com/PRIVATE_PATH";
    const session = createFetchUrlSession({
      plan: { version: 1, userUrlDigests: [fetchUrlDigest(url)] }, scheduled: false,
      proxyPlan: { entries: [connection] }, runProxies: runProxiesFromRows([connection]), userId: "owner",
      fetchProxyPage: async () => {
        if (failed) throw new WebFetchError("proxy_auth_failed", { dispatched: true });
        return { body: Buffer.from("PRIVATE_CONTENT"), contentType: "text/plain", finalUrl: url, status: 200 };
      },
      extractPage: async () => ({ kind: "text", text: "PRIVATE_CONTENT", title: null, truncated: false })
    });
    await session.execute({ id: "call", name: "fetch_url", arguments: { url, proxy: connection.name } }, { signal: new AbortController().signal });
    const records = observation.records().filter((record) => record.event === "fetch_proxy");
    expect(records).toMatchObject([{ outcome: "started" }, failed ? { outcome: "failed", code: "proxy_auth_failed" } : { outcome: "read" }]);
    const aggregator = createTelemetryAggregator();
    for (const record of records) aggregator.observe(record);
    const counters = aggregator.drain().counters;
    expect(counters).toHaveLength(2);
    expect(counters.map((counter) => counter.dimensions)).toContainEqual(failed ? { outcome: "failed", code: "proxy_auth_failed" } : { outcome: "read" });
    const encoded = JSON.stringify([records, counters]);
    for (const privateText of ["PRIVATE_", connection.host, connection.login!, connection.password!]) expect(encoded).not.toContain(privateText);
  });
});

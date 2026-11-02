import { describe, expect, it, vi } from "vitest";
import { DocumentParserError } from "../parsing/errors";
import { WebFetchError, type WebFetchResponse } from "../webFetch/transport";
import { fetchUrlDigest } from "../webFetch/urls";
import { createFetchUrlSession, type FetchUrlSessionDeps } from "./fetchUrl";
import type { ToolExecutionResult } from "./types";

const urls = ["https://www.shop.co.uk/one", "https://reviews.shop.co.uk/two", "https://shop.co.uk/three", "https://other.example/"];
const signal = new AbortController().signal;
const call = (index: number) => ({ arguments: { url: urls[index] }, id: `call-${index}`, name: "fetch_url" });
const timeout = () => new WebFetchError("fetch_timeout", { dispatched: true });
const page: WebFetchResponse = { body: new TextEncoder().encode("Page."), contentType: "text/plain", finalUrl: urls[0]!, status: 200 };
const json = (result: ToolExecutionResult) => {
  const content = result.content[0];
  if (content?.type !== "json") throw new Error("Expected JSON.");
  return content.value as Record<string, unknown>;
};
const session = (extra: Partial<FetchUrlSessionDeps> = {}) => createFetchUrlSession({
  extractPage: async () => ({ kind: "text", text: "Page.", title: null, truncated: false }),
  fetchPage: vi.fn(async () => page), plan: { userUrlDigests: urls.map(fetchUrlDigest), version: 1 },
  research: async () => new Map(), scheduled: false, ...extra
});

describe("research refuses unreachable fetch_url sites", () => {
  it("reloads recorded sites before every read, including cached pages, and closes the whole registrable domain", async () => {
    const unreachable = new Map<string, string>();
    const fetchPage = vi.fn(async () => page);
    const s = session({ fetchPage, research: async () => new Map(unreachable) });
    expect((await s.execute(call(0), { signal })).status).toBe("complete");
    unreachable.set("shop.co.uk", "The site requires sign-in.");
    for (const index of [0, 1]) {
      const result = await s.execute(call(index), { signal });
      expect(result.status).toBe("error");
      expect(json(result).message).toContain("already recorded as unreachable");
      expect(json(result).message).toContain("The site requires sign-in.");
      expect(json(result).message).toContain('record_evidence with kind "unreachable"');
      expect(result.rawPreview).toMatchObject({ fetchUrl: { dispatched: false } });
    }
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect((await s.execute(call(3), { signal })).status).toBe("complete");
  });

  it("stops after two connection timeouts across pages and subdomains, and keeps counts only in this run", async () => {
    const fetchPage = vi.fn(async () => { throw timeout(); });
    const s = session({ fetchPage });
    expect(json(await s.execute(call(0), { signal })).message).not.toContain("record_evidence");
    expect(json(await s.execute(call(1), { signal })).message).toContain("timed out twice");
    const refused = await s.execute(call(2), { signal });
    expect(json(refused).message).toContain('record_evidence with kind "unreachable"');
    expect(refused.rawPreview).toMatchObject({ fetchUrl: { dispatched: false } });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await s.execute(call(3), { signal });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    await session({ fetchPage }).execute(call(2), { signal });
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it("counts one shared network request once even when several agents await it", async () => {
    let reject!: (error: Error) => void;
    const fetchPage = vi.fn(() => new Promise<WebFetchResponse>((_resolve, fail) => { reject = fail; }));
    const s = session({ fetchPage });
    const waiting = [s.execute(call(0), { signal }), s.execute(call(0), { signal })];
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    reject(timeout());
    const results = await Promise.all(waiting);
    expect(results.every((result) => !String(json(result).message).includes("timed out twice"))).toBe(true);
    const second = s.execute(call(1), { signal });
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    reject(timeout());
    await second;
    await s.execute(call(2), { signal });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("leaves ordinary runs unchanged and counts only timeouts after research starts", async () => {
    let researching = false;
    const fetchPage = vi.fn(async () => { throw timeout(); });
    const s = session({ fetchPage, research: async () => researching ? new Map() : null });
    for (const index of [0, 1, 2]) expect(json(await s.execute(call(index), { signal })).message).not.toContain("record_evidence");
    expect(fetchPage).toHaveBeenCalledTimes(3);
    researching = true;
    expect(json(await s.execute(call(0), { signal })).message).not.toContain("timed out twice");
    expect(json(await s.execute(call(1), { signal })).message).toContain("timed out twice");
    await s.execute(call(2), { signal });
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });

  it("does not count parser deadlines as connection timeouts", async () => {
    const fetchPage = vi.fn(async () => page);
    const s = session({ extractPage: async () => { throw new DocumentParserError("parser_timeout"); }, fetchPage });
    for (const index of [0, 1, 2]) expect(json(await s.execute(call(index), { signal })).message).not.toContain("record_evidence");
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("keeps link authority ahead of research refusal and makes no request", async () => {
    const research = vi.fn(async () => new Map([["shop.co.uk", "Sign-in required."]]));
    const fetchPage = vi.fn(async () => page);
    const s = session({ fetchPage, plan: { userUrlDigests: [], version: 1 }, research });
    expect(json(await s.execute(call(0), { signal })).error).toBe("fetch_url_not_in_conversation");
    expect(research).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("sends a research block to the run's own browser first, then to unreachable, never to a person's handoff", async () => {
    const blocked = async () => { throw new WebFetchError("fetch_http_status", { dispatched: true, httpStatus: 403 }); };
    const withBrowser = json(await session({ browserStep: () => "user", fetchPage: blocked }).execute(call(0), { signal }));
    expect(withBrowser.message).toContain("open it once in the Workspace browser");
    expect(withBrowser.message).toContain('If that is refused too or shows a CAPTCHA, a block page or a sign-in: Call record_evidence with kind "unreachable"');
    expect(withBrowser.message).not.toContain("browser_handoff");
    const withoutBrowser = json(await session({ fetchPage: blocked }).execute(call(0), { signal }));
    expect(withoutBrowser.message).not.toContain("Workspace browser");
    expect(withoutBrowser.message).toContain('record_evidence with kind "unreachable"');
  });
});

import { describe, expect, it, vi } from "vitest";
import type { extractWebPageInIsolation } from "../parsing/isolatedParser";
import { extractPage } from "./extract";
import { PAGE_TEXT_MAX_CHARACTERS } from "./pageKinds";
import { extractFetchedPage } from "./pageText";

type Isolate = typeof extractWebPageInIsolation;

const encoder = new TextEncoder();
const finalUrl = "https://news.example/today";
const input = (body: string | Uint8Array, contentType: string | null, signal = new AbortController().signal) => ({
  body: typeof body === "string" ? encoder.encode(body) : body, contentType, finalUrl, signal
});
// Runs the parser process's extraction in this process.
const inProcess: Isolate = async (request) => extractPage(request);

describe("fetched page text", () => {
  it("parses every readable kind only through the parser process, with bounded header values", async () => {
    const isolate = vi.fn(inProcess);
    const longType = `text/html; charset=utf-8; ${"x".repeat(600)}`;
    await expect(extractFetchedPage(input("<title>Today</title><p>Fresh news.</p>", longType), { isolate }))
      .resolves.toMatchObject({ kind: "html", text: "Fresh news.", title: "Today" });
    await expect(extractFetchedPage(input("plain words", "text/plain"), { isolate })).resolves.toMatchObject({ kind: "text" });
    await expect(extractFetchedPage(input("{\"a\":1}", null), { isolate })).resolves.toMatchObject({ kind: "json" });
    expect(isolate).toHaveBeenCalledTimes(3);
    expect(isolate.mock.calls[0]![0]).toMatchObject({ contentType: longType.slice(0, 512), finalUrl,
      maxCharacters: PAGE_TEXT_MAX_CHARACTERS });
    expect(isolate.mock.calls[2]![0].contentType).toBeNull();
  });

  it("refuses unreadable kinds without starting a parser process", async () => {
    const isolate = vi.fn(inProcess);
    await expect(extractFetchedPage(input("%PDF", "application/pdf"), { isolate })).resolves.toBeNull();
    await expect(extractFetchedPage(input(Uint8Array.from([0x89, 0x50, 0, 1]), null), { isolate })).resolves.toBeNull();
    expect(isolate).not.toHaveBeenCalled();
  });

  it("ends a parse at the deadline, waiting for the slot included, and keeps the run's cancellation", async () => {
    const waitForAbort: Isolate = (request) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
    });
    await expect(extractFetchedPage(input("<p>slow</p>", "text/html"), { deadlineMs: 20, isolate: waitForAbort }))
      .rejects.toMatchObject({ name: "TimeoutError" });
    const controller = new AbortController();
    const pending = extractFetchedPage(input("<p>slow</p>", "text/html", controller.signal), { isolate: waitForAbort });
    controller.abort(new DOMException("stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

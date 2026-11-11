import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { addressesAllowed, createPinnedHttpsExchange, multipartBody } from "./pinnedHttps";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function collect(parts: readonly (Buffer | Readable)[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (Buffer.isBuffer(part)) chunks.push(part);
    else for await (const chunk of part) chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe("pinned HTTPS exchange", () => {
  it("allows only addresses in the requested scope", () => {
    expect(addressesAllowed([{ address: "93.184.215.14", family: 4 }], "public")).toBe(true);
    expect(addressesAllowed([{ address: "127.0.0.1", family: 4 }], "public")).toBe(false);
    expect(addressesAllowed([{ address: "127.0.0.1", family: 4 }], "loopback")).toBe(true);
    expect(addressesAllowed([{ address: "93.184.215.14", family: 6 }], "public")).toBe(false);
    expect(addressesAllowed([], "public")).toBe(false);
  });

  it("builds a multipart body of fields and several files with its exact length", async () => {
    const built = multipartBody({
      label: "test", fields: [["payload_json", "{}"]], fieldName: /^(?:payload_json|files\[\d\])$/u,
      files: [
        { field: "files[0]", filename: "a\".txt", contentType: "text/plain", data: Buffer.from("A") },
        { field: "files[1]", filename: "b.bin", contentType: "bad type", stream: Readable.from([Buffer.from("BB")]), size: 2 }
      ]
    })!;
    const bytes = await collect(built.body.parts);
    expect(bytes.length).toBe(built.body.length);
    const text = bytes.toString("latin1");
    expect(text).toContain('name="payload_json"\r\n\r\n{}\r\n');
    expect(text).toContain('name="files[0]"; filename="a_.txt"\r\nContent-Type: text/plain\r\n\r\nA\r\n');
    expect(text).toContain('name="files[1]"; filename="b.bin"\r\nContent-Type: application/octet-stream\r\n\r\nBB\r\n--');
    expect(text.endsWith("--\r\n")).toBe(true);
    expect(multipartBody({ label: "test", fields: [["bad name", "x"]], files: [], fieldName: /^[a-z]+$/u })).toBeUndefined();
  });

  it("returns status, headers and body from a loopback server only in loopback scope", async () => {
    const port = await listen((_request, response) => { response.writeHead(201, { "x-ratelimit-bucket": "b" }); response.end("ok"); });
    const exchange = createPinnedHttpsExchange();
    const spec = {
      hostname: "127.0.0.1", port, secure: false, method: "GET" as const, path: "/", headers: {},
      timeoutMs: 5_000, maxResponseBytes: 1024
    };
    const result = await exchange({ ...spec, allowedScope: "loopback" });
    expect(result).toMatchObject({ ok: true, status: 201, body: Buffer.from("ok"), headers: expect.objectContaining({ "x-ratelimit-bucket": "b" }) });
    expect(await exchange({ ...spec, allowedScope: "public" })).toEqual({ ok: false, kind: "network_before_send", category: "forbidden_address" });
  });
});

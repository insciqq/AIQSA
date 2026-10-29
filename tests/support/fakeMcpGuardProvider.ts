import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeMcpGuardVerdict = "allow" | "ask" | "failure" | "malformed";
export const FAKE_MCP_GUARD_REASON = "Please confirm this change because your request did not authorize it.";

/** A protocol fake, not a privileged production role: the app uses its normal Responses transport and credential checks. */
export function fakeMcpGuardResponse(verdict: FakeMcpGuardVerdict) {
  if (verdict === "failure") return { status: 503, body: { error: { code: "synthetic_guard_unavailable" } } };
  const output = verdict === "malformed" ? { decision: "maybe" } : {
    decision: verdict, reason: verdict === "ask" ? FAKE_MCP_GUARD_REASON : "You requested this change."
  };
  return { status: 200, body: { id: "synthetic-guard-response", status: "completed", output: [{ type: "message", role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify(output) }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
}

/** Bounded, synthetic-only peer owned by a test. Never logs or retains request text. */
export async function startFakeMcpGuardProvider(options: Readonly<{ host?: string; publicHost?: string }> = {}) {
  if (process.env.AIQSA_TEST_MODE !== "1" || process.env.NODE_ENV === "production") throw new Error("fake_provider_not_allowed");
  let verdict: FakeMcpGuardVerdict = "ask";
  let calls = 0;
  const http = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > 128 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: { format?: { name?: unknown; type?: unknown } } };
      if (body.text?.format?.name !== "mcp_write_guard" || body.text.format.type !== "json_schema") {
        response.writeHead(400).end();
        return;
      }
      calls += 1;
      const result = fakeMcpGuardResponse(verdict);
      response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, options.host ?? "127.0.0.1", resolve);
  });
  return {
    apiRoot: `http://${options.publicHost ?? options.host ?? "127.0.0.1"}:${(http.address() as AddressInfo).port}/v1`,
    calls: () => calls,
    setVerdict(next: FakeMcpGuardVerdict) { verdict = next; },
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    }
  };
}

export type FakeMcpGuardProvider = Awaited<ReturnType<typeof startFakeMcpGuardProvider>>;

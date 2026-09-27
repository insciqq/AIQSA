import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { runtimeSecurityHeaders } from "../../lib/server/security/headers";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * The inbound MCP consent must reach the client's callback under the policy a
 * production HTTPS installation enforces (`form-action 'self'`), which also
 * governs redirects of the consent form submission. The dev server only
 * reports that policy, so this spec applies the exact production header to
 * the consent responses and keeps the callbacks on two other real origins.
 */
const PRODUCTION_CSP = runtimeSecurityHeaders({
  AIQSA_APP_BASE_URL: "https://aiqsa.example.test",
  NODE_ENV: "production"
})["Content-Security-Policy"]!;

type CallbackHit = Readonly<{ host: string; path: string; query: URLSearchParams }>;

async function startCallbackPeer(hits: CallbackHit[]): Promise<Readonly<{ close(): Promise<void>; port: number }>> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://callback.invalid");
    hits.push({ host: request.headers.host ?? "", path: url.pathname, query: url.searchParams });
    response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Synthetic client</title><h1>Callback received</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port: (server.address() as AddressInfo).port
  };
}

async function enforceProductionCsp(page: Page, appOrigin: string): Promise<void> {
  await page.route((url) => url.origin === appOrigin && url.pathname === "/oauth/authorize", async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const headers: Record<string, string> = { ...response.headers(), "content-security-policy": PRODUCTION_CSP };
    delete headers["content-security-policy-report-only"];
    await route.fulfill({ headers, response });
  });
}

function pkceChallenge(): string {
  return createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
}

test.describe("inbound MCP consent under the production CSP", () => {
  for (const variant of [
    { applicationType: "native", host: "127.0.0.1", label: "a native loopback callback" },
    { applicationType: "web", host: "localhost", label: "a web callback on another origin" }
  ] as const) {
    test(`reaches ${variant.label} after Approve without a manual step`, async ({ page }, testInfo) => {
      const hits: CallbackHit[] = [];
      const peer = await startCallbackPeer(hits);
      try {
        await signInWithLocalToken(page);
        const appOrigin = new URL(page.url()).origin;
        const redirectUri = `http://${variant.host}:${peer.port}/callback`;
        expect(new URL(redirectUri).origin).not.toBe(appOrigin);
        const registration = await page.request.post("/oauth/register", { data: {
          application_type: variant.applicationType,
          client_name: `Synthetic consent client ${variant.applicationType}`,
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: [redirectUri],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        } });
        expect(registration.status()).toBe(201);
        const clientId = (await registration.json()).client_id as string;

        await enforceProductionCsp(page, appOrigin);
        const state = `consent-${randomBytes(8).toString("hex")}`;
        const authorize = new URL("/oauth/authorize", appOrigin);
        authorize.search = new URLSearchParams({
          client_id: clientId,
          code_challenge: pkceChallenge(),
          code_challenge_method: "S256",
          redirect_uri: redirectUri,
          resource: `${appOrigin}/mcp`,
          response_type: "code",
          state
        }).toString();
        const consent = await page.goto(authorize.toString());
        expect(consent?.headers()["content-security-policy"]).toContain("form-action 'self'");
        await expect(page.getByRole("heading", { name: "Connect Personal Memory?" })).toBeVisible();
        // The injected policy is really enforced in this document.
        const probeBlocked = await page.evaluate(async (probe) => {
          try {
            await fetch(probe, { mode: "no-cors" });
            return false;
          } catch {
            return true;
          }
        }, `http://${variant.host}:${peer.port}/probe`);
        expect(probeBlocked).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`consent-${variant.applicationType}.png`) });

        await page.getByRole("button", { name: "Approve" }).click();
        await expect.poll(() => hits.filter((hit) => hit.path === "/callback").length, { timeout: 15_000 }).toBe(1);
        const callback = hits.find((hit) => hit.path === "/callback")!;
        expect(callback.host).toBe(`${variant.host}:${peer.port}`);
        expect(callback.query.get("code")).toMatch(/^aiqsa_mc_/u);
        expect(callback.query.get("state")).toBe(state);
        expect(callback.query.get("iss")).toBe(appOrigin);
        await expect(page).toHaveURL(new RegExp(`^http://${variant.host}:${peer.port}/callback\\?`, "u"));
        await expect(page.getByRole("heading", { name: "Callback received" })).toBeVisible();
        expect(hits.filter((hit) => hit.path === "/probe")).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`callback-${variant.applicationType}.png`) });
      } finally {
        await peer.close();
      }
    });
  }

  test("keeps Cancel reaching the client with access_denied under the same policy", async ({ page }) => {
    const hits: CallbackHit[] = [];
    const peer = await startCallbackPeer(hits);
    try {
      await signInWithLocalToken(page);
      const appOrigin = new URL(page.url()).origin;
      const redirectUri = `http://127.0.0.1:${peer.port}/callback`;
      const registration = await page.request.post("/oauth/register", { data: {
        application_type: "native",
        client_name: "Synthetic consent client cancel",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none"
      } });
      expect(registration.status()).toBe(201);
      await enforceProductionCsp(page, appOrigin);
      const authorize = new URL("/oauth/authorize", appOrigin);
      authorize.search = new URLSearchParams({
        client_id: (await registration.json()).client_id as string,
        code_challenge: pkceChallenge(),
        code_challenge_method: "S256",
        redirect_uri: redirectUri,
        resource: `${appOrigin}/mcp`,
        response_type: "code",
        state: "cancel-state"
      }).toString();
      await page.goto(authorize.toString());
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect.poll(() => hits.length, { timeout: 15_000 }).toBe(1);
      expect(hits[0]!.query.get("error")).toBe("access_denied");
      expect(hits[0]!.query.get("state")).toBe("cancel-state");
      expect(hits[0]!.query.has("code")).toBe(false);
      await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${peer.port}/callback\\?`, "u"));
    } finally {
      await peer.close();
    }
  });
});

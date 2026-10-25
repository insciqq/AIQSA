import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEDULED_TASK_WEBHOOK_BODY_MAX_BYTES } from "../../contracts/scheduledTasks";
import { scheduledWebhookTokenHash } from "./webhookEvent";
import {
  createScheduledTaskWebhookIntake,
  type ScheduledTaskWebhookAcceptance,
  type ScheduledTaskWebhookTarget
} from "./webhookIntake";

const PUBLIC_ID = "AbCdEfGhIjKlMnOpQrSt_-";
const TOKEN = `aiqsa_wh_${"Tok3n-_".repeat(6)}x`;
const OTHER = `aiqsa_wh_${"0".repeat(43)}`;
const target: ScheduledTaskWebhookTarget = { open: true, taskId: "task-1", tokenHash: scheduledWebhookTokenHash(TOKEN), userId: "owner-1" };

function fixture(found: ScheduledTaskWebhookTarget | null = target, outcome: ScheduledTaskWebhookAcceptance = { kind: "accepted" }) {
  const store = {
    accept: vi.fn(async () => outcome),
    find: vi.fn(async (_publicId: string) => found)
  };
  const kick = vi.fn();
  return { kick, receive: createScheduledTaskWebhookIntake({ kick, store }), store };
}

function post(init: Readonly<{ body?: BodyInit | null; headers?: Record<string, string>; query?: string }> = {}): Request {
  return new Request(`https://aiqsa.example/api/automations/hooks/${PUBLIC_ID}${init.query ?? ""}`, {
    body: init.body === undefined ? '{"object_kind":"pipeline"}' : init.body,
    headers: { "content-type": "application/json", ...init.headers },
    method: "POST"
  });
}

const bearer = { authorization: `Bearer ${TOKEN}` };

/** The headers the intake itself sets; the runtime security headers are checked on their own below. */
const OWN_HEADERS = new Set(["cache-control", "content-type", "retry-after"]);

async function shape(response: Response) {
  return { body: await response.text(), headers: [...response.headers.entries()].filter(([name]) => OWN_HEADERS.has(name)),
    status: response.status };
}

afterEach(() => vi.restoreAllMocks());

describe("automation webhook intake", () => {
  it("applies the Proxy's guards itself, since the route bypasses Proxy body cloning", async () => {
    const f = fixture();
    const egress = await f.receive(post({ headers: { ...bearer, "x-aiqsa-egress": "personal-mcp" } }), PUBLIC_ID);
    expect([egress.status, await egress.text()]).toEqual([421, ""]);
    const crossSiteHeaders: Record<string, string>[] = [{ origin: "https://attacker.example" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of crossSiteHeaders) {
      const crossSite = await f.receive(post({ headers: { ...bearer, ...headers } }), PUBLIC_ID);
      expect([crossSite.status, await crossSite.json()]).toEqual([403, { error: "invalid_origin" }]);
    }
    expect(f.store.find).not.toHaveBeenCalled();
    expect(f.store.accept).not.toHaveBeenCalled();
    // Senders without a browser origin pass, and every answer carries the runtime security headers.
    const answers = [await f.receive(post({ headers: { ...bearer, "sec-fetch-site": "none" } }), PUBLIC_ID),
      await fixture(null).receive(post({ headers: bearer }), PUBLIC_ID), egress];
    expect(answers.map((response) => response.status)).toEqual([202, 404, 421]);
    for (const response of answers) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
    const [accepted, refused] = answers;
    const security = (response: Response) => [...response.headers.entries()].filter(([name]) => !OWN_HEADERS.has(name));
    expect(security(refused!)).toEqual(security(accepted!));
  });

  it("refuses every unauthenticated request with one response, before reading the body", async () => {
    const refusals: Array<[string, ScheduledTaskWebhookTarget | null, Request, string?]> = [
      ["unknown webhook", null, post({ headers: bearer })],
      ["wrong token", target, post({ headers: { authorization: `Bearer ${OTHER}` } })],
      ["token only in the query", target, post({ query: `?token=${TOKEN}` }), "unread"],
      ["no token header", target, post(), "unread"],
      ["malformed token", target, post({ headers: { authorization: "Bearer aiqsa_wh_short" } }), "unread"],
      ["headers that disagree", target, post({ headers: { ...bearer, "x-gitlab-token": OTHER } }), "unread"],
      ["no token issued yet", { ...target, tokenHash: null }, post({ headers: bearer })],
      ["webhook off, task paused or completed, owner inactive", { ...target, open: false }, post({ headers: bearer })]
    ];
    const expected = { body: JSON.stringify({ error: "not_found" }), headers: [["cache-control", "no-store"],
      ["content-type", "application/json"]], status: 404 };
    for (const [name, found, request, unread] of refusals) {
      const f = fixture(found);
      expect(await shape(await f.receive(request, PUBLIC_ID)), name).toEqual(expected);
      expect(request.bodyUsed, name).toBe(false);
      expect(f.store.accept, name).not.toHaveBeenCalled();
      expect(f.kick, name).not.toHaveBeenCalled();
      // A presented token is always looked up and compared, found or not.
      expect(f.store.find, name).toHaveBeenCalledTimes(unread ? 0 : 1);
    }
    const malformed = fixture();
    expect(await shape(await malformed.receive(post({ headers: bearer }), "not-a-public-id"))).toEqual(expected);
    expect(malformed.store.find).not.toHaveBeenCalled();
  });

  it("queues an authenticated event and answers 202 at once, waking the runner", async () => {
    const f = fixture();
    const response = await f.receive(post({ headers: { ...bearer, "x-gitlab-event": "Pipeline Hook",
      "x-gitlab-event-uuid": "delivery-1" } }), PUBLIC_ID);
    expect(await shape(response)).toEqual({ body: JSON.stringify({ accepted: true }),
      headers: [["cache-control", "no-store"], ["content-type", "application/json"]], status: 202 });
    expect(f.store.find).toHaveBeenCalledWith(PUBLIC_ID);
    expect(f.store.accept).toHaveBeenCalledWith({
      event: { bodyText: "{\n  \"object_kind\": \"pipeline\"\n}", contentType: "application/json", dedupeKey: "delivery-1",
        eventName: "Pipeline Hook" },
      publicId: PUBLIC_ID, taskId: "task-1", tokenHash: scheduledWebhookTokenHash(TOKEN), userId: "owner-1"
    });
    expect(f.kick).toHaveBeenCalledTimes(1);
  });

  it("takes the token from X-Gitlab-Token, or from both headers when they agree", async () => {
    for (const headers of [{ "x-gitlab-token": TOKEN }, { ...bearer, "x-gitlab-token": TOKEN }]) {
      const f = fixture();
      expect((await f.receive(post({ headers }), PUBLIC_ID)).status).toBe(202);
      expect(f.store.accept).toHaveBeenCalledTimes(1);
    }
  });

  it("answers a repeated delivery with 202 without a new event or a wake-up", async () => {
    const f = fixture(target, { kind: "duplicate" });
    const response = await f.receive(post({ headers: { ...bearer, "idempotency-key": "delivery-1" } }), PUBLIC_ID);
    expect([response.status, await response.json()]).toEqual([202, { accepted: true }]);
    expect(f.kick).not.toHaveBeenCalled();
  });

  it("refuses a body over its bound with 413, only once the request is authenticated", async () => {
    const oversized = "x".repeat(SCHEDULED_TASK_WEBHOOK_BODY_MAX_BYTES + 1);
    const f = fixture();
    const refused = await f.receive(post({ body: oversized, headers: { ...bearer, "content-type": "text/plain" } }), PUBLIC_ID);
    expect([refused.status, await refused.json(), refused.headers.get("cache-control")])
      .toEqual([413, { error: "webhook_body_too_large" }, "no-store"]);
    expect(f.store.accept).not.toHaveBeenCalled();
    // A body at the bound is accepted.
    const fits = await f.receive(post({ body: oversized.slice(1), headers: { ...bearer, "content-type": "text/plain" } }), PUBLIC_ID);
    expect(fits.status).toBe(202);
    // Without the token the size tells nothing: the same refusal as any other.
    const anonymous = post({ body: oversized });
    expect((await f.receive(anonymous, PUBLIC_ID)).status).toBe(404);
    expect(anonymous.bodyUsed).toBe(false);
  });

  it("refuses undecodable bodies and malformed event headers with 400 before queueing", async () => {
    const f = fixture();
    const binary = await f.receive(post({ body: new Uint8Array([0x7b, 0xff, 0x7d]), headers: bearer }), PUBLIC_ID);
    expect([binary.status, await binary.json()]).toEqual([400, { error: "webhook_body_invalid" }]);
    const headers = await f.receive(post({ headers: { ...bearer, "x-github-delivery": "k".repeat(201) } }), PUBLIC_ID);
    expect([headers.status, await headers.json()]).toEqual([400, { error: "webhook_headers_invalid" }]);
    expect(f.store.accept).not.toHaveBeenCalled();
    // An empty body is an event like any other.
    expect((await f.receive(post({ body: null, headers: bearer }), PUBLIC_ID)).status).toBe(202);
    expect(f.store.accept).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ bodyText: "" }) }));
  });

  it("answers the queue and rate caps with 429, the rate cap with Retry-After", async () => {
    const full = await fixture(target, { kind: "queue_full" }).receive(post({ headers: bearer }), PUBLIC_ID);
    expect([full.status, await full.json(), full.headers.get("retry-after")]).toEqual([429, { error: "webhook_queue_full" }, null]);
    const limited = await fixture(target, { kind: "rate_limited", retryAfterSeconds: 1_234 }).receive(post({ headers: bearer }), PUBLIC_ID);
    expect([limited.status, await limited.json(), limited.headers.get("retry-after"), limited.headers.get("cache-control")])
      .toEqual([429, { error: "webhook_rate_limited" }, "1234", "no-store"]);
  });

  it("refuses an event whose token was rotated or whose automation stopped meanwhile like any other refusal", async () => {
    const f = fixture(target, { kind: "refused" });
    const response = await f.receive(post({ headers: bearer }), PUBLIC_ID);
    expect(await shape(response)).toEqual({ body: JSON.stringify({ error: "not_found" }),
      headers: [["cache-control", "no-store"], ["content-type", "application/json"]], status: 404 });
    expect(f.kick).not.toHaveBeenCalled();
  });

  it("reports an unavailable store without the token, the body, its headers or the public id", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const failing = fixture();
    failing.store.find.mockRejectedValueOnce(new Error(`lookup failed for ${PUBLIC_ID} with ${TOKEN}`));
    const lookup = await failing.receive(post({ headers: { ...bearer, "x-gitlab-event": "Secret Event Name" } }), PUBLIC_ID);
    expect([lookup.status, await lookup.json()]).toEqual([503, { error: "scheduled_tasks_unavailable" }]);
    failing.store.accept.mockRejectedValueOnce(new Error(`insert failed for ${PUBLIC_ID}`));
    const write = await failing.receive(post({ body: "private-body-text", headers: { ...bearer, "content-type": "text/plain" } }),
      PUBLIC_ID);
    expect(write.status).toBe(503);
    const output = writes.join("");
    expect(output).toContain('"code":"scheduled_tasks_unavailable"');
    for (const secret of [TOKEN, PUBLIC_ID, "private-body-text", "Secret Event Name", "object_kind", scheduledWebhookTokenHash(TOKEN)]) {
      expect(output).not.toContain(secret);
    }
  });
});

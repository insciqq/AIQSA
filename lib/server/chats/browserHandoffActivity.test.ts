// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeThreadToolActivity } from "../../contracts/chats";
import { browserHandoffActivityFacts } from "../tools/browserHandoffActivity";
import { summarizeMessageRunToolActivity } from "./prismaRepository";

const at = new Date("2026-11-20T10:00:00.000Z");
const ended = (outcome: string, url: string | null) => ({ callId: "p", name: "browser_handoff", status: "complete",
  content: [{ type: "json", value: { next: "…", outcome, page: url === null ? null : { title: "Sign in", url } } }] });
const call = (reason: string, result: unknown, extra: Record<string, unknown> = {}) => ({ arguments: { message: "Please sign in.", reason },
  completedAt: at, ordinal: 0, providerCallId: "p-handoff", result, roundIndex: 1, startedAt: at, state: "complete", toolName: "browser_handoff", ...extra });

describe("an answer's ended sign-in handoff", () => {
  it("projects its outcome and the host of the page it ended on, only for a sign-in, a code or a check", () => {
    expect(browserHandoffActivityFacts("browser_handoff", { reason: "sign_in" }, ended("not_answered", "https://Mail.Example.com/u/0/#inbox")))
      .toEqual({ browserHandoff: { host: "mail.example.com", outcome: "not_answered" } });
    expect(browserHandoffActivityFacts("browser_handoff", { reason: "verification_code" }, ended("timed_out", "https://id.example.org/code")))
      .toEqual({ browserHandoff: { host: "id.example.org", outcome: "timed_out" } });
    expect(browserHandoffActivityFacts("browser_handoff", { reason: "captcha" }, ended("cancelled", "https://shop.example/check")))
      .toEqual({ browserHandoff: { host: "shop.example", outcome: "cancelled" } });
    // A consent or a choice is no sign-in; a page that is no web address, no page and a refusal name no site.
    expect(browserHandoffActivityFacts("browser_handoff", { reason: "user_choice" }, ended("timed_out", "https://shop.example/"))).toEqual({});
    expect(browserHandoffActivityFacts("browser_handoff", { reason: "sign_in" }, ended("timed_out", "about:blank"))).toEqual({});
    expect(browserHandoffActivityFacts("browser_handoff", { reason: "sign_in" }, ended("timed_out", null))).toEqual({});
    expect(browserHandoffActivityFacts("browser_handoff", { reason: "sign_in" }, { content: [{ type: "json",
      value: { error: "browser_handoff_unavailable", message: "…" } }] })).toEqual({});
    expect(browserHandoffActivityFacts("browser_handoff", { reason: "sign_in" }, ended("later", "https://shop.example/"))).toEqual({});
    expect(browserHandoffActivityFacts("fetch_url", { reason: "sign_in" }, ended("timed_out", "https://shop.example/"))).toEqual({});
  });

  it("reaches the run's owner through the browser contract, and nobody else", () => {
    const run = { errorPayload: null, normalizedRequest: {}, status: "complete", userId: "owner",
      toolCalls: [call("sign_in", ended("not_answered", "https://accounts.example.com/signin"))] };
    const owned = summarizeMessageRunToolActivity(run, "owner");
    expect(decodeThreadToolActivity(JSON.parse(JSON.stringify(owned)))?.calls[0])
      .toMatchObject({ browserHandoff: { host: "accounts.example.com", outcome: "not_answered" }, toolName: "browser_handoff" });
    expect(summarizeMessageRunToolActivity(run, "someone-else")?.calls[0]).not.toHaveProperty("browserHandoff");
    expect(summarizeMessageRunToolActivity(run)?.calls[0]).not.toHaveProperty("browserHandoff");
  });

  it("drops malformed facts from the wire instead of guessing a site", () => {
    const wire = (browserHandoff: unknown) => decodeThreadToolActivity({ calls: [{ browserHandoff, round: 1, status: "complete",
      toolName: "browser_handoff" }] })?.calls[0];
    expect(wire({ host: "https://shop.example", outcome: "timed_out" })).not.toHaveProperty("browserHandoff");
    expect(wire({ host: "shop.example", outcome: "gone" })).not.toHaveProperty("browserHandoff");
    expect(wire({ extra: 1, host: "shop.example", outcome: "timed_out" })).not.toHaveProperty("browserHandoff");
    expect(wire({ host: "shop.example", outcome: "timed_out" })).toMatchObject({ browserHandoff: { host: "shop.example", outcome: "timed_out" } });
  });
});

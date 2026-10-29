import { describe, expect, it } from "vitest";
import {
  BROWSER_LIVE_LIMITS,
  browserLiveControlRequestSchema,
  browserLiveHandoffRequestSchema,
  browserLiveInputSchema,
  browserLiveStreamPath,
  decodeBrowserLiveEvent
} from "./browserLive";

const handoff = { id: "handoff_1", agent: { id: "thread_1", name: "shopper" }, reason: "sign_in", message: "Sign in to the shop",
  startedAt: "2026-10-26T18:00:00.000Z", expiresAt: "2026-10-26T18:10:00.000Z" };
const page = { url: "https://shop.example/login", title: "Sign in" };
const state = {
  version: 2,
  runId: "run_1",
  browser: "running",
  agents: [
    { id: "main", name: null, controller: "agent", waitingForUser: false, page: null },
    { id: "thread_1", name: "shopper", controller: "user", waitingForUser: true, page }
  ],
  selected: "thread_1",
  controller: "user",
  signInRemembered: true,
  handoff,
  handoffs: [handoff],
  page
};

describe("browser live events", () => {
  it("decodes each event by its name and refuses unknown names, bad JSON and extra fields", () => {
    expect(decodeBrowserLiveEvent("state", JSON.stringify(state))).toEqual({ type: "state", value: state });
    expect(decodeBrowserLiveEvent("frame", JSON.stringify({ agent: "main", seq: 3, mime: "image/jpeg", data: "QUJD", width: 1440, height: 900 })))
      .toMatchObject({ type: "frame", value: { seq: 3, width: 1440 } });
    expect(decodeBrowserLiveEvent("steps", JSON.stringify({ agent: "main", steps: [{ n: 1, action: "click", target: "button \"Login\"",
      host: "shop.example", path: "/login" }] }))).toMatchObject({ type: "steps" });
    expect(decodeBrowserLiveEvent("end", JSON.stringify({ reason: "run_finished" }))).toEqual({ type: "end", value: { reason: "run_finished" } });
    expect(decodeBrowserLiveEvent("toString", "{}")).toBeNull();
    expect(decodeBrowserLiveEvent("state", "{")).toBeNull();
    expect(decodeBrowserLiveEvent("state", JSON.stringify({ ...state, extra: true }))).toBeNull();
    expect(decodeBrowserLiveEvent("frame", JSON.stringify({ agent: "main", seq: 1, mime: "image/png", data: "QUJD", width: 1, height: 1 }))).toBeNull();
    expect(decodeBrowserLiveEvent("frame", JSON.stringify({ agent: "main", seq: 1, mime: "image/jpeg", data: "not base64!", width: 1, height: 1 }))).toBeNull();
  });

  it("refuses a malformed agent, a sub-agent name outside the name rule and too many agents", () => {
    const agent = state.agents[1]!;
    expect(decodeBrowserLiveEvent("state", JSON.stringify({ ...state, selected: "../x" }))).toBeNull();
    expect(decodeBrowserLiveEvent("state", JSON.stringify({ ...state, agents: [{ ...agent, name: "Shopper" }] }))).toBeNull();
    expect(decodeBrowserLiveEvent("state", JSON.stringify({ ...state, agents: [] }))).toBeNull();
    expect(decodeBrowserLiveEvent("state", JSON.stringify({ ...state,
      agents: Array.from({ length: BROWSER_LIVE_LIMITS.agentsPerEvent + 1 }, (_, index) => ({ ...agent, id: `thread_${index}` })) }))).toBeNull();
    expect(decodeBrowserLiveEvent("state", JSON.stringify({ ...state, handoff: { ...handoff, agent: undefined } }))).toBeNull();
    expect(decodeBrowserLiveEvent("frame", JSON.stringify({ seq: 3, mime: "image/jpeg", data: "QUJD", width: 1, height: 1 }))).toBeNull();
  });

  it("refuses control characters in labels and oversized step lists", () => {
    expect(decodeBrowserLiveEvent("state", JSON.stringify({ ...state, page: { url: "https://x.example/", title: "a\u0000b" } }))).toBeNull();
    const step = { n: 1, action: "click", target: "x", host: "x.example", path: "/" };
    expect(decodeBrowserLiveEvent("steps", JSON.stringify({ agent: "main", steps: Array(BROWSER_LIVE_LIMITS.stepsPerEvent + 1).fill(step) }))).toBeNull();
  });
});

describe("browser live requests", () => {
  it("accepts pointer, key and text input within bounds", () => {
    expect(browserLiveInputSchema.safeParse({ kind: "mouse", type: "down", x: 10.5, y: 20, button: "left", clickCount: 1 }).success).toBe(true);
    expect(browserLiveInputSchema.safeParse({ kind: "mouse", type: "wheel", x: 0, y: 0, deltaY: 120 }).success).toBe(true);
    expect(browserLiveInputSchema.safeParse({ kind: "key", type: "down", key: "Enter", code: "Enter" }).success).toBe(true);
    expect(browserLiveInputSchema.safeParse({ kind: "text", text: "123456" }).success).toBe(true);
    expect(browserLiveInputSchema.safeParse({ agent: "thread_1", kind: "text", text: "123456" }).success).toBe(true);
    expect(browserLiveInputSchema.safeParse({ agent: "", kind: "text", text: "123456" }).success).toBe(false);
  });

  it("refuses unknown kinds, out-of-range coordinates, oversized text and control characters", () => {
    expect(browserLiveInputSchema.safeParse({ kind: "script", text: "x" }).success).toBe(false);
    expect(browserLiveInputSchema.safeParse({ kind: "mouse", type: "down", x: -1, y: 0 }).success).toBe(false);
    expect(browserLiveInputSchema.safeParse({ kind: "text", text: "a".repeat(BROWSER_LIVE_LIMITS.textChars + 1) }).success).toBe(false);
    expect(browserLiveInputSchema.safeParse({ kind: "text", text: "a\u0007" }).success).toBe(false);
    expect(browserLiveInputSchema.safeParse({ kind: "key", type: "down", key: "", code: "" }).success).toBe(false);
  });

  it("parses control and handoff actions strictly", () => {
    expect(browserLiveControlRequestSchema.safeParse({ action: "take" }).success).toBe(true);
    expect(browserLiveControlRequestSchema.safeParse({ action: "take", agent: "thread_1" }).success).toBe(true);
    expect(browserLiveControlRequestSchema.safeParse({ action: "select", agent: "thread_1" }).success).toBe(true);
    expect(browserLiveControlRequestSchema.safeParse({ action: "select" }).success).toBe(false);
    expect(browserLiveControlRequestSchema.safeParse({ action: "take", agent: "a b" }).success).toBe(false);
    expect(browserLiveControlRequestSchema.safeParse({ action: "steal" }).success).toBe(false);
    expect(browserLiveHandoffRequestSchema.safeParse({ handoffId: "handoff_1", action: "done" }).success).toBe(true);
    expect(browserLiveHandoffRequestSchema.safeParse({ handoffId: "../x", action: "done" }).success).toBe(false);
  });

  it("builds chat-scoped paths", () => {
    expect(browserLiveStreamPath("chat/1")).toBe("/api/chats/chat%2F1/browser/stream");
  });
});

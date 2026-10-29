// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserHandoffOutcome, BrowserLiveStateEvent } from "@/lib/contracts/browserLive";
import { BrowserLiveRelay } from "./browserLive";
import { BrowserLiveAgents, type BrowserLivePendingHandoff } from "./browserLiveAgents";
import { recordingWriter, until } from "./browserLive.testFixtures";
import { fakeAgentsGuest } from "./browserLiveAgents.testFixtures";

const owner = { authSessionId: "session-1", userId: "user-1" };
const amazon = { id: "thread_amazon", name: "amazon" };
const shop = { id: "thread_shop", name: "shop" };

function listed(entries: ReadonlyArray<Readonly<{ acted?: number; agent: string; controller?: string; name?: string | null }>>) {
  return entries.map((entry) => ({ acted: entry.acted ?? 0, agent: entry.agent, controller: entry.controller ?? "agent", handoff: false,
    name: entry.name ?? null, page: { title: entry.agent, url: `https://${entry.agent}.example/` } }));
}

function pending(id: string, agent: Readonly<{ id: string; name: string | null }>, startedAt: number,
  resolve: (outcome: BrowserHandoffOutcome | "aborted") => void = () => undefined): BrowserLivePendingHandoff {
  return { agent, expiresAt: startedAt + 60_000, id, message: "Sign in", reason: "sign_in", resolve, startedAt };
}

describe("the agent switcher's state", () => {
  it("shows the main agent alone for a guest without per-agent tabs, as before", () => {
    const agents = new BrowserLiveAgents();
    agents.applyAgentState("main", "agent", { title: "Cart", url: "https://shop.example/cart" });
    expect(agents.project()).toMatchObject({ agents: [{ id: "main", name: null, page: { title: "Cart" } }], controller: "agent",
      handoff: null, handoffs: [], page: { title: "Cart" }, selected: "main" });
    expect(agents.browsing("main")).toBe(true);
    expect(agents.browsing(amazon.id)).toBe(false);
  });

  it("opens on the agent that acted last, keeps the owner's choice and falls back once that agent leaves", () => {
    const agents = new BrowserLiveAgents();
    agents.applyAgents(listed([{ acted: 1, agent: "main" }, { acted: 5, agent: amazon.id, name: "amazon" }, { acted: 3, agent: shop.id, name: "shop" }]));
    expect(agents.viewOpened()).toBe(true);
    expect(agents.selected).toBe(amazon.id);
    expect(agents.project().agents.map((agent) => [agent.id, agent.name])).toEqual([["main", null], [amazon.id, "amazon"], [shop.id, "shop"]]);
    // Sticky: another agent acting does not move the stream.
    agents.applyAgents(listed([{ acted: 1, agent: "main" }, { acted: 5, agent: amazon.id }, { acted: 9, agent: shop.id }]));
    expect(agents.selected).toBe(amazon.id);
    expect(agents.select(shop.id)).toEqual({ changed: true, ok: true });
    expect(agents.viewOpened()).toBe(false);
    expect(agents.select("thread_gone")).toEqual({ changed: false, ok: false });
    // The chosen agent stopped browsing: the one that acted last is shown.
    agents.applyAgents(listed([{ acted: 1, agent: "main" }, { acted: 7, agent: amazon.id }]));
    expect(agents.selected).toBe(amazon.id);
  });

  it("moves to the agent of a new oldest handoff and on to the next one, oldest first", () => {
    const agents = new BrowserLiveAgents();
    agents.applyAgents(listed([{ agent: "main" }, { agent: amazon.id, name: "amazon" }, { agent: shop.id, name: "shop" }]));
    agents.select("main");
    expect(agents.addHandoff(pending("h_shop", shop, 100))).toBe(true);
    expect(agents.selected).toBe(shop.id);
    // A later handoff waits behind it and does not take the stream.
    expect(agents.addHandoff(pending("h_amazon", amazon, 200))).toBe(false);
    agents.select("main");
    let projection = agents.project();
    expect(projection.handoffs.map((handoff) => handoff.agent.id)).toEqual([shop.id, amazon.id]);
    expect(projection.handoff).toMatchObject({ agent: shop, id: "h_shop" });
    expect(projection.agents.map((agent) => [agent.id, agent.controller, agent.waitingForUser])).toEqual([
      ["main", "agent", false], [amazon.id, "user", true], [shop.id, "user", true]]);
    expect(agents.handoffBusy(shop.id)).toBe(true);
    expect(agents.handoffBusy("main")).toBe(false);
    // Answering the oldest shows the next one's agent.
    agents.removeHandoff("h_shop");
    projection = agents.project();
    expect([agents.selected, projection.handoff?.id, projection.handoffs.length]).toEqual([amazon.id, "h_amazon", 1]);
    expect(agents.userControls(shop.id)).toBe(false);
    agents.removeHandoff("h_amazon");
    expect(agents.project().handoff).toBeNull();
    expect(agents.selected).toBe(amazon.id);
  });

  it("keeps control per agent and lets a guest report only hand an agent's tab back", () => {
    const agents = new BrowserLiveAgents();
    agents.applyAgents(listed([{ agent: "main" }, { agent: amazon.id, name: "amazon" }]));
    agents.setTaken(amazon.id, true);
    agents.applyAgents(listed([{ agent: "main", controller: "user" }, { agent: amazon.id, controller: "user", name: "amazon" }]));
    // The guest cannot give the user an agent's tab the server never gave.
    expect([agents.userControls("main"), agents.userControls(amazon.id)]).toEqual([false, true]);
    agents.applyAgents(listed([{ agent: "main" }, { agent: amazon.id, name: "amazon" }]));
    expect(agents.userControls(amazon.id)).toBe(false);
  });

  it("keeps a waiting agent listed after its slot went, and skips malformed entries", () => {
    const agents = new BrowserLiveAgents();
    agents.applyAgents([...listed([{ agent: "main" }, { agent: shop.id, name: "shop" }]), { agent: "a b" }, null, { agent: shop.id }]);
    agents.addHandoff(pending("h_shop", shop, 1));
    agents.applyAgents(listed([{ agent: "main" }]));
    expect(agents.project().agents.map((agent) => [agent.id, agent.name, agent.page, agent.waitingForUser])).toEqual([
      ["main", null, { title: "main", url: "https://main.example/" }, false], [shop.id, "shop", null, true]]);
    expect(agents.selected).toBe(shop.id);
  });
});

describe("the live browser with several browsing agents", () => {
  const ended: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const end of ended.splice(0)) await end();
  });

  function setup() {
    const relay = new BrowserLiveRelay();
    const guest = fakeAgentsGuest([
      { acted: 1, id: "main", name: null, page: { title: "Amazon", url: "https://amazon.es/" } },
      { acted: 3, id: amazon.id, name: amazon.name, page: { title: "Kettles", url: "https://amazon.es/s?k=kettle" } },
      { acted: 2, id: shop.id, name: shop.name, page: { title: "Swag Labs", url: "https://saucedemo.com/" } }
    ]);
    const handle = relay.register({ channel: guest.channel, chatId: "chat-1", runId: "run-1", signInRemembered: async () => true,
      userId: "user-1" });
    ended.push(() => handle.end());
    return { guest, handle, view: relay.find("chat-1", "user-1")! };
  }

  it("streams the selected agent's tab and switches when the owner picks another", async () => {
    const { guest, view } = setup();
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.agents.length === 3 && tab.of("frame").length > 0);
    expect(tab.last<BrowserLiveStateEvent>("state")).toMatchObject({ page: { title: "Kettles" }, selected: amazon.id });
    expect(guest.selections()).toEqual([amazon.id]);
    expect(await view.control(owner, { action: "select", agent: shop.id })).toBeNull();
    await until(() => tab.last<{ agent: string }>("frame")?.agent === shop.id);
    expect(tab.last<BrowserLiveStateEvent>("state")).toMatchObject({ page: { title: "Swag Labs" }, selected: shop.id });
    expect(tab.last<{ agent: string }>("steps")?.agent).toBe(shop.id);
    // A late frame of the agent shown before never reaches the view.
    const frames = tab.of("frame").length;
    guest.frameOf(amazon.id);
    guest.frameOf(shop.id);
    await until(() => tab.of("frame").length > frames);
    expect((tab.of("frame") as Array<{ agent: string }>).slice(frames).every((frame) => frame.agent === shop.id)).toBe(true);
    expect(await view.control(owner, { action: "select", agent: "thread_gone" })).toBe("browser_live_unavailable");
  });

  it("takes control of one agent while the others go on, and sends input only to that agent's tab", async () => {
    const { guest, view } = setup();
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.browser === "running");
    expect(await view.control(owner, { action: "take", agent: shop.id })).toBeNull();
    expect(guest.received).toContainEqual(expect.objectContaining({ action: "take", agent: shop.id, t: "control" }));
    const state = tab.last<BrowserLiveStateEvent>("state")!;
    expect(state.agents.map((agent) => [agent.id, agent.controller])).toEqual([["main", "agent"], [amazon.id, "agent"], [shop.id, "user"]]);
    // The stream shows amazon, which the agent drives: its controller is the agent's.
    expect([state.selected, state.controller]).toEqual([amazon.id, "agent"]);
    expect(await view.input(owner, { agent: shop.id, kind: "text", text: "standard_user" })).toBeNull();
    expect(await view.input(owner, { agent: amazon.id, kind: "text", text: "x" })).toBe("browser_live_not_in_control");
    expect(await view.input(owner, { kind: "text", text: "x" })).toBe("browser_live_not_in_control");
    expect(guest.received.filter((message) => message.t === "input")).toEqual([
      { agent: shop.id, input: { kind: "text", text: "standard_user" }, t: "input" }]);
    expect(await view.control(owner, { action: "return", agent: shop.id })).toBeNull();
    expect(tab.last<BrowserLiveStateEvent>("state")!.agents.every((agent) => agent.controller === "agent")).toBe(true);
    expect(await view.control(owner, { action: "take", agent: "thread_gone" })).toBe("browser_live_unavailable");
  });

  it("queues two agents' handoffs, shows the oldest first and answers each agent's own request in order", async () => {
    const { guest, handle, view } = setup();
    const tab = recordingWriter();
    await view.watch(owner, tab.writer);
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.browser === "running");
    const signal = new AbortController().signal;
    const first = handle.handoff({ agent: shop, message: "Sign in to Swag Labs", reason: "sign_in", signal, waitMs: 60_000 });
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.handoffs.length === 1);
    const second = handle.handoff({ agent: amazon, message: "Enter the code", reason: "verification_code", signal, waitMs: 60_000 });
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.handoffs.length === 2);
    expect(await handle.handoff({ agent: shop, message: "Again", reason: "other", signal, waitMs: 60_000 })).toEqual({ kind: "busy" });
    let state = tab.last<BrowserLiveStateEvent>("state")!;
    expect([state.selected, state.handoff?.agent, state.handoffs.map((handoff) => handoff.agent.name)])
      .toEqual([shop.id, shop, ["shop", "amazon"]]);
    expect(state.agents.filter((agent) => agent.waitingForUser).map((agent) => agent.id)).toEqual([amazon.id, shop.id]);
    // The main agent keeps working and the user cannot hand it back while it waits for nobody.
    expect(await view.input(owner, { kind: "text", text: "x" })).toBe("browser_live_not_in_control");
    expect(view.answerHandoff(owner, { action: "done", handoffId: state.handoff!.id })).toBeNull();
    expect(await first).toMatchObject({ kind: "ended", outcome: "completed", saved: shop.id });
    expect(guest.received).toContainEqual(expect.objectContaining({ action: "end", agent: shop.id, outcome: "completed", t: "handoff" }));
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.handoffs.length === 1);
    state = tab.last<BrowserLiveStateEvent>("state")!;
    expect([state.selected, state.handoff?.agent.id, state.controller]).toEqual([amazon.id, amazon.id, "user"]);
    expect(view.answerHandoff(owner, { action: "cancel", handoffId: state.handoff!.id })).toBeNull();
    expect(await second).toMatchObject({ kind: "ended", outcome: "cancelled", saved: null });
    expect(guest.received.filter((message) => message.t === "handoff" && message.action === "end").map((message) => message.agent))
      .toEqual([shop.id, amazon.id]);
    await until(() => tab.last<BrowserLiveStateEvent>("state")?.handoff === null);
  });

  it("ends every agent's waiting handoff with the run", async () => {
    const { handle } = setup();
    const signal = new AbortController().signal;
    const first = handle.handoff({ agent: shop, message: "Sign in", reason: "sign_in", signal, waitMs: 60_000 });
    const second = handle.handoff({ agent: amazon, message: "Code", reason: "verification_code", signal, waitMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handle.end();
    expect([(await first).kind, (await second).kind]).toEqual(["ended", "ended"]);
  });
});

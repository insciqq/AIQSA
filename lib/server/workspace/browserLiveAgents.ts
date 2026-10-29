import {
  BROWSER_LIVE_LIMITS,
  BROWSER_LIVE_MAIN_AGENT,
  browserLiveAgentRefSchema,
  browserLiveStateEventSchema,
  type BrowserHandoffOutcome,
  type BrowserHandoffReason,
  type BrowserLiveAgent,
  type BrowserLiveAgentRef,
  type BrowserLiveController,
  type BrowserLiveHandoff,
  type BrowserLiveStateEvent
} from "@/lib/contracts/browserLive";
import { WORKSPACE_AGENT_PROTOCOL } from "../subagents/guestProtocol";

/**
 * The per-agent layer of the live browser (`browserLive.ts`): which agents browse the shared browser, which one
 * the stream shows, who controls each agent's tab, and the queue of handoffs. Pure state: the relay feeds it the
 * guest's reports and the owner's requests and sends what it decides. Everything stays in memory.
 *
 * - Agents come from the guest's `agents` message (`ops/workspace-guest/python/aiqsa/agents.py`). A guest that
 *   never sent one (protocol 1) browses as the main agent alone, whose page and control its `state` reports.
 * - Control is this server's record per agent, as for one agent before: the owner's Take and Return and a pending
 *   handoff give an agent's tab to the user; a guest report may hand it back (its grace ended), never take it.
 * - Selection (decision 2026-10-30): the owner's own choice while that agent browses; otherwise the agent of the
 *   oldest pending handoff; otherwise the agent that acted last when the panel opened. A new oldest handoff moves
 *   the stream to its agent, so Done and Cancel always answer the page the user sees. Selection is sticky between
 *   those moments, so the stream never jumps between agents as they act.
 * - Handoffs: one pending per agent, shown oldest first; Done and Cancel answer exactly the request they name.
 */

export const BROWSER_LIVE_MAIN_REF: BrowserLiveAgentRef = Object.freeze({ id: BROWSER_LIVE_MAIN_AGENT, name: null });

const AGENT_ID = new RegExp(WORKSPACE_AGENT_PROTOCOL.AGENT_ID_PATTERN, "u");
const pageSchema = browserLiveStateEventSchema.shape.page;

type Page = BrowserLiveStateEvent["page"];

export type BrowserLivePendingHandoff = Readonly<{
  agent: BrowserLiveAgentRef;
  expiresAt: number;
  id: string;
  message: string;
  reason: BrowserHandoffReason;
  resolve: (outcome: BrowserHandoffOutcome | "aborted") => void;
  startedAt: number;
}>;

type Listed = {
  acted: number;
  guestController: BrowserLiveController;
  readonly id: string;
  name: string | null;
  page: Page;
};

/** An agent id of the guest protocol: `main` or a thread id. */
export function isBrowserLiveAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value);
}

/** The agent a guest message names; absent means the main agent; null when malformed. */
export function guestMessageAgent(message: Readonly<Record<string, unknown>>): string | null {
  const value = message[WORKSPACE_AGENT_PROTOCOL.LIVE_AGENT_FIELD];
  if (value === undefined) return BROWSER_LIVE_MAIN_AGENT;
  return isBrowserLiveAgentId(value) ? value : null;
}

export function browserLivePage(value: unknown): Page {
  if (typeof value !== "object" || value === null) return null;
  const parsed = pageSchema.safeParse({ title: (value as { title?: unknown }).title, url: (value as { url?: unknown }).url });
  return parsed.success ? parsed.data : null;
}

function agentName(id: string, value: unknown): string | null {
  if (id === BROWSER_LIVE_MAIN_AGENT || typeof value !== "string") return null;
  const parsed = browserLiveAgentRefSchema.shape.name.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class BrowserLiveAgents {
  /** The guest's browsing agents in the order it first listed them. */
  private readonly listed = new Map<string, Listed>();
  /** The guest sent an `agents` message: it knows per-agent messages (protocol 2). */
  private perAgent = false;
  /** Agents whose tab the user took (Take control); a pending handoff counts on its own. */
  private readonly taken = new Set<string>();
  private readonly queue: BrowserLivePendingHandoff[] = [];
  /** Handoffs whose begin is under way, by agent. */
  private readonly starting = new Set<string>();
  private pinned: string | null = null;
  private current: string = BROWSER_LIVE_MAIN_AGENT;
  /** A view opened before the guest listed its agents: the first list picks the default. */
  private defaultOnList = false;
  /** The main agent's page and the guest's control of it, as a protocol 1 guest reports them. */
  private legacy: Readonly<{ controller: BrowserLiveController; page: Page }> = { controller: "agent", page: null };

  // The guest -----------------------------------------------------------------------------------------------------

  /**
   * The guest's `agents` message. Returns whether the projection changed. Unknown shapes are skipped entry by entry;
   * an agent's control the server gave the user stays only while the guest also says the user holds it.
   */
  applyAgents(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const before = this.signature();
    this.perAgent = true;
    const seen = new Set<string>();
    for (const entry of value.slice(0, BROWSER_LIVE_LIMITS.agentsPerEvent)) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Readonly<Record<string, unknown>>;
      const id = record[WORKSPACE_AGENT_PROTOCOL.LIVE_AGENT_FIELD];
      if (!isBrowserLiveAgentId(id) || seen.has(id)) continue;
      seen.add(id);
      const acted = typeof record.acted === "number" && Number.isSafeInteger(record.acted) && record.acted >= 0 ? record.acted : 0;
      const guestController: BrowserLiveController = record.controller === "user" ? "user" : "agent";
      const known = this.listed.get(id);
      const page = browserLivePage(record.page);
      if (known) {
        known.acted = acted;
        known.guestController = guestController;
        known.name = agentName(id, record.name) ?? known.name;
        known.page = page;
      } else {
        this.listed.set(id, { acted, guestController, id, name: agentName(id, record.name), page });
      }
    }
    for (const id of [...this.listed.keys()]) if (!seen.has(id)) this.listed.delete(id);
    for (const id of [...this.taken]) if (this.listed.get(id)?.guestController !== "user") this.taken.delete(id);
    if (this.defaultOnList) {
      this.defaultOnList = false;
      if (!this.pinned) this.current = this.defaultAgent();
    }
    this.settle();
    return this.signature() !== before;
  }

  /** A guest `state` for one agent (protocol 1: always the main agent). Returns whether the projection changed. */
  applyAgentState(agent: string, controller: unknown, page: unknown): boolean {
    const before = this.signature();
    const guestController: BrowserLiveController = controller === "user" ? "user" : "agent";
    const parsed = browserLivePage(page);
    const known = this.listed.get(agent);
    if (known) {
      known.guestController = guestController;
      known.page = parsed;
    } else if (!this.perAgent && agent === BROWSER_LIVE_MAIN_AGENT) {
      this.legacy = { controller: guestController, page: parsed };
    }
    if (this.taken.has(agent) && guestController !== "user") this.taken.delete(agent);
    return this.signature() !== before;
  }

  /** The browser is not reachable or stopped: nobody holds a tab and no agent browses. */
  clearBrowsing(): void {
    this.listed.clear();
    this.taken.clear();
    this.legacy = { controller: "agent", page: null };
    this.settle();
  }

  // Questions -----------------------------------------------------------------------------------------------------

  /** Whether the agent has a tab the user can be shown (the main agent always, for a protocol 1 guest). */
  browsing(agent: string): boolean {
    return this.listed.has(agent) || (!this.perAgent && agent === BROWSER_LIVE_MAIN_AGENT);
  }

  /** Whether the user drives the agent's tab: Take control or its pending handoff. */
  userControls(agent: string): boolean {
    return this.taken.has(agent) || this.queue.some((pending) => pending.agent.id === agent);
  }

  get selected(): string {
    return this.current;
  }

  pendingOf(agent: string): BrowserLivePendingHandoff | null {
    return this.queue.find((pending) => pending.agent.id === agent) ?? null;
  }

  pending(id: string): BrowserLivePendingHandoff | null {
    return this.queue.find((pending) => pending.id === id) ?? null;
  }

  pendingAll(): readonly BrowserLivePendingHandoff[] {
    return this.queue;
  }

  /** A handoff of this agent is pending or starting: another one is `busy`. */
  handoffBusy(agent: string): boolean {
    return this.starting.has(agent) || this.pendingOf(agent) !== null;
  }

  anyStarting(): boolean {
    return this.starting.size > 0;
  }

  // The owner and the engine --------------------------------------------------------------------------------------

  /** The owner's choice of the agent to watch; false when that agent does not browse. Returns whether it changed. */
  select(agent: string): Readonly<{ ok: boolean; changed: boolean }> {
    if (!this.browsing(agent) && !this.pendingOf(agent)) return { changed: false, ok: false };
    this.pinned = agent;
    const before = this.current;
    this.current = agent;
    return { changed: before !== agent, ok: true };
  }

  /** The panel opened with no view before: without the owner's choice, the default is taken again. */
  viewOpened(): boolean {
    if (this.pinned) return false;
    this.defaultOnList = !this.perAgent;
    const before = this.current;
    this.current = this.defaultAgent();
    return before !== this.current;
  }

  setTaken(agent: string, taken: boolean): void {
    if (taken) this.taken.add(agent);
    else this.taken.delete(agent);
  }

  beginStarting(agent: string): void {
    this.starting.add(agent);
  }

  endStarting(agent: string): void {
    this.starting.delete(agent);
  }

  /** A new pending handoff; a new oldest one moves the stream to its agent. Returns whether the selection changed. */
  addHandoff(pending: BrowserLivePendingHandoff): boolean {
    const head = this.queue[0]?.id;
    this.queue.push(pending);
    this.queue.sort((left, right) => left.startedAt - right.startedAt);
    return this.headMoved(head);
  }

  /** A handoff ended (answered, timed out, aborted): its agent's tab returns to the agent. */
  removeHandoff(id: string): boolean {
    const index = this.queue.findIndex((pending) => pending.id === id);
    if (index < 0) return false;
    const head = this.queue[0]?.id;
    const [removed] = this.queue.splice(index, 1);
    this.taken.delete(removed!.agent.id);
    this.headMoved(head);
    return true;
  }

  /** Every pending handoff, oldest first, emptied (the run ended). */
  drainHandoffs(): BrowserLivePendingHandoff[] {
    const drained = this.queue.splice(0, this.queue.length);
    this.taken.clear();
    this.settle();
    return drained;
  }

  // Projection ----------------------------------------------------------------------------------------------------

  /** The agent fields of the state event. */
  project(): Pick<BrowserLiveStateEvent, "agents" | "controller" | "handoff" | "handoffs" | "page" | "selected"> {
    const agents = this.agentViews();
    const handoffs = this.queue.slice(0, BROWSER_LIVE_LIMITS.agentsPerEvent).map((pending): BrowserLiveHandoff => ({
      agent: pending.agent,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      id: pending.id,
      message: pending.message,
      reason: pending.reason,
      startedAt: new Date(pending.startedAt).toISOString()
    }));
    const selected = agents.find((agent) => agent.id === this.current);
    return {
      agents,
      controller: this.controllerOf(this.current),
      handoff: handoffs[0] ?? null,
      handoffs,
      page: selected?.page ?? null,
      selected: this.current
    };
  }

  private controllerOf(agent: string): BrowserLiveController {
    return this.userControls(agent) ? "user" : "agent";
  }

  private agentViews(): BrowserLiveAgent[] {
    const views: BrowserLiveAgent[] = [];
    const add = (id: string, name: string | null, page: Page) => {
      if (views.length >= BROWSER_LIVE_LIMITS.agentsPerEvent || views.some((view) => view.id === id)) return;
      views.push({ controller: this.controllerOf(id), id, name, page, waitingForUser: this.pendingOf(id) !== null });
    };
    if (!this.perAgent) add(BROWSER_LIVE_MAIN_AGENT, null, this.legacy.page);
    const main = this.listed.get(BROWSER_LIVE_MAIN_AGENT);
    if (main) add(main.id, null, main.page);
    for (const entry of this.listed.values()) add(entry.id, entry.name, entry.page);
    // An agent whose handoff outlived its slot stays on the list while the user is asked; the selected one too.
    for (const pending of this.queue) add(pending.agent.id, pending.agent.name, null);
    if (views.length === 0) add(BROWSER_LIVE_MAIN_AGENT, null, null);
    if (!views.some((view) => view.id === this.current)) {
      // The stream still shows an agent that is gone for a moment (`settle` moves it on the next report).
      views.length = Math.min(views.length, BROWSER_LIVE_LIMITS.agentsPerEvent - 1);
      views.push({ controller: this.controllerOf(this.current), id: this.current, name: null, page: null, waitingForUser: false });
    }
    return views;
  }

  private signature(): string {
    const listed = [...this.listed.values()].map((entry) => [entry.id, entry.name, entry.guestController, entry.page?.url,
      entry.page?.title]);
    return JSON.stringify([listed, [...this.taken], this.current, this.legacy.controller, this.legacy.page?.url,
      this.legacy.page?.title]);
  }

  private headMoved(previous: string | undefined): boolean {
    const head = this.queue[0];
    if (head && head.id !== previous) {
      // The user is asked something new: the stream shows that agent's tab, whatever was chosen before.
      this.pinned = null;
      const before = this.current;
      this.current = head.agent.id;
      return before !== this.current;
    }
    return this.settle();
  }

  /** Keeps the selection while its agent browses or waits; otherwise takes the default. */
  private settle(): boolean {
    if (this.pinned && !this.browsing(this.pinned) && !this.pendingOf(this.pinned)) this.pinned = null;
    if (this.browsing(this.current) || this.pendingOf(this.current)) return false;
    const before = this.current;
    this.current = this.defaultAgent();
    return before !== this.current;
  }

  private defaultAgent(): string {
    const head = this.queue[0];
    if (head) return head.agent.id;
    let latest: Listed | null = null;
    for (const entry of this.listed.values()) if (!latest || entry.acted > latest.acted) latest = entry;
    return latest?.id ?? BROWSER_LIVE_MAIN_AGENT;
  }
}

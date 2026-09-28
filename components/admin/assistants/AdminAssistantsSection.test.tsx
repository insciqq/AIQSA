import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import { AdminAssistantsSection } from "./AdminAssistantsSection";

const avatar = { accents: [1, 4], backgroundShape: "hexagon", foregroundShape: "circle", kind: "generated", paletteId: "ocean", recipeVersion: 1, rotations: [0, 3] };
const listedRow = (assistantId: string, name: string, featuredOrder: number | null, listedAt: string, chatCount30Days = 0) => ({
  assistantId, name, avatar, ownerDisplayName: "Local Operator", updatedAt: "2026-09-24T10:00:00.000Z", listedAt, featuredOrder, chatCount30Days
});
const listed = [
  listedRow("hr", "HR Helper", 0, "2026-09-10T00:00:00.000Z", 38),
  listedRow("jira", "Jira desk", 1, "2026-09-11T00:00:00.000Z", 1),
  listedRow("notes", "Meeting notes", null, "2026-09-12T00:00:00.000Z", 9)
];
const pendingRequest = { id: "request-1", state: "pending", definitionVersion: 3, outdated: false, createdAt: "2026-09-25T10:00:00.000Z",
  reviewedAt: null, reviewNote: null, assistantId: "writer", name: "Writing editor", avatar: null, ownerDisplayName: "Camila Collaborator",
  updatedAt: "2026-09-25T09:00:00.000Z", canReview: true };
const outdatedRequest = { ...pendingRequest, id: "request-2", assistantId: "sales", name: "Sales brief", outdated: true, canReview: false };
const definition = { version: 3, name: "Writing editor", description: "Edits drafts", category: "writing", avatar, instructions: "Be concise.\nKeep the author's voice.",
  answerRules: "", responseReminder: "Cite sources.", starterPrompts: ["Tighten this paragraph"],
  rows: { model: { policy: "fixed", value: { mode: "model", modelId: "gemini-flash" } }, controls: { policy: "adjustable", value: {} },
    search: { policy: "fixed", value: { mode: "off" } }, tools: { policy: "adjustable", value: { mode: "off" } },
    knowledge: { policy: "adjustable", value: { mode: "explicit", baseIds: ["kb-shared"], sourceIds: [], hiddenCount: 1 } },
    skills: { policy: "adjustable", value: { mode: "auto", links: [] } } },
  names: { models: [{ id: "gemini-flash", name: "Gemini Flash" }], knowledgeBases: [{ id: "kb-shared", name: "Company handbook" }],
    knowledgeSources: [], mcpServers: [], searchOptions: [], skills: [] } };

type Call = { body: unknown; method: string; url: string };
let calls: Call[];
let routes: (call: Call) => Response | Promise<Response>;

/**
 * The recorded calls to one URL suffix. Reloads after a mutation are issued
 * from effects, so assertions address calls by content, never by position.
 */
function callsTo(suffix: string): Call[] {
  return calls.filter((call) => call.url.endsWith(suffix));
}

function listResponse(state: "listed" | "requests", rows: unknown[], pendingCount = 1, nextCursor: string | null = null) {
  return Response.json(state === "listed" ? { state, assistants: rows, nextCursor, pendingCount } : { state, requests: rows, nextCursor, pendingCount });
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { body: init?.body ? JSON.parse(String(init.body)) : undefined, method: init?.method ?? "GET", url: String(input) };
    calls.push(call);
    return routes(call);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function Harness({ initialFilter = null, initialResource = null, requestConfirmation = vi.fn(), onPendingCount = vi.fn(),
  feedback = { reportError: vi.fn(), reportNotice: vi.fn() } }: {
  feedback?: { reportError(message: string): void; reportNotice(message: string): void };
  initialFilter?: string | null;
  initialResource?: string | null;
  onPendingCount?(count: number): void;
  requestConfirmation?(config: AdminConfirmationRequest): void;
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [resource, setResource] = useState(initialResource);
  const [pending, setPending] = useState(0);
  return (
    <AdminAssistantsSection
      feedback={feedback}
      filter={filter}
      onPendingCount={(count) => { setPending(count); onPendingCount(count); }}
      onSelectFilter={setFilter}
      onSelectResource={setResource}
      pendingCount={pending}
      requestConfirmation={requestConfirmation}
      resource={resource}
    />
  );
}

describe("AdminAssistantsSection", () => {
  it("lists Assistants for everyone with author, dates, 30-day chats and Featured positions", async () => {
    routes = () => listResponse("listed", listed, 2);
    const onPendingCount = vi.fn();
    render(<Harness onPendingCount={onPendingCount} />);
    const list = await screen.findByRole("list", { name: "Assistants listed for everyone" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-assistant-id"))).toEqual(["hr", "jira", "notes"]);
    expect(rows[0]).toHaveTextContent("HR Helper");
    expect(rows[0]).toHaveTextContent("By Local Operator");
    expect(rows[0]).toHaveTextContent("38 chats · 30 days");
    expect(rows[1]).toHaveTextContent("1 chat · 30 days");
    expect(within(rows[0]!).getByTestId("admin-assistant-featured-position")).toHaveTextContent("#1");
    expect(within(rows[2]!).queryByTestId("admin-assistant-featured-position")).toBeNull();
    expect(within(rows[0]!).getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
    expect(within(rows[2]!).getByRole("radiogroup", { name: "Featured: Meeting notes" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Listed for everyone" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Requests · 2" })).toHaveAttribute("aria-pressed", "false");
    expect(onPendingCount).toHaveBeenCalledWith(2);
    expect(calls.map((call) => call.url)).toEqual(["/api/admin/assistants?state=listed&limit=30"]);
  });

  it("opens a listed Assistant's Studio details from its row, between Featured and the menu", async () => {
    routes = () => listResponse("listed", [...listed, listedRow("id with/slash&x", "Odd id", null, "2026-09-13T00:00:00.000Z")]);
    render(<Harness />);
    const list = await screen.findByRole("list", { name: "Assistants listed for everyone" });
    const [hr] = within(list).getAllByRole("listitem");
    const open = within(hr!).getByRole("link", { name: "Open HR Helper" });
    expect(open).toHaveTextContent("Open");
    expect(open).toHaveAttribute("href", "/?library=assistants&assistant=hr");
    expect(open).not.toHaveAttribute("target");
    expect(open).toHaveAttribute("data-testid", "admin-assistant-open");
    expect(within(list).getByRole("link", { name: "Open Odd id" }))
      .toHaveAttribute("href", "/?library=assistants&assistant=id%20with%2Fslash%26x");
    const controls = Array.from(hr!.querySelectorAll<HTMLElement>("a[href], button"))
      .map((control) => control.getAttribute("aria-label") ?? control.textContent);
    expect(controls).toEqual(["On", "Off", "Open HR Helper", "More actions for HR Helper"]);
  });

  it("features, reorders and unfeatures from the returned order, keeping rows sorted", async () => {
    let featured = [{ assistantId: "hr", featuredOrder: 0 }, { assistantId: "jira", featuredOrder: 1 }];
    routes = (call) => {
      if (call.url.endsWith("/featured")) {
        const id = call.url.split("/")[4]!;
        const order = (call.body as { order: number | null }).order;
        const rest = featured.map((entry) => entry.assistantId).filter((entry) => entry !== id);
        if (order !== null) rest.splice(Math.min(order, rest.length), 0, id);
        featured = rest.map((assistantId, index) => ({ assistantId, featuredOrder: index }));
        return Response.json({ featured });
      }
      return listResponse("listed", listed);
    };
    const feedback = { reportError: vi.fn(), reportNotice: vi.fn() };
    render(<Harness feedback={feedback} />);
    const list = await screen.findByRole("list", { name: "Assistants listed for everyone" });
    const order = () => within(list).getAllByRole("listitem").map((row) => row.getAttribute("data-assistant-id"));

    const notes = within(list).getByRole("radiogroup", { name: "Featured: Meeting notes" });
    fireEvent.click(within(notes).getByRole("radio", { name: "On" }));
    await waitFor(() => expect(feedback.reportNotice).toHaveBeenCalledWith("Meeting notes is Featured at #3."));
    const notesOn = { body: { order: 2 }, method: "POST", url: "/api/admin/assistants/notes/featured" };
    expect(callsTo("/featured")).toEqual([notesOn]);

    fireEvent.click(within(list).getByRole("button", { name: "More actions for Meeting notes" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
    await waitFor(() => expect(order()).toEqual(["hr", "notes", "jira"]));
    const notesUp = { body: { order: 1 }, method: "POST", url: "/api/admin/assistants/notes/featured" };
    expect(callsTo("/featured")).toEqual([notesOn, notesUp]);
    expect(within(list).getAllByTestId("admin-assistant-featured-position").map((node) => node.textContent)).toEqual(
      ["#1Featured position 1", "#2Featured position 2", "#3Featured position 3"]
    );

    fireEvent.click(within(list).getByRole("button", { name: "More actions for HR Helper" }));
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toBeDisabled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    fireEvent.click(within(within(list).getByRole("radiogroup", { name: "Featured: HR Helper" })).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(order()).toEqual(["notes", "jira", "hr"]));
    expect(callsTo("/featured")).toEqual([notesOn, notesUp, { body: { order: null }, method: "POST", url: "/api/admin/assistants/hr/featured" }]);
    expect(feedback.reportNotice).toHaveBeenLastCalledWith("HR Helper is no longer Featured.");
  });

  it("reports the Featured limit instead of changing the row", async () => {
    routes = (call) => call.url.endsWith("/featured") ? Response.json({ error: "assistant_featured_limit" }, { status: 409 }) : listResponse("listed", listed);
    const feedback = { reportError: vi.fn(), reportNotice: vi.fn() };
    render(<Harness feedback={feedback} />);
    const notes = await screen.findByRole("radiogroup", { name: "Featured: Meeting notes" });
    fireEvent.click(within(notes).getByRole("radio", { name: "On" }));
    await waitFor(() => expect(feedback.reportError).toHaveBeenCalledWith(
      "Up to 8 Assistants can be Featured. Turn Featured off for another Assistant first."
    ));
    expect(within(notes).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  });

  it("unlists only after a confirmation that names the Assistant and the consequence", async () => {
    let unlisted = false;
    routes = (call) => {
      if (call.method === "DELETE") { unlisted = true; return new Response(null, { status: 204 }); }
      return listResponse("listed", unlisted ? listed.filter((row) => row.assistantId !== "hr") : listed);
    };
    const requestConfirmation = vi.fn();
    render(<Harness requestConfirmation={requestConfirmation} />);
    const list = await screen.findByRole("list", { name: "Assistants listed for everyone" });
    fireEvent.click(within(list).getByRole("button", { name: "More actions for HR Helper" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unlist…" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(requestConfirmation).toHaveBeenCalledOnce();
    const config = requestConfirmation.mock.calls[0]![0] as AdminConfirmationRequest;
    expect(config).toMatchObject({ confirmLabel: "Unlist", dialogLabel: "Unlist HR Helper", title: "Unlist HR Helper?", tone: "destructive",
      testId: "admin-confirm-unlist-assistant" });
    expect(config.body).toBe("HR Helper will be removed from everyone's Assistants list and from Featured. " +
      "People who can use it only because it is listed lose access to it. The owner keeps the Assistant and can ask to list it again.");
    await act(async () => { await config.onConfirm(); });
    expect(calls.find((call) => call.method === "DELETE")?.url).toBe("/api/admin/assistants/hr/publications/installation");
    await waitFor(() => expect(within(list).queryByText("HR Helper")).toBeNull());
    expect(calls.filter((call) => call.url.startsWith("/api/admin/assistants?state=listed"))).toHaveLength(2);
  });

  it("separates a loading failure from an empty list and retries", async () => {
    let attempts = 0;
    routes = () => ++attempts === 1 ? Response.json({ error: "assistant_listing_failed" }, { status: 503 }) : listResponse("listed", []);
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Assistants could not be loaded. Assistants are unavailable right now. Try again in a moment.");
    expect(screen.queryByText("No Assistants are listed for everyone yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No Assistants are listed for everyone yet")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows requests with Pending and Outdated, the pending count, and a linkable Review", async () => {
    window.history.replaceState(null, "", "/admin?section=assistants&filter=requests");
    routes = (call) => call.url.includes("state=requests") ? listResponse("requests", [pendingRequest, outdatedRequest], 1) : listResponse("listed", listed, 1);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Requests · 1" }));
    const list = await screen.findByRole("list", { name: "Requests to list an Assistant for everyone" });
    expect(screen.getByText(/1 awaiting review · Approving lists the Assistant for everyone\./u)).toBeVisible();
    const [pending, outdated] = within(list).getAllByRole("listitem");
    expect(pending).toHaveAttribute("data-request-status", "pending");
    expect(pending).toHaveTextContent("Pending");
    expect(outdated).toHaveAttribute("data-request-status", "outdated");
    expect(outdated).toHaveTextContent("Outdated");
    expect(outdated).toHaveTextContent("By Camila Collaborator");
    const review = within(pending!).getByRole("link", { name: "Review Writing editor" });
    expect(review).toHaveAttribute("href", "/admin?section=assistants&filter=requests&resource=request-1");
    expect(within(list).queryByRole("link", { name: /^Open / })).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("shows an empty request queue as a next step, not as a failure", async () => {
    routes = () => listResponse("requests", [], 0);
    render(<Harness initialFilter="requests" />);
    expect(await screen.findByText("No requests waiting for review")).toBeVisible();
    expect(screen.getByRole("button", { name: "Requests · 0" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reviews a pending request read-only, approves it with a note and offers Feature it", async () => {
    let decided = false;
    routes = (call) => {
      if (call.url.endsWith("/decision")) {
        decided = true;
        return Response.json({ request: { ...pendingRequest, state: "approved", canReview: false, reviewedAt: "2026-09-26T00:00:00.000Z", reviewNote: "Welcome" } });
      }
      if (call.url.endsWith("/featured")) return Response.json({ featured: [{ assistantId: "hr", featuredOrder: 0 }, { assistantId: "writer", featuredOrder: 1 }] });
      if (call.url.startsWith("/api/admin/assistant-listing-requests/")) return Response.json({ request: { ...pendingRequest, definition } });
      return listResponse("requests", decided ? [] : [pendingRequest], decided ? 0 : 1);
    };
    const onPendingCount = vi.fn();
    render(<Harness initialFilter="requests" initialResource="request-1" onPendingCount={onPendingCount} />);
    const sheet = await screen.findByRole("dialog", { name: "Review listing request" });
    await within(sheet).findByTestId("admin-assistant-review-definition");
    expect(within(sheet).getByText("Edits drafts")).toBeVisible();
    expect(within(sheet).getByText("Writing")).toBeVisible();
    expect(within(sheet).getByText("Tighten this paragraph")).toBeVisible();
    for (const [label, text] of [
      ["Model", "Gemini FlashFixed"], ["Reasoning & parameters", "Not setAdjustable"], ["Web search", "OffFixed"],
      ["Tools", "OffAdjustable"], ["Knowledge", "Company handbook, 1 base or source you can't accessAdjustable"],
      ["Skills", "Auto · No Skills selectedAdjustable"]
    ] as const) expect(within(sheet).getByTestId(`admin-assistant-setup-${label}`)).toHaveTextContent(text);
    expect(within(sheet).getByTestId("admin-assistant-review-instructions").textContent).toBe("Be concise.\nKeep the author's voice.");
    expect(within(sheet).getByText("Standard AIQSA answer rules.")).toBeVisible();
    expect(within(sheet).getByTestId("admin-assistant-review-response-reminder")).toHaveTextContent("Cite sources.");
    expect(within(sheet).getByTestId("admin-assistant-review-status")).toHaveTextContent("Pending");

    const note = within(sheet).getByRole("textbox", { name: "Review note (optional)" });
    fireEvent.change(note, { target: { value: "x".repeat(4_001) } });
    expect(within(sheet).getByText("4,001 / 4,000 characters")).toBeVisible();
    expect(within(sheet).getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.change(note, { target: { value: "  Welcome  " } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Approve" }));
    expect(await within(sheet).findByText(/Writing editor is now listed for everyone\./u)).toBeVisible();
    expect(callsTo("/decision")).toEqual([{
      body: { action: "approve", note: "Welcome" }, method: "POST", url: "/api/admin/assistant-listing-requests/request-1/decision"
    }]);
    expect(within(sheet).queryByRole("button", { name: "Approve" })).toBeNull();
    await waitFor(() => expect(onPendingCount).toHaveBeenLastCalledWith(0));

    fireEvent.click(within(sheet).getByRole("button", { name: "Feature it" }));
    expect(await within(sheet).findByText(/It is Featured at #2\./u)).toBeVisible();
    expect(callsTo("/featured")).toEqual([{ body: { order: 7 }, method: "POST", url: "/api/admin/assistants/writer/featured" }]);
    const [decisionCall] = callsTo("/decision"), [featuredCall] = callsTo("/featured");
    expect(calls.indexOf(decisionCall!)).toBeLessThan(calls.indexOf(featuredCall!));
    // The Featured change reloads the requests list; the sheet keeps the position the server returned.
    await waitFor(() => expect(calls.slice(calls.indexOf(featuredCall!) + 1).some((call) => call.url.includes("state=requests"))).toBe(true));
    expect(within(sheet).getByText(/It is Featured at #2\./u)).toBeVisible();
    expect(within(sheet).queryByRole("button", { name: "Feature it" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review listing request" })).toBeNull());
  });

  it("shows an outdated request without its definition or decision buttons", async () => {
    routes = (call) => call.url.startsWith("/api/admin/assistant-listing-requests/")
      ? Response.json({ request: { ...outdatedRequest, definition: null } })
      : listResponse("requests", [pendingRequest, outdatedRequest]);
    render(<Harness initialFilter="requests" initialResource="request-2" />);
    const sheet = await screen.findByRole("dialog", { name: "Review listing request" });
    expect(await within(sheet).findByTestId("admin-assistant-review-unavailable")).toHaveTextContent(
      "The owner changed this Assistant after asking to list it, so this request can no longer be decided and its definition is not available for review."
    );
    expect(within(sheet).getByTestId("admin-assistant-review-status")).toHaveTextContent("Outdated");
    expect(within(sheet).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Reject" })).toBeNull();
    expect(within(sheet).queryByRole("textbox")).toBeNull();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review listing request" })).toBeNull());
  });

  it("asks before discarding a typed note and keeps the request pending on reject", async () => {
    routes = (call) => {
      if (call.url.endsWith("/decision")) return Response.json({ request: { ...pendingRequest, state: "rejected", canReview: false, reviewNote: "Needs sources" } });
      if (call.url.startsWith("/api/admin/assistant-listing-requests/")) return Response.json({ request: { ...pendingRequest, definition } });
      return listResponse("requests", [pendingRequest]);
    };
    render(<Harness initialFilter="requests" initialResource="request-1" />);
    const sheet = await screen.findByRole("dialog", { name: "Review listing request" });
    const note = await within(sheet).findByRole("textbox", { name: "Review note (optional)" });
    fireEvent.change(note, { target: { value: "Needs sources" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    const discard = await screen.findByTestId("admin-assistant-review-discard");
    fireEvent.click(within(discard).getByRole("button", { name: "Keep reviewing" }));
    expect(screen.getByRole("dialog", { name: "Review listing request" })).toBeVisible();
    fireEvent.click(within(sheet).getByRole("button", { name: "Reject" }));
    expect(await within(sheet).findByText("Request rejected. The owner can read your note in Sharing.")).toBeVisible();
    expect(calls.find((call) => call.url.endsWith("/decision"))?.body).toEqual({ action: "reject", note: "Needs sources" });
  });

  it("drops the decision buttons when the request was decided elsewhere", async () => {
    let decidedElsewhere = false;
    routes = (call) => {
      if (call.url.endsWith("/decision")) { decidedElsewhere = true; return Response.json({ error: "assistant_listing_request_conflict" }, { status: 409 }); }
      if (call.url.startsWith("/api/admin/assistant-listing-requests/")) {
        return decidedElsewhere ? Response.json({ error: "assistant_listing_request_not_available" }, { status: 404 })
          : Response.json({ request: { ...pendingRequest, definition } });
      }
      return listResponse("requests", decidedElsewhere ? [] : [pendingRequest]);
    };
    render(<Harness initialFilter="requests" initialResource="request-1" />);
    const sheet = await screen.findByRole("dialog", { name: "Review listing request" });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Approve" }));
    expect(await within(sheet).findByText(/This request is no longer waiting for review\./u)).toBeVisible();
    expect(within(sheet).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(sheet).queryByTestId("admin-assistant-review-definition")).toBeNull();
  });

  it("explains a request that is no longer waiting instead of failing", async () => {
    routes = (call) => call.url.startsWith("/api/admin/assistant-listing-requests/")
      ? Response.json({ error: "assistant_listing_request_not_available" }, { status: 404 })
      : listResponse("requests", []);
    render(<Harness initialFilter="requests" initialResource="gone" />);
    const sheet = await screen.findByRole("dialog", { name: "Review listing request" });
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("This request is no longer waiting for review.");
    expect(within(sheet).queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

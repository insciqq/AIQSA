import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpApprovalCard } from "@/lib/contracts/mcpApprovals";
import { AnswerOutputsV2 } from "./AnswerOutputsV2";
import { McpApprovalCardsV2, McpApprovalContinuationTurnV2 } from "./McpApprovalCardV2";

const pending: McpApprovalCard = { approvalId: "approval-1", canDecide: true, details: { ordinal: 0, roundIndex: 1 },
  serverName: "Records", source: "model", state: "pending", toolName: "delete_record" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function decided(state: McpApprovalCard["state"]): McpApprovalCard {
  return { approvalId: pending.approvalId, serverName: pending.serverName, source: pending.source, state, toolName: pending.toolName };
}

describe("McpApprovalCardsV2", () => {
  it("asks with three verbs, posts the decision once with its nonce, and continues after an Allow", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ approval: decided("allowed_once") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onContinue = vi.fn(async () => undefined);
    render(<McpApprovalCardsV2 cards={[pending]} onContinue={onContinue} runId="run-1" />);
    const card = screen.getByRole("listitem", { name: "Approval for Records delete_record" });
    expect(card).toHaveTextContent("Approval needed");
    expect(card).toHaveTextContent("This tool may change data, so nothing was sent.");
    expect(within(card).getByRole("button", { name: /^Review arguments/u })).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(card).toHaveTextContent("Allowed once: only this exact call may run, once."));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("/api/model-runs/run-1/mcp-approvals/approval-1");
    expect(JSON.parse(String(init.body))).toEqual({ decision: "allow_once", nonce: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/u) });
    expect(onContinue).toHaveBeenCalledWith(decided("allowed_once"));
    expect(within(card).queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it("denies without continuing and repeats the nonce when a failed decision is retried", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ approval: decided("denied") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onContinue = vi.fn();
    render(<McpApprovalCardsV2 cards={[pending]} onContinue={onContinue} runId="run-1" />);
    const card = screen.getByTestId("mcp-approval-card");
    fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(within(card).getByRole("alert")).toHaveTextContent("Your decision could not be saved. Try again."));
    fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(card).toHaveTextContent("Nothing was sent."));
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("adopts the stored state of a card someone already decided", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ approval: decided("allowed_server"),
      error: "mcp_approval_already_decided" }), { status: 409 })));
    const onContinue = vi.fn();
    render(<McpApprovalCardsV2 cards={[pending]} onContinue={onContinue} runId="run-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Always allow for this server" }));
    await waitFor(() => expect(screen.getByTestId("mcp-approval-card")).toHaveTextContent(
      "Tools of Records now run without asking. You can revoke this in Settings › MCP servers."));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("keeps the verbs waiting while the answer runs and shows other members the card read-only", () => {
    const { rerender } = render(<McpApprovalCardsV2 cards={[pending]} live runId="run-1" />);
    expect(screen.getByTestId("mcp-approval-card")).toHaveTextContent("Nothing was sent. Decide when the answer finishes.");
    for (const name of ["Deny", "Always allow for this server", "Allow once"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    const { canDecide: _canDecide, details: _details, ...readOnly } = pending;
    rerender(<McpApprovalCardsV2 cards={[readOnly]} runId="run-1" />);
    expect(screen.getByTestId("mcp-approval-card")).toHaveTextContent("Only the person who sent this message can allow this tool.");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("explains guest-code and Agent refusals, and renders inside the answer outputs", () => {
    render(<AnswerOutputsV2 artifact={{ citations: [], reasoningText: [], sources: [], mcpApprovals: [
      { ...pending, approvalId: "approval-code", details: undefined, source: "code" },
      { ...pending, approvalId: "approval-agent", details: undefined, source: "agent" }
    ] }} runId="run-1" />);
    const [code, agent] = screen.getAllByTestId("mcp-approval-card");
    expect(code).toHaveTextContent("Code in the Workspace called this tool, which may change data. Nothing was sent.");
    expect(agent).toHaveTextContent("Agent called this tool, which may change data. Nothing was sent.");
    expect(screen.getByRole("region", { name: "Tool approvals" })).toBeVisible();
  });

  it("leaves Continue on the latest answer when the Allow started no run, and retries it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ approval: { ...decided("allowed_once"),
      canContinue: true } }), { status: 200 })));
    const onContinue = vi.fn(async () => "not_started" as const);
    render(<McpApprovalCardsV2 cards={[pending]} offerContinue onContinue={onContinue} runId="run-1" />);
    const card = screen.getByTestId("mcp-approval-card");
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    const retry = await within(card).findByRole("button", { name: "Continue" });
    expect(card).toHaveTextContent("Allowed once: only this exact call may run, once. The answer has not continued yet.");
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(2));
    expect(onContinue).toHaveBeenLastCalledWith({ ...decided("allowed_once"), canContinue: true });
    expect(await within(card).findByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("drops Continue once the server says the approval is gone", async () => {
    const allowed: McpApprovalCard = { ...decided("allowed_server"), canContinue: true };
    const onContinue = vi.fn(async () => "unavailable" as const);
    render(<McpApprovalCardsV2 cards={[allowed]} offerContinue onContinue={onContinue} runId="run-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Continue" })).toBeNull());
    expect(screen.getByTestId("mcp-approval-card")).not.toHaveTextContent("The answer has not continued yet.");
  });

  it("offers Continue only on the latest settled answer, for a card the server lets continue", () => {
    const allowed: McpApprovalCard = { ...decided("allowed_once"), canContinue: true };
    const onContinue = vi.fn();
    const { rerender } = render(<McpApprovalCardsV2 cards={[allowed]} onContinue={onContinue} runId="run-1" />);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    rerender(<McpApprovalCardsV2 cards={[allowed]} live offerContinue onContinue={onContinue} runId="run-1" />);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    rerender(<McpApprovalCardsV2 cards={[decided("allowed_once")]} offerContinue onContinue={onContinue} runId="run-1" />);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    rerender(<AnswerOutputsV2 artifact={{ citations: [], mcpApprovals: [allowed], reasoningText: [], sources: [] }}
      latestAnswer onContinueAfterMcpApproval={onContinue} runId="run-1" />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeVisible();
    rerender(<AnswerOutputsV2 artifact={{ citations: [], mcpApprovals: [allowed], reasoningText: [], sources: [] }}
      onContinueAfterMcpApproval={onContinue} runId="run-1" />);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("shows the server-written continuation turn as a compact chip", () => {
    render(<McpApprovalContinuationTurnV2 anchorId="message-1"
      content="The user approved `delete_record` on `Records`. Continue the task." />);
    expect(screen.getByRole("article", { name: "Approval" })).toHaveTextContent("Allowed: delete_record");
  });
});

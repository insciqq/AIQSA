import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AssistantDetailSheetView,
  AssistantGalleryView,
  AssistantResourceNames
} from "@/components/assistants/libraryViewContracts";
import type { AssistantDetail } from "@/lib/contracts/assistants";
import { assistantContent, assistantDetail, assistantSummary } from "@/tests/support/assistantLibraryFixtures";
import { ASSISTANT_NOT_AVAILABLE_TEXT, AssistantDetailSheetV2 } from "./AssistantDetailSheetV2";

const names: AssistantResourceNames = {
  knowledgeBases: [{ id: "base-hr", name: "HR handbook" }],
  knowledgeSources: [],
  mcpServers: [{ id: "mcp-jira", name: "Jira" }],
  models: [{ id: "model-1", label: "Model one" }],
  searchOptions: [{ id: "web", label: "Web Search" }]
};

function gallery(): AssistantGalleryView {
  return {
    assistants: [],
    onArchiveToggle: vi.fn(),
    onCopyLink: vi.fn(async () => true),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onEdit: vi.fn(),
    onOpenDetail: vi.fn(),
    onPinToggle: vi.fn(),
    onShare: vi.fn(),
    onStartChat: vi.fn(async () => true),
    recentAssistantIds: [],
    viewer: { canPublishInstallation: false, defaultAssistantId: null }
  };
}

function sheet(detail: AssistantDetail | null, overrides: Partial<AssistantDetailSheetView> = {}): AssistantDetailSheetView {
  return {
    assistantId: detail?.id ?? "assistant-1",
    detail,
    error: null,
    names,
    onClose: vi.fn(),
    onRetry: vi.fn(),
    state: detail ? "ready" : "loading",
    summary: assistantSummary({ updatedAt: "2026-09-24T12:00:00.000Z" }),
    ...overrides
  };
}

function renderSheet(view: AssistantDetailSheetView, actions = gallery()) {
  const onStartWithStarter = vi.fn();
  render(
    <AssistantDetailSheetV2
      busy={false}
      gallery={actions}
      notice={null}
      sheet={view}
      onDismissNotice={vi.fn()}
      onStartWithStarter={onStartWithStarter}
    />
  );
  return { actions, onStartWithStarter };
}

const ownerDetail = assistantDetail(4, {
  audience: { everyone: false, groupNames: ["Support team"] },
  content: assistantContent({
    answerRules: "Answer in short paragraphs.",
    description: "Answers questions about the handbook.",
    responseReminder: "SECRET REMINDER TEXT",
    rows: {
      controls: { policy: "adjustable", value: { reasoningEffort: "medium", temperature: 0.4 } },
      knowledge: { policy: "fixed", value: { baseIds: ["base-hr", "base-gone"], mode: "explicit", sourceIds: [] } },
      model: { policy: "adjustable", value: { mode: "model", modelId: "model-1" } },
      search: { policy: "fixed", value: { mode: "off" } },
      skills: { policy: "adjustable", value: { links: [{ delivery: "always", skillId: "skill-1" }, { delivery: "on_demand", skillId: "skill-2" }], mode: "auto" } },
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-jira"] } }
    },
    starterPrompts: ["What is covered?", "Explain leave"],
    systemPrompt: "You are the HR Helper.\nToday is {local_date}."
  }),
  featured: true,
  featuredOrder: 0,
  listingRequest: {
    canRequest: false,
    canWithdraw: true,
    listed: false,
    request: { createdAt: "2026-09-20T00:00:00.000Z", definitionVersion: 4, id: "request-1", outdated: false, reviewNote: null, reviewedAt: null, state: "pending" }
  },
  projects: { otherProjectCount: 1, projects: [{ id: "project-1", name: "People Ops" }] },
  publications: [{ groupId: "group-1", groupName: "Support team", id: "publication-1", scope: "group", updatedAt: "2026-09-20T00:00:00.000Z" }],
  recentChatCount: 38,
  rowAvailability: { model: { dependencies: [{ kind: "model", name: "Model one" }], reason: "model_access" } },
  skills: [{ id: "skill-1", name: "Policy citations" }, { id: "skill-2", name: "Leave rules" }],
  updatedAt: "2026-09-25T12:00:00.000Z"
});

describe("Assistant detail sheet", () => {
  it("shows the owner the header, starters, Setup rows, Sharing and Usage", () => {
    const { actions, onStartWithStarter } = renderSheet(sheet(ownerDetail));
    const dialog = screen.getByRole("dialog", { name: "Code reviewer" });
    expect(dialog).toHaveTextContent("Answers questions about the handbook.");
    expect(dialog).toHaveTextContent("Yours · 1 group · Updated Sep 25, 2026");
    expect(dialog).toHaveTextContent("Coding");
    expect(dialog).toHaveTextContent("Featured");

    fireEvent.click(within(dialog).getByRole("button", { name: "Explain leave" }));
    expect(onStartWithStarter).toHaveBeenCalledWith("assistant-1", "Explain leave");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start chat" }));
    expect(actions.onStartChat).toHaveBeenCalledWith("assistant-1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    expect(actions.onEdit).toHaveBeenCalledWith("assistant-1");
    const pin = within(dialog).getByRole("button", { name: "Pin" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin.querySelector("use")).toHaveAttribute("href", "#v2-icon-pin");

    const rows = within(dialog).getAllByRole("row").map((row) => row.textContent);
    expect(rows).toEqual([
      "ModelModel oneModel one isn't available to you. Your default will be used.Adjustable",
      "Reasoning & parametersReasoning: medium · Temperature 0.4Adjustable",
      "Web searchOffFixed",
      "ToolsJiraFixed",
      "KnowledgeHR handbook · 1 unavailableFixed",
      "SkillsLoads on demand · 1 always: Policy citations · 1 on demandAdjustable"
    ]);

    const sharing = within(dialog).getByRole("region", { name: "Sharing" });
    expect(sharing).toHaveTextContent("Groups: Support team · Featured #1");
    expect(sharing).toHaveTextContent("Request to list for everyone: waiting for an administrator");
    expect(sharing).toHaveTextContent("Used by Projects: People Ops, 1 other Project");
    fireEvent.click(within(sharing).getByRole("button", { name: "Manage sharing…" }));
    expect(actions.onShare).toHaveBeenCalledWith("assistant-1");
    expect(within(dialog).getByRole("region", { name: "Usage" })).toHaveTextContent("38 chats in the last 30 days");
  });

  it("renders the instructions preview with variables and only a marker for the reminder", () => {
    renderSheet(sheet(ownerDetail));
    const view = screen.getByRole("button", { name: "View" });
    expect(view).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("You are the HR Helper.")).toBeInTheDocument();
    fireEvent.click(view);
    const preview = screen.getByLabelText("Instructions preview");
    // The open text replaces the cut first line instead of repeating it.
    expect(screen.getAllByText(/You are the HR Helper\./u)).toEqual([preview]);
    expect(preview).toHaveTextContent("You are the HR Helper.");
    expect(preview.textContent).not.toContain("{local_date}");
    expect(preview.textContent).toMatch(/Today is \w+/u);
    expect(preview).toHaveTextContent("Answer rules: Answer in short paragraphs.");
    expect(preview).toHaveTextContent("[response reminder omitted]");
    expect(document.body.textContent).not.toContain("SECRET REMINDER TEXT");
    expect(screen.getByText("Visible to everyone who can use the Assistant. Only you can edit.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByText("You are the HR Helper.")).toBeInTheDocument();
  });

  it("shows a consumer counted rows, the same preview and no owner sections", () => {
    const consumer = assistantDetail(undefined, {
      availability: { ok: false, reason: "tools_access" },
      content: assistantContent({
        responseReminder: "Keep it short.",
        rows: {
          controls: { policy: "fixed", value: {} },
          knowledge: { policy: "fixed", value: { baseIds: ["base-hr"], hiddenCount: 2, mode: "explicit", sourceIds: [] } },
          model: { policy: "adjustable", value: { mode: "model", modelId: null } },
          search: { policy: "adjustable", value: { mode: "inherit" } },
          skills: { policy: "adjustable", value: { hiddenCount: 1, links: [], mode: "auto" } },
          tools: { policy: "fixed", value: { hiddenCount: 1, mode: "exact", serverIds: [] } }
        },
        starterPrompts: ["Brief me"]
      }),
      listingRequest: undefined,
      owned: false,
      ownerDisplayName: "Ada Analyst",
      projects: undefined,
      publications: undefined,
      recentChatCount: undefined,
      rowAvailability: { model: { reason: "model_access" } },
      scope: { groupNames: ["Sales group"], kind: "group" },
      version: undefined
    });
    const { actions } = renderSheet(sheet(consumer, {
      summary: assistantSummary({ owned: false, scope: { groupNames: ["Sales group"], kind: "group" } })
    }));
    const dialog = screen.getByRole("dialog", { name: "Code reviewer" });
    expect(dialog).toHaveTextContent("By Ada Analyst · 1 group · Updated Sep 20, 2026");
    // Each segment of the meta line wraps whole: the date is one piece.
    expect(within(dialog).getByText("Updated Sep 20, 2026")).toBeInTheDocument();
    expect(within(dialog).getByText("By Ada Analyst ·")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Not available to you");
    expect(within(dialog).getByRole("button", { name: "Start chat" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Brief me" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Manage sharing…" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "Usage" })).not.toBeInTheDocument();

    const rows = within(dialog).getAllByRole("row").map((row) => row.textContent);
    expect(rows).toEqual([
      "ModelA model you can't useYour default will be usedAdjustable",
      "Reasoning & parametersYour saved valuesFixed",
      "Web searchYour defaultAdjustable",
      "Tools1 MCP server you can't accessNot available to youFixed",
      "KnowledgeHR handbook · 2 bases or documents you can't accessFixed",
      "SkillsLoads on demand · 1 Skill you can't accessAdjustable"
    ]);
    expect(within(dialog).getByRole("region", { name: "Sharing" })).toHaveTextContent("Shared with Sales group");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
    expect(actions.onCopyLink).toHaveBeenCalledWith("assistant-1");

    fireEvent.click(within(dialog).getByRole("button", { name: "View" }));
    expect(screen.getByLabelText("Instructions preview")).toHaveTextContent("Review carefully. [response reminder omitted]");
    expect(document.body.textContent).not.toContain("Keep it short.");
  });

  it("says a missing fixed model once in the Model row: by name to the owner, as a fact to anyone else", () => {
    const blocked = {
      ...ownerDetail,
      availability: { dependencies: [{ kind: "model" as const, name: "GPT-5.5" }], ok: false as const, reason: "model_access" as const },
      content: { ...ownerDetail.content, rows: { ...ownerDetail.content.rows, model: { policy: "fixed" as const, value: { mode: "model" as const, modelId: "gpt-5.5" } } } },
      rowAvailability: {}
    };
    renderSheet(sheet(blocked, { summary: assistantSummary({ availability: blocked.availability, fingerprint: { ...assistantSummary().fingerprint, modelLabel: null } }) }));
    const owner = screen.getByRole("dialog", { name: "Code reviewer" });
    expect(owner).toHaveTextContent("Needs attention: GPT-5.5 isn't available");
    expect(within(owner).getByRole("row", { name: /^Model/u })).toHaveTextContent(/^ModelGPT-5\.5Not availableFixed$/u);
    cleanup();

    const consumer = {
      ...blocked,
      availability: { ok: false as const, reason: "model_access" as const },
      content: { ...blocked.content, rows: { ...blocked.content.rows, model: { policy: "fixed" as const, value: { mode: "model" as const, modelId: null } } } },
      owned: false
    };
    renderSheet(sheet(consumer, { summary: null }));
    const dialog = screen.getByRole("dialog", { name: "Code reviewer" });
    expect(dialog).toHaveTextContent("Not available to you");
    expect(within(dialog).getByRole("row", { name: /^Model/u })).toHaveTextContent(/^ModelA model you can't useFixed$/u);
  });

  it("says No Skills linked without the mode words when there is nothing they apply to", () => {
    renderSheet(sheet({
      ...ownerDetail,
      content: { ...ownerDetail.content, rows: { ...ownerDetail.content.rows, skills: { policy: "adjustable", value: { links: [], mode: "auto" } } } }
    }));
    expect(screen.getByRole("row", { name: /^Skills/u })).toHaveTextContent("SkillsNo Skills linkedAdjustable");
  });

  it("says Everyone in the header of an Assistant listed for everyone and names every group in Sharing", () => {
    renderSheet(sheet({
      ...ownerDetail,
      audience: { everyone: true, groupNames: ["Platform team", "Release managers", "SRE"] }
    }));
    const dialog = screen.getByRole("dialog", { name: "Code reviewer" });
    expect(dialog).toHaveTextContent("Yours · Everyone · Updated Sep 25, 2026");
    expect(within(dialog).getByRole("region", { name: "Sharing" }))
      .toHaveTextContent("Everyone in this installation · Groups: Platform team, Release managers, SRE · Featured #1");
  });

  it("reads Sharing from the detail: Only you for an unshared owner, the reaching scope for a consumer", () => {
    renderSheet(sheet({ ...ownerDetail, audience: { everyone: false, groupNames: [] }, featured: false, featuredOrder: null }));
    const owner = screen.getByRole("dialog", { name: "Code reviewer" });
    expect(owner).toHaveTextContent("Yours · Only you · Updated Sep 25, 2026");
    expect(within(owner).getByRole("region", { name: "Sharing" })).toHaveTextContent("Only you");
    cleanup();

    const consumer = assistantDetail(undefined, {
      featuredOrder: undefined, listingRequest: undefined, owned: false, ownerDisplayName: "Ada Analyst",
      projects: undefined, publications: undefined, recentChatCount: undefined,
      scope: { kind: "installation" }, version: undefined
    });
    // The list entry, when any, no longer decides the section.
    renderSheet(sheet(consumer, { summary: assistantSummary({ owned: false, scope: { groupNames: ["Stale"], kind: "group" } }) }));
    const sharing = within(screen.getByRole("dialog", { name: "Code reviewer" })).getByRole("region", { name: "Sharing" });
    expect(sharing).toHaveTextContent("Everyone in this installation");
    expect(sharing).not.toHaveTextContent("Stale");
    expect(within(sharing).queryByRole("button", { name: "Manage sharing…" })).not.toBeInTheDocument();
  });

  it("shows a Project member the Project scope and the update date without a list entry", () => {
    const member = assistantDetail(undefined, {
      featuredOrder: undefined,
      listingRequest: undefined,
      owned: false,
      ownerDisplayName: "Ada Analyst",
      projects: undefined,
      publications: undefined,
      recentChatCount: undefined,
      scope: { kind: "project", projectName: "Support" },
      updatedAt: "2026-09-22T12:00:00.000Z",
      version: undefined
    });
    const { actions } = renderSheet(sheet(member, { summary: null }));
    const dialog = screen.getByRole("dialog", { name: "Code reviewer" });
    expect(dialog).toHaveTextContent("By Ada Analyst · Project “Support” · Updated Sep 22, 2026");
    expect(within(dialog).queryByRole("button", { name: "Pin" })).not.toBeInTheDocument();
    const sharing = within(dialog).getByRole("region", { name: "Sharing" });
    expect(sharing).toHaveTextContent("Project “Support”");
    expect(within(sharing).queryByRole("button", { name: "Manage sharing…" })).not.toBeInTheDocument();
    fireEvent.click(within(sharing).getByRole("button", { name: "Copy link" }));
    expect(actions.onCopyLink).toHaveBeenCalledWith("assistant-1");
  });

  it("shows one neutral notice for an Assistant the viewer cannot open", () => {
    const view = sheet(null, { state: "unavailable", summary: null });
    renderSheet(view);
    const dialog = screen.getByRole("dialog", { name: "Assistant" });
    expect(within(dialog).getByRole("status")).toHaveTextContent(ASSISTANT_NOT_AVAILABLE_TEXT);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(view.onClose).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to Assistants" }));
    expect(view.onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed load retryable", () => {
    const view = sheet(null, { error: "Server unavailable.", state: "error" });
    renderSheet(view);
    expect(screen.getByRole("alert")).toHaveTextContent("Server unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(view.onRetry).toHaveBeenCalledOnce();
  });
});

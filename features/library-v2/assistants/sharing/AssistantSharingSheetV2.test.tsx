import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantResourceNames,
  AssistantSharingSheetView
} from "@/components/assistants/libraryViewContracts";
import type { AssistantDetail } from "@/lib/contracts/assistants";
import type { AssistantListingStatus } from "@/lib/contracts/assistantListing";
import { assistantContent, assistantDetail } from "@/tests/support/assistantLibraryFixtures";
import { AssistantSharingSheetV2 } from "./AssistantSharingSheetV2";
import { assistantSharingAccessItems } from "./assistantSharingCopy";

const names: AssistantResourceNames = {
  knowledgeBases: [{ id: "base-hr", name: "HR handbook" }],
  knowledgeSources: [],
  mcpServers: [{ id: "mcp-jira", name: "Jira" }, { id: "mcp-confluence", name: "Confluence" }],
  models: [{ id: "model-1", label: "Model one" }],
  searchOptions: [{ id: "web", label: "Web Search" }]
};

const groups = [
  { id: "group-a", memberCount: 12, name: "Platform team" },
  { id: "group-b", memberCount: 1, name: "Support" }
];

function groupPublication(groupId: string, groupName: string) {
  return { groupId, groupName, id: `pub-${groupId}`, scope: "group" as const, updatedAt: "2026-09-20T00:00:00.000Z" };
}

const installation = { groupId: null, groupName: null, id: "pub-installation", scope: "installation" as const, updatedAt: "2026-09-20T00:00:00.000Z" };

function pendingListing(overrides: Partial<NonNullable<AssistantListingStatus["request"]>> = {}): AssistantListingStatus {
  return {
    canRequest: overrides.outdated === true,
    canWithdraw: true,
    listed: false,
    request: {
      createdAt: "2026-09-25T10:00:00.000Z",
      definitionVersion: 3,
      id: "request-1",
      outdated: false,
      reviewNote: null,
      reviewedAt: null,
      state: "pending",
      ...overrides
    }
  };
}

const sharedDetail = assistantDetail(3, {
  content: assistantContent({
    name: "Jira desk",
    rows: {
      controls: { policy: "fixed", value: { temperature: 0.2 } },
      knowledge: { policy: "adjustable", value: { baseIds: ["base-hr"], mode: "explicit", sourceIds: [] } },
      model: { policy: "adjustable", value: { mode: "model", modelId: "model-1" } },
      search: { policy: "fixed", value: { mode: "off" } },
      skills: { policy: "adjustable", value: { links: [{ delivery: "always", skillId: "skill-1" }, { delivery: "on_demand", skillId: "skill-2" }], mode: "auto" } },
      tools: { policy: "fixed", value: { hiddenCount: 1, mode: "exact", serverIds: ["mcp-jira", "mcp-confluence", "mcp-gone"] } }
    }
  }),
  projects: { otherProjectCount: 1, projects: [{ id: "project-1", name: "Platform ops" }] },
  skills: [{ id: "skill-1", name: "Jira issue format" }]
});

function sheetView(overrides: Partial<AssistantSharingSheetView> = {}): AssistantSharingSheetView {
  const detail = overrides.detail === undefined ? sharedDetail : overrides.detail;
  return {
    assistantId: "assistant-1",
    detail,
    dirty: false,
    draft: { audience: "owner", featured: false, featuredOrder: 0, groupIds: [] },
    error: null,
    failures: [],
    featuredCount: 0,
    groups,
    isAdministrator: false,
    listing: detail?.listingRequest ?? null,
    name: "Jira desk",
    names,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onCopyLink: vi.fn(async () => true),
    onRetry: vi.fn(),
    onSave: vi.fn(async () => true),
    onWithdrawRequest: vi.fn(),
    saving: false,
    state: detail ? "ready" : "loading",
    withdrawing: false,
    ...overrides
  };
}

function withDetail(overrides: Partial<AssistantDetail>, view: Partial<AssistantSharingSheetView> = {}) {
  const detail = { ...sharedDetail, ...overrides };
  return sheetView({ detail, listing: detail.listingRequest ?? null, ...view });
}

afterEach(() => cleanup());

describe("Assistant Sharing sheet", () => {
  it("shows the owner every section: audience, required access, link and Projects", () => {
    const view = sheetView();
    render(<AssistantSharingSheetV2 view={view} />);
    const dialog = screen.getByRole("dialog", { name: "Sharing · Jira desk" });
    expect(dialog).toHaveAccessibleDescription("Who can start chats with this Assistant. Changes apply to future chats.");

    const audience = within(dialog).getByRole("group", { name: "Who can use it" });
    expect(within(audience).getByRole("radio", { name: "Only me" })).toBeChecked();
    expect(within(audience).getByRole("checkbox", { name: "Platform team" })).toBeDisabled();
    expect(within(audience).getByRole("checkbox", { name: "Platform team" })).toHaveAccessibleDescription("12 people");
    expect(within(audience).getByRole("checkbox", { name: "Support" })).not.toBeChecked();
    const everyone = within(audience).getByRole("radio", { name: "Request listing for everyone" });
    expect(everyone).toHaveAccessibleDescription(
      "An administrator reviews the Assistant, including its instructions, before it is listed."
    );
    expect(within(dialog).queryByRole("switch", { name: "Featured" })).toBeNull();

    // Fixed rows and Skill links only: the adjustable model and Knowledge are not listed.
    const access = within(dialog).getByRole("region", { name: "People you share with need access to" });
    expect(within(access).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["Jira", "Confluence", "2 more MCP servers", "Skill “Jira issue format”", "1 more Skill"]);
    expect(access).toHaveTextContent(
      "Those without access will see the Assistant as unavailable. Adjustable rows fall back to their own defaults."
    );

    const link = within(dialog).getByRole("region", { name: "Link" });
    expect(within(link).getByRole("textbox", { name: "Assistant link" }))
      .toHaveValue(`${window.location.origin}/assistant/assistant-1`);
    expect(link).toHaveTextContent("Opens a new chat with this Assistant for people who can use it; others land on their own new chat.");

    const projects = within(dialog).getByRole("region", { name: "Projects using this Assistant" });
    expect(within(projects).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["Platform ops", "1 other Project you can't open"]);
    expect(projects).toHaveTextContent("Project managers refresh dependencies from the Project.");

    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(within(audience).getByRole("radio", { name: "Selected groups" }));
    fireEvent.click(everyone);
    expect(view.onChange).toHaveBeenNthCalledWith(1, { audience: "groups" });
    expect(view.onChange).toHaveBeenNthCalledWith(2, { audience: "everyone" });
  });

  it("chooses groups with their member counts and asks for at least one", () => {
    const view = withDetail({ publications: [groupPublication("group-a", "Platform team")] }, {
      dirty: true,
      draft: { audience: "groups", featured: false, featuredOrder: 0, groupIds: ["group-a"] }
    });
    const { rerender } = render(<AssistantSharingSheetV2 view={view} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Support" }));
    expect(view.onChange).toHaveBeenCalledWith({ groupIds: ["group-a", "group-b"] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Platform team" }));
    expect(view.onChange).toHaveBeenLastCalledWith({ groupIds: [] });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(view.onSave).toHaveBeenCalledOnce();

    rerender(<AssistantSharingSheetV2 view={{ ...view, draft: { ...view.draft, groupIds: [] } }} />);
    expect(screen.getByText("Choose at least one group, or choose Only me.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Unchecking a saved group names what Save takes away.
    expect(screen.getByText("Saving stops sharing it with Platform team.")).toBeVisible();
  });

  it("keeps a group that is still published but no longer one of the owner's groups", () => {
    render(<AssistantSharingSheetV2 view={withDetail(
      { publications: [groupPublication("group-old", "Former team")] },
      { draft: { audience: "groups", featured: false, featuredOrder: 0, groupIds: ["group-old"] } }
    )} />);

    expect(screen.getByRole("checkbox", { name: "Former team" })).toBeChecked();
  });

  it("shows a pending request with Withdraw, and says Save sends a new one", () => {
    const pending = withDetail({ listingRequest: pendingListing() }, {
      draft: { audience: "everyone", featured: false, featuredOrder: 0, groupIds: [] }
    });
    const { rerender } = render(<AssistantSharingSheetV2 view={pending} />);
    const status = screen.getByText("Pending").closest("div")!;
    expect(status.querySelector("p")).toHaveTextContent(/^Pending · Sent Sep 25, 2026\.$/u);
    fireEvent.click(within(status).getByRole("button", { name: "Withdraw request" }));
    expect(pending.onWithdrawRequest).toHaveBeenCalledOnce();
    expect(screen.queryByText("Save sends the request to an administrator.")).toBeNull();

    rerender(<AssistantSharingSheetV2 view={withDetail({}, {
      dirty: true,
      draft: { audience: "everyone", featured: false, featuredOrder: 0, groupIds: [] }
    })} />);
    expect(screen.queryByText("Pending")).toBeNull();
    expect(screen.getByText("Save sends the request to an administrator.")).toBeVisible();
  });

  it("moves focus to the Everyone option once Withdraw removed the request", () => {
    const pending = withDetail({ listingRequest: pendingListing() }, {
      draft: { audience: "everyone", featured: false, featuredOrder: 0, groupIds: [] }
    });
    const { rerender } = render(<AssistantSharingSheetV2 view={pending} />);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    rerender(<AssistantSharingSheetV2 view={{ ...pending, withdrawing: true }} />);
    const withdrawn = withDetail({ listingRequest: { canRequest: true, canWithdraw: false, listed: false, request: { ...pendingListing().request!, state: "withdrawn" } } });
    rerender(<AssistantSharingSheetV2 view={withdrawn} />);

    expect(screen.queryByRole("button", { name: "Withdraw request" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Request listing for everyone" })).toHaveFocus();
  });

  it("shows rejected with the reviewer's note, outdated, and approved, and how to send a request again", () => {
    const rejected = {
      canRequest: true,
      canWithdraw: false,
      listed: false,
      request: { ...pendingListing().request!, reviewNote: "Remove the internal link first.", reviewedAt: "2026-09-26T12:00:00.000Z", state: "rejected" as const }
    };
    const { rerender } = render(<AssistantSharingSheetV2 view={withDetail({ listingRequest: rejected })} />);
    expect(screen.getByText("Rejected").closest("div")).toHaveTextContent(
      "Rejected · Reviewed Sep 26, 2026.Reviewer's note: Remove the internal link first.Choose this option and save to send it again."
    );
    expect(screen.queryByRole("button", { name: "Withdraw request" })).toBeNull();

    rerender(<AssistantSharingSheetV2 view={withDetail({ listingRequest: { ...rejected, request: { ...rejected.request, reviewNote: null } } })} />);
    expect(screen.getByText("Rejected").closest("p")).toHaveTextContent(
      "Rejected · Reviewed Sep 26, 2026. Choose this option and save to send it again."
    );

    rerender(<AssistantSharingSheetV2 view={withDetail({ listingRequest: pendingListing({ outdated: true }) })} />);
    expect(screen.getByText("Outdated").closest("p")).toHaveTextContent(
      "Outdated · Your Assistant changed since the request. Choose this option and save to send it again."
    );
    expect(screen.getByRole("button", { name: "Withdraw request" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Request listing for everyone" })).toBeEnabled();

    // Chosen, the option's hint says what Save does instead.
    rerender(<AssistantSharingSheetV2 view={withDetail({ listingRequest: pendingListing({ outdated: true }) }, {
      dirty: true,
      draft: { audience: "everyone", featured: false, featuredOrder: 0, groupIds: [] }
    })} />);
    expect(screen.getByText("Outdated").closest("p")).toHaveTextContent(/^Outdated · Your Assistant changed since the request\.$/u);
    expect(screen.getByText("Save sends the request to an administrator.")).toBeVisible();

    rerender(<AssistantSharingSheetV2 view={withDetail({
      listingRequest: {
        canRequest: false,
        canWithdraw: false,
        listed: true,
        request: { ...pendingListing().request!, reviewedAt: "2026-09-26T12:00:00.000Z", state: "approved" }
      },
      publications: [installation]
    }, { draft: { audience: "everyone", featured: false, featuredOrder: 0, groupIds: [] } })} />);
    expect(screen.getByText("Approved").closest("p")).toHaveTextContent("Approved · Listed for everyone since Sep 26, 2026.");
    // Listed, the option is the audience itself, described by its status.
    const listed = screen.getByRole("radio", { name: "Everyone in this installation" });
    expect(listed).toBeChecked();
    expect(listed).toHaveAccessibleDescription("Approved · Listed for everyone since Sep 26, 2026.");
    expect(screen.queryByText(/An administrator reviews the Assistant/u)).toBeNull();

    // Once the listing is gone, listing again takes a new request.
    rerender(<AssistantSharingSheetV2 view={withDetail({
      listingRequest: {
        canRequest: true,
        canWithdraw: false,
        listed: false,
        request: { ...pendingListing().request!, reviewedAt: "2026-09-26T12:00:00.000Z", state: "approved" }
      }
    })} />);
    expect(screen.getByRole("radio", { name: "Request listing for everyone" })).toHaveAccessibleDescription(
      "An administrator reviews the Assistant, including its instructions, before it is listed."
    );
  });

  it("disables Everyone when no request can be made", () => {
    render(<AssistantSharingSheetV2 view={withDetail({ listingRequest: { canRequest: false, canWithdraw: false, listed: false, request: null } })} />);

    expect(screen.getByRole("radio", { name: "Request listing for everyone" })).toBeDisabled();
  });

  it("lists an administrator's Assistant right away with Featured and its position", () => {
    const view = withDetail({ featured: true, featuredOrder: 1, listingRequest: { canRequest: false, canWithdraw: false, listed: true, request: null }, publications: [installation] }, {
      draft: { audience: "everyone", featured: true, featuredOrder: 1, groupIds: [] },
      featuredCount: 2,
      isAdministrator: true
    });
    render(<AssistantSharingSheetV2 view={view} />);

    const everyone = screen.getByRole("radio", { name: "Everyone in this installation" });
    expect(everyone).toBeChecked();
    expect(everyone).toHaveAccessibleDescription("You are an administrator: listed right away.");
    expect(screen.queryByText("Pending")).toBeNull();
    const featured = screen.getByRole("switch", { name: "Featured" });
    expect(featured).toHaveAttribute("aria-checked", "true");
    expect(featured).toHaveAccessibleDescription("Featured Shown on every empty chat.");
    expect(screen.getByRole("button", { name: "Move up in Featured" })).toHaveAccessibleDescription("Position 2 of 3");
    expect(screen.getByRole("button", { name: "Move down in Featured" })).toHaveAccessibleDescription("Position 2 of 3");

    fireEvent.click(screen.getByRole("button", { name: "Move up in Featured" }));
    expect(view.onChange).toHaveBeenLastCalledWith({ featuredOrder: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Move down in Featured" }));
    expect(view.onChange).toHaveBeenLastCalledWith({ featuredOrder: 2 });
    fireEvent.click(screen.getByRole("switch", { name: "Featured" }));
    expect(view.onChange).toHaveBeenLastCalledWith({ featured: false, featuredOrder: 1 });
  });

  it("keeps the position controls focusable at the ends and refuses a full Featured list", () => {
    const view = withDetail({ publications: [installation] }, {
      draft: { audience: "everyone", featured: true, featuredOrder: 0, groupIds: [] },
      featuredCount: 0,
      isAdministrator: true
    });
    const { rerender } = render(<AssistantSharingSheetV2 view={view} />);
    const up = screen.getByRole("button", { name: "Move up in Featured" });
    expect(up).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(up);
    fireEvent.click(screen.getByRole("button", { name: "Move down in Featured" }));
    expect(view.onChange).not.toHaveBeenCalled();

    rerender(<AssistantSharingSheetV2 view={{ ...view, draft: { ...view.draft, featured: false, featuredOrder: 8 }, featuredCount: 8 }} />);
    expect(screen.getByRole("switch", { name: "Featured" })).toBeDisabled();
    expect(screen.getByText(/Featured holds up to 8 Assistants/u)).toBeVisible();
  });

  it("names what leaving Everyone takes away before Save", () => {
    const { rerender } = render(<AssistantSharingSheetV2 view={withDetail(
      { featured: true, featuredOrder: 0, publications: [installation, groupPublication("group-a", "Platform team")] },
      { dirty: true, draft: { audience: "owner", featured: true, featuredOrder: 0, groupIds: [] }, isAdministrator: true }
    )} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(expect.arrayContaining([
      "Saving removes it from everyone in this installation and from Featured.",
      "Saving stops sharing it with Platform team."
    ]));

    rerender(<AssistantSharingSheetV2 view={withDetail(
      { listingRequest: pendingListing() },
      { dirty: true, draft: { audience: "owner", featured: false, featuredOrder: 0, groupIds: [] } }
    )} />);
    expect(screen.getByText("Saving withdraws your request to list it for everyone.")).toBeVisible();
  });

  it("shows each failure at its control, with the blocking Skill names, and what was saved", () => {
    const view = withDetail({ publications: [groupPublication("group-a", "Platform team")] }, {
      dirty: true,
      draft: { audience: "groups", featured: false, featuredOrder: 0, groupIds: ["group-a", "group-b"] },
      failures: [{
        code: "assistant_skill_audience_mismatch",
        skills: ["Jira issue format", "Incident brief"],
        target: { groupId: "group-b", kind: "group" },
        text: "Share every included Skill with this audience first, then save again."
      }]
    });
    render(<AssistantSharingSheetV2 view={view} />);

    const summary = screen.getByRole("alert");
    expect(summary).toHaveTextContent("Not everything was saved. The changes marked below were not applied; the rest is saved.");
    expect(summary).toHaveFocus();
    const support = screen.getByRole("checkbox", { name: "Support" });
    expect(support).toHaveAttribute("aria-invalid", "true");
    expect(support).toHaveAccessibleDescription(
      "1 person Share these Skills with Support first, then save again: “Jira issue format”, “Incident brief”."
    );
    expect(screen.getByRole("checkbox", { name: "Platform team" })).not.toHaveAttribute("aria-invalid");
  });

  it("says nothing was removed when a group that replaces another failed", () => {
    render(<AssistantSharingSheetV2 view={withDetail({ publications: [groupPublication("group-a", "Platform team")] }, {
      dirty: true,
      draft: { audience: "groups", featured: false, featuredOrder: 0, groupIds: ["group-b"] },
      failures: [{
        code: "assistant_skill_audience_mismatch",
        skills: ["Jira issue format"],
        target: { groupId: "group-b", kind: "group" },
        text: "Share every included Skill with this audience first, then save again."
      }]
    })} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not everything was saved. The changes marked below were not applied; nothing was removed."
    );
    // What was held back is still named, for the next Save.
    expect(screen.getByText("Saving stops sharing it with Platform team.")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Support" })).toHaveAccessibleDescription(
      "1 person Share the Skill “Jira issue format” with Support first, then save again."
    );
  });

  it("shows a listing and a Featured failure at their options", () => {
    render(<AssistantSharingSheetV2 view={withDetail({ publications: [installation] }, {
      dirty: true,
      draft: { audience: "everyone", featured: true, featuredOrder: 0, groupIds: [] },
      failures: [
        { code: "assistant_skill_audience_mismatch", skills: ["Jira issue format"], target: { kind: "everyone" }, text: "Share every included Skill with this audience first, then save again." },
        { code: "assistant_featured_invalid", skills: [], target: { kind: "featured" }, text: "Featured could not be changed." }
      ],
      isAdministrator: true
    })} />);

    expect(screen.getByRole("radio", { name: "Everyone in this installation" })).toHaveAccessibleDescription(
      "You are an administrator: listed right away. Share the Skill “Jira issue format” with everyone first, then save again."
    );
    expect(screen.getByRole("switch", { name: "Featured" })).toHaveAccessibleDescription(/Featured could not be changed\./u);
  });

  it("asks before discarding unsaved changes, on Cancel, Close and Escape", () => {
    const view = sheetView({ dirty: true, draft: { audience: "groups", featured: false, featuredOrder: 0, groupIds: ["group-a"] } });
    render(<AssistantSharingSheetV2 view={view} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const confirmation = screen.getByRole("dialog", { name: "Unsaved sharing changes" });
    expect(confirmation).toHaveTextContent("Discard sharing changes?");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog", { name: "Unsaved sharing changes" })).toBeNull();
    expect(view.onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sharing · Jira desk" }), { key: "Escape" });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Unsaved sharing changes" }))
      .getByRole("button", { name: "Confirm discard changes" }));
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it("closes a clean sheet on Escape and blocks closing while saving", () => {
    const view = sheetView();
    const { rerender } = render(<AssistantSharingSheetV2 view={view} />);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sharing · Jira desk" }), { key: "Escape" });
    expect(view.onClose).toHaveBeenCalledOnce();

    const saving = sheetView({ dirty: true, saving: true });
    rerender(<AssistantSharingSheetV2 view={saving} />);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sharing · Jira desk" }), { key: "Escape" });
    expect(saving.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("group", { name: "Who can use it" })).toBeDisabled();
  });

  it("copies the link and reports the result", async () => {
    const view = sheetView({ onCopyLink: vi.fn(async () => false) });
    render(<AssistantSharingSheetV2 view={view} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy link" })); });
    expect(screen.getByText("Could not copy the Assistant link.")).toBeInTheDocument();
  });

  it("shows loading and a load failure with Retry", () => {
    const { rerender } = render(<AssistantSharingSheetV2 view={sheetView({ detail: null, state: "loading" })} />);
    expect(screen.getByRole("status", { name: "Loading sharing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    const failed = sheetView({ detail: null, error: "Only the owner can share this assistant.", name: null, state: "error" });
    rerender(<AssistantSharingSheetV2 view={failed} />);
    expect(screen.getByRole("dialog", { name: "Sharing" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Only the owner can share this assistant.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failed.onRetry).toHaveBeenCalledOnce();
  });

  it("returns focus to the control that opened it", async () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Manage sharing…</button>
          {open ? <AssistantSharingSheetV2 view={sheetView({ onClose: () => setOpen(false) })} /> : null}
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Manage sharing…" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sharing · Jira desk" }), { key: "Escape" });
    await act(async () => { await Promise.resolve(); });
    expect(opener).toHaveFocus();
  });
});

describe("Focus after closing", () => {
  function Surface({ removeOpener = false }: Readonly<{ removeOpener?: boolean }>) {
    const [open, setOpen] = useState(false);
    const [closed, setClosed] = useState(false);
    const dirty = sheetView({ dirty: true, onClose: () => { setOpen(false); setClosed(true); } });
    return (
      <section aria-label="Cards">
        <article>
          <button type="button">Start chat with Jira desk</button>
          {removeOpener && closed ? null : (
            <button aria-label="More actions for Jira desk" type="button" onClick={() => setOpen(true)} />
          )}
        </article>
        {open ? <AssistantSharingSheetV2 view={dirty} /> : null}
      </section>
    );
  }

  it("returns to the opener after a confirmed discard", async () => {
    render(<Surface />);
    const opener = screen.getByRole("button", { name: "More actions for Jira desk" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Unsaved sharing changes" }))
      .getByRole("button", { name: "Confirm discard changes" }));

    await vi.waitFor(() => expect(opener).toHaveFocus());
  });

  it("goes to the nearest neighbour when the opener is gone, never to the page", async () => {
    render(<Surface removeOpener />);
    const opener = screen.getByRole("button", { name: "More actions for Jira desk" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sharing · Jira desk" }), { key: "Escape" });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Unsaved sharing changes" }))
      .getByRole("button", { name: "Confirm discard changes" }));

    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Start chat with Jira desk" })).toHaveFocus());
    expect(opener.isConnected).toBe(false);
  });
});

describe("Required access", () => {
  it("names only what the owner's catalogs resolve and counts the rest", () => {
    const detail = assistantDetail(3, {
      content: assistantContent({
        rows: {
          controls: { policy: "adjustable", value: {} },
          knowledge: { policy: "fixed", value: { baseIds: ["base-hr", "base-gone"], hiddenCount: 1, mode: "explicit", sourceIds: [] } },
          model: { policy: "fixed", value: { mode: "model", modelId: null } },
          search: { policy: "fixed", value: { mode: "model_choice", optionIds: ["web"] } },
          skills: { policy: "fixed", value: { links: [], mode: "auto" } },
          tools: { policy: "adjustable", value: { mode: "exact", serverIds: ["mcp-jira"] } }
        }
      })
    });

    expect(assistantSharingAccessItems(detail, names).map((item) => item.label)).toEqual([
      "1 model",
      "Web Search",
      "HR handbook",
      "2 more Knowledge bases or documents"
    ]);
    const adjustable = assistantContent().rows;
    expect(assistantSharingAccessItems(assistantDetail(3, {
      content: assistantContent({ rows: { ...adjustable, model: { ...adjustable.model, policy: "adjustable" } } })
    }), names)).toEqual([]);
  });
});

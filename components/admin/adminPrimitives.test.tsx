import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminGroup } from "@/lib/contracts/admin";
import {
  AdminAvailabilityStatus,
  AdminGroupOptions,
  AdminResourceDetailPane,
  AdminResourceIndexPane,
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  enableButton
} from "./adminPrimitives";

const activeGroup: AdminGroup = {
  accessGrants: [],
  archivedAt: null,
  id: "group-active",
  name: "Active group",
  systemRole: null,
  userCount: 1
};

const archivedGroup: AdminGroup = {
  ...activeGroup,
  archivedAt: "2026-07-01T00:00:00.000Z",
  id: "group-archived",
  name: "Archived group"
};

describe("AdminGroupOptions", () => {
  it("exposes only active groups and emits the next bounded selection", () => {
    const onChange = vi.fn<(groupIds: string[]) => void>();
    render(
      <AdminGroupOptions
        groups={[activeGroup, archivedGroup]}
        label="Default groups"
        onChange={onChange}
        selected={[activeGroup.id, archivedGroup.id]}
      />
    );

    const active = screen.getByRole("checkbox", { name: "Active group" });
    expect(active).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Archived group" })).not.toBeInTheDocument();

    fireEvent.click(active);

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("renders the deliberate empty state when no active groups exist", () => {
    render(
      <AdminGroupOptions
        groups={[archivedGroup]}
        label="Default groups"
        onChange={vi.fn()}
        selected={[]}
      />
    );

    expect(screen.getByRole("group", { name: "Default groups" })).toHaveTextContent("No groups");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("admin lifecycle presentation", () => {
  it("keeps enabled, disabled, and restoration actions semantically distinct", () => {
    render(
      <>
        <AdminAvailabilityStatus enabled />
        <AdminAvailabilityStatus enabled={false} />
        <button className={enableButton} type="button">Enable resource</button>
      </>
    );

    expect(screen.getByText("Enabled")).toHaveClass("border-positive/35", "bg-positive/[0.12]", "text-positive");
    expect(screen.getByText("Disabled")).toHaveClass("border-trace-strong", "bg-control-surface", "text-ink");
    expect(screen.getByRole("button", { name: "Enable resource" })).toHaveClass("border-proof/25", "bg-proof/[0.08]", "text-proof");
  });
});

describe("admin resource task panes", () => {
  it("keeps index and detail mounted while switching the compact task owner", () => {
    render(
      <>
        <AdminResourceIndexPane compactVisible testId="resource-index">
          Resource index
        </AdminResourceIndexPane>
        <AdminResourceDetailPane compactVisible={false} testId="resource-detail">
          Resource detail
        </AdminResourceDetailPane>
      </>
    );

    expect(screen.getByTestId("resource-index")).toHaveAttribute("data-admin-task-view", "index");
    expect(screen.getByTestId("resource-index")).toHaveClass("block", "lg:block");
    expect(screen.getByTestId("resource-detail")).toHaveAttribute("data-admin-task-view", "detail");
    expect(screen.getByTestId("resource-detail")).toHaveClass("hidden", "lg:block");
    expect(screen.getByText("Resource detail")).toBeInTheDocument();
  });

  it("keeps an inner resource list mounted while compact detail owns the viewport", () => {
    const onBack = vi.fn();
    render(
      <AdminTaskWorkspace indexWidth="20rem">
        <AdminTaskIndexPane compactDetailOpen testId="task-index">
          Task index
        </AdminTaskIndexPane>
        <AdminTaskDetailPane compactDetailOpen testId="task-detail">
          <AdminTaskBackButton label="Back to resources" onClick={onBack} />
          Task detail
        </AdminTaskDetailPane>
      </AdminTaskWorkspace>
    );

    expect(screen.getByTestId("task-index")).toHaveClass("hidden", "lg:block");
    expect(screen.getByTestId("task-detail")).toHaveClass("block", "lg:block");
    expect(screen.getByText("Task index")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to resources" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminGroup } from "@/lib/contracts/admin";
import { useState } from "react";
import {
  AdminAvailabilityStatus,
  AdminGroupOptions,
  AdminResourceDetailPane,
  AdminResourceIndexPane,
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  enableButton,
  focusRing,
  inputClass
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

    expect(screen.getByText("Enabled")).toHaveClass("border-positive/35", "bg-positive/[0.12]", "text-ink");
    expect(screen.getByText("Disabled")).toHaveClass("border-trace-strong", "bg-control-surface", "text-ink");
    expect(screen.getByRole("button", { name: "Enable resource" })).toHaveClass("border-proof/25", "bg-proof/[0.08]", "text-proof");
  });
});

describe("admin interactive recipes", () => {
  it("keeps enabled, invalid, disabled, and focused fields semantically distinct", () => {
    expect(inputClass).toContain("border-control-boundary");
    expect(inputClass).toContain("aria-[invalid=true]:border-critical");
    expect(inputClass).toContain("disabled:border-trace-subtle");
    expect(inputClass).toContain("disabled:text-ink-disabled");
    expect(focusRing).toContain("focus-visible:ring-focus");
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
      <AdminTaskWorkspace detailOpen indexWidth="20rem">
        <AdminTaskIndexPane compactDetailOpen testId="task-index">
          Task index
        </AdminTaskIndexPane>
        <AdminTaskDetailPane compactDetailOpen testId="task-detail">
          <AdminTaskBackButton label="Back to resources" onClick={onBack} />
          Task detail
        </AdminTaskDetailPane>
      </AdminTaskWorkspace>
    );

    const taskIndex = screen.getByTestId("task-index");
    const taskDetail = screen.getByTestId("task-detail");
    expect(taskIndex).toHaveClass("hidden");
    expect(taskIndex).not.toHaveClass("lg:block");
    expect(taskDetail).toHaveClass("block");
    expect(taskDetail).not.toHaveClass("lg:block");
    expect(taskIndex.parentElement).toHaveAttribute("data-admin-task-layout", "true");
    expect(taskIndex.parentElement?.parentElement).toHaveAttribute("data-admin-task-container", "true");
    expect(screen.getByRole("button", { name: "Back to resources" })).toHaveAttribute(
      "data-admin-task-back",
      "responsive"
    );
    expect(screen.getByText("Task index")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to resources" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("moves focus into an exclusive detail and restores its index opener on Back", () => {
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      display: element instanceof HTMLElement && element.classList.contains("hidden")
        ? "none"
        : "block"
    }) as CSSStyleDeclaration);

    function FocusWorkspace() {
      const [detailOpen, setDetailOpen] = useState(false);
      return (
        <section data-admin-task-focus-scope="true" data-testid="admin-section-focus-fixture">
          <button onClick={() => setDetailOpen(true)} type="button">Open resource</button>
          <AdminTaskWorkspace detailOpen={detailOpen}>
            <AdminTaskIndexPane compactDetailOpen={detailOpen} testId="focus-index">
              Resource index
            </AdminTaskIndexPane>
            <AdminTaskDetailPane compactDetailOpen={detailOpen} testId="focus-detail">
              <AdminTaskBackButton label="Back to resources" onClick={() => setDetailOpen(false)} />
            </AdminTaskDetailPane>
          </AdminTaskWorkspace>
        </section>
      );
    }

    try {
      render(<FocusWorkspace />);
      const opener = screen.getByTestId("admin-section-focus-fixture").querySelector("button");
      const back = screen.getByTestId("focus-detail").querySelector("button");
      expect(opener).not.toBeNull();
      expect(back).not.toBeNull();
      if (!opener || !back) return;
      opener.focus();
      fireEvent.click(opener);

      expect(back).toHaveFocus();

      fireEvent.click(back);
      expect(opener).toHaveFocus();
    } finally {
      styleSpy.mockRestore();
    }
  });

  it("leaves external modal focus alone while an exclusive detail closes", () => {
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      display: element instanceof HTMLElement && element.classList.contains("hidden")
        ? "none"
        : "block"
    }) as CSSStyleDeclaration);

    function FocusWorkspace() {
      const [detailOpen, setDetailOpen] = useState(false);
      return (
        <div>
          <button data-testid="external-action" onClick={() => setDetailOpen(false)} type="button">
            Complete modal action
          </button>
          <section data-admin-task-focus-scope="true" data-testid="admin-section-external-focus-fixture">
            <button onClick={() => setDetailOpen(true)} type="button">Open resource</button>
            <AdminTaskWorkspace detailOpen={detailOpen}>
              <AdminTaskIndexPane compactDetailOpen={detailOpen} testId="external-focus-index">
                Resource index
              </AdminTaskIndexPane>
              <AdminTaskDetailPane compactDetailOpen={detailOpen} testId="external-focus-detail">
                <AdminTaskBackButton label="Back to resources" onClick={() => setDetailOpen(false)} />
              </AdminTaskDetailPane>
            </AdminTaskWorkspace>
          </section>
        </div>
      );
    }

    try {
      render(<FocusWorkspace />);
      fireEvent.click(screen.getByText("Open resource"));
      const externalAction = screen.getByTestId("external-action");
      externalAction.focus();
      fireEvent.click(externalAction);

      expect(externalAction).toHaveFocus();
      expect(screen.getByTestId("external-focus-index")).not.toHaveFocus();
    } finally {
      styleSpy.mockRestore();
    }
  });

  it("moves focus off a responsive Back action when the workspace expands to a split", () => {
    let wide = false;
    let reconcileResize = () => {};
    const originalResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        reconcileResize = () => callback([], this as unknown as ResizeObserver);
      }
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      display: wide
        ? element instanceof HTMLElement && element.matches("[data-admin-task-back='responsive']")
          ? "none"
          : "block"
        : element instanceof HTMLElement && element.classList.contains("hidden")
          ? "none"
          : "block"
    }) as CSSStyleDeclaration);

    function FocusWorkspace() {
      const [detailOpen, setDetailOpen] = useState(false);
      return (
        <section data-admin-task-focus-scope="true" data-testid="admin-section-resize-focus-fixture">
          <button onClick={() => setDetailOpen(true)} type="button">Open resource</button>
          <AdminTaskWorkspace detailOpen={detailOpen}>
            <AdminTaskIndexPane compactDetailOpen={detailOpen} testId="resize-focus-index">
              Resource index
            </AdminTaskIndexPane>
            <AdminTaskDetailPane compactDetailOpen={detailOpen} testId="resize-focus-detail">
              <AdminTaskBackButton label="Back to resources" onClick={() => setDetailOpen(false)} />
            </AdminTaskDetailPane>
          </AdminTaskWorkspace>
        </section>
      );
    }

    try {
      render(<FocusWorkspace />);
      const opener = screen.getByText("Open resource");
      const detail = screen.getByTestId("resize-focus-detail");
      const back = detail.querySelector("button");
      expect(back).not.toBeNull();
      if (!back) return;
      opener.focus();
      fireEvent.click(opener);
      expect(back).toHaveFocus();

      wide = true;
      reconcileResize();
      expect(detail).toHaveFocus();
    } finally {
      styleSpy.mockRestore();
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    }
  });

  it("restores the latest opener selected inside a retained split", () => {
    let wide = true;
    let reconcileResize = () => {};
    const originalResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        reconcileResize = () => callback([], this as unknown as ResizeObserver);
      }
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      display: wide
        ? element instanceof HTMLElement && element.matches("[data-admin-task-back='responsive']")
          ? "none"
          : "block"
        : element instanceof HTMLElement && element.classList.contains("hidden")
          ? "none"
          : "block"
    }) as CSSStyleDeclaration);

    function FocusWorkspace() {
      const [detailOpen, setDetailOpen] = useState(false);
      const [selected, setSelected] = useState("none");
      const open = (id: string) => {
        setSelected(id);
        setDetailOpen(true);
      };
      return (
        <section data-admin-task-focus-scope="true">
          <AdminTaskWorkspace detailOpen={detailOpen}>
            <AdminTaskIndexPane compactDetailOpen={detailOpen} testId="retained-focus-index">
              <button data-admin-task-opener="true" onClick={() => open("A")} type="button">Resource A</button>
              <button data-admin-task-opener="true" onClick={() => open("B")} type="button">Resource B</button>
            </AdminTaskIndexPane>
            <AdminTaskDetailPane compactDetailOpen={detailOpen} testId="retained-focus-detail">
              <AdminTaskBackButton label="Back to resources" onClick={() => setDetailOpen(false)} />
              <button type="button">Work in {selected}</button>
            </AdminTaskDetailPane>
          </AdminTaskWorkspace>
        </section>
      );
    }

    try {
      render(<FocusWorkspace />);
      const openerA = screen.getByText("Resource A");
      const openerB = screen.getByText("Resource B");
      fireEvent.click(openerA);
      fireEvent.click(openerB);
      screen.getByText("Work in B").focus();

      wide = false;
      reconcileResize();
      const back = screen.getByText("Back to resources");
      back.focus();
      fireEvent.click(back);

      expect(openerB).toHaveFocus();
      expect(openerA).not.toHaveFocus();
    } finally {
      styleSpy.mockRestore();
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    }
  });

  it("falls back to a live index opener when a mutation removes the original owner", () => {
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
      display: element instanceof HTMLElement && element.classList.contains("hidden")
        ? "none"
        : "block"
    }) as CSSStyleDeclaration);

    function FocusWorkspace() {
      const [detailOpen, setDetailOpen] = useState(false);
      const [resourcePresent, setResourcePresent] = useState(true);
      return (
        <section data-admin-task-focus-scope="true">
          <AdminTaskWorkspace detailOpen={detailOpen}>
            <AdminTaskIndexPane compactDetailOpen={detailOpen} testId="removed-owner-index">
              <button data-admin-task-opener="true" type="button">Add resource</button>
              {resourcePresent ? (
                <button data-admin-task-opener="true" onClick={() => setDetailOpen(true)} type="button">
                  Resource A
                </button>
              ) : null}
            </AdminTaskIndexPane>
            <AdminTaskDetailPane compactDetailOpen={detailOpen} testId="removed-owner-detail">
              <button
                onClick={() => {
                  setResourcePresent(false);
                  setDetailOpen(false);
                }}
                type="button"
              >
                Delete and close
              </button>
            </AdminTaskDetailPane>
          </AdminTaskWorkspace>
        </section>
      );
    }

    try {
      render(<FocusWorkspace />);
      const opener = screen.getByText("Resource A");
      opener.focus();
      fireEvent.click(opener);
      const deleteAction = screen.getByText("Delete and close");
      deleteAction.focus();
      fireEvent.click(deleteAction);

      expect(screen.getByText("Add resource")).toHaveFocus();
    } finally {
      styleSpy.mockRestore();
    }
  });
});

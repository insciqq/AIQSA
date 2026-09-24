import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceActivityTimelineV2 } from "./WorkspaceActivityTimelineV2";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";

vi.mock("@/components/clipboard/writeClipboardText", () => ({
  writeClipboardText: vi.fn(async () => undefined)
}));

describe("WorkspaceActivityTimelineV2", () => {
  it("shows only confirmed failure guidance and keeps command diagnostics collapsed", () => {
    const { container } = render(<WorkspaceActivityTimelineV2 activity={{ entries: [
      { id: "timeout", kind: "command", phase: "failed", command: { preview: "python export.py" }, errorCode: "workspace_tool_timeout" },
      { id: "denied", kind: "file_read", phase: "failed", file: { displayPath: "project/input.png" }, errorCode: "workspace_path_access_denied" },
      { id: "unknown", kind: "file_check", phase: "failed", file: { displayPath: "project/checkpoint.json" }, errorCode: "workspace_operation_failed" },
      { id: "untrusted", kind: "file_list", phase: "failed", errorCode: "private-provider-body" as ThreadWorkspaceActivityEntry["errorCode"] }
    ] }} />);
    const command = container.querySelector("details")!;
    expect(command).not.toHaveAttribute("open");
    expect(screen.getByText(/does not confirm that execution stopped/u)).not.toBeVisible();
    expect(screen.getByText(/Access to the requested path was denied/u)).toBeVisible();
    expect(screen.getByText("Could not check project/checkpoint.json")).toBeVisible();
    expect(screen.getByText(/without a confirmed specific cause/u)).toBeVisible();
    expect(container.textContent).not.toContain("private-provider-body");
    fireEvent.click(command.querySelector("summary")!);
    expect(screen.getByText(/does not confirm that execution stopped/u)).toBeVisible();
    expect(command).not.toHaveTextContent(/Exit code/u);
  });

  it("keeps command details closed until requested and puts failure stderr first", () => {
    const { container } = render(
      <WorkspaceActivityTimelineV2
        activity={{
          entries: [
            { count: 2, durationMs: 800, id: "prep", kind: "attachments_prepare", phase: "succeeded" },
            { file: { displayPath: "package.json" }, id: "read", kind: "file_read", phase: "succeeded" },
            {
              command: { cwd: "project", exitCode: 0, preview: "npm install", stdoutPreview: "added 12 packages" },
              durationMs: 8_400,
              id: "install",
              kind: "command",
              phase: "succeeded"
            },
            {
              command: { exitCode: 1, preview: "npm test", stderrPreview: "TypeError: boom", stdoutPreview: "1 failing", truncated: true },
              durationMs: 4_100,
              id: "test",
              kind: "command",
              phase: "failed"
            },
            { command: { preview: "sleep 300" }, id: "stopped", kind: "command", phase: "cancelled" },
            { id: "recreated", kind: "workspace_recreated", phase: "succeeded" },
            { command: { preview: "pytest -q" }, groupId: "exec:1", id: "exec:1", kind: "command", phase: "running" }
          ]
        }}
      />
    );
    expect(screen.getByText("Prepared 2 attachments")).toBeVisible();
    expect(screen.getByText("Read package.json")).toBeVisible();
    expect(screen.getByText("Ran npm install")).toBeVisible();
    expect(screen.getByText("npm test failed")).toBeVisible();
    expect(screen.getByText("Stopped sleep 300")).toBeVisible();
    expect(screen.getByText("Running pytest -q…")).toBeVisible();
    expect(screen.getByText(/Original attachments were restored/u)).toBeVisible();
    expect(container.textContent).not.toMatch(/sandbox_|mcp_workspace/u);

    const cards = container.querySelectorAll("details.v2-workspace-command");
    expect(cards).toHaveLength(4);
    const install = cards[0]!;
    const failed = cards[1]!;
    expect(install).not.toHaveAttribute("open");
    for (const card of cards) expect(card).not.toHaveAttribute("open");
    fireEvent.click(failed.querySelector("summary")!);
    expect(failed).toHaveAttribute("open");
    const streams = [...failed.querySelectorAll("[data-stream]")].map((node) => node.getAttribute("data-stream"));
    expect(streams).toEqual(["stderr", "stdout"]);
    expect(failed).toHaveTextContent("TypeError: boom");
    expect(failed).toHaveTextContent("Output truncated");
    expect(failed).toHaveTextContent("Exit code 1 · 4.1 s");

    fireEvent.click(install.querySelector("summary")!);
    expect(install).toHaveAttribute("open");
    expect(install).toHaveTextContent("$ npm install");
    expect(install).toHaveTextContent("Working directory");
    expect(install).toHaveTextContent("added 12 packages");
    expect(install).toHaveTextContent("Exit code 0 · 8.4 s");
    fireEvent.click(screen.getAllByRole("button", { name: "Copy command" })[0]!);
  });

  it("preserves manual choices through phase and output changes without sharing them between commands", () => {
    const entry: ThreadWorkspaceActivityEntry = {
      id: "command-one", kind: "command", phase: "running", command: { preview: "python check.py" }
    };
    const { container, rerender } = render(<WorkspaceActivityTimelineV2 activity={{ entries: [entry] }} />);
    const card = container.querySelector("details.v2-workspace-command")!;
    fireEvent.click(card.querySelector("summary")!);
    expect(card).toHaveAttribute("open");

    const failed: ThreadWorkspaceActivityEntry = {
      ...entry, phase: "failed", command: { ...entry.command!, stderrPreview: "Synthetic failure", exitCode: 1 }
    };
    const second: ThreadWorkspaceActivityEntry = { ...failed, id: "command-two" };
    rerender(<WorkspaceActivityTimelineV2 activity={{ entries: [failed, second] }} />);
    expect(container.querySelector("details.v2-workspace-command")).toBe(card);
    expect(card).toHaveAttribute("open");
    expect(screen.getAllByText("Synthetic failure")[0]).toBeVisible();
    expect(container.querySelectorAll("details.v2-workspace-command")[1]).not.toHaveAttribute("open");

    fireEvent.click(card.querySelector("summary")!);
    rerender(<WorkspaceActivityTimelineV2 activity={{ entries: [
      { ...failed, durationMs: 800 }, { ...second, phase: "cancelled" }
    ] }} />);
    for (const row of container.querySelectorAll("details.v2-workspace-command")) {
      expect(row).not.toHaveAttribute("open");
    }
  });

  it("starts Show all command details closed and resets only after the overlay is remounted", () => {
    const entries: ThreadWorkspaceActivityEntry[] = Array.from({ length: 10 }, (_, index) => ({
      id: `command-${index}`, sequence: index, kind: "command", phase: "failed",
      command: { preview: "python check.py", stderrPreview: "Synthetic failure" }
    }));
    render(<WorkspaceActivityTimelineV2 activity={{ entries }} />);
    fireEvent.click(screen.getByRole("button", { name: /Show all/u }));
    let dialog = screen.getByRole("dialog", { name: "Workspace activity" });
    for (const row of dialog.querySelectorAll("details")) expect(row).not.toHaveAttribute("open");
    fireEvent.click(dialog.querySelector("summary")!);
    expect(dialog.querySelector("details")).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /Show all/u }));
    dialog = screen.getByRole("dialog", { name: "Workspace activity" });
    for (const row of dialog.querySelectorAll("details")) expect(row).not.toHaveAttribute("open");
  });
});

it("renders neutral closed and unknown commands without a spinner or success tick", () => {
  const { container } = render(<WorkspaceActivityTimelineV2 activity={{ entries: [
    { id: "closed", kind: "command", phase: "closed", command: { preview: "long-work" } },
    { id: "unknown", kind: "command", phase: "unknown", command: { preview: "other-work" } }
  ] }} />);
  expect(screen.getByText("long-work · exit not observed")).toBeVisible();
  expect(screen.getByText("other-work · outcome unconfirmed")).toBeVisible();
  expect(container.querySelector(".v2-spinner")).toBeNull();
  expect(container.querySelector('[data-status="complete"]')).toBeNull();
  expect(screen.queryByText(/Exit code 0/u)).not.toBeInTheDocument();
});

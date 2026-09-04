import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceActivityTimelineV2 } from "./WorkspaceActivityTimelineV2";

vi.mock("@/components/clipboard/writeClipboardText", () => ({
  writeClipboardText: vi.fn(async () => undefined)
}));

describe("WorkspaceActivityTimelineV2", () => {
  it("renders human rows, opens failed command cards with stderr first, and never shows raw tool names", () => {
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
});

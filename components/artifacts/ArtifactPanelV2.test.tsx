import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactPanelV2 } from "./ArtifactPanelV2";
import { closeArtifactPanel, openArtifactPanel, useArtifactPanelStore } from "./artifactPanelStore";
import type { ThreadGeneratedArtifact } from "@/lib/contracts/chats";

const latest = (versionNumber: number): ThreadGeneratedArtifact => ({ artifactId: "artifact", versionId: `v${versionNumber}`, versionNumber,
  title: "Counter", kind: "game", entrypoint: "index.html" });
let currentVersionId = "v1";
function installFixture() {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/content")
    ? new Response("<h1>Counter</h1>", { headers: { "content-type": "text/html" } })
    : Response.json({ artifact: { id: "artifact", title: "Counter", currentVersionId, sourceChatId: "chat", publications: [],
      versions: Array.from({ length: Number(currentVersionId.slice(1)) }, (_, index) => ({ id: `v${index + 1}`,
        versionNumber: index + 1, title: "Counter", kind: "game", entrypoint: "index.html" })) } })));
}
function Harness({ version, compact = false }: { version: number; compact?: boolean }) {
  const target = useArtifactPanelStore(state => state.open);
  return target ? <ArtifactPanelV2 target={target} compact={compact} latest={latest(version)} onEdit={vi.fn(async () => undefined)} /> : null;
}
afterEach(() => { closeArtifactPanel(false); currentVersionId = "v1"; vi.unstubAllGlobals(); });
describe("an answer's file in the chat panel (operator request 2026-11-20)", () => {
  const panelFile = (attachmentId: string, fileName: string) => ({ attachmentId, byteSize: 20, fileName, previewKind: "text" as const });

  it("docks beside the chat, replaces another file, expands to the window and back, and closes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(path.includes("/f2/") ? "second file" : "first file")));
    openArtifactPanel({ chatId: "chat", file: panelFile("f1", "first.txt") });
    render(<Harness version={1} />);
    const docked = await screen.findByRole("complementary", { name: "File preview: first.txt" });
    await waitFor(() => expect(docked).toHaveTextContent("first file"));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Another file takes the panel: the same artifact panel's rule, keyed by the file.
    act(() => openArtifactPanel({ chatId: "chat", file: panelFile("f2", "second.txt") }));
    const second = await screen.findByRole("complementary", { name: "File preview: second.txt" });
    await waitFor(() => expect(second).toHaveTextContent("second file"));
    fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));
    const expanded = await screen.findByRole("dialog", { name: "File preview: second.txt" });
    fireEvent.keyDown(expanded, { key: "Escape" });
    await screen.findByRole("complementary", { name: "File preview: second.txt" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand preview" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(useArtifactPanelStore.getState().open).toBeNull();
  });

  it("takes the window on a narrow screen, with no Expand", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("first file")));
    openArtifactPanel({ chatId: "chat", file: panelFile("f1", "first.txt") });
    render(<Harness version={1} compact />);
    const dialog = await screen.findByRole("dialog", { name: "File preview: first.txt" });
    await waitFor(() => expect(dialog).toHaveTextContent("first file"));
    expect(screen.queryByRole("button", { name: "Expand preview" })).toBeNull();
  });
});

describe("chat artifact panel", () => {
  it("follows new current versions without moving focus and keeps historical selection", async () => {
    installFixture();
    const input = document.createElement("textarea"); document.body.append(input); input.focus();
    openArtifactPanel({ chatId: "chat", artifactId: "artifact", versionId: "v1" });
    const { rerender } = render(<Harness version={1} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Version v1" })).toBeEnabled());
    currentVersionId = "v2";
    rerender(<Harness version={2} />);
    await screen.findByRole("button", { name: "Version v2" });
    expect(screen.getByText("Updated to v2")).toBeVisible();
    expect(input).toHaveFocus();
    rerender(<Harness version={1} />);
    expect(screen.getByRole("button", { name: "Version v2" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Version v2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^v1/ }));
    await screen.findByText("You’re viewing v1. The current version is v2.");
    const preview = await screen.findByTitle("Artifact preview");
    currentVersionId = "v3";
    rerender(<Harness version={3} />);
    await screen.findByText("You’re viewing v1. The current version is v3.");
    expect(screen.getByTitle("Artifact preview")).toBe(preview);
    fireEvent.click(screen.getByRole("button", { name: "Version v1" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["v3 · current", "v2", "v1"]);
    input.remove();
  });
  it("only handles desktop Escape within the panel and returns focus to its card", async () => {
    installFixture();
    const source = document.createElement("button"); document.body.append(source);
    openArtifactPanel({ chatId: "chat", artifactId: "artifact", versionId: "v1" }, source);
    render(<Harness version={1} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(await screen.findByRole("complementary", { name: "Artifact: Counter" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    await waitFor(() => expect(source).toHaveFocus());
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    source.remove();
  });
  it("opens a compact modal with inert background and restores it on close", async () => {
    installFixture();
    const source = document.createElement("button"); document.body.append(source); source.focus();
    act(() => openArtifactPanel({ chatId: "chat", artifactId: "artifact", versionId: "v1" }, source));
    render(<Harness version={1} compact />);
    const dialog = await screen.findByRole("dialog", { name: "Artifact: Counter" });
    expect(source.inert).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(source).toHaveFocus());
    expect(source.inert).not.toBe(true);
    source.remove();
  });
});

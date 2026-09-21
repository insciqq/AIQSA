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
      versions: [1, 2, 3].map(versionNumber => ({ id: `v${versionNumber}`, versionNumber, title: "Counter", kind: "game", entrypoint: "index.html" })) } })));
}
function Harness({ version, compact = false }: { version: number; compact?: boolean }) {
  const target = useArtifactPanelStore(state => state.open);
  return target ? <ArtifactPanelV2 target={target} compact={compact} latest={latest(version)} onEdit={vi.fn(async () => undefined)} /> : null;
}
afterEach(() => { closeArtifactPanel(false); currentVersionId = "v1"; vi.unstubAllGlobals(); });
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
    currentVersionId = "v3";
    rerender(<Harness version={3} />);
    await screen.findByRole("button", { name: "Version v1" });
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

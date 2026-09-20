import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactShareDialog } from "./ArtifactShareDialog";
import { appendArtifactDraft } from "./artifactDraft";
import { composerSessionKey, useComposerSessionStore } from "@/components/app-shell/composerSessionStore";

describe("artifact sharing and edit input", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("publishes only after confirmation, rejects duplicate clicks, and revokes the returned link", async () => {
    let settle!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { settle = resolve; }))
      .mockResolvedValueOnce(Response.json({ revoked: true }));
    vi.stubGlobal("fetch", fetcher);
    const onClose = vi.fn();
    render(<ArtifactShareDialog artifactId="artifact" versionId="version" versionNumber={3} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Publish version 3" });
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Link expires" }), { target: { value: "7" } });
    const publish = screen.getByRole("button", { name: "Publish v3" });
    fireEvent.click(publish); fireEvent.click(publish);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ versionId: "version", expiresInDays: 7 });
    await act(async () => settle(Response.json({ publication: { id: "publication", publicPath: `/a/${"x".repeat(43)}` } })));
    expect(screen.getByRole("textbox", { name: "Public link" })).toHaveValue(`${window.location.origin}/a/${"x".repeat(43)}`);
    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
    await screen.findByText("Link revoked. It can no longer be opened.");
    expect(screen.queryByRole("link", { name: "Open link" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls[1]![0]).toBe("/api/artifacts/publications/publication/revoke");
  });

  it("keeps the dialog usable after a network failure without inventing a public link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection lost")));
    render(<ArtifactShareDialog artifactId="artifact" versionId="version" versionNumber={1} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Publish v1" }));
    await screen.findByText("Connection lost");
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeEnabled());
    expect(screen.queryByRole("textbox", { name: "Public link" })).not.toBeInTheDocument();
  });

  it("preserves both drafts when editing is prepared while the user changes chats", () => {
    const store = useComposerSessionStore.getState();
    const first = composerSessionKey("artifact-draft-first");
    const second = composerSessionKey("artifact-draft-second");
    store.activateSession(first); store.updateSession(first, { draft: "My unsent change" });
    store.activateSession(second); store.updateSession(second, { draft: "Another conversation" });
    appendArtifactDraft("artifact-draft-first", "Edit the game");
    appendArtifactDraft("artifact-draft-first", "Edit the game");
    expect(useComposerSessionStore.getState().sessionsByKey[first]?.draft).toBe("My unsent change\n\nEdit the game");
    expect(useComposerSessionStore.getState().sessionsByKey[second]?.draft).toBe("Another conversation");
    store.removeSession(first); store.removeSession(second);
  });
});

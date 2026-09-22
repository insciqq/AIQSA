import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSecretsPanel } from "./WorkspaceSecretsPanel";
import { requestWorkspaceSecrets } from "./workspaceSecretsApi";
import { WORKSPACE_BROWSER_SESSION_MAX_COUNT, WORKSPACE_SECRET_MAX_COUNT, type WorkspaceSecretSummary } from "@/lib/contracts/workspaceSecrets";

vi.mock("./workspaceSecretsApi", () => ({ requestWorkspaceSecrets: vi.fn() }));
const request = vi.mocked(requestWorkspaceSecrets);
function expectDirty(value: boolean) {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(value);
}
const saved: WorkspaceSecretSummary = { id: "10000000-0000-4000-8000-000000000001", versionId: "10000000-0000-4000-8000-000000000002",
  kind: "text", name: "Saved access", description: "Use for the fixture service", byteSize: 45,
  updatedAt: "2026-09-11T00:00:00Z", envNames: [], originalName: null, sshProtected: false };

beforeEach(() => {
  // Exercise these actions with the Crypto API exposed on non-loopback HTTP.
  vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
});

afterEach(() => vi.unstubAllGlobals());

describe("WorkspaceSecretsPanel", () => {
  beforeEach(() => request.mockReset());

  it.each([
    [WORKSPACE_SECRET_MAX_COUNT, 0, "Browser session"],
    [0, WORKSPACE_BROWSER_SESSION_MAX_COUNT, "SSH key"],
    [WORKSPACE_SECRET_MAX_COUNT, WORKSPACE_BROWSER_SESSION_MAX_COUNT, null]
  ] as const)("keeps ordinary and browser-session capacity independent (%i, %i)", async (ordinary, sessions, initialType) => {
    request.mockResolvedValueOnce([
      ...Array.from({ length: ordinary }, (_, index) => ({ ...saved, id: `ordinary-${index}`, name: `Saved secret ${index}` })),
      ...Array.from({ length: sessions }, (_, index) => ({ ...saved, id: `browser-${index}`, name: `Saved session ${index}`, kind: "browser_session" as const }))
    ]);
    render(<WorkspaceSecretsPanel />);
    await screen.findByRole("heading", { name: ordinary ? "Saved secret 0" : "Saved session 0" });
    const add = screen.getByRole("button", { name: "Add secret" });
    if (initialType === null) {
      expect(add).toBeDisabled();
      return;
    }
    fireEvent.click(add);
    expect(screen.getByRole("radio", { name: initialType })).toBeChecked();
    expect(screen.getByRole("radio", { name: ordinary ? "Text" : "Browser session" })).toBeDisabled();
    expectDirty(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports dirty only while a create draft differs from its opening state", async () => {
    request.mockResolvedValueOnce([]);
    render(<WorkspaceSecretsPanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add secret" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    expectDirty(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expectDirty(false);

    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    fireEvent.click(screen.getByRole("radio", { name: "Environment" }));
    expectDirty(true);
    fireEvent.change(screen.getByLabelText("Variable name 1"), { target: { value: "API_TOKEN" } });
    fireEvent.click(screen.getByRole("radio", { name: "SSH key" }));
    expectDirty(false);
    fireEvent.change(screen.getByLabelText("Private SSH key"), { target: { value: "synthetic key" } });
    expectDirty(true);
    fireEvent.change(screen.getByLabelText("Private SSH key"), { target: { value: "" } });
    expectDirty(false);
  });

  it("reports edit metadata and replacement changes and clears dirty when they are reverted", async () => {
    request.mockResolvedValueOnce([saved]);
    render(<WorkspaceSecretsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Saved access" }));
    expectDirty(false);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed access" } });
    expectDirty(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: saved.name } });
    expectDirty(false);

    fireEvent.click(screen.getByLabelText("Replace saved value"));
    expectDirty(true);
    fireEvent.change(screen.getByLabelText("Secret text"), { target: { value: "replacement synthetic token" } });
    fireEvent.click(screen.getByLabelText("Replace saved value"));
    expectDirty(false);
  });

  it("shows browser origin metadata and imports original state bytes without showing saved cookies", async () => {
    const browser: WorkspaceSecretSummary = { ...saved, kind: "browser_session", name: "Shop session", originalName: "shop.example.json",
      browserSession: { autoSaved: true } };
    request.mockResolvedValueOnce([browser]);
    render(<WorkspaceSecretsPanel />);
    expect(await screen.findByText(/Saved by Workspace/)).toBeInTheDocument();
    expect(screen.getByText("shop.example.json")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Shop session" }));
    expect(screen.queryByLabelText("Browser session JSON")).toBeNull();
    fireEvent.click(screen.getByLabelText("Replace saved value"));
    const original = Buffer.from('{"cookies":[],"origins":[]}\r\n');
    const upload = new File([new Uint8Array(original)], "import.json", { type: "application/json" });
    Object.defineProperty(upload, "arrayBuffer", { value: async () => original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) });
    fireEvent.change(screen.getByLabelText("Browser session JSON"), { target: { files: [upload] } });
    await waitFor(() => expect(screen.getByLabelText("Session filename")).toHaveValue("import.json"));
    fireEvent.change(screen.getByLabelText("Session filename"), { target: { value: "shop.example.json" } });
    request.mockResolvedValueOnce([{ ...browser, browserSession: { autoSaved: false } }]);
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    await screen.findByText(/Imported/);
    expect(request).toHaveBeenLastCalledWith({ action: "update", id: browser.id, expectedVersionId: browser.versionId,
      name: browser.name, description: browser.description, value: { action: "replace", content: {
        kind: "browser_session", originalName: "shop.example.json", base64: original.toString("base64")
      } } });
  });

  it("ignores an aborted initial load after React remounts the effect", async () => {
    let reject!: (error: Error) => void;
    request.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValueOnce([]);
    render(<StrictMode><WorkspaceSecretsPanel /></StrictMode>);
    await screen.findByText("No saved Workspace secrets.");
    expect(request.mock.calls[0]![1]!.aborted).toBe(true);
    await act(async () => reject(new DOMException("Aborted", "AbortError")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Add secret" })).toBeEnabled();
  });

  it("keeps exact env input after failure, blocks duplicate writes and preserves focus after saving", async () => {
    request.mockResolvedValueOnce([]);
    render(<WorkspaceSecretsPanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add secret" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
    fireEvent.click(screen.getByRole("radio", { name: "Environment" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fixture API" } });
    fireEvent.change(screen.getByLabelText("Variable name 1"), { target: { value: "API_TOKEN" } });
    const value = "'\"$HOME`touch x`\nsecond line";
    fireEvent.change(screen.getByLabelText("Variable value 1"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove variable 2" }));
    expect(request).toHaveBeenCalledTimes(1);
    let reject!: (error: Error) => void;
    request.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    fireEvent.submit(screen.getByRole("form", { name: "Add Workspace secret" }));
    fireEvent.submit(screen.getByRole("form", { name: "Add Workspace secret" }));
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => reject(new Error("An environment name is already used by another saved secret.")));
    expect(await screen.findByRole("alert")).toHaveTextContent("already used");
    expect(screen.getByLabelText("Variable value 1")).toHaveValue(value);
    expectDirty(true);
    request.mockResolvedValueOnce([{ ...saved, kind: "env", name: "Fixture API", envNames: ["API_TOKEN"] }]);
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    await screen.findByRole("heading", { name: "Fixture API" });
    expect(request).toHaveBeenLastCalledWith({ action: "create", name: "Fixture API", description: "", value: { kind: "env", entries: [{ name: "API_TOKEN", value }] } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Fixture API" })).toHaveFocus());
    expectDirty(false);
    expect(screen.queryByText(value)).toBeNull();
  });

  it("renames with preserve, requires an explicit replacement, and deletes the exact version", async () => {
    request.mockResolvedValueOnce([saved]);
    render(<WorkspaceSecretsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Saved access" }));
    expect(screen.queryByLabelText("Secret text")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed access" } });
    const renamed = { ...saved, name: "Renamed access", versionId: "10000000-0000-4000-8000-000000000003" };
    request.mockResolvedValueOnce([renamed]);
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    await screen.findByRole("heading", { name: "Renamed access" });
    expect(request).toHaveBeenLastCalledWith({ action: "update", id: saved.id, expectedVersionId: saved.versionId,
      name: "Renamed access", description: saved.description, value: { action: "preserve" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit Renamed access" }));
    fireEvent.click(screen.getByLabelText("Replace saved value"));
    fireEvent.change(screen.getByLabelText("Secret text"), { target: { value: "replacement synthetic token" } });
    request.mockRejectedValueOnce(new Error("Temporary failure"));
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Secret text")).toHaveValue("replacement synthetic token");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions for Renamed access" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    request.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await screen.findByText("No saved Workspace secrets.");
    expect(request).toHaveBeenLastCalledWith({ action: "delete", id: renamed.id, expectedVersionId: renamed.versionId });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add secret" })).toHaveFocus());
  });

  it("uploads original binary bytes and offers private-key paste/upload without a host field", async () => {
    request.mockResolvedValueOnce([]);
    render(<WorkspaceSecretsPanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add secret" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    expect(screen.getByLabelText("Private SSH key")).toBeVisible();
    expect(screen.getByLabelText("Or upload a private key")).toBeVisible();
    expect(screen.queryByLabelText(/^Host$/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "File" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Original credentials" } });
    const bytes = Uint8Array.from([0, 255, 13, 10, 36]);
    const file = new File([bytes], "credentials.bin");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
    fireEvent.change(screen.getByLabelText(/Original file/), { target: { files: [file] } });
    await screen.findByText("credentials.bin");
    request.mockResolvedValueOnce([{ ...saved, kind: "file", name: "Original credentials", originalName: file.name }]);
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    await screen.findByRole("heading", { name: "Original credentials" });
    expect(request).toHaveBeenLastCalledWith({ action: "create", name: "Original credentials", description: "",
      value: { kind: "file", originalName: "credentials.bin", base64: "AP8NCiQ=" } });
  });

  it("merges .env locally, retains pasted drafts on close and sends only explicit Save", async () => {
    request.mockResolvedValueOnce([]);
    render(<WorkspaceSecretsPanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add secret" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    fireEvent.click(screen.getByRole("radio", { name: "Environment" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fixture env" } });
    fireEvent.change(screen.getByLabelText("Variable name 1"), { target: { value: "EXISTING" } });
    fireEvent.change(screen.getByLabelText("Variable value 1"), { target: { value: "old" } });
    fireEvent.click(screen.getByRole("button", { name: "Paste .env" }));
    const text = 'EXISTING=replaced\nNEW="first\\nsecond"\ninvalid line';
    fireEvent.change(screen.getByLabelText("Paste the contents of a .env file"), { target: { value: text } });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Add secret" }), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Unsaved Workspace secret" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Paste the contents of a .env file")).toHaveValue(text);
    fireEvent.click(screen.getByRole("button", { name: "Add variables" }));
    expect(screen.getByRole("status")).toHaveTextContent("Added 1, replaced 1, skipped 1.");
    expect(screen.getByLabelText("Variable value 2")).toHaveValue("first\nsecond");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce([{ ...saved, kind: "env", name: "Fixture env", envNames: ["EXISTING", "NEW"] }]);
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    await screen.findByRole("heading", { name: "Fixture env" });
    expect(request).toHaveBeenLastCalledWith({ action: "create", name: "Fixture env", description: "", value: {
      kind: "env", entries: [{ name: "EXISTING", value: "replaced" }, { name: "NEW", value: "first\nsecond" }]
    } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("blocks every sheet close during Save and keeps the draft after failure", async () => {
    request.mockResolvedValueOnce([]);
    render(<WorkspaceSecretsPanel />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add secret" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    fireEvent.change(screen.getByLabelText("Secret text"), { target: { value: "synthetic" } });
    let reject!: (error: Error) => void;
    request.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    for (const name of ["Cancel", "Close", "Dismiss"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Add secret" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Unsaved Workspace secret" })).toBeNull();
    await act(async () => reject(new Error("Synthetic failure")));
    expect(screen.getByLabelText("Secret text")).toHaveValue("synthetic");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("refreshes conflicting metadata without replacing the draft or its text selection", async () => {
    request.mockResolvedValueOnce([saved]);
    render(<WorkspaceSecretsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Saved access" }));
    fireEvent.click(screen.getByLabelText("Replace saved value"));
    const text = screen.getByLabelText("Secret text") as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "unsaved replacement" } });
    request.mockRejectedValueOnce(new Error("This secret changed in another window."));
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    await screen.findByRole("alert");
    request.mockResolvedValueOnce([{ ...saved, versionId: "10000000-0000-4000-8000-000000000003" }]);
    text.focus(); text.setSelectionRange(2, 7);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(text).toHaveValue("unsaved replacement");
    expect(text.selectionStart).toBe(2);
    expect(text.selectionEnd).toBe(7);
    await act(async () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve())));
    expect(screen.getByLabelText("Name")).not.toHaveFocus();
  });
});

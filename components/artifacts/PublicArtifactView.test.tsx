import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserLocksFixture } from "@/tests/support/browserLocks";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN, ARTIFACT_STORAGE_PLACEHOLDER } from "@/lib/contracts/artifactRuntime";
import { ARTIFACT_PUBLIC_VERSION_HEADER, type ArtifactPublicManifest } from "@/lib/contracts/artifacts";
import { PublicArtifactView } from "./PublicArtifactView";
import { publicArtifactStateKey } from "./artifactBrowserStorage";

function manifest(mode: "single" | "version_set" = "single", versions = [1], defaultVersionNumber = versions[0]!): ArtifactPublicManifest {
  return { mode, title: "Public page", kind: "game", expiresAt: null, defaultVersionNumber,
    versions: versions.map(versionNumber => ({ versionNumber, title: `Public v${versionNumber}`, kind: "game" })) };
}
function content(number: number) {
  return new Response(`${ARTIFACT_BRIDGE_SCRIPT_OPEN}const initial=${ARTIFACT_STORAGE_PLACEHOLDER};</script><p>Version ${number}</p>`,
    { headers: { "content-type": "text/html", [ARTIFACT_PUBLIC_VERSION_HEADER]: String(number) } });
}
function number(init?: RequestInit) { return Number(new Headers(init?.headers).get(ARTIFACT_PUBLIC_VERSION_HEADER)); }
function fetcher(value = manifest()) {
  return vi.fn(async (path: string, init?: RequestInit) => path.endsWith("/manifest") ? Response.json({ publication: value }) : content(number(init)));
}
function navigate(hash: string) {
  act(() => { window.history.replaceState(window.history.state, "", hash || "/"); window.dispatchEvent(new PopStateEvent("popstate")); });
}
async function choose(version: number) {
  fireEvent.click(screen.getByRole("button", { name: /^Version v/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: `v${version}` }));
}

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
beforeEach(() => vi.stubGlobal("navigator", { locks: createBrowserLocksFixture() }));

describe("public artifact body", () => {
  it("offers confirmed links and resets only this public namespace", async () => {
    vi.stubGlobal("crypto", { randomUUID: crypto.randomUUID.bind(crypto), subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).fill(4).buffer) } });
    vi.stubGlobal("fetch", fetcher());
    localStorage.setItem("aiqsa.artifact.state.private", "keep private state");
    render(<PublicArtifactView initialManifest={manifest()} token="public-reset" />);
    const iframe = await screen.findByLabelText("Public v1", { selector: "iframe" }) as HTMLIFrameElement;
    const key = await publicArtifactStateKey("public-reset");
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null", source: iframe.contentWindow,
      data: { type: "aiqsa_artifact_storage_set", key: "score", value: "9" } })));
    await waitFor(() => expect(localStorage.getItem(key)).not.toBeNull());
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null", source: iframe.contentWindow,
      data: { type: "aiqsa_artifact_open_link", href: "https://example.com/read" } })));
    expect(screen.getByRole("dialog", { name: "Open external link?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Artifact actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset saved state" }));
    await screen.findByText("Saved state reset for this artifact.");
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("aiqsa.artifact.state.private")).toBe("keep private state");
    expect(screen.getByLabelText("Public v1", { selector: "iframe" })).not.toBe(iframe);
  });
  it("fetches a single-version body once on the client and keeps runtime repair private", async () => {
    const fetch = fetcher(); vi.stubGlobal("fetch", fetch);
    render(<PublicArtifactView initialManifest={manifest()} token="opaque-fixture" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading artifact");
    const iframe = await screen.findByLabelText("Public v1") as HTMLIFrameElement;
    expect(fetch.mock.calls.filter(([path]) => !path.endsWith("/manifest"))).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith("/api/artifact-public/opaque-fixture", expect.objectContaining({ cache: "no-store", headers: { [ARTIFACT_PUBLIC_VERSION_HEADER]: "1" } }));
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-pointer-lock allow-downloads");
    expect(iframe).toHaveAttribute("allow", "fullscreen; clipboard-write");
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null", source: iframe.contentWindow,
      data: { type: "aiqsa_artifact_runtime_error", kind: "error", message: "failure", line: 1, column: 0 } })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fix with AI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Version/ })).not.toBeInTheDocument();
  });
  it("explains unavailable content and permits an explicit retry", async () => {
    const fetch = fetcher(); let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (!path.endsWith("/manifest") && fail) { fail = false; return new Response("", { status: 410 }); }
      return fetch(path, init);
    }));
    render(<PublicArtifactView initialManifest={manifest()} token="fixture" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This artifact is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Public v1")).toHaveAttribute("srcdoc", expect.stringContaining("Version 1"));
  });
  it("uses permanent numbers, preserves history state and follows hash navigation", async () => {
    const value = manifest("version_set", [5, 1, 3], 3); const fetch = fetcher(value); vi.stubGlobal("fetch", fetch);
    window.history.replaceState({ preserved: true }, "", "#v1");
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    await screen.findByLabelText("Public v1");
    fireEvent.click(screen.getByRole("button", { name: "Version v1" }));
    expect(screen.getAllByRole("menuitem").map(item => item.getAttribute("aria-label"))).toEqual(["v5", "v1", "v3"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "v5" }));
    await screen.findByLabelText("Public v5");
    expect(window.location.hash).toBe("#v5"); expect(window.history.state).toEqual({ preserved: true });
    navigate("#v1"); await screen.findByLabelText("Public v1");
    navigate(""); await screen.findByLabelText("Public v3");
    expect(fetch.mock.calls.filter(([path]) => !path.endsWith("/manifest")).map(([, init]) => number(init))).toEqual([1, 5, 1, 3]);
  });
  it.each(["#v2", "#v0", "#v01", "#v2147483648", "#private", "#v1/secret"])("normalizes an unavailable fragment %s without requesting it", async fragment => {
    const value = manifest("version_set", [1, 3], 3); const fetch = fetcher(value); vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", fragment);
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    await screen.findByLabelText("Public v3");
    expect(screen.getByRole("status")).toHaveTextContent("Requested version is unavailable. Showing v3.");
    expect(window.location.hash).toBe("#v3");
    expect(fetch.mock.calls.filter(([path]) => !path.endsWith("/manifest")).map(([, init]) => number(init))).toEqual([3]);
  });
  it("ignores a late response after a newer selection wins", async () => {
    const value = manifest("version_set", [1, 3], 3); let release!: (value: Response) => void;
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/manifest")) return Response.json({ publication: value });
      return number(init) === 1 ? new Promise<Response>(resolve => { release = resolve; }) : content(3);
    });
    vi.stubGlobal("fetch", fetch); window.history.replaceState(null, "", "#v1");
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    await choose(3); const winning = await screen.findByLabelText("Public v3");
    await act(async () => release(content(1)));
    expect(screen.getByLabelText("Public v3")).toBe(winning);
    expect(screen.queryByLabelText("Public v1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });
  it("falls back only after a fresh manifest proves that the selected member was removed", async () => {
    const value = manifest("version_set", [1, 3], 3); let manifests = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => path.endsWith("/manifest")
      ? Response.json({ publication: ++manifests === 1 ? value : manifest("version_set", [3], 3) })
      : number(init) === 1 ? new Response("", { status: 404 }) : content(3)));
    window.history.replaceState(null, "", "#v1");
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    await screen.findByLabelText("Public v3");
    expect(screen.getByRole("status")).toHaveTextContent("Requested version is unavailable. Showing v3.");
    expect(window.location.hash).toBe("#v3");
  });
  it.each([404, 429])("does not substitute the default after a still-published snapshot fails with %i", async status => {
    const value = manifest("version_set", [1, 3], 3); const calls: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/manifest")) return Response.json({ publication: value });
      calls.push(number(init)); return new Response("", { status });
    }));
    window.history.replaceState(null, "", "#v1");
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(status === 429 ? "Too many requests" : "This artifact is unavailable");
    expect(calls).toEqual([1]); expect(window.location.hash).toBe("#v1");
    expect(screen.queryByText(/Requested version is unavailable/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  });
  it("fails closed when the publication itself is no longer authorized", async () => {
    const value = manifest("version_set", [1, 3], 3); const fetch = vi.fn().mockResolvedValue(new Response("", { status: 404 })); vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", "#v1");
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    await screen.findByRole("alert"); expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Requested version is unavailable/)).not.toBeInTheDocument();
  });
  it("rejects content that does not attest to the requested version", async () => {
    const value = manifest("version_set", [1, 3], 3);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/manifest")
      ? Response.json({ publication: value }) : content(1)));
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this artifact. Try again.");
    expect(screen.queryByLabelText("Public v1")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Public v3")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  });
  it("keeps token-scoped saves across a version change and isolates a reissued token", async () => {
    const value = manifest("version_set", [1, 3], 3); vi.stubGlobal("fetch", fetcher(value));
    vi.stubGlobal("crypto", { randomUUID: crypto.randomUUID.bind(crypto), subtle: { digest: vi.fn(async (_algorithm, bytes: Uint8Array) => new Uint8Array(32).fill(bytes[0]).buffer) } });
    window.history.replaceState(null, "", "#v1");
    const { rerender } = render(<PublicArtifactView initialManifest={value} token="first" />);
    const iframe = await screen.findByLabelText("Public v1") as HTMLIFrameElement;
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "null", source: iframe.contentWindow,
      data: { type: "aiqsa_artifact_storage_set", key: "level", value: "8" } })));
    await choose(3);
    expect(await screen.findByLabelText("Public v3")).toHaveAttribute("srcdoc", expect.stringContaining('[["level","8"]]'));
    rerender(<PublicArtifactView initialManifest={value} token="reissued" />);
    await waitFor(() => expect(screen.getByLabelText("Public v3")).toHaveAttribute("srcdoc", expect.stringContaining("const initial=[]")));
  });
  it("downloads exactly the displayed version using the bounded header", async () => {
    const value = manifest("version_set", [1, 3], 3); let downloaded: HTMLAnchorElement | undefined;
    const fetch = vi.fn(async (path: string, init?: RequestInit) => path.endsWith("?download=zip")
      ? new Response("PK fixture", { headers: { "content-type": "application/zip", [ARTIFACT_PUBLIC_VERSION_HEADER]: String(number(init)), "content-disposition": "attachment; filename=\"version-one.zip\"" } })
      : fetcher(value)(path, init));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloaded = this; });
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn().mockReturnValue("blob:fixture"); static revokeObjectURL = vi.fn(); });
    window.history.replaceState(null, "", "#v1");
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    await screen.findByLabelText("Public v1");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(downloaded?.download).toBe("version-one.zip"));
    expect(fetch).toHaveBeenCalledWith("/api/artifact-public/fixture?download=zip", expect.objectContaining({ headers: { [ARTIFACT_PUBLIC_VERSION_HEADER]: "1" } }));
    expect(downloaded?.href).toBe("blob:fixture");
  });
  it("cancels an old download on navigation and allows the newly displayed version to download", async () => {
    const value = manifest("version_set", [1, 3], 3); let finishOld!: (response: Response) => void;
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn().mockReturnValue("blob:download"); static revokeObjectURL = vi.fn(); });
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("?download=zip") && number(init) === 1) return new Promise<Response>(resolve => { finishOld = resolve; });
      return fetcher(value)(path, init);
    });
    vi.stubGlobal("fetch", fetch); window.history.replaceState(null, "", "#v1");
    render(<PublicArtifactView initialManifest={value} token="fixture" />);
    await screen.findByLabelText("Public v1");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    await choose(3); await screen.findByLabelText("Public v3");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clicked).toHaveBeenCalledOnce());
    await act(async () => finishOld(content(1)));
    expect(clicked).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([path]) => path.endsWith("?download=zip")).map(([, init]) => number(init))).toEqual([1, 3]);
  });
});

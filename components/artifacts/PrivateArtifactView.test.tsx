import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserLocksFixture } from "@/tests/support/browserLocks";
import { ARTIFACT_PAGE_HEADER } from "@/lib/contracts/artifacts";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN, ARTIFACT_FRAGMENT_PLACEHOLDER, ARTIFACT_STORAGE_PLACEHOLDER } from "@/lib/contracts/artifactRuntime";
import { PrivateArtifactView } from "./PrivateArtifactView";
import { privateArtifactStateKey } from "./artifactBrowserStorage";

const document = (title: string) => `${ARTIFACT_BRIDGE_SCRIPT_OPEN}const initial=${ARTIFACT_STORAGE_PLACEHOLDER};const arrival=${ARTIFACT_FRAGMENT_PLACEHOLDER};</script><h1>${title}</h1>`;
const html = (page: string, title: string) => new Response(document(title), { headers: { "content-type": "text/html; charset=utf-8", [ARTIFACT_PAGE_HEADER]: page } });
const failure = (status: number, error: string) => Response.json({ error }, { status });
const titles: Record<string, string> = { "index.html": "Home", "docs/about.html": "About", "guide.html": "Guide" };
/** The content route of one version: `?page=` selects a page, none the entry page. */
function contentRoute(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return vi.fn(async (path: string) => {
    const url = new URL(path, "https://app.example");
    if (!url.pathname.endsWith("/content")) throw new Error(`unexpected request ${path}`);
    const page = url.searchParams.get("page") ?? "index.html";
    if (overrides[page]) return overrides[page]!();
    return titles[page] ? html(page, titles[page]!) : failure(404, "artifact_page_not_found");
  });
}
const requested = (fetch: ReturnType<typeof contentRoute>) => fetch.mock.calls.map(([path]) => new URL(path, "https://app.example").search);
const frame = () => screen.getByTitle("Artifact preview") as HTMLIFrameElement;
function post(data: unknown, target = frame()) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: target.contentWindow })));
}
let now = 0;
beforeEach(() => {
  now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("navigator", { locks: createBrowserLocksFixture() });
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("private artifact pages", () => {
  it("opens linked pages in place with the artifact's saved state and returns to the start page", async () => {
    const fetch = contentRoute(); vi.stubGlobal("fetch", fetch);
    render(<PrivateArtifactView artifactId="site" versionId="v1" />);
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    expect(screen.queryByRole("navigation", { name: "Artifact page" })).not.toBeInTheDocument();
    post({ type: "aiqsa_artifact_storage_set", key: "level", value: "4" });
    await waitFor(() => expect(localStorage.getItem(privateArtifactStateKey("site"))).toContain('"level","4"'));
    post({ type: "aiqsa_artifact_navigate", path: "docs/about.html", fragment: "team" });
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>About</h1>")));
    expect(fetch).toHaveBeenLastCalledWith("/api/artifacts/site/versions/v1/content?page=docs%2Fabout.html", expect.objectContaining({ cache: "no-store" }));
    expect(frame().srcdoc).toContain('const arrival="team"');
    expect(frame().srcdoc).toContain('[["level","4"]]');
    const bar = screen.getByRole("navigation", { name: "Artifact page" });
    expect(bar).toHaveTextContent("docs/about.html");
    fireEvent.click(within(bar).getByRole("button", { name: "Start page" }));
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    expect(screen.queryByRole("navigation", { name: "Artifact page" })).not.toBeInTheDocument();
    await waitFor(() => expect(frame()).toHaveFocus());
    // A link back to the entry page asks for the entry page itself.
    now = 1000; post({ type: "aiqsa_artifact_navigate", path: "guide.html" });
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Guide</h1>")));
    now = 2000; post({ type: "aiqsa_artifact_navigate", path: "index.html" });
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    expect(requested(fetch)).toEqual(["", "?page=docs%2Fabout.html", "", "?page=guide.html", ""]);
  });

  it("loads one page at a time and keeps the shown page until the next one arrives", async () => {
    let release!: () => void;
    const fetch = contentRoute({ "docs/about.html": () => new Promise<Response>(resolve => { release = () => resolve(html("docs/about.html", "About")); }) });
    vi.stubGlobal("fetch", fetch);
    render(<PrivateArtifactView artifactId="site" versionId="v1" />);
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    post({ type: "aiqsa_artifact_navigate", path: "docs/about.html" });
    const bar = await screen.findByRole("navigation", { name: "Artifact page" });
    expect(bar).toHaveTextContent("docs/about.html");
    expect(within(bar).getByRole("status")).toHaveTextContent("Opening…");
    expect(within(bar).getByRole("button", { name: "Start page" })).toBeDisabled();
    expect(frame().srcdoc).toContain("<h1>Home</h1>");
    now = 1000; post({ type: "aiqsa_artifact_navigate", path: "guide.html" });
    await act(async () => release());
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>About</h1>")));
    expect(requested(fetch)).toEqual(["", "?page=docs%2Fabout.html"]);
  });

  it("explains a page that cannot open, offers the way back, and never shows a blank frame", async () => {
    const fetch = contentRoute({ "broken.html": () => failure(400, "artifact_element_unsupported"), "busy.html": () => failure(429, "rate_limit_exceeded"),
      "other.html": () => html("index.html", "Home") });
    vi.stubGlobal("fetch", fetch);
    render(<PrivateArtifactView artifactId="site" versionId="v1" />);
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    act(() => frame().focus());
    post({ type: "aiqsa_artifact_navigate", path: "missing.html" });
    const missing = await screen.findByRole("alert");
    expect(missing).toHaveTextContent("This page is not part of this version.");
    expect(screen.queryByTitle("Artifact preview")).not.toBeInTheDocument();
    await waitFor(() => expect(within(missing).getByRole("button", { name: "Start page" })).toHaveFocus());
    fireEvent.click(within(missing).getByRole("button", { name: "Start page" }));
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    now = 1000; post({ type: "aiqsa_artifact_navigate", path: "broken.html" });
    const broken = await screen.findByRole("alert");
    expect(broken).toHaveTextContent("This page cannot be displayed. artifact_element_unsupported");
    fireEvent.click(within(broken).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requested(fetch).filter(search => search === "?page=broken.html")).toHaveLength(2));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Start page" }));
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    now = 2000; post({ type: "aiqsa_artifact_navigate", path: "busy.html" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The preview is busy. Try again in a moment.");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Start page" }));
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    // A response that names another page is not shown as the requested one.
    now = 3000; post({ type: "aiqsa_artifact_navigate", path: "other.html" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this page.");
  });

  it("reports the first runtime error of each page and offers its repair", async () => {
    vi.stubGlobal("fetch", contentRoute());
    const onFix = vi.fn();
    render(<PrivateArtifactView artifactId="site" versionId="v1" onFix={onFix} />);
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Home</h1>")));
    post({ type: "aiqsa_artifact_runtime_error", kind: "error", message: "Home failed", line: 2, column: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent("Home failed");
    post({ type: "aiqsa_artifact_navigate", path: "guide.html" });
    await waitFor(() => expect(frame()).toHaveAttribute("srcdoc", expect.stringContaining("<h1>Guide</h1>")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    post({ type: "aiqsa_artifact_runtime_error", kind: "error", message: "Guide failed", line: 4, column: 0 });
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Fix with AI" }));
    expect(onFix).toHaveBeenCalledWith({ kind: "error", message: "Guide failed", line: 4, column: 0 });
  });
});

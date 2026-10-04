import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";
import type { MermaidColorScheme, MermaidRenderResult } from "./mermaidRendering";
import { serializeRenderedMarkdownSelection } from "./renderedMarkdown";

const renderMock = vi.hoisted(() => ({
  renderMermaidDiagram: vi.fn<(source: string, scheme: MermaidColorScheme) => Promise<MermaidRenderResult>>()
}));

vi.mock("./mermaidRendering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mermaidRendering")>()),
  renderMermaidDiagram: renderMock.renderMermaidDiagram
}));

const source = "flowchart TD\n  A[Start] --> B[Done]\n";
const fenced = (body = source, language = "mermaid") => `Intro\n\n\`\`\`${language}\n${body}\`\`\`\n\nAfter`;
const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="40" viewBox="0 0 900 40"><text>${label}</text></svg>`;

beforeEach(() => {
  renderMock.renderMermaidDiagram.mockImplementation(async (_source, scheme) => ({ ok: true, svg: svg(`diagram-${scheme}`) }));
  document.documentElement.dataset.theme = "light";
});

afterEach(() => {
  renderMock.renderMermaidDiagram.mockReset();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

describe("Mermaid blocks in Markdown", () => {
  it("shows the source until the diagram is ready, then switches between diagram and code", async () => {
    let resolve: (result: MermaidRenderResult) => void = () => undefined;
    renderMock.renderMermaidDiagram.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<MarkdownMessage content={fenced()} />);

    const pending = screen.getByRole("region", { name: "Scrollable code block" });
    expect(pending).toHaveTextContent("A[Start] --> B[Done]");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(renderMock.renderMermaidDiagram).toHaveBeenCalledWith(source, "light");

    await act(async () => resolve({ ok: true, svg: svg("diagram-light") }));
    const diagram = screen.getByRole("region", { name: "Scrollable diagram" });
    expect(diagram.querySelector("svg text")).toHaveTextContent("diagram-light");
    expect(screen.queryByRole("region", { name: "Scrollable code block" })).toBeNull();
    expect(screen.getByRole("button", { name: "Diagram" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByRole("region", { name: "Scrollable code block" })).toHaveTextContent("A[Start] --> B[Done]");
    expect(screen.queryByRole("region", { name: "Scrollable diagram" })).toBeNull();
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    expect(screen.getByRole("region", { name: "Scrollable diagram" })).toBeInTheDocument();
  });

  it("copies the source and downloads the rendered SVG", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const createObjectURL = vi.fn((_blob: Blob) => "blob:diagram");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("diagram.svg");
      expect(this.getAttribute("href")).toBe("blob:diagram");
    });
    render(<MarkdownMessage content={fenced()} />);
    await screen.findByRole("region", { name: "Scrollable diagram" });

    fireEvent.click(screen.getByRole("button", { name: "Copy diagram source" }));
    expect(writeText).toHaveBeenCalledWith(source);
    await waitFor(() => expect(screen.getAllByText("Copied").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Download SVG" }));
    expect(click).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toBe(svg("diagram-light"));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:diagram"));
  });

  it("accepts the fence language in any case", async () => {
    render(<MarkdownMessage content={fenced(source, "Mermaid")} />);
    expect(await screen.findByRole("region", { name: "Scrollable diagram" })).toBeInTheDocument();
  });

  it.each([
    ["invalid", "Diagram could not be rendered."],
    ["too_large", "Diagram could not be rendered: the source is longer than 20,000 characters."],
    ["timeout", "Diagram could not be rendered: it took too long."]
  ] as const)("keeps the code with a one-line note when rendering fails (%s)", async (reason, note) => {
    renderMock.renderMermaidDiagram.mockResolvedValue({ ok: false, reason });
    render(<MarkdownMessage content={fenced()} />);
    expect(await screen.findByTestId("mermaid-fallback-note")).toHaveTextContent(note);
    expect(screen.getByRole("region", { name: "Scrollable code block" })).toHaveTextContent("A[Start] --> B[Done]");
    expect(screen.getByRole("region", { name: "Scrollable code block" })).not.toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("region", { name: "Scrollable diagram" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download SVG" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Diagram view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy diagram source" })).toBeInTheDocument();
  });

  it("keeps an unclosed fence as partial text while streaming and renders once it closes", async () => {
    const partial = "Intro\n\n```mermaid\nflowchart TD\n  A[Start] -->";
    const { container, rerender } = render(<MarkdownMessage content={partial} streaming />);
    expect(container.textContent).toContain("```mermaid\nflowchart TD\n  A[Start] -->");
    expect(screen.queryByTestId("mermaid-block")).toBeNull();
    expect(renderMock.renderMermaidDiagram).not.toHaveBeenCalled();

    rerender(<MarkdownMessage content={`${partial} B[Done]\n\`\`\`\n\nStill writing`} streaming />);
    expect(await screen.findByRole("region", { name: "Scrollable diagram" })).toBeInTheDocument();
    expect(renderMock.renderMermaidDiagram).toHaveBeenCalledWith(source, "light");
  });

  it("never loads the renderer for other code or a truncated fence", () => {
    render(<MarkdownMessage content={"```ts\nconst a = 1;\n```\n\n```mermaid\nflowchart TD\n  A --> B"} />);
    expect(screen.queryByTestId("mermaid-block")).toBeNull();
    expect(screen.getAllByRole("region", { name: "Scrollable code block" })).toHaveLength(2);
    expect(renderMock.renderMermaidDiagram).not.toHaveBeenCalled();
  });

  it("follows the app theme and re-renders when it changes", async () => {
    document.documentElement.dataset.theme = "dark";
    render(<MarkdownMessage content={fenced()} />);
    const diagram = await screen.findByRole("region", { name: "Scrollable diagram" });
    expect(diagram).toHaveTextContent("diagram-dark");

    act(() => {
      document.documentElement.dataset.theme = "light";
    });
    await waitFor(() => expect(screen.getByRole("region", { name: "Scrollable diagram" })).toHaveTextContent("diagram-light"));
    expect(renderMock.renderMermaidDiagram).toHaveBeenLastCalledWith(source, "light");
  });

  it("quotes a rendered diagram as its Mermaid source", async () => {
    const { container } = render(<MarkdownMessage content={fenced()} />);
    const diagram = await screen.findByRole("region", { name: "Scrollable diagram" });
    const range = document.createRange();
    range.selectNodeContents(diagram.querySelector("text")!);
    expect(serializeRenderedMarkdownSelection(range, container.firstElementChild as HTMLElement))
      .toBe(`\`\`\`mermaid\n${source}\`\`\``);
  });
});

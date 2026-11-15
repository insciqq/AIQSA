import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ThreadArtifactSummary, ThreadSearchSource } from "@/lib/contracts/chats";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/app-shell/shellApi", () => ({ shellFetch: vi.fn() }));

/** 1600 search results over 40 sites: ten sites of 80, ten of 40, twenty of 20. */
function largeRun(): ThreadSearchSource[] {
  const sizes = Array.from({ length: 40 }, (_, site) => site < 10 ? 80 : site < 20 ? 40 : 20);
  return sizes.flatMap((size, site) => Array.from({ length: size }, (_, page) => ({
    rank: page + 1,
    snippet: `Snippet of page ${page} on site ${site}.`,
    title: `Result ${page} on site ${site}`,
    url: `https://www.site-${String(site).padStart(2, "0")}.example/page-${page}`
  })));
}

const artifact: ThreadArtifactSummary = { citations: [], reasoningText: [], sources: largeRun() };

/** An answer that links 14 of the listed pages, on every other site. */
const citingText = Array.from({ length: 14 }, (_, index) =>
  `Point ${index} [source](https://site-${String(index * 2).padStart(2, "0")}.example/page-${index}).`
).join("\n");

function renderAnswer(content: string, summary: ThreadArtifactSummary = artifact) {
  return render(
    <RunAnswerV2 artifact={summary} content={content} presentation={{ kind: "complete", runId: "run-1" }} />
  );
}

function openSheet() {
  fireEvent.click(screen.getByTestId("answer-sources-toggle"));
  return screen.getByRole("dialog", { name: "Sources" });
}

describe("answer sources", () => {
  it("counts every source when the answer cites none and opens on the sites", () => {
    renderAnswer("An answer that failed before citing anything.");
    expect(screen.getByTestId("answer-sources-toggle")).toHaveAccessibleName("Sources, 1600 items");
    const sheet = openSheet();

    expect(within(sheet).queryByTestId("answer-sources-cited")).not.toBeInTheDocument();
    const searched = within(sheet).getByRole("button", { name: "Searched · 1600" });
    expect(searched).toHaveAttribute("aria-expanded", "true");
    const sites = within(sheet).getAllByTestId("answer-source-site");
    expect(sites).toHaveLength(40);
    expect(within(sheet).queryAllByRole("link")).toHaveLength(0);
    expect(sites[0]).toHaveTextContent("site-00.example · 80");
    expect(sites.at(-1)).toHaveTextContent("site-39.example · 20");
  });

  it("counts the cited sources and leads with them, the rest one tap away", () => {
    renderAnswer(citingText);
    expect(screen.getByTestId("answer-sources-toggle")).toHaveAccessibleName("Sources, 14 items");
    const sheet = openSheet();

    const cited = within(sheet).getByTestId("answer-sources-cited");
    expect(within(cited).getByRole("heading")).toHaveTextContent("Cited in the answer · 14");
    const rows = within(cited).getAllByRole("listitem");
    expect(rows).toHaveLength(14);
    expect(rows[0]).toHaveTextContent("Result 0 on site 0");
    expect(rows[0]).toHaveTextContent("site-00.example");
    expect(rows[0]).toHaveTextContent("Snippet of page 0 on site 0.");
    expect(within(rows[13]!).getByRole("link", { name: "Result 13 on site 26" }))
      .toHaveAttribute("href", "https://www.site-26.example/page-13");

    const searched = within(sheet).getByRole("button", { name: "Also searched · 1586" });
    expect(searched).toHaveAttribute("aria-expanded", "false");
    expect(within(sheet).queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.click(searched);
    expect(searched).toHaveAttribute("aria-expanded", "true");
    expect(within(sheet).getAllByTestId("answer-source-site")).toHaveLength(40);
  });

  it("expands a site to its links fifty at a time", () => {
    renderAnswer("No links.");
    const sheet = openSheet();
    const site = within(sheet).getByRole("button", { name: "site-03.example · 80" });
    expect(site).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(site);
    expect(site).toHaveAttribute("aria-expanded", "true");
    const links = document.getElementById(site.getAttribute("aria-controls")!)!;
    expect(within(links).getAllByRole("link")).toHaveLength(50);
    expect(within(links).getAllByRole("link")[0]).toHaveAccessibleName("Result 0 on site 3");
    fireEvent.click(within(links).getByRole("button", { name: "Show more · 30 left" }));
    expect(within(links).getAllByRole("link")).toHaveLength(80);
    expect(within(links).queryByRole("button", { name: /Show more/u })).not.toBeInTheDocument();
    fireEvent.click(site);
    expect(within(sheet).queryAllByRole("link")).toHaveLength(0);
  });

  it("filters by title, site or address and pages the matches", () => {
    renderAnswer("No links.");
    const sheet = openSheet();
    const filter = within(sheet).getByRole("searchbox", { name: "Filter sources" });

    fireEvent.change(filter, { target: { value: "Site 7" } });
    expect(within(sheet).getByRole("status")).toHaveTextContent("80 matching");
    const matches = within(sheet).getByTestId("answer-source-matches");
    expect(within(matches).getAllByRole("link")).toHaveLength(50);
    expect(within(sheet).queryAllByTestId("answer-source-site")).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole("button", { name: "Show more · 30 left" }));
    expect(within(matches).getAllByRole("link")).toHaveLength(80);

    fireEvent.change(filter, { target: { value: "site-39.example/page-1" } });
    expect(within(sheet).getByRole("status")).toHaveTextContent("11 matching");
    fireEvent.change(filter, { target: { value: "nothing like this" } });
    expect(within(sheet).getByRole("status")).toHaveTextContent("No sources match.");
    fireEvent.change(filter, { target: { value: "" } });
    expect(within(sheet).getAllByTestId("answer-source-site")).toHaveLength(40);
  });

  it("pages more than fifty sites", () => {
    const sources = Array.from({ length: 120 }, (_, index) => ({
      rank: 1, title: `Only page ${index}`, url: `https://host-${index}.example/`
    }));
    renderAnswer("No links.", { citations: [], reasoningText: [], sources });
    const sheet = openSheet();
    expect(within(sheet).getAllByTestId("answer-source-site")).toHaveLength(50);
    fireEvent.click(within(sheet).getByRole("button", { name: "Show more · 70 left" }));
    expect(within(sheet).getAllByTestId("answer-source-site")).toHaveLength(100);
  });

  it("says in the sheet when the list is partial", () => {
    renderAnswer("No links.", { ...artifact, sourcesTruncated: true });
    const sheet = openSheet();
    expect(within(sheet).getByTestId("answer-sources-truncated"))
      .toHaveTextContent("This answer has more sources than can be listed.");
  });

  it("closes on Escape and returns focus to the chip", async () => {
    renderAnswer(citingText);
    const chip = screen.getByTestId("answer-sources-toggle");
    chip.focus();
    const sheet = openSheet();
    await waitFor(() => expect(sheet).toContainElement(document.activeElement as HTMLElement));
    fireEvent.keyDown(within(sheet).getByRole("button", { name: "Close" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sources" })).not.toBeInTheDocument());
    await waitFor(() => expect(chip).toHaveFocus());
  });
});

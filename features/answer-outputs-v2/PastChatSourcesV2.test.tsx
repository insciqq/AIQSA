import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeContextCompactionStatus } from "@/lib/contracts/contextCompaction";
import type { PastChatSource } from "@/lib/contracts/pastChats";
import { AnswerProcessV2 } from "./AnswerProcessV2";
import { groupPastChatSources, pastChatExcerptText, PastChatSourcesV2 } from "./PastChatSourcesV2";

const source = (chat: number, message: number, excerpt = `Excerpt ${chat}.${message}`): PastChatSource => ({
  chatId: `chat_${chat}`, chatTitle: `Deployment ${chat}`, date: "2026-11-02T09:30:00.000Z", messageId: `msg_${chat}_${message}`, excerpt
});

afterEach(() => cleanup());

describe("PastChatSourcesV2", () => {
  it("groups turns by chat in ranked order", () => {
    const groups = groupPastChatSources([source(2, 1), source(1, 1), source(2, 2)]);
    expect(groups.map((group) => [group.chatId, group.sources.map((entry) => entry.messageId)]))
      .toEqual([["chat_2", ["msg_2_1", "msg_2_2"]], ["chat_1", ["msg_1_1"]]]);
  });

  it("counts chats, links each to its message and folds the rest behind Show all", () => {
    render(<PastChatSourcesV2 sources={[source(1, 1), source(1, 2), source(2, 1), source(3, 1), source(4, 1)]} />);
    const disclosure = screen.getByTestId("past-chat-sources");
    expect(disclosure.querySelector("summary")).toHaveTextContent("Past chats · 4");
    fireEvent.click(disclosure.querySelector("summary")!);
    const visible = () => within(disclosure).getAllByTestId("past-chat-source").filter((element) => !element.hidden);
    expect(visible()).toHaveLength(3);
    const first = visible()[0]!;
    expect(within(first).getByRole("link", { name: "Open Deployment 1 at this message" })).toHaveAttribute("href", "/c/chat_1?message=msg_1_1");
    expect(within(first).getByText("Excerpt 1.1")).toBeInTheDocument();
    expect(first.querySelector(".v2-past-chat-heading > time")).toHaveTextContent("Nov 2, 2026");
    expect(within(first).getByText("1 more from this chat")).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: "Open Deployment 1 at this message, Nov 2, 2026", hidden: true }))
      .toHaveAttribute("href", "/c/chat_1?message=msg_1_2");
    fireEvent.click(within(disclosure).getByRole("button", { name: "Show all 4" }));
    expect(visible()).toHaveLength(4);
    fireEvent.click(within(disclosure).getByRole("button", { name: "Show less" }));
    expect(visible()).toHaveLength(3);
  });

  it("opens a source in the shell on a plain click and leaves modified clicks to the browser", () => {
    const onOpenChatMessage = vi.fn();
    render(<PastChatSourcesV2 onOpenChatMessage={onOpenChatMessage} sources={[source(1, 1)]} />);
    const link = screen.getByRole("link", { name: "Open Deployment 1 at this message", hidden: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(onOpenChatMessage).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onOpenChatMessage).toHaveBeenCalledWith("chat_1", "msg_1_1");
  });

  it("renders nothing without sources", () => {
    const { container } = render(<PastChatSourcesV2 sources={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AnswerProcessV2 with past-chat sources", () => {
  it("names them once: a line that counts them is their only heading, and the fold opens straight onto the chats", () => {
    render(<AnswerProcessV2 pastChatSources={[source(1, 1), source(2, 1), source(2, 2)]} />);
    const fold = screen.getByTestId("tool-activity-disclosure") as HTMLDetailsElement;
    const line = fold.querySelector(":scope > summary")!;
    expect(line).toHaveTextContent("Past chats · 2");
    expect(screen.getAllByText(/Past chats/u)).toHaveLength(1);
    const sources = within(fold).getByTestId("past-chat-sources");
    expect(sources.querySelector(":scope > summary")).toBeNull();
    expect(within(sources).queryByRole("heading")).toBeNull();
    // The line is the one control: it opens the fold, and the chats are links right inside it.
    expect(fold.open).toBe(false);
    fireEvent.click(line);
    expect(fold.open).toBe(true);
    expect(within(sources).getByRole("link", { name: "Open Deployment 1 at this message" })).toHaveAttribute("href", "/c/chat_1?message=msg_1_1");
    expect(within(sources).getByRole("link", { name: "Open Deployment 2 at this message" })).toBeVisible();
  });

  it("titles them as a section when the line names them beside other fold sections", () => {
    render(<AnswerProcessV2 contextCompactionFailures={[makeContextCompactionStatus({ outcome: "summary_failed", state: "failed" })]}
      pastChatSources={[source(1, 1)]} />);
    const fold = screen.getByTestId("tool-activity-disclosure");
    expect(fold.querySelector(":scope > summary")).toHaveTextContent(/^Past chats · 1/u);
    const sources = within(fold).getByTestId("past-chat-sources");
    expect(sources.querySelector(":scope > summary")).toBeNull();
    expect(within(sources).getByRole("heading", { hidden: true })).toHaveTextContent(/^Past chats$/u);
  });

  it("keeps their own counted disclosure when the line names other work", () => {
    render(<AnswerProcessV2 pastChatSources={[source(1, 1), source(2, 1)]} reasoningTexts={["Checking the earlier plan."]}
      workDurationMs={8_000} />);
    const fold = screen.getByTestId("tool-activity-disclosure");
    expect(fold.querySelector(":scope > summary")).toHaveTextContent("Thought for 8s");
    expect(within(fold).getByTestId("past-chat-sources").querySelector(":scope > summary")).toHaveTextContent("Past chats · 2");
  });
});

describe("pastChatExcerptText", () => {
  it("drops the index's turn labels and reads the question and answer as one line", () => {
    expect(pastChatExcerptText("User: And the rollback?\nAssistant: Keep the previous image tagged."))
      .toBe("And the rollback? — Keep the previous image tagged.");
    expect(pastChatExcerptText("A window in the middle of an answer.")).toBe("A window in the middle of an answer.");
  });
});

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PastChatSource } from "@/lib/contracts/pastChats";
import { AnswerProcessV2 } from "./AnswerProcessV2";
import { groupPastChatSources, PastChatSourcesV2 } from "./PastChatSourcesV2";

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
  it("lists them in the fold where Memory's sources were, and the line counts them when there is no other work", () => {
    render(<AnswerProcessV2 pastChatSources={[source(1, 1), source(2, 1), source(2, 2)]} />);
    const fold = screen.getByTestId("tool-activity-disclosure");
    expect(fold.querySelector(":scope > summary")).toHaveTextContent("Past chats · 2");
    expect(within(fold).getByTestId("past-chat-sources").querySelector("summary")).toHaveTextContent("Past chats · 2");
  });
});

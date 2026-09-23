import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatDragDropProvider, ChatRootDropTarget, useChatDraggable, useChatFolderDrop } from "./chatDragDrop";

function Chat() { const drag = useChatDraggable("chat"); return <div {...drag}>Chat</div>; }
function Folder() { const drop = useChatFolderDrop("folder"); return <div {...drop}>Folder</div>; }
function transfer() {
  const data = new Map<string, string>();
  return { types: ["application/x-aiqsa-chat"], setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) };
}
describe("Chat folder drag and drop", () => {
  it("uses the move action and never moves an unrelated external drag", () => {
    const move = vi.fn();
    render(<ChatDragDropProvider chats={[{ id: "chat", folderId: null }]} onMove={move}><Chat /><Folder /></ChatDragDropProvider>);
    const dataTransfer = transfer();
    fireEvent.drop(screen.getByText("Folder"), { dataTransfer });
    expect(move).not.toHaveBeenCalled();
    fireEvent.dragStart(screen.getByText("Chat"), { dataTransfer });
    fireEvent.dragOver(screen.getByText("Folder"), { dataTransfer });
    expect(screen.getByText("Folder")).toHaveAttribute("data-chat-drop-active", "true");
    fireEvent.drop(screen.getByText("Folder"), { dataTransfer });
    expect(move).toHaveBeenCalledExactlyOnceWith("chat", "folder");
  });
  it("supports a root target and prevents dragging when movement is unavailable", () => {
    const move = vi.fn();
    const { rerender } = render(<ChatDragDropProvider chats={[{ id: "chat", folderId: "folder" }]} onMove={move}><Chat /><ChatRootDropTarget /></ChatDragDropProvider>);
    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getByText("Chat"), { dataTransfer });
    fireEvent.drop(screen.getByText("Move out of folder"), { dataTransfer });
    expect(move).toHaveBeenCalledExactlyOnceWith("chat", null);
    rerender(<ChatDragDropProvider chats={[{ id: "chat", folderId: null }]}><Chat /></ChatDragDropProvider>);
    expect(screen.getByText("Chat")).toHaveAttribute("draggable", "false");
  });
});

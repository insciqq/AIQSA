"use client";

import { createContext, useContext, useState, type DragEvent, type ReactNode } from "react";
import "./chat-drag-drop.css";

const MIME = "application/x-aiqsa-chat";
type DragContextValue = {
  activeId: string | null;
  setActive(id: string | null): void;
  chats: readonly { id: string; folderId: string | null }[];
  onMove?(chatId: string, folderId: string | null): void;
};
const DragContext = createContext<DragContextValue | null>(null);

export function ChatDragDropProvider({ chats, onMove, children }: Readonly<{
  chats: DragContextValue["chats"]; onMove?: DragContextValue["onMove"]; children: ReactNode;
}>) {
  const [activeId, setActive] = useState<string | null>(null);
  return <DragContext.Provider value={{ activeId, setActive, chats, onMove }}>{children}</DragContext.Provider>;
}

export function useChatDraggable(chatId: string, disabled = false) {
  const context = useContext(DragContext);
  return {
    draggable: Boolean(context?.onMove && !disabled),
    "data-chat-dragging": context?.activeId === chatId || undefined,
    onDragStart(event: DragEvent<HTMLElement>) {
      if (!context?.onMove || disabled) { event.preventDefault(); return; }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(MIME, chatId);
      context.setActive(chatId);
    },
    onDragEnd() { context?.setActive(null); }
  };
}

export function useChatFolderDrop(folderId: string | null) {
  const context = useContext(DragContext);
  const [hover, setHover] = useState(false);
  const chat = context?.chats.find(item => item.id === context.activeId);
  const available = Boolean(context?.onMove && chat && chat.folderId !== folderId);
  return {
    "data-chat-drop-active": available && hover || undefined,
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!available || !event.dataTransfer.types.includes(MIME)) return;
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setHover(true);
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setHover(false);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      setHover(false);
      if (!available || !chat || event.dataTransfer.getData(MIME) !== chat.id) return;
      event.preventDefault(); event.stopPropagation();
      context?.setActive(null);
      // Placement changes only after the existing server-backed action succeeds.
      context?.onMove?.(chat.id, folderId);
    }
  };
}

export function ChatRootDropTarget() {
  const context = useContext(DragContext);
  const drop = useChatFolderDrop(null);
  if (!context?.activeId || !context.chats.find(chat => chat.id === context.activeId)?.folderId) return null;
  return <div {...drop} className="v2-chat-root-drop" role="status">Move out of folder</div>;
}

import {
  closeArchivedChats,
  loadEarlierArchivedMessages,
  openArchivedChatPreview,
  refreshArchivedChats,
  restoreArchivedChat,
  showArchivedChatList,
  useArchivedChatsStore
} from "@/components/app-shell/archivedChatsStore";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { resolveMemoryCopy } from "@/lib/contracts/memoryCopy";
import type { MemoryUiLocale } from "@/lib/contracts/memory";
import { useMemorySettingsStore } from "@/components/app-shell/memorySettingsStore";
import {
  openPermanentChatDeletion,
  usePermanentChatDeletionStore
} from "@/components/app-shell/permanentChatDeletionStore";
import { Archive, ArrowLeft, LoaderCircle, RotateCw, Trash2, Undo2, X } from "lucide-react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface";
const button =
  `inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-3 text-sm font-semibold text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-control ${focusRing}`;

function formatDate(locale: MemoryUiLocale, value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(date);
}

export function ArchivedChatsDialog({
  locale,
  onRestored
}: {
  locale: MemoryUiLocale;
  onRestored(chatId: string): Promise<void> | void;
}) {
  const detail = useArchivedChatsStore((state) => state.detail);
  const detailError = useArchivedChatsStore((state) => state.detailError);
  const detailLoadState = useArchivedChatsStore((state) => state.detailLoadState);
  const listError = useArchivedChatsStore((state) => state.listError);
  const listLoadState = useArchivedChatsStore((state) => state.listLoadState);
  const nextCursor = useArchivedChatsStore((state) => state.nextCursor);
  const restoring = useArchivedChatsStore((state) => state.restoring);
  const summaries = useArchivedChatsStore((state) => state.summaries);
  const permanentChatDeletionAvailable = useMemorySettingsStore(
    (state) => Boolean(state.data?.capabilities.permanentChatDeletion)
  );
  const permanentDialogOpen = usePermanentChatDeletionStore(
    (state) => Boolean(state.target) || state.statusOpen
  );
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose: closeArchivedChats });
  const ru = false;

  async function restore(): Promise<void> {
    const chatId = await restoreArchivedChat();
    if (!chatId) return;
    await onRestored(chatId);
    closeArchivedChats();
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-scrim/70 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] sm:items-center sm:p-3"
      data-testid="archived-chats-dialog"
      role="presentation"
      onMouseDown={closeArchivedChats}
    >
      <div
        ref={dialogRef}
        aria-hidden={permanentDialogOpen || undefined}
        className="pop-enter flex h-[min(48rem,calc(100dvh-env(safe-area-inset-top)))] w-full max-w-3xl flex-col overflow-hidden rounded-t-panel border border-b-0 border-trace-subtle bg-overlay-surface text-ink shadow-overlay sm:h-[min(44rem,calc(100dvh-1.5rem))] sm:rounded-panel sm:border"
        inert={permanentDialogOpen || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-chats-heading"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-touch shrink-0 items-center gap-2 border-b border-trace-subtle px-3 sm:px-4">
          {detail ? (
            <button
              className={`grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
              type="button"
              aria-label={ru ? "Назад к архиву" : "Back to archive"}
              onClick={showArchivedChatList}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </button>
          ) : (
            <Archive className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" id="archived-chats-heading">
            {detail?.title ?? (ru ? "Архив чатов" : "Archived chats")}
          </h2>
          <button
            className={`grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
            type="button"
            aria-label={ru ? "Закрыть архив" : "Close archive"}
            onClick={closeArchivedChats}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        {detail ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-trace-subtle px-4 py-3 text-sm text-ink-secondary">
              <p>{resolveMemoryCopy(locale, "archive.explanation")}</p>
              <p className="mt-1 text-xs text-ink-muted">
                {detail.memoryMode === "EXCLUDED"
                  ? `${resolveMemoryCopy(locale, "exclude.explanation")} ${
                      ru
                        ? "Отдельное состояние исключения имеет приоритет до возобновления."
                        : "The separate Exclude state takes precedence until Resume."
                    }`
                  : ru ? "Предпросмотр владельца доступен только для чтения." : "This owner preview is read-only."}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
              {detail.pageInfo.hasOlder ? (
                <button
                  className={`${button} mb-3 w-full`}
                  disabled={detailLoadState === "loading"}
                  type="button"
                  onClick={() => void loadEarlierArchivedMessages().catch(() => undefined)}
                >
                  {detailLoadState === "loading" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {ru ? "Загрузить более ранние сообщения" : "Load earlier messages"}
                </button>
              ) : null}
              <ol className="space-y-3" aria-label={ru ? "Сообщения архивного чата" : "Archived chat messages"}>
                {detail.messages.map((message) => (
                  <li
                    className="border-l-2 border-trace-subtle pl-3 text-sm leading-6"
                    key={message.id}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                      {message.role === "user" ? (ru ? "Вы" : "You") : (ru ? "Ассистент" : "Assistant")}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-ink-secondary">
                      {textFromThreadContent(message.content) || (ru ? "Нет текстового содержимого" : "No text content")}
                    </p>
                  </li>
                ))}
              </ol>
            </div>
            {detailError ? <p className="border-t border-critical/20 px-4 py-2 text-sm text-critical" role="alert">{detailError}</p> : null}
            <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-trace-subtle px-4 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 sm:pb-3">
              {permanentChatDeletionAvailable ? (
                <button
                  className={`${button} border-critical/50 bg-critical/10 text-critical hover:bg-critical/15 hover:text-critical`}
                  disabled={restoring}
                  type="button"
                  onClick={() => openPermanentChatDeletion({
                    chatId: detail.id,
                    expectedActiveLeafMessageId: detail.activeLeafMessageId,
                    expectedChatRevision: detail.sourceRevision,
                    location: "ARCHIVED",
                    title: detail.title
                  })}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  {ru ? "Удалить навсегда" : "Delete permanently"}
                </button>
              ) : null}
              <button className={button} disabled={restoring} type="button" onClick={() => void restore().catch(() => undefined)}>
                {restoring ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Undo2 className="size-4" aria-hidden="true" />}
                {resolveMemoryCopy(locale, "restore.action")}
              </button>
            </footer>
          </div>
        ) : detailLoadState === "loading" ? (
          <div className="grid min-h-0 flex-1 place-items-center px-4 py-10" role="status">
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              {ru ? "Загрузка предпросмотра…" : "Loading preview…"}
            </p>
          </div>
        ) : detailLoadState === "error" ? (
          <div className="grid min-h-0 flex-1 place-items-center px-4 py-10 text-center">
            <div>
              <p className="text-sm text-critical" role="alert">
                {ru ? "Не удалось открыть архивный чат." : "Could not open the archived chat."}
              </p>
              <button
                className={`${button} mt-3`}
                type="button"
                onClick={() => {
                  showArchivedChatList();
                  void refreshArchivedChats().catch(() => undefined);
                }}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                {ru ? "Назад к архиву" : "Back to archive"}
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={listLoadState === "loading"}>
            {listLoadState === "loading" && summaries.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-ink-muted">{ru ? "Загрузка архива…" : "Loading archive…"}</p>
            ) : null}
            {listError && summaries.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-critical" role="alert">{ru ? "Не удалось загрузить архив." : "Could not load the archive."}</p>
                <button className={`${button} mt-3`} type="button" onClick={() => void refreshArchivedChats().catch(() => undefined)}>
                  <RotateCw className="size-4" aria-hidden="true" />
                  {ru ? "Повторить" : "Retry"}
                </button>
              </div>
            ) : null}
            {listLoadState === "ready" && summaries.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-ink-muted">{ru ? "Архив пуст." : "No archived chats."}</p>
            ) : null}
            {summaries.length ? (
              <ul className="divide-y divide-trace-subtle" aria-label={ru ? "Архивные чаты" : "Archived chats"}>
                {summaries.map((chat) => (
                  <li key={chat.id}>
                    <button
                      className={`w-full px-4 py-3 text-left hover:bg-control-hover ${focusRing}`}
                      type="button"
                      onClick={() => void openArchivedChatPreview(chat.id).catch(() => undefined)}
                    >
                      <span className="block truncate text-sm font-semibold text-ink">{chat.title}</span>
                      <span className="mt-1 block text-xs text-ink-muted">
                        {formatDate(locale, chat.updatedAt)} · {chat.messageCount} {ru ? "сообщ." : "messages"}
                        {chat.memoryMode === "EXCLUDED"
                          ? ` · ${ru ? "Исключён из источников Памяти" : "Excluded from Memory sources"}`
                          : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {nextCursor ? (
              <div className="p-3">
                <button className={`${button} w-full`} disabled={listLoadState === "loading"} type="button" onClick={() => void refreshArchivedChats(true).catch(() => undefined)}>
                  {ru ? "Показать ещё" : "Show more"}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import type { PublicShareSnapshot } from "@/lib/domain/shareSnapshot";
import { Lock } from "lucide-react";

type PublicShareViewProps = {
  snapshot: PublicShareSnapshot;
  title: string;
};

function PublicShareHeader() {
  return (
    <header className="border-b border-trace-subtle bg-workspace-rail pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex min-h-14 w-full max-w-reading items-center justify-between gap-4 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:min-h-16 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]">
        <div className="flex min-w-0 items-center gap-2.5">
          <p className="shrink-0 text-sm font-semibold tracking-[0.01em] text-ink">AIQSA</p>
          <span className="h-4 w-px shrink-0 bg-trace-strong" aria-hidden="true" />
          <p className="truncate text-xs text-ink-muted">Shared research</p>
        </div>
        <p className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-secondary">
          <Lock className="size-3.5 text-ink-muted" aria-hidden="true" />
          Read-only snapshot
        </p>
      </div>
    </header>
  );
}

function SnapshotNote() {
  return (
    <div
      className="mt-7 flex min-w-0 items-start gap-3 border-y border-trace-subtle py-3.5 text-sm leading-6"
      data-testid="public-share-note"
    >
      <Lock className="mt-1 size-3.5 shrink-0 text-proof" aria-hidden="true" />
      <p className="min-w-0 text-ink-secondary">
        <span className="font-medium text-ink">Fixed conversation copy.</span>{" "}
        It shows one conversation branch and won&apos;t update or change the original chat.
      </p>
    </div>
  );
}

function messageText(message: PublicShareSnapshot["messages"][number]): string {
  return message.content.blocks.map((block) => block.text).join("\n\n");
}

export function PublicShareView({ snapshot, title }: PublicShareViewProps) {
  const displayTitle = title.trim() || "Shared chat";

  return (
    <main
      className="min-h-[100dvh] min-w-0 overflow-x-hidden bg-answer-paper text-ink"
      data-testid="public-share-view"
    >
      <PublicShareHeader />

      <div className="pb-[max(4rem,env(safe-area-inset-bottom))] sm:pb-24">
        <header className="mx-auto min-w-0 w-full max-w-reading pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-10 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-14">
          <p className="mb-2 text-xs font-medium text-ink-muted">Shared conversation</p>
          <h1
            className="break-words text-2xl font-semibold leading-8 text-ink [overflow-wrap:anywhere] sm:text-[28px] sm:leading-9"
            id="public-share-title"
          >
            {displayTitle}
          </h1>
          <SnapshotNote />
        </header>

        {snapshot.messages.length > 0 ? (
          <ol
            className="mt-2 min-w-0"
            data-testid="public-share-thread"
            aria-label="Shared conversation"
          >
            {snapshot.messages.map((message, index) => {
              const content = messageText(message);
              const isUser = message.role === "user";

              return (
                <li
                  className={
                    isUser
                      ? "min-w-0 pb-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-8 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]"
                      : "min-w-0 pb-8 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-2 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]"
                  }
                  key={`${message.role}-${index}`}
                >
                  <article
                    className={
                      isUser
                        ? "mx-auto min-w-0 w-full max-w-reading"
                        : "mx-auto min-w-0 w-full max-w-reading text-[16px] leading-[1.68] text-ink sm:text-[17px]"
                    }
                    data-role={message.role}
                    aria-label={isUser ? "Shared question" : "Shared answer"}
                  >
                    <div
                      className={
                        isUser
                          ? "ml-auto w-fit min-w-0 max-w-[min(36rem,88%)] break-words rounded-panel bg-control-surface px-4 py-3 text-[15px] leading-6 text-ink [overflow-wrap:anywhere]"
                          : "min-w-0"
                      }
                      data-public-share-message-content="true"
                    >
                      {content.trim() ? (
                        <MarkdownMessage content={content} />
                      ) : (
                        <p className="text-sm italic text-ink-muted">No shared text in this turn.</p>
                      )}
                    </div>
                  </article>
                </li>
              );
            })}
          </ol>
        ) : (
          <section
            className="mx-auto mt-10 w-full max-w-reading border-y border-trace-subtle pb-8 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-8 sm:pb-10 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-10"
            data-testid="public-share-empty"
            aria-labelledby="public-share-empty-title"
          >
            <h2 className="text-lg font-semibold text-ink" id="public-share-empty-title">
              This snapshot has no visible messages.
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
              Nothing from the shared branch can be displayed here.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

export function PublicShareUnavailableView() {
  return (
    <main
      className="min-h-[100dvh] min-w-0 overflow-x-hidden bg-answer-paper text-ink"
      data-testid="public-share-unavailable"
    >
      <PublicShareHeader />
      <section
        className="mx-auto w-full max-w-reading pb-[max(4rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-16 sm:pb-24 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-24"
        aria-labelledby="public-share-unavailable-title"
      >
        <p className="mb-2 text-xs font-medium text-ink-muted">Public snapshot</p>
        <h1 className="text-2xl font-semibold leading-8 text-ink" id="public-share-unavailable-title">
          Shared snapshot unavailable
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-ink-secondary">
          This link is invalid or the snapshot is no longer available. No conversation details can be
          shown.
        </p>
      </section>
    </main>
  );
}

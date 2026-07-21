import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import type { PublicShareSnapshot } from "@/lib/domain/shareSnapshot";
import { Lock } from "lucide-react";

type PublicShareViewProps = {
  snapshot: PublicShareSnapshot;
  title: string;
};

function PublicShareHeader() {
  return (
    <header className="relative z-10 border-b border-separator-subtle bg-surface-navigation pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex min-h-14 w-full max-w-reading items-center justify-between gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]">
        <p className="text-sm font-semibold tracking-[0.01em] text-content-primary">AIQSA</p>
        <p className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-content-secondary">
          <Lock className="size-3.5 text-content-muted" aria-hidden="true" />
          Read-only snapshot
        </p>
      </div>
    </header>
  );
}

function messageText(message: PublicShareSnapshot["messages"][number]): string {
  return message.content.blocks.map((block) => block.text).join("\n\n");
}

export function PublicShareView({ snapshot, title }: PublicShareViewProps) {
  const displayTitle = title.trim() || "Shared chat";

  return (
    <main
      className="min-h-[100dvh] min-w-0 overflow-x-hidden text-content-primary"
      data-testid="public-share-view"
    >
      <PublicShareHeader />

      <div className="mx-auto w-full max-w-reading pb-[max(4rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-8 sm:pb-24 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-12">
        <header className="mb-10 min-w-0">
          <p className="mb-2 text-xs font-medium text-content-muted">Shared chat</p>
          <h1
            className="break-words text-2xl font-semibold leading-8 text-content-primary [overflow-wrap:anywhere] sm:text-[28px] sm:leading-9"
            id="public-share-title"
          >
            {displayTitle}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-content-secondary">
            A fixed copy of one conversation branch. It won&apos;t update, and nothing on this page can
            change the original chat.
          </p>
        </header>

        {snapshot.messages.length > 0 ? (
          <ol
            className="min-w-0 space-y-8 sm:space-y-10"
            data-testid="public-share-thread"
            aria-label="Shared conversation"
          >
            {snapshot.messages.map((message, index) => {
              const content = messageText(message);
              const isUser = message.role === "user";

              return (
                <li className={isUser ? "flex min-w-0 justify-end" : "min-w-0"} key={`${message.role}-${index}`}>
                  <article
                    className={
                      isUser
                        ? "ml-auto min-w-0 max-w-[min(38rem,88%)] rounded-bubble bg-surface-raised px-4 py-3 text-[15px] leading-7 text-content-primary"
                        : "min-w-0 w-full text-[15px] leading-7 text-content-primary"
                    }
                    data-role={message.role}
                    aria-label={isUser ? "Shared question" : "Shared answer"}
                  >
                    {content.trim() ? (
                      <MarkdownMessage content={content} />
                    ) : (
                      <p className="text-sm italic text-content-muted">No shared text in this turn.</p>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        ) : (
          <section
            className="py-12 sm:py-16"
            data-testid="public-share-empty"
            aria-labelledby="public-share-empty-title"
          >
            <h2 className="text-lg font-semibold text-content-primary" id="public-share-empty-title">
              This snapshot has no visible messages.
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-content-secondary">
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
      className="min-h-[100dvh] min-w-0 overflow-x-hidden text-content-primary"
      data-testid="public-share-unavailable"
    >
      <PublicShareHeader />
      <section
        className="mx-auto w-full max-w-reading pb-[max(4rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(4rem,env(safe-area-inset-top))] sm:pb-24 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-24"
        aria-labelledby="public-share-unavailable-title"
      >
        <p className="mb-2 text-xs font-medium text-content-muted">Shared chat</p>
        <h1 className="text-2xl font-semibold leading-8 text-content-primary" id="public-share-unavailable-title">
          Shared snapshot unavailable
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-content-secondary">
          This link is invalid or the snapshot is no longer available. No conversation details can be
          shown.
        </p>
      </section>
    </main>
  );
}

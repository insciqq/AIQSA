"use client";

import { responseErrorMessage, errorMessage } from "@/components/app-shell/shellFormatting";
import { shellFetch } from "@/components/app-shell/shellApi";
import type { ChatSummary } from "@/components/app-shell/types";
import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDialogFocus } from "./useDialogFocus";

export type ShareDialogTarget = {
  activeLeafMessageId: string | null;
  chat: ChatSummary;
};

type ShareLink = {
  createdAt: string;
  id: string;
};

type CreatedShareLink = {
  href: string;
  id: string;
};

function decodeShareList(value: unknown): ShareLink[] | null {
  if (typeof value !== "object" || value === null || !("shares" in value)) {
    return null;
  }

  const shares = (value as { shares?: unknown }).shares;
  if (!Array.isArray(shares)) {
    return null;
  }

  const links: ShareLink[] = [];
  for (const entry of shares) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { id?: unknown }).id !== "string" ||
      typeof (entry as { createdAt?: unknown }).createdAt !== "string"
    ) {
      return null;
    }
    links.push({
      createdAt: (entry as { createdAt: string }).createdAt,
      id: (entry as { id: string }).id
    });
  }

  return links;
}

function createdAtLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return date.toLocaleString(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric"
  });
}

export function ShareDialog({
  onClose,
  target
}: {
  onClose(): void;
  target: ShareDialogTarget;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState<CreatedShareLink | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | "idle">("idle");
  const [revokingIds, setRevokingIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dialogRef = useDialogFocus<HTMLDivElement>({
    autoFocus: true,
    closeOnEscape: true,
    containFocus: true,
    onClose
  });

  const chatId = target.chat.id;
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const response = await shellFetch(`/api/chats/${chatId}/share`);
        if (!response.ok) {
          throw new Error(await responseErrorMessage(response, `share_list_failed_${response.status}`));
        }

        const decoded = decodeShareList(await response.json());
        if (!decoded) {
          throw new Error("share_list_malformed");
        }
        if (!stale) {
          setLinks(decoded);
        }
      } catch (error) {
        if (!stale) {
          setLinks([]);
          setListError(errorMessage(error));
        }
      }
    })();

    return () => {
      stale = true;
    };
  }, [chatId]);

  async function createLink() {
    if (creating || !target.activeLeafMessageId) {
      return;
    }

    setCreating(true);
    setActionError(null);
    try {
      const response = await shellFetch(`/api/chats/${chatId}/share`, {
        body: JSON.stringify({
          activeLeafMessageId: target.activeLeafMessageId
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `share_failed_${response.status}`));
      }

      const body = (await response.json()) as {
        share?: { createdAt?: unknown; id?: unknown; publicPath?: unknown };
      };
      if (typeof body.share?.id !== "string" || typeof body.share.publicPath !== "string") {
        throw new Error("share_response_invalid");
      }

      const href = new URL(body.share.publicPath, window.location.origin).toString();
      const createdAt =
        typeof body.share.createdAt === "string" ? body.share.createdAt : new Date().toISOString();
      if (!mountedRef.current) {
        return;
      }
      setCreatedLink({ href, id: body.share.id });
      setLinks((current) => [
        { createdAt, id: body.share!.id as string },
        ...(current ?? []).filter((link) => link.id !== body.share!.id)
      ]);
      try {
        await writeClipboardText(href);
        if (mountedRef.current) {
          setCopyStatus("copied");
        }
      } catch {
        if (mountedRef.current) {
          setCopyStatus("failed");
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        setActionError(errorMessage(error));
      }
    } finally {
      if (mountedRef.current) {
        setCreating(false);
      }
    }
  }

  async function copyCreatedLink() {
    if (!createdLink) {
      return;
    }

    try {
      await writeClipboardText(createdLink.href);
      if (mountedRef.current) {
        setCopyStatus("copied");
      }
    } catch {
      if (mountedRef.current) {
        setCopyStatus("failed");
      }
    }
  }

  async function revokeLink(linkId: string) {
    if (revokingIds.has(linkId)) {
      return;
    }

    setRevokingIds((current) => new Set(current).add(linkId));
    setActionError(null);
    try {
      const response = await shellFetch(`/api/shares/${linkId}/revoke`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `share_revoke_failed_${response.status}`));
      }

      if (!mountedRef.current) {
        return;
      }
      setLinks((current) => (current ?? []).filter((link) => link.id !== linkId));
      setCreatedLink((current) => (current?.id === linkId ? null : current));
    } catch (error) {
      if (mountedRef.current) {
        setActionError(errorMessage(error));
      }
    } finally {
      if (mountedRef.current) {
        setRevokingIds((current) => {
          const next = new Set(current);
          next.delete(linkId);
          return next;
        });
      }
    }
  }

  const secondaryButtonClass =
    "h-touch rounded-control bg-control-surface px-3 text-sm font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface disabled:opacity-50 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch";
  const destructiveButtonClass =
    "h-touch rounded-control px-3 text-sm font-medium text-critical outline-none hover:bg-critical/10 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface disabled:opacity-50 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch";

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-scrim/60 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[max(.75rem,env(safe-area-inset-top))] sm:items-center sm:pb-[max(.75rem,env(safe-area-inset-bottom))] sm:pl-[max(.75rem,env(safe-area-inset-left))] sm:pr-[max(.75rem,env(safe-area-inset-right))]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="pop-enter flex max-h-[calc(100dvh-max(.75rem,env(safe-area-inset-top)))] w-full max-w-lg flex-col overflow-hidden rounded-t-panel border border-b-0 border-trace-subtle bg-overlay-surface text-ink shadow-overlay sm:max-h-[calc(100dvh-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:rounded-panel sm:border [@media(max-height:32rem)]:max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]"
        role="dialog"
        aria-modal="true"
        aria-label="Share anonymously"
        aria-busy={creating || undefined}
        data-testid="share-dialog"
      >
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-trace-subtle px-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">Share anonymously</h2>
            <p className="break-words text-xs text-ink-muted [overflow-wrap:anywhere]">{target.chat.title}</p>
          </div>
          <button
            className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
            type="button"
            aria-label="Close share dialog"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
          <p className="text-sm leading-6 text-ink-secondary" id="share-dialog-description">
            Creating a link publishes a read-only, sanitized snapshot of the current conversation branch at a
            secret address. The snapshot never updates with the conversation, and attachments, run internals,
            and account details are excluded. Anyone with the link can read it until you revoke it.
          </p>
          {actionError ? (
            <p className="mt-3 break-words text-sm leading-5 text-critical [overflow-wrap:anywhere]" role="alert">
              {actionError}
            </p>
          ) : null}
          {createdLink ? (
            <div
              className="mt-4 rounded-control border border-proof/35 bg-proof/[0.06] px-3 py-3"
              data-testid="share-link"
            >
              <p className="text-xs font-medium text-ink-secondary">
                {copyStatus === "copied"
                  ? "Link created and copied"
                  : copyStatus === "failed"
                    ? "Link created. Copying failed — use Copy link or select the URL."
                    : "Link created"}
              </p>
              <a
                className="mt-1 block break-all text-sm font-medium text-proof underline underline-offset-2"
                href={createdLink.href}
                rel="noreferrer"
                target="_blank"
              >
                {createdLink.href}
              </a>
              <p className="mt-1 text-xs leading-5 text-ink-muted">
                Save it now: the full URL is only shown right after creation.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button className={secondaryButtonClass} type="button" onClick={() => void copyCreatedLink()}>
                  Copy link
                </button>
                <button
                  className={destructiveButtonClass}
                  type="button"
                  disabled={revokingIds.has(createdLink.id)}
                  onClick={() => void revokeLink(createdLink.id)}
                >
                  {revokingIds.has(createdLink.id) ? "Revoking…" : "Revoke link"}
                </button>
              </div>
            </div>
          ) : null}
          <section aria-labelledby="share-dialog-links-heading" className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted" id="share-dialog-links-heading">
              Live links for this chat
            </h3>
            {links === null ? (
              <p className="mt-2 text-sm text-ink-muted" data-testid="share-links-loading">
                Loading links…
              </p>
            ) : (
              <>
                {listError ? (
                  <p className="mt-2 break-words text-sm leading-5 text-critical [overflow-wrap:anywhere]">
                    {listError}
                  </p>
                ) : null}
                {links.length === 0 && !listError ? (
                  <p className="mt-2 text-sm text-ink-muted" data-testid="share-links-empty">
                    No live links. This chat is private.
                  </p>
                ) : null}
                {links.length > 0 ? (
                  <ul className="mt-2 divide-y divide-trace-subtle border-y border-trace-subtle" data-testid="share-links">
                    {links.map((link) => (
                      <li className="flex items-center justify-between gap-3 py-2.5" key={link.id}>
                        <div className="min-w-0">
                          <p className="text-sm text-ink">
                            {createdLink?.id === link.id ? "Just created" : "Public link"}
                          </p>
                          <p className="text-xs text-ink-muted">Created {createdAtLabel(link.createdAt)}</p>
                        </div>
                        <button
                          className={destructiveButtonClass}
                          type="button"
                          aria-label={`Revoke link created ${createdAtLabel(link.createdAt)}`}
                          disabled={revokingIds.has(link.id)}
                          onClick={() => void revokeLink(link.id)}
                        >
                          {revokingIds.has(link.id) ? "Revoking…" : "Revoke link"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {links.length > 0 && !createdLink ? (
                  <p className="mt-2 text-xs leading-5 text-ink-muted">
                    Full URLs are only shown right after creation; stored links are kept as hashes.
                  </p>
                ) : null}
              </>
            )}
          </section>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-trace-subtle px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:pb-3">
          <button className={secondaryButtonClass} type="button" onClick={onClose}>
            Close
          </button>
          <button
            className="h-touch rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast outline-none hover:bg-proof-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-overlay-surface disabled:opacity-50 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            aria-describedby="share-dialog-description"
            disabled={creating || !target.activeLeafMessageId}
            onClick={() => void createLink()}
          >
            {creating ? "Creating link…" : "Create public link"}
          </button>
        </footer>
      </div>
    </div>
  );
}

"use client";

import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export const CODE_CHROME_BUTTON_CLASS =
  "inline-flex h-touch items-center gap-1.5 rounded-control px-2 text-metadata text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch sm:h-control-sm";

/** Copy action of a code block toolbar, with a short "Copied" confirmation. */
export function CodeCopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copiedResetRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedResetRef.current !== null) {
        window.clearTimeout(copiedResetRef.current);
      }
    },
    []
  );

  async function copy() {
    try {
      await writeClipboardText(text);
      setCopied(true);
      if (copiedResetRef.current !== null) {
        window.clearTimeout(copiedResetRef.current);
      }
      copiedResetRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <button className={CODE_CHROME_BUTTON_CLASS} type="button" aria-label={label} onClick={() => void copy()}>
        {copied ? (
          <Check className="size-3 text-positive" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

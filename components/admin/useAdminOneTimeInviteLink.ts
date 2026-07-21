import { adminActionErrorMessage } from "@/components/admin/adminApi";
import { useCallback, useMemo, useRef, useState } from "react";

type AdminInviteLinkFeedback = Readonly<{
  clearAll(): void;
  reportError(message: string): void;
  reportNotice(message: string): void;
}>;

export type AdminClipboardWriter = (value: string) => Promise<void>;

export type UseAdminOneTimeInviteLinkOptions = Readonly<{
  feedback: AdminInviteLinkFeedback;
  writeText?: AdminClipboardWriter;
}>;

export type AdminOneTimeInviteLinkController = Readonly<{
  copyOneTimeUrl(): Promise<void>;
  oneTimeUrl: string | null;
  oneTimeUrlCopied: boolean;
  revealOneTimeUrl(url?: string | null): void;
}>;

async function writeToBrowserClipboard(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("clipboard_unavailable");
  }

  await navigator.clipboard.writeText(value);
}

export function useAdminOneTimeInviteLink({
  feedback,
  writeText = writeToBrowserClipboard
}: UseAdminOneTimeInviteLinkOptions): AdminOneTimeInviteLinkController {
  const { clearAll, reportError, reportNotice } = feedback;
  const [oneTimeUrl, setOneTimeUrl] = useState<string | null>(null);
  const [oneTimeUrlCopied, setOneTimeUrlCopied] = useState(false);
  const copyGenerationRef = useRef(0);

  const revealOneTimeUrl = useCallback((url?: string | null) => {
    copyGenerationRef.current += 1;
    setOneTimeUrl(url ?? null);
    setOneTimeUrlCopied(false);
  }, []);

  const copyOneTimeUrl = useCallback(async () => {
    if (!oneTimeUrl) {
      return;
    }

    const copyGeneration = copyGenerationRef.current + 1;
    copyGenerationRef.current = copyGeneration;
    const copiedUrl = oneTimeUrl;
    setOneTimeUrlCopied(false);
    clearAll();
    try {
      await writeText(copiedUrl);
      if (copyGeneration !== copyGenerationRef.current) {
        return;
      }
      setOneTimeUrlCopied(true);
      reportNotice("Invite link copied.");
    } catch {
      if (copyGeneration !== copyGenerationRef.current) {
        return;
      }
      reportError(adminActionErrorMessage("clipboard_unavailable"));
    }
  }, [clearAll, oneTimeUrl, reportError, reportNotice, writeText]);

  return useMemo(
    () => ({
      copyOneTimeUrl,
      oneTimeUrl,
      oneTimeUrlCopied,
      revealOneTimeUrl
    }),
    [copyOneTimeUrl, oneTimeUrl, oneTimeUrlCopied, revealOneTimeUrl]
  );
}

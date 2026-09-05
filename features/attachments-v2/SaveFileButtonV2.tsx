"use client";

import { saveFileToLibrary, useFileLibraryStore } from "@/components/app-shell/fileLibraryStore";
import { UiV2Button } from "@/components/ui-v2";

export function SaveFileButtonV2({ attachmentId }: Readonly<{ attachmentId: string }>) {
  const state = useFileLibraryStore((current) => current.mutations[attachmentId]);
  return (
    <span className="v2-file-save">
      <UiV2Button
        disabled={state === "saving" || state === "saved"}
        aria-busy={state === "saving" || undefined}
        onClick={() => void saveFileToLibrary(attachmentId)}
      >
        {state === "saved" ? "Saved to Library" : "Save to Library"}
      </UiV2Button>
      {state === "error" ? <small role="alert">Could not save. Try again.</small> : null}
    </span>
  );
}

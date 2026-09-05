"use client";

import { loadMoreFileLibrary, refreshFileLibrary, useFileLibraryStore } from "@/components/app-shell/fileLibraryStore";
import { formatAttachmentBytes } from "@/components/app-shell/attachmentLimitUsage";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import { useEffect, useRef, useState } from "react";

export function SavedFilePickerV2({ disabled, onUse, onUsed }: Readonly<{
  disabled?: boolean;
  onUse(attachmentId: string, fileName: string): Promise<boolean>;
  onUsed?(): void;
}>) {
  const data = useFileLibraryStore((state) => state.data);
  const loadState = useFileLibraryStore((state) => state.loadState);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void refreshFileLibrary(true).catch(() => undefined);
    return () => { active.current = false; };
  }, []);
  const saved = (data?.files ?? []).filter((file) => file.savedAt);
  const files = saved.filter((file) => file.fileName.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <div className="v2-composer-layer-scroll v2-saved-file-picker">
      <input
        aria-label="Find saved files"
        data-v2-file-search
        placeholder="Find saved files…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p className="v2-composer-layer-note">Attach a copy. Saved originals stay unchanged.</p>
      {loadState === "loading" && !data ? <p role="status">Loading files…</p> : null}
      {loadState === "error" ? (
        <div role="alert">Files could not be loaded. <UiV2Button onClick={() => void refreshFileLibrary(true).catch(() => undefined)}>Retry</UiV2Button></div>
      ) : null}
      {error ? <p role="alert">This file could not be attached. Try again.</p> : null}
      <ul aria-label="Saved files">
        {files.map((file) => (
          <li key={file.id}>
            <UiV2Icon name="file" />
            <span><strong>{file.fileName}</strong><small>{formatAttachmentBytes(file.byteSize)}</small></span>
            <UiV2Button
              data-v2-composer-option="true"
              disabled={disabled || pending !== null}
              aria-busy={pending === file.id || undefined}
              onClick={() => {
                setPending(file.id);
                setError(false);
                void onUse(file.id, file.fileName).then((used) => {
                  if (!active.current) return;
                  setError(!used);
                  if (used) onUsed?.();
                }, () => { if (active.current) setError(true); })
                  .finally(() => { if (active.current) setPending(null); });
              }}
            >Use file</UiV2Button>
          </li>
        ))}
      </ul>
      {data?.nextCursor ? <UiV2Button disabled={loadState === "loading"} onClick={() => void loadMoreFileLibrary()?.catch(() => undefined)}>Load more files</UiV2Button> : null}
      {loadState === "ready" && files.length === 0 ? (
        <p>{saved.length ? "No matching saved files." : "Save a file from a message or Library to use it here."}</p>
      ) : null}
    </div>
  );
}

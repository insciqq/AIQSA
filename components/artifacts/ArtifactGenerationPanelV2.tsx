"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { ArtifactViewerFrameV2 } from "./ArtifactViewerFrameV2";
import { closeArtifactPanel } from "./artifactPanelStore";
import { artifactGenerationStatus, type ArtifactGenerationDraft } from "./artifactGenerationState";

export function ArtifactGenerationPanelV2({ draft, compact }: Readonly<{ draft?: ArtifactGenerationDraft; compact: boolean }>) {
  const [expanded, setExpanded] = useState(false);
  const [fileIndex, setFileIndex] = useState<number | null>(null);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);
  const file = draft?.files.find(file => file.index === fileIndex) ?? draft?.files[0];
  useLayoutEffect(() => {
    if (following && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [file?.text, following]);
  const title = draft?.title ?? "Artifact";
  return <ArtifactViewerFrameV2 compact={compact} expanded={expanded} host="chat" title={title} onClose={() => { if (expanded) setExpanded(false); else closeArtifactPanel(); }}>
    {initialFocusRef => <div className="v2-artifact-viewer v2-artifact-generation" data-testid="artifact-generation-panel">
      <header className="v2-artifact-toolbar">
        <div className="v2-artifact-title"><h2 title={title}>{title}</h2></div><small>Code</small>
        <UiV2IconButton icon={expanded ? "collapse" : "expand"} label={expanded ? "Collapse artifact" : "Expand artifact"} onClick={() => setExpanded(value => !value)} />
        <UiV2IconButton icon="close" label="Close artifact" ref={initialFocusRef} onClick={() => closeArtifactPanel()} />
      </header>
      <p className="v2-artifact-generation-status" role="status">{draft ? artifactGenerationStatus(draft) : "Live code is unavailable. Check the conversation for the saved result."}</p>
      {file ? <div className="v2-artifact-generation-source">
        <div className="v2-artifact-generation-files" aria-label="Artifact files">
          {draft?.files.map(item => <button type="button" className="v2-focusable" key={item.index}
            aria-pressed={item.index === file.index} onClick={() => { setFileIndex(item.index); setFollowing(true); }}>{item.path ?? `File ${item.index + 1}`}</button>)}
          {!following ? <UiV2Button onClick={() => setFollowing(true)}>Follow code</UiV2Button> : null}
        </div>
        <pre className="v2-artifact-generation-code" aria-label={file.path ?? "Artifact code"} ref={scrollRef} tabIndex={0}
          onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)}
          onKeyDown={event => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) setFollowing(false); }}
          onScroll={() => { const element = scrollRef.current; if (element && element.scrollHeight - element.clientHeight - element.scrollTop > 24) setFollowing(false); }}><code>{file.text}</code></pre>
      </div> : <p className="v2-artifact-generation-empty">{draft?.status === "pending" && !draft.previewUnavailable ? "The code will appear here as it is generated." : "Only a saved, ready version can be previewed."}</p>}
    </div>}
  </ArtifactViewerFrameV2>;
}

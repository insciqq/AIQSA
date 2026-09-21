"use client";

import { useRouter } from "next/navigation";
import { UiV2IconSprite } from "@/components/ui-v2";
import { ArtifactViewerV2 } from "./ArtifactViewerV2";
import { prepareArtifactEdit } from "./artifactClient";
import { storeArtifactRuntimeError } from "./artifactRuntimeSession";

export function ArtifactPageV2({ artifactId, versionId }: { artifactId: string; versionId: string }) {
  const router = useRouter();
  return <main className="v2-artifact-page">
    <UiV2IconSprite />
    <ArtifactViewerV2 artifactId={artifactId} host="page" versionId={versionId}
      onVersionChange={next => router.replace(`/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(next)}`, { scroll: false })}
      onEditRequest={async (intent, error) => {
        const chatId = await prepareArtifactEdit(artifactId, versionId);
        if (intent === "runtime_error" && error) storeArtifactRuntimeError(versionId, error);
        router.push(`/?chat=${encodeURIComponent(chatId)}&artifactEdit=${intent}&artifactId=${encodeURIComponent(artifactId)}&versionId=${encodeURIComponent(versionId)}`);
      }} />
  </main>;
}

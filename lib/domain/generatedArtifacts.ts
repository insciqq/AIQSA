import type { ThreadGeneratedArtifact } from "../contracts/chats";

/** Keep first-appearance order while replayed older versions cannot replace newer receipts. */
export function latestGeneratedArtifactsForAnswer(
  artifacts: readonly ThreadGeneratedArtifact[]
): ThreadGeneratedArtifact[] {
  const latest = new Map<string, ThreadGeneratedArtifact>();
  for (const artifact of artifacts) {
    const previous = latest.get(artifact.artifactId);
    if (!previous || artifact.versionNumber > previous.versionNumber) {
      latest.set(artifact.artifactId, artifact);
    }
  }
  return [...latest.values()];
}

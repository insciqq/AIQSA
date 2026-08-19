function storageSegment(value: string): string {
  return encodeURIComponent(value);
}

export function knowledgeSourceNormalizedTextStorageKey(input: Readonly<{
  artifactId: string;
  ownerUserId: string;
  sourceId: string;
  sourceVersionId: string;
}>): string {
  return [
    "knowledge-sources",
    storageSegment(input.ownerUserId),
    storageSegment(input.sourceId),
    storageSegment(input.sourceVersionId),
    storageSegment(input.artifactId),
    "normalized-v2.json"
  ].join("/");
}

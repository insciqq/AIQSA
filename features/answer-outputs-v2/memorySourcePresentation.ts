import type { MemoryAnswerSource } from "@/lib/contracts/memoryClient";

export type PastChatSourceV2 = Extract<MemoryAnswerSource, { sourceType: "PAST_CHAT" }>;
export type PastChatGroupV2 = Readonly<{ key: string; sources: readonly PastChatSourceV2[] }>;

export function presentMemorySourcesV2(sources: readonly MemoryAnswerSource[]) {
  const groups = new Map<string, PastChatSourceV2[]>();
  const memories: MemoryAnswerSource[] = [];
  for (const source of sources) {
    if (source.sourceType !== "PAST_CHAT") {
      memories.push(source);
      continue;
    }
    const group = groups.get(source.chatGroup) ?? [];
    group.push(source);
    groups.set(source.chatGroup, group);
  }
  return {
    memories,
    pastChats: [...groups].map(([key, grouped]) => ({ key, sources: grouped }))
  };
}

import type {
  ChatBranchGraphWire,
  ChatBranchNodeWire
} from "@/lib/contracts/chats";

export type BranchVersionV2 = Readonly<{
  active: boolean;
  checkoutLeafId: string;
  kind: "edited_question" | "original" | "regenerated_answer" | "version";
  messageCount: number;
  ordinal: number;
  preview: string;
  status: ChatBranchNodeWire["status"];
}>;

export type BranchPagerStateV2 = Readonly<{
  current: number;
  nextLeafId: string | null;
  previousLeafId: string | null;
  total: number;
}>;

function childrenByParent(graph: ChatBranchGraphWire): Map<string, ChatBranchNodeWire[]> {
  const children = new Map<string, ChatBranchNodeWire[]>();
  for (const node of graph.nodes) {
    if (!node.parentMessageId) continue;
    const siblings = children.get(node.parentMessageId) ?? [];
    siblings.push(node);
    children.set(node.parentMessageId, siblings);
  }
  return children;
}

function nodePath(
  graph: ChatBranchGraphWire,
  leafId: string
): ChatBranchNodeWire[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const reverse: ChatBranchNodeWire[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(leafId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    reverse.push(cursor);
    cursor = cursor.parentMessageId ? byId.get(cursor.parentMessageId) : undefined;
  }
  return reverse.reverse();
}

function deepestLeafId(
  graph: ChatBranchGraphWire,
  node: ChatBranchNodeWire
): string {
  const children = childrenByParent(graph);
  const seen = new Set<string>();
  let cursor = node;
  while (!seen.has(cursor.id)) {
    seen.add(cursor.id);
    const next = children.get(cursor.id)?.at(-1);
    if (!next) break;
    cursor = next;
  }
  return cursor.id;
}

export function activeBranchPathV2(
  graph: ChatBranchGraphWire
): ChatBranchNodeWire[] {
  return graph.activeLeafMessageId ? nodePath(graph, graph.activeLeafMessageId) : [];
}

export function branchVersionsV2(
  graph: ChatBranchGraphWire
): BranchVersionV2[] {
  const parentIds = new Set(
    graph.nodes.flatMap((node) => node.parentMessageId ? [node.parentMessageId] : [])
  );
  const leaves = graph.nodes.filter((node) => !parentIds.has(node.id));
  return leaves.map((leaf, index) => {
    const path = nodePath(graph, leaf.id);
    const comparisonPathIds = new Set(
      index > 0 ? nodePath(graph, leaves[index - 1]!.id).map((node) => node.id) : []
    );
    const divergence = index === 0
      ? null
      : path.find((node) => !comparisonPathIds.has(node.id)) ?? null;
    const question = [...path].reverse().find((node) => node.role === "user");
    const preview = question?.preview || leaf.preview || leaf.status;
    return {
      active: leaf.id === graph.activeLeafMessageId,
      checkoutLeafId: leaf.id,
      kind: index === 0
        ? "original"
        : divergence?.role === "user"
          ? "edited_question"
          : divergence?.role === "assistant"
            ? "regenerated_answer"
            : "version",
      messageCount: path.length,
      ordinal: index + 1,
      preview,
      status: leaf.status
    };
  });
}

export function branchPagerForMessageV2(
  graph: ChatBranchGraphWire,
  messageId: string
): BranchPagerStateV2 | null {
  const node = graph.nodes.find((candidate) => candidate.id === messageId);
  if (!node) return null;
  const siblings = graph.nodes.filter((candidate) =>
    candidate.parentMessageId === node.parentMessageId && candidate.role === node.role
  );
  if (siblings.length <= 1) return null;
  const index = siblings.findIndex((candidate) => candidate.id === node.id);
  if (index < 0) return null;
  return {
    current: index + 1,
    nextLeafId: siblings[index + 1] ? deepestLeafId(graph, siblings[index + 1]!) : null,
    previousLeafId: siblings[index - 1] ? deepestLeafId(graph, siblings[index - 1]!) : null,
    total: siblings.length
  };
}

export type CommandKind = "action" | "chat" | "model" | "prompt" | "search";

export type CommandItem = {
  current?: boolean;
  id: string;
  kind: CommandKind;
  keywords: string[];
  label: string;
  subtitle: string;
};

export type CommandSelectionDirection = "down" | "first" | "last" | "up";

const kindSearchTerms: Record<CommandKind, string> = {
  action: "action actions command commands",
  chat: "chat chats conversation conversations",
  model: "model models provider providers",
  prompt: "prompt prompts preset presets",
  search: "search searches strategy strategies"
};

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function filterCommandItems(items: CommandItem[], query: string): CommandItem[] {
  const terms = normalized(query)
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return items;
  }

  return items.filter((item) => {
    const haystack = normalized([kindSearchTerms[item.kind], item.label, item.subtitle, ...item.keywords].join(" "));

    return terms.every((term) => haystack.includes(term));
  });
}

export function moveCommandSelection(
  currentIndex: number,
  itemCount: number,
  direction: CommandSelectionDirection
): number {
  if (itemCount <= 0) {
    return 0;
  }

  if (direction === "first") {
    return 0;
  }

  if (direction === "last") {
    return itemCount - 1;
  }

  if (direction === "down") {
    return (currentIndex + 1 + itemCount) % itemCount;
  }

  return (currentIndex - 1 + itemCount) % itemCount;
}

import type { TelegramInputRichBlock, TelegramRichText } from "../botApi";

export const RICH_LIMITS = { characters: 32_768, blocks: 500, depth: 16, columns: 20 } as const;
export const TEXT_LIMIT = 4_096;

export function isRichArray(text: TelegramRichText): text is readonly TelegramRichText[] {
  return Array.isArray(text);
}

export function plainText(text: TelegramRichText, links = false): string {
  if (typeof text === "string") return text;
  if (isRichArray(text)) return text.map(part => plainText(part, links)).join("");
  if (text.type === "mathematical_expression") return text.expression;
  const label = plainText(text.text, links);
  return links && text.type === "url" && label !== text.url ? `${label} (${text.url})` : label;
}

/** Readable projection used for fallback and for containers that must be flattened. */
export function plainBlock(block: TelegramInputRichBlock, links = false): string {
  switch (block.type) {
    case "divider": return "---";
    case "mathematical_expression": return block.expression;
    case "blockquote": return block.blocks.map(child => plainBlock(child, links)).join("\n\n");
    case "list": return block.items.map(item => {
      const label = item.value === undefined ? "-" : `${item.value}.`;
      return `${label} ${item.blocks.map(child => plainBlock(child, links)).join("\n\n")}`;
    }).join("\n");
    case "table": return block.cells.map(row => row.map(cell => plainText(cell.text ?? "", links)).join(" | ")).join("\n");
    default: return plainText(block.text, links);
  }
}

export function blockSize(block: TelegramInputRichBlock): { characters: number; blocks: number } {
  switch (block.type) {
    case "divider": return { characters: 0, blocks: 1 };
    case "mathematical_expression": return { characters: block.expression.length, blocks: 1 };
    case "blockquote": {
      const sizes = block.blocks.map(blockSize);
      return {
        characters: sizes.reduce((sum, size) => sum + size.characters, 0),
        blocks: 1 + sizes.reduce((sum, size) => sum + size.blocks, 0)
      };
    }
    case "list": {
      const sizes = block.items.flatMap(item => item.blocks.map(blockSize));
      return {
        characters: sizes.reduce((sum, size) => sum + size.characters, 0),
        blocks: 1 + block.items.length + sizes.reduce((sum, size) => sum + size.blocks, 0)
      };
    }
    case "table": return {
      characters: block.cells.reduce((sum, row) => sum + row.reduce((total, cell) => total + plainText(cell.text ?? "").length, 0), 0),
      blocks: 1 + block.cells.length
    };
    default: return { characters: plainText(block.text).length, blocks: 1 };
  }
}

function limitTextDepth(text: TelegramRichText, depth: number): TelegramRichText {
  if (typeof text === "string") return text;
  if (isRichArray(text)) return text.map(part => limitTextDepth(part, depth));
  if (depth >= RICH_LIMITS.depth) return plainText(text);
  if (text.type === "mathematical_expression") return text;
  return { ...text, text: limitTextDepth(text.text, depth + 1) };
}

export function limitBlockDepth(block: TelegramInputRichBlock, depth = 0): TelegramInputRichBlock {
  if (block.type === "blockquote") {
    if (depth + 2 > RICH_LIMITS.depth) return { type: "pre", text: plainBlock(block) };
    return { ...block, blocks: block.blocks.map(child => limitBlockDepth(child, depth + 1)) };
  }
  if (block.type === "list") {
    if (depth + 3 > RICH_LIMITS.depth) return { type: "pre", text: plainBlock(block) };
    return { ...block, items: block.items.map(item => ({
      ...item, blocks: item.blocks.map(child => limitBlockDepth(child, depth + 2))
    })) };
  }
  if (block.type === "table") return { ...block, cells: block.cells.map(row => row.map(cell => ({
    ...cell, text: limitTextDepth(cell.text ?? "", depth + 1)
  }))) };
  if ("text" in block) return { ...block, text: limitTextDepth(block.text, depth + 1) };
  return block;
}

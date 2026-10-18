import { describe, expect, it } from "vitest";
import { TELEGRAM_RICH_LIMITS, validateTelegramRichMessage } from "@/tests/support/fakeTelegramBotApi";
import type { TelegramInputRichBlock, TelegramInputRichMessage } from "../botApi";
import { limitBlockDepth, plainBlock, RICH_LIMITS, TEXT_LIMIT } from "./richText";
import { CONTINUATION_MARKER, draftMessage, packBlocks, splitText } from "./split";

function content(messages: TelegramInputRichMessage[]) {
  return messages.flatMap((message, index) => index === 0 ? message.blocks : message.blocks.slice(1));
}

function verify(blocks: TelegramInputRichBlock[]) {
  const messages = packBlocks(blocks);
  messages.forEach((message, index) => {
    expect(validateTelegramRichMessage(message)).toMatchObject({ ok: true });
    if (index) expect(message.blocks[0]).toEqual({ type: 'footer', text: CONTINUATION_MARKER });
  });
  // Delimiters stay in the chunk that owned them. Continuation markers are
  // transport framing, excluded by position rather than matching answer text.
  expect(content(messages).map(block => plainBlock(block)).join('')).toBe(blocks.map(block => plainBlock(block)).join(''));
  return messages;
}

describe('Telegram splitting', () => {
  it('uses the independently validated wire limits', () => {
    expect(RICH_LIMITS).toEqual(TELEGRAM_RICH_LIMITS);
    expect(TEXT_LIMIT).toBe(4096);
  });

  it('packs top-level blocks under both budgets', () => {
    const messages = verify(Array.from({ length: 1_200 }, (_, index) => ({ type: 'paragraph', text: `p${index}` })));
    expect(messages).toHaveLength(3);
    expect(messages.map(message => message.blocks.length)).toEqual([499, 500, 203]);
    const lengthy = verify(Array.from({ length: 6 }, (_, index) => ({ type: 'paragraph', text: `${index}${'x'.repeat(20_000)}` })));
    expect(lengthy).toHaveLength(6);
  });

  it('counts nested list items, quote blocks and table rows', () => {
    const list: TelegramInputRichBlock = {
      type: 'list', items: Array.from({ length: 120 }, (_, index) => ({ blocks: [{ type: 'paragraph', text: String(index) }] }))
    };
    const quote: TelegramInputRichBlock = { type: 'blockquote', blocks: [list] };
    const table: TelegramInputRichBlock = {
      type: 'table', cells: Array.from({ length: 260 }, () => [{ text: 'cell', align: 'left', valign: 'top' }])
    };
    expect(verify([quote, table])).toHaveLength(2);
  });

  it('splits oversized paragraphs and code without losing or duplicating any character', () => {
    const text = Array.from({ length: 20_000 }, (_, index) => `word${index} 😀\n`).join('');
    const messages = verify([{ type: 'paragraph', text: [
      { type: 'bold', text: 'prefix ' }, { type: 'italic', text }, { type: 'url', text: ' tail', url: 'https://example.com' }
    ] }, { type: 'pre', text, language: 'ts' }]);
    expect(messages.length).toBeGreaterThan(2);
    expect(content(messages).some(block => block.type === 'pre' && block.language === 'ts')).toBe(true);
    expect(JSON.stringify(messages)).not.toMatch(/\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/u);
  });

  it('splits long formulas into inert text instead of malformed math', () => {
    const formula = 'a + '.repeat(20_000);
    const messages = verify([
      { type: 'mathematical_expression', expression: formula },
      { type: 'paragraph', text: [{ type: 'mathematical_expression', expression: formula }] }
    ]);
    expect(content(messages).every(block => block.type === 'pre' || block.type === 'paragraph')).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('mathematical_expression');
  });

  it('flattens oversized containers with their item labels and row boundaries intact', () => {
    verify([{ type: 'list', items: Array.from({ length: 600 }, (_, index) => ({
      type: '1', value: index + 5, blocks: [{ type: 'paragraph', text: `item${index}` }]
    })) }]);
    verify([{ type: 'table', cells: Array.from({ length: 700 }, (_, index) => [
      { text: `cell${index}`, align: 'left', valign: 'top' },
      { text: 'value', align: 'left', valign: 'top' }
    ]) }]);
    verify([{ type: 'blockquote', blocks: [{ type: 'pre', text: 'code\n'.repeat(20_000) }] }]);
  });

  it('preserves combined block and inline depth at the boundary', () => {
    let block: TelegramInputRichBlock = { type: 'paragraph', text: { type: 'bold', text: { type: 'italic', text: 'deep' } } };
    for (let index = 0; index < 40; index++) block = index % 2
      ? { type: 'blockquote', blocks: [block] }
      : { type: 'list', items: [{ blocks: [block] }] };
    const bounded = limitBlockDepth(block);
    expect(plainBlock(bounded)).toBe(plainBlock(block));
    verify([bounded]);
  });

  it.each([4095, 4096, 4097, 32756, 32757, 32758, 32768, 65536, 200000])('preserves text at length %s', length => {
    const text = 'x'.repeat(length);
    verify([{ type: 'paragraph', text }]);
    const chunks = splitText(text, TEXT_LIMIT);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= TEXT_LIMIT)).toBe(true);
  });

  it('prefers paragraph and line boundaries and retains their whitespace', () => {
    const text = `${'a'.repeat(2500)}\n\n${'b'.repeat(2000)}\n${'c'.repeat(2300)}`;
    expect(splitText(text, TEXT_LIMIT)).toEqual([`${'a'.repeat(2500)}\n\n`, `${'b'.repeat(2000)}\n`, 'c'.repeat(2300)]);
    const word = `${'x'.repeat(3000)} ${'y'.repeat(2000)}`;
    expect(splitText(word, TEXT_LIMIT)).toEqual([`${'x'.repeat(3000)} `, 'y'.repeat(2000)]);
  });

  it('never cuts a surrogate pair in fallback or draft truncation', () => {
    const text = `a${'😀'.repeat(30_000)}`;
    expect(splitText(text, TEXT_LIMIT).join('')).toBe(text);
    for (const chunk of splitText(text, TEXT_LIMIT)) expect(() => encodeURIComponent(chunk)).not.toThrow();
    const draft = draftMessage([{ type: 'paragraph', text }]);
    expect(validateTelegramRichMessage(draft)).toMatchObject({ ok: true });
    expect(() => encodeURIComponent(plainBlock(draft.blocks[0]))).not.toThrow();
  });

  it('limits drafts when only the block count exceeds the budget', () => {
    const blocks: TelegramInputRichBlock[] = Array.from({ length: 600 }, (_, index) => ({ type: 'paragraph', text: `p${index}` }));
    const draft = draftMessage(blocks);
    expect(validateTelegramRichMessage(draft)).toMatchObject({ ok: true });
    expect(draft.blocks).toHaveLength(1);
    expect(plainBlock(draft.blocks[0])).toMatch(/^p0/u);
    expect(plainBlock(draft.blocks[0])).toMatch(/p599$/u);
  });
});

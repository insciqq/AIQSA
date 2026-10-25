import { describe, expect, it } from "vitest";
import { TELEGRAM_TEXT_MAX_LENGTH, validateTelegramRichMessage } from "@/tests/support/fakeTelegramBotApi";
import { renderTelegramAnswer, type TelegramAnswerOptions } from "./index";
import { hostileMarkdown } from "./hostile.fixtures";

function valid(markdown: string, options: TelegramAnswerOptions = {}) {
  const result = renderTelegramAnswer(markdown, options);
  for (const message of result.messages) {
    expect(validateTelegramRichMessage(message)).toMatchObject({ ok: true });
    expect(message.skip_entity_detection).toBe(true);
    expect(Object.keys(message).sort()).toEqual(["blocks", "skip_entity_detection"]);
  }
  for (const chunk of result.plainFallback) {
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX_LENGTH);
  }
  if (options.streaming) expect(result.messages).toHaveLength(1);
  return result;
}

describe("renderTelegramAnswer", () => {
  it("renders an explicit representative tree and readable fallback", () => {
    const markdown = [
      '# Answer',
      '**Bold** *soft* ~~old~~ `x` [web](https://example.com) $a+b$ [2] [1] [7]',
      '3. First\n   - Nested\n4. Second',
      '> Quoted',
      '| A | B |\n| --- | --- |\n| one | two |',
      '```ts\nconst x = 1;\n```',
      '$$x^2$$',
      '---'
    ].join('\n\n');
    const result = valid(markdown, { citations: [
      { index: 1, title: 'Note', url: 'https://example.com/note' },
      { index: 2, title: 'Guide', url: 'https://example.com/guide' }
    ] });
    expect(result.messages).toEqual([{ skip_entity_detection: true, blocks: [
      { type: 'heading', size: 1, text: 'Answer' },
      { type: 'paragraph', text: [
        { type: 'bold', text: 'Bold' }, ' ', { type: 'italic', text: 'soft' }, ' ',
        { type: 'strikethrough', text: 'old' }, ' ', { type: 'code', text: 'x' }, ' ',
        { type: 'url', text: 'web', url: 'https://example.com' }, ' ',
        { type: 'mathematical_expression', expression: 'a+b' }, [
          ' ', { type: 'url', text: '[2]', url: 'https://example.com/guide' },
          ' ', { type: 'url', text: '[1]', url: 'https://example.com/note' }, ' [7]'
        ]
      ] },
      { type: 'list', items: [
        { type: '1', value: 3, blocks: [
          { type: 'paragraph', text: 'First' },
          { type: 'list', items: [{ blocks: [{ type: 'paragraph', text: 'Nested' }] }] }
        ] },
        { type: '1', value: 4, blocks: [{ type: 'paragraph', text: 'Second' }] }
      ] },
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'Quoted' }] },
      { type: 'table', is_bordered: true, cells: [
        [{ text: 'A', align: 'left', valign: 'top', is_header: true }, { text: 'B', align: 'left', valign: 'top', is_header: true }],
        [{ text: 'one', align: 'left', valign: 'top' }, { text: 'two', align: 'left', valign: 'top' }]
      ] },
      { type: 'pre', language: 'ts', text: 'const x = 1;\n' },
      { type: 'mathematical_expression', expression: 'x^2' },
      { type: 'divider' }
    ] }]);
    expect(result.plainFallback).toEqual([
      'Answer\n\nBold soft old x web (https://example.com) a+b [2] (https://example.com/guide) [1] (https://example.com/note) [7]\n\n3. First\n\n- Nested\n4. Second\n\nQuoted\n\nA | B\none | two\n\nconst x = 1;\n\n\nx^2\n\n---'
    ]);
  });

  it.each(hostileMarkdown.map((text, index) => [index, text] as const))("keeps hostile input %s within the allowlist and all limits", (_index, markdown) => {
    valid(markdown);
    valid(markdown, { streaming: true });
  });

  it("keeps markup, forbidden destinations, mentions and commands inert", () => {
    const content = '<tg-button>go</tg-button> <details>x</details> <img> [x](tg://user?id=1) [x](javascript:alert(1)) [mail](mailto:a@b.test) @username /unlink #hashtag';
    expect(valid(content).messages[0].blocks).toEqual([{ type: 'paragraph', text: [
      '<tg-button>go</tg-button> <details>x</details> <img> ', '[x](tg://user?id=1)', ' ',
      '[x](javascript:alert(1))', ' ', '[mail](mailto:a@b.test)', ' @username /unlink #hashtag'
    ] }]);
  });

  it("links search citations by their actual indices with no Sources list, leaving other brackets as written", () => {
    const result = valid('[9] then [2] again [9]. [3] [4] [K2] [99]', { citations: [
      { index: 9, title: 'Ninth', url: 'https://example.com/9' },
      { index: 2, title: 'Second', url: 'https://example.com/2' },
      { index: 3, title: 'Unsafe', url: 'javascript:alert(1)' },
      { index: 4, title: 'Telegram', url: 'tg://user?id=1' }
    ] });
    expect(result.messages.flatMap(message => message.blocks).map(block => block.type)).toEqual(['paragraph']);
    expect(result.plainFallback.join('')).toBe(
      '[9] (https://example.com/9) then [2] (https://example.com/2) again [9] (https://example.com/9). [3] [4] [K2] [99]');
  });

  it("does not link coded or linked citations", () => {
    const result = valid('`[1]` [[1]](https://example.com) [1]', { citations: [{ index: 1, title: 'One', url: 'https://example.com/1' }] });
    expect(result.plainFallback.join('')).toBe('[1] [1] (https://example.com) [1] (https://example.com/1)');
  });

  it("renders wide tables as monospace text without dropping cells", () => {
    const row = Array.from({ length: 30 }, (_, index) => `c${index}`);
    const markdown = `${row.join(' | ')}\n${row.map(() => '---').join(' | ')}\n${row.join(' | ')}`;
    const block = valid(markdown).messages[0].blocks[0];
    expect(block.type).toBe('pre');
    if (block.type !== 'pre') throw new Error('Expected pre');
    expect(block.text).toBe([row.join(' | '), row.join(' | ')].join('\n'));
    const narrow = row.slice(0, 20);
    expect(valid(`${narrow.join(' | ')}\n${narrow.map(() => '---').join(' | ')}`).messages[0].blocks[0].type).toBe('table');
  });

  it.each(['ts', 'c++', 'c#', 'objective-c', 'python3'])("allows a short safe code language %s", language => {
    expect(valid(`\`\`\`${language}\nx`, { streaming: true }).messages[0].blocks).toEqual([{ type: 'pre', text: 'x\n', language }]);
  });

  it.each(['<img>', 'x'.repeat(33), 'tg://button'])("drops an unsafe code language %s", language => {
    expect(valid(`\`\`\`${language}\nx`).messages[0].blocks).toEqual([{ type: 'pre', text: 'x\n' }]);
  });

  it("renders every prefix of mixed Markdown as one valid draft", () => {
    const source = '# H\n\n**bold** [link](https://example.com) [K1] $a$ \\(b\\)\n\n> - item\n\n| a | b |\n| --- | --- |\n| x | y |\n\n$$x$$\n\n```ts\nlet x = 1;\n```';
    for (let end = 0; end <= source.length; end++) valid(source.slice(0, end), { streaming: true });
  });

  it("truncates drafts from the start, keeping the latest tail and the complete fallback", () => {
    const source = `old ${'😀 word '.repeat(30_000)}LATEST`;
    const result = valid(source, { streaming: true });
    const block = result.messages[0].blocks[0];
    expect(block.type).toBe('paragraph');
    if (block.type !== 'paragraph') throw new Error('Expected paragraph');
    expect(typeof block.text).toBe('string');
    expect(block.text).toMatch(/^…/u);
    expect(block.text).toMatch(/LATEST$/u);
    expect(source.endsWith(String(block.text).slice(1))).toBe(true);
    expect(result.plainFallback.join('')).toBe(source);
  });

  it("preserves literal overflow beyond the parser bounds", () => {
    const source = 'x'.repeat(610_000);
    expect(valid(source).plainFallback.join('')).toBe(source);
  });
});

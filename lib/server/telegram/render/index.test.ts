import { describe, expect, it } from "vitest";
import type { ThreadArtifactSummary } from "@/lib/contracts/chats";
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
      '**Bold** *soft* ~~old~~ `x` [web](https://example.com) $a+b$ [K2] [K1] [K2]',
      '3. First\n   - Nested\n4. Second',
      '> Quoted',
      '| A | B |\n| --- | --- |\n| one | two |',
      '```ts\nconst x = 1;\n```',
      '$$x^2$$',
      '---'
    ].join('\n\n');
    const result = valid(markdown, {
      citations: [{ handle: 'K1' }, { handle: 'K2' }],
      sources: [
        { handle: 'K1', title: 'Local note' },
        { handle: 'K2', title: 'Guide', url: 'https://example.com/guide' }
      ]
    });
    expect(result.messages).toEqual([{ skip_entity_detection: true, blocks: [
      { type: 'heading', size: 1, text: 'Answer' },
      { type: 'paragraph', text: [
        { type: 'bold', text: 'Bold' }, ' ', { type: 'italic', text: 'soft' }, ' ',
        { type: 'strikethrough', text: 'old' }, ' ', { type: 'code', text: 'x' }, ' ',
        { type: 'url', text: 'web', url: 'https://example.com' }, ' ',
        { type: 'mathematical_expression', expression: 'a+b' }, ' ', '[1]', ' ', '[2]', ' ', '[1]'
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
      { type: 'divider' },
      { type: 'footer', text: [
        { type: 'bold', text: 'Sources' }, '\n[1] ',
        { type: 'url', text: 'Guide', url: 'https://example.com/guide' }, '\n[2] ', 'Local note'
      ] }
    ] }]);
    expect(result.plainFallback).toEqual([
      'Answer\n\nBold soft old x web (https://example.com) a+b [1] [2] [1]\n\n3. First\n\n- Nested\n4. Second\n\nQuoted\n\nA | B\none | two\n\nconst x = 1;\n\n\nx^2\n\n---\n\nSources\n[1] Guide (https://example.com/guide)\n[2] Local note'
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

  it("resolves artifact search citations by their actual indices, and handles by exact identity", () => {
    const artifact: Pick<ThreadArtifactSummary, 'citations' | 'sources'> = {
      citations: [{ index: 9, title: 'Ninth', url: 'https://example.com/9' }, { index: 2, title: 'Second', url: 'https://example.com/2' }],
      sources: [{ rank: 1, title: 'Ninth', url: 'https://example.com/9' }]
    };
    const result = valid('[9] then [2] again [9]. [K9] [K2] [K3] [99]', {
      citations: [...artifact.citations, { handle: 'K9' }, { handle: 'K2', deleted: true }], sources: artifact.sources
    });
    expect(result.plainFallback.join('')).toBe('[1] then [2] again [1]. [3] [K2] [K3] [99]\n\nSources\n[1] Ninth (https://example.com/9)\n[2] Second (https://example.com/2)\n[3] Source K9');
  });

  it("uses literal titles and safe source links without interpreting source markup", () => {
    expect(valid('[K1] [K2]', {
      citations: [{ handle: 'K1', title: '**Title**', url: 'tg://user?id=1' }, { handle: 'K2' }],
      sources: [{ handle: 'K2', title: '<tg-button>Source</tg-button>', url: 'javascript:alert(1)' }]
    }).messages[0].blocks.at(-1)).toEqual({ type: 'footer', text: [
      { type: 'bold', text: 'Sources' }, '\n[1] ', '**Title**', '\n[2] ', '<tg-button>Source</tg-button>'
    ] });
  });

  it("does not resolve coded, escaped or linked handle citations", () => {
    const result = valid('`[K1]` \\[K1] [[K1]](https://example.com) [K1.2]', {
      citations: [{ handle: 'K1' }, { handle: 'K1.2', title: 'Passage' }]
    });
    expect(result.plainFallback.join('')).toBe('[K1] [K1] [K1] (https://example.com) [1]\n\nSources\n[1] Passage');
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

  it("splits large resolved source metadata without loss", () => {
    const title = 'Title '.repeat(12_000);
    const result = valid('[K1]', { citations: [{ handle: 'K1', title, url: 'https://example.com' }] });
    expect(result.messages.length).toBeGreaterThan(1);
    expect(result.plainFallback.join('')).toBe(`[1]\n\nSources\n[1] ${title} (https://example.com)`);
  });

  it("preserves literal overflow beyond the parser bounds", () => {
    const source = 'x'.repeat(610_000);
    expect(valid(source).plainFallback.join('')).toBe(source);
  });
});

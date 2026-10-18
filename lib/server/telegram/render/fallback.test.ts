import { afterEach, expect, it, vi } from "vitest";
import { validateTelegramRichMessage } from "@/tests/support/fakeTelegramBotApi";

afterEach(() => {
  vi.doUnmock('markdown-it');
  vi.resetModules();
});

it('renders literal source when the bounded parser fails, including drafts', async () => {
  vi.doMock('markdown-it', () => ({ default: class { constructor() { throw new Error('Synthetic parser failure'); } } }));
  const { renderTelegramAnswer } = await import('./index');
  const source = '<tg-button> **answer** [link](tg://user?id=1)';
  for (const streaming of [false, true]) {
    const result = renderTelegramAnswer(source, { streaming });
    expect(result.messages).toEqual([{ blocks: [{ type: 'paragraph', text: source }], skip_entity_detection: true }]);
    expect(result.plainFallback).toEqual([source]);
    expect(validateTelegramRichMessage(result.messages[0])).toMatchObject({ ok: true });
  }
});

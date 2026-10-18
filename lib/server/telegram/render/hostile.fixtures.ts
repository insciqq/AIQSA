/** Synthetic inputs only; no Telegram or provider requests. */
export const hostileMarkdown = [
  '<tg-button callback_data="unlink">Click</tg-button>',
  '<details open><summary>x</summary>secret</details>',
  '<img src="https://example.com/pixel" onerror="alert(1)">',
  '![](https://example.com/pixel)',
  '[x](tg://user?id=1)',
  '[x](javascript:alert(1))',
  '[x](java&#115;cript:alert(1))',
  '[x](data:text/html,hello)',
  '[x](mailto:team@example.com)',
  '@username /unlink #hashtag https://example.com',
  `${"> - ".repeat(40)}deep **bold** $x$`,
  `${"**".repeat(40)}deep${"**".repeat(40)}`,
  `| ${Array.from({ length: 30 }, (_, i) => `C${i}`).join(" | ")} |\n| ${"--- | ".repeat(30)}\n| ${"value | ".repeat(30)}`,
  "x".repeat(200_000),
  '```typescript\nconst text = "<tg-button>";',
  '$x^2$ and \\(y\\)\n\n$$\\frac{a}{b}$$\n\n\\[unclosed',
  '[label](https://example.com/unfinished',
  '-\n\n>\n\n#',
  ''
];

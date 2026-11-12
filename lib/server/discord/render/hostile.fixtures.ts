import { hostileMarkdown as telegramHostileMarkdown } from "../../telegram/render/hostile.fixtures";

/** Synthetic inputs only (PRD §12.2); ids are made up and no Discord request is made. */
export const discordHostileMarkdown = [
  ...telegramHostileMarkdown,
  "Ping <@123456789012345678> and <@!123456789012345678> and the role <@&223456789012345678>",
  "Go to <#323456789012345678>, run </ask:423456789012345678>, open <id:customize> or <id:browse>",
  "@everyone @here @EVERYONE @Here hello@everyone.example everyone",
  "Due <t:1700000000:R> and <t:1700000000> <:smile:523456789012345678> <a:wave:623456789012345678>",
  "[open](discord://-/channels/1/2) [x](<javascript:alert(1)>) [y](https://example.com/@everyone) discord://-/users/1",
  "[spoof](https://user:secret@example.com/) <https://example.com/a> ||spoiler|| -# subtext",
  "-# subtext line\n# heading\n> quote\n>>> block quote",
  "```\n<@123456789012345678> @everyone\n```\n`<@&1> @here`",
  "```js\nconsole.log(1)\n``` still code? <@1>",
  "~~~\nfence ``` inside\n~~~",
  "$$\\int_0^1 x\\,dx$$ and $e^{i\\pi}+1=0$ <@1>",
  "<script>alert(1)</script><iframe src=\"https://example.com\"></iframe><!-- <@1> -->",
  "![<@1>](https://example.com/x.png) ![](javascript:alert(1))",
  "Footnote[^note] here.\n\n[^note]: @everyone hidden",
  `${"- ".repeat(40)}deep`,
  `${"> ".repeat(40)}deep <@1>`,
  `| ${Array.from({ length: 30 }, (_, i) => `<@${i + 1}>`).join(" | ")} |\n| ${"--- | ".repeat(30)}\n| ${"@here | ".repeat(30)}`,
  `${"word ".repeat(40_000)}<@1>`,
  "<".repeat(5_000),
  "@".repeat(3_000) + "everyone",
  "`".repeat(3_000),
  "\u200b<\u200b@1> <\u2060@1>"
];

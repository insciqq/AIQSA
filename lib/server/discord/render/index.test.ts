import { describe, expect, it } from "vitest";
import type { ThreadCitation } from "@/lib/contracts/chats";
import { discordHostileMarkdown } from "./hostile.fixtures";
import {
  DISCORD_MESSAGE_MAX_CHARS, DISCORD_STATUS_MAX_CHARS, discordInlineText, formatDiscordStatus, renderDiscordAnswer
} from "./index";

const Z = "​";
const citations: ThreadCitation[] = [
  { index: 1, title: "Note", url: "https://example.com/note" },
  { index: 2, title: "Guide", url: "https://example.com/@guide" },
  { index: 3, title: "Script", url: "javascript:alert(1)" },
  { index: 4, title: "App", url: "discord://-/channels/1/2" },
  { index: 5, title: "Credentials", url: "https://user:pass@example.com/x" },
  { index: 6, title: "Token", url: "https://example.com/x?key=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
  { index: 7, title: "Mail", url: "mailto:team@example.com" }
];

/** The content with fenced blocks and closed inline code spans removed: what Discord reads as markup. */
function outsideCode(content: string): string {
  let out = "";
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^[ ]*(?:> )?[ ]*```/u.test(line)) fenced = !fenced;
    else if (!fenced) {
      let index = 0;
      while (index < line.length) {
        if (line[index] === "\\") {
          out += line.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (line[index] !== "`") {
          out += line[index];
          index += 1;
          continue;
        }
        let end = index;
        while (line[end] === "`") end += 1;
        const run = end - index;
        let close = end;
        for (;;) {
          close = line.indexOf("`", close);
          if (close < 0) break;
          let closeEnd = close;
          while (line[closeEnd] === "`") closeEnd += 1;
          if (closeEnd - close === run) break;
          close = closeEnd;
        }
        if (close < 0) out += line.slice(index, end);
        index = close < 0 ? end : close + run;
      }
    }
    out += "\n";
  }
  return out;
}

/** What the sink guarantees for any input. */
function expectSafe(content: string, limit = DISCORD_MESSAGE_MAX_CHARS) {
  expect(content.length).toBeLessThanOrEqual(limit);
  expect(content).not.toMatch(/<@|<#|@everyone|@here/iu);
  // Outside code, where Discord renders markup: every `<` is broken or opens an address this renderer checked.
  const text = outsideCode(content);
  for (const match of text.matchAll(/</gu)) {
    const rest = text.slice(match.index + 1);
    if (rest.startsWith(Z) || /^\s/u.test(rest)) continue;
    expect(rest).toMatch(/^https?:\/\/[^\s<>]+>/u);
  }
  // The only masked links are citations.
  for (const match of text.matchAll(/\]\(/gu)) {
    if (text[match.index - 1] === "\\") continue;
    expect(text.slice(0, match.index + 1)).toMatch(/\[[1-9]\d*\]$/u);
    expect(text.slice(match.index + 2)).toMatch(/^<https?:\/\//u);
  }
  expect(text).not.toMatch(/(?:javascript|discord|data):\/\//iu);
}

function render(markdown: string, options: { maxChars?: number; reserve?: number } = {}) {
  const result = renderDiscordAnswer({ markdown, citations, ...options });
  expectSafe(result.content, (options.maxChars ?? DISCORD_MESSAGE_MAX_CHARS) - (options.reserve ?? 0));
  return result;
}

describe("renderDiscordAnswer", () => {
  it("writes the Discord subset of a representative answer", () => {
    const markdown = [
      "# Answer",
      "**Bold** *soft* ~~old~~ `x` [web](https://example.com) $a+b$ [2] [1] [9] see https://example.com/a_b.",
      "3. First\n   - Nested\n4. Second",
      "> Quoted\n>\n> again",
      "| A | B |\n| --- | --- |\n| one | two |",
      "```ts\nconst x = 1;\n```",
      "#### Small",
      "---"
    ].join("\n\n");
    expect(render(markdown)).toEqual({
      content: [
        "# Answer",
        "**Bold** *soft* ~~old~~ `x` web (<https://example.com/>) `a+b` [2](<https://example.com/%40guide>) " +
          "[1](<https://example.com/note>) \\[9\\] see <https://example.com/a_b>.",
        "3. First\n   - Nested\n4. Second",
        "> Quoted\n> again",
        "```\nA   | B\n----|----\none | two\n```",
        "```ts\nconst x = 1;\n```",
        "**Small**",
        "───"
      ].join("\n\n"),
      truncated: false,
      redactions: 0
    });
  });

  it("links a citation only to its own safe http(s) source and adds no Sources list", () => {
    const { content } = render("Facts [1] [2] [3] [4] [5] [6] [7] [8].");
    expect(content).toBe(
      "Facts [1](<https://example.com/note>) [2](<https://example.com/%40guide>) " +
      "\\[3\\] \\[4\\] \\[5\\] \\[6\\] \\[7\\] \\[8\\]."
    );
    expect(content).not.toMatch(/sources|example\.com\/x/iu);
    expect(renderDiscordAnswer({ markdown: "No citations [1]." }).content).toBe("No citations \\[1\\].");
  });

  it("writes model links as checked addresses and never as masked links", () => {
    expect(render("[docs](https://example.com/docs) [x](javascript:alert(1)) [y](discord://-/a) [m](mailto:a@example.com)").content)
      .toBe("docs (<https://example.com/docs>) x y m");
    expect(render("[https://example.com/](https://example.com/)").content).toBe("<https://example.com/>");
    expect(render("[spoof](https://user:secret@example.com/)").content).toBe("spoof");
    expect(render("bare discord://-/users/1 and http://example.com/x_(y)), done").content)
      .toBe(`bare discord:${Z}//-/users/1 and <http://example.com/x_%28y%29>), done`);
  });

  it("drops raw HTML, images and footnotes", () => {
    expect(render("<details open><summary>Title</summary>body</details> <!-- hidden --> ok").content).toBe("Titlebody  ok");
    expect(render("Look ![chart](https://example.com/c.png) here").content).toBe("Look  here");
    expect(render("Claim[^a].\n\n[^a]: The note.").content).toBe("Claim.");
  });

  it("escapes Markdown the model wrote as text", () => {
    expect(render("2 \\* 3 \\* 4 and snake\\_case ||x|| \\~~y~~").content).toBe("2 \\* 3 \\* 4 and snake\\_case \\|\\|x\\|\\| \\~\\~y\\~\\~");
    expect(render("line\\\n\\-# subtext\\\n\\# heading\\\n\\> quote\\\n2\\. not a list").content)
      .toBe("line\n\\-# subtext\n\\# heading\n\\> quote\n2\\. not a list");
  });

  it("keeps code verbatim except for mentions and fences that would close it", () => {
    expect(render("```py\nprint('``` <@1> @everyone')\n```").content)
      .toBe(`\`\`\`py\nprint('\`${Z}\`\` <${Z}@1> @${Z}everyone')\n\`\`\``);
    expect(render("```<@1>\nx\n```").content).toBe("```\nx\n```");
    expect(render("Run ``a `b` c`` now").content).toBe("Run `` a `b` c `` now");
  });

  it("turns tables into a monospace block, and wide ones into bullet rows", () => {
    expect(render("| Name | Qty |\n| --- | --: |\n| **Tea** | 2 |").content).toBe("```\nName | Qty\n-----|----\nTea  | 2\n```");
    const wide = render(`| ${Array.from({ length: 8 }, (_, i) => `H${i}`).join(" | ")} |\n|${" --- |".repeat(8)}\n| ${Array.from({ length: 8 }, (_, i) => `**v${i}**`).join(" | ")} |`);
    expect(wide.content).toBe(`- ${Array.from({ length: 8 }, (_, i) => `**H${i}:** **v${i}**`).join(" · ")}`);
    const long = render(`| A | B |\n| --- | --- |\n| ${"x".repeat(60)} | ${"y".repeat(30)} |`);
    expect(long.content).toBe(`- **A:** ${"x".repeat(60)} · **B:** ${"y".repeat(30)}`);
  });

  it("cuts a long answer at a block boundary near 1500 characters", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `${i} ${"word ".repeat(30).trim()}`);
    const result = render(paragraphs.join("\n\n"));
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(1500);
    expect(result.content.length).toBeGreaterThan(1200);
    expect(result.content.endsWith("\n\n…")).toBe(true);
    expect(paragraphs).toContain(result.content.split("\n\n").at(-2));
  });

  it("closes a code fence the cut leaves open", () => {
    const code = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const result = render(`Intro\n\n\`\`\`txt\n${code}\n\`\`\``);
    expect(result.truncated).toBe(true);
    expect(result.content.startsWith("Intro\n\n```txt\nline 0\n")).toBe(true);
    expect(result.content.endsWith("\n```\n…")).toBe(true);
    expect(result.content.match(/```/gu)).toHaveLength(2);
  });

  it("closes a fence inside a quote with the quote's prefix", () => {
    const code = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const result = render(`> \`\`\`\n${code.split("\n").map(line => `> ${line}`).join("\n")}\n> \`\`\``);
    expect(result.content.endsWith("\n> ```\n…")).toBe(true);
  });

  it("keeps the caller's reserve free", () => {
    const markdown = "word ".repeat(380).trim();
    expect(render(markdown).truncated).toBe(false);
    const reserved = render(markdown, { reserve: 200 });
    expect(reserved.truncated).toBe(true);
    expect(reserved.content.length).toBeLessThanOrEqual(1500);
    const small = render(markdown, { maxChars: 300 });
    expect(small.content.length).toBeLessThanOrEqual(300);
    expect(small.content.endsWith("…")).toBe(true);
  });

  it("redacts secrets before rendering and counts them", () => {
    const result = render("Set `DB_PASSWORD=hunter2` and use sk-abcdefghijklmnopqrstuvwxyz123456 now.\n\n```yaml\nenv:\n  - name: API_TOKEN\n    value: plain-value\n```");
    expect(result.content).toBe("Set `DB_PASSWORD=[redacted]` and use \\[redacted\\] now.\n\n```yaml\nenv:\n  - name: API_TOKEN\n    value: [redacted]\n```");
    expect(result.redactions).toBe(3);
  });

  it("renders every hostile input to safe text within the limit", () => {
    for (const markdown of discordHostileMarkdown) {
      const result = render(markdown);
      expect(typeof result.truncated).toBe("boolean");
    }
    const huge = render("x".repeat(200_000));
    expect(huge.truncated).toBe(true);
    expect(huge.content.endsWith("…")).toBe(true);
  });

  it("breaks every mention form whatever the input (property)", () => {
    const fragments = [
      "<@", "<@!", "<@&", "<#", "<t:", "</", "<", "@", "#", "&", "!", "everyone", "here", "EVERYONE", "Here", "123", "`",
      "```", "\n", "\n\n", " ", "[1]", "[2]", "(", ")", "[", "]", "**", "_", "> ", "- ", "1. ", "|", "\\", Z, ">",
      "https://example.com/@here", "<https://example.com>", "[a](https://example.com/@everyone)", "$", "<b>", "-->"
    ];
    let seed = 0x2f6e2b1;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let run = 0; run < 1_500; run += 1) {
      const length = 1 + Math.floor(random() * 80);
      const markdown = Array.from({ length }, () => fragments[Math.floor(random() * fragments.length)]).join("");
      const maxChars = run % 5 === 0 ? 40 + Math.floor(random() * 200) : DISCORD_MESSAGE_MAX_CHARS;
      const { content } = renderDiscordAnswer({ markdown, citations, maxChars });
      expectSafe(content, maxChars);
    }
  });
});

describe("formatDiscordStatus", () => {
  it("writes the clock and the activity within 100 characters", () => {
    expect(formatDiscordStatus(72_400, "Searching the web").content).toBe("Working · 1:12 — Searching the web");
    expect(formatDiscordStatus(5_000).content).toBe("Working · 0:05");
    expect(formatDiscordStatus(3_725_000, "  ").content).toBe("Working · 62:05");
    const long = formatDiscordStatus(9_000, `Reading ${"page ".repeat(60)}`).content;
    expect(long.length).toBe(DISCORD_STATUS_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("redacts and neutralizes the activity", () => {
    const status = formatDiscordStatus(1_000, "Running\nkubectl with TOKEN=abc123secret for <@1> @here **x**");
    expect(status).toEqual({
      content: `Working · 0:01 — Running kubectl with TOKEN=\\[redacted\\] for <${Z}@1> @${Z}here \\*\\*x\\*\\*`,
      redactions: 1
    });
  });

  it("bounds any one-line text", () => {
    expect(discordInlineText("a ghp_abcdefghijklmnopqrstuvwxyz0123456789 b", 100)).toEqual({ content: "a \\[redacted\\] b", redactions: 1 });
    expect(discordInlineText("x".repeat(50), 10).content).toBe(`${"x".repeat(9)}…`);
  });
});

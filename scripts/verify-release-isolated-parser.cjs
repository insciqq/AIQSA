"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

// The check must work with a read-only root and leave no compiler cache in the image.
process.env.TSX_DISABLE_CACHE = "1";

async function main() {
  assert.equal(process.platform, "linux", "isolated_parser_release_platform_invalid");
  assert.notEqual(process.getuid(), 0, "isolated_parser_release_requires_nonroot");
  const root = path.resolve(__dirname, "..");
  // The application process runs from Next's standalone directory. The parser
  // child must still find the shipped source, SheetJS, tsx, prlimit and /proc,
  // using synthetic content only.
  process.chdir(path.join(root, "runtime"));
  require("tsx/cjs/api").register();
  const { utils, write } = require("xlsx");
  const {
    extractHtmlTextInIsolation,
    extractWebPageInIsolation,
    parseSpreadsheetInIsolation
  } = require("../lib/server/parsing/isolatedParser.ts");

  const csv = await parseSpreadsheetInIsolation({
    bytes: Buffer.from("Region,Revenue\nNorth,10\n"),
    format: "csv",
    mediaType: "text/csv"
  });
  assert.equal(csv.text, "Region\tRevenue\nNorth\t10", "isolated_parser_release_csv_invalid");

  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([["Region", "Revenue"], ["North", 10]]), "Sales");
  const xlsx = await parseSpreadsheetInIsolation({
    bytes: write(book, { bookType: "xlsx", compression: true, type: "buffer" }),
    format: "xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  assert.equal(xlsx.text, "Region\tRevenue\nNorth\t10", "isolated_parser_release_xlsx_invalid");

  const html = await extractHtmlTextInIsolation({
    bytes: Buffer.from("<h1>Release</h1><script>probe()</script><p>check</p>"),
    maxChars: 100
  });
  assert.deepEqual(
    html,
    { kind: "html", text: "Release\n\ncheck", truncated: false },
    "isolated_parser_release_html_invalid"
  );

  // fetch_url pages need parse5, linkedom and Readability in the pruned tools image.
  const page = await extractWebPageInIsolation({
    body: Buffer.from("<title>Release</title><script>probe()</script><article><h1>Page</h1><p>Check.</p></article>"),
    contentType: "text/html",
    finalUrl: "https://release.invalid/",
    maxCharacters: 100
  });
  assert.deepEqual(
    page,
    { kind: "html", text: "## Page\n\nCheck.", title: "Release", truncated: false },
    "isolated_parser_release_page_invalid"
  );
  console.log(JSON.stringify({ architecture: process.arch, csv: true, html: true, page: true, xlsx: true }));
}

main().catch(() => {
  console.error("isolated_parser_release_check_failed");
  process.exitCode = 1;
});

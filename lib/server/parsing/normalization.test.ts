import { normalizeDoclingResponse, normalizeTikaResponse } from "./normalization";

describe("Docling normalization", () => {
  it("preserves Cyrillic OCR text and its page attribution", () => {
    const parsed = normalizeDoclingResponse({
      document: {
        json_content: {
          body: { children: [{ $ref: "#/texts/0" }, { $ref: "#/texts/1" }] },
          pages: {
            "1": { page_no: 1 },
            "2": { page_no: 2 }
          },
          schema_name: "DoclingDocument",
          texts: [
            {
              content_layer: "body",
              label: "paragraph",
              prov: [{
                bbox: { b: 18, coord_origin: "TOPLEFT", l: 2, r: 20, t: 4 },
                page_no: 1
              }],
              text: "Русский текст для поиска"
            },
            {
              content_layer: "body",
              label: "paragraph",
              prov: [{ page_no: 2 }],
              text: "English text and номер 2026"
            }
          ]
        }
      },
      status: "success"
    }, "application/pdf");

    expect(parsed.text).toBe("Русский текст для поиска\n\nEnglish text and номер 2026");
    expect(parsed.blocks).toMatchObject([
      {
        boundingBoxes: [{
          bottom: 18,
          coordinateOrigin: "top_left",
          left: 2,
          page: 1,
          right: 20,
          top: 4
        }],
        page: 1,
        text: "Русский текст для поиска"
      },
      { page: 2, text: "English text and номер 2026" }
    ]);
  });

  it("preserves reading order, page anchors, heading paths, and tables", () => {
    const parsed = normalizeDoclingResponse({
      document: {
        json_content: {
          body: {
            children: [
              { $ref: "#/texts/0" },
              { $ref: "#/texts/1" },
              { $ref: "#/groups/0" },
              { $ref: "#/tables/0" },
              { $ref: "#/pictures/0" }
            ]
          },
          groups: [{
            children: [{ $ref: "#/texts/2" }, { $ref: "#/texts/3" }],
            content_layer: "body"
          }],
          pages: {
            "1": { page_no: 1 },
            "2": { page_no: 2 }
          },
          pictures: [{}],
          schema_name: "DoclingDocument",
          tables: [{
            content_layer: "body",
            data: {
              table_cells: [
                {
                  end_col_offset_idx: 1,
                  end_row_offset_idx: 1,
                  start_col_offset_idx: 0,
                  start_row_offset_idx: 0,
                  text: "Name"
                },
                {
                  end_col_offset_idx: 2,
                  end_row_offset_idx: 1,
                  start_col_offset_idx: 1,
                  start_row_offset_idx: 0,
                  text: "Value"
                },
                {
                  end_col_offset_idx: 1,
                  end_row_offset_idx: 2,
                  start_col_offset_idx: 0,
                  start_row_offset_idx: 1,
                  text: "alpha"
                },
                {
                  end_col_offset_idx: 2,
                  end_row_offset_idx: 2,
                  start_col_offset_idx: 1,
                  start_row_offset_idx: 1,
                  text: "1"
                }
              ]
            },
            prov: [{ page_no: 2 }]
          }],
          texts: [
            { content_layer: "body", label: "title", prov: [{ page_no: 1 }], text: "Guide" },
            { content_layer: "body", label: "paragraph", prov: [{ page_no: 1 }], text: "Opening" },
            { content_layer: "body", label: "section_header", level: 1, prov: [{ page_no: 2 }], text: "Details" },
            { content_layer: "body", label: "paragraph", prov: [{ page_no: 2 }], text: "Second page" }
          ]
        }
      },
      status: "success"
    }, "application/pdf");

    expect(parsed).toMatchObject({
      engine: "docling",
      mediaType: "application/pdf",
      pageCount: 2,
      status: "complete"
    });
    expect(parsed.blocks.slice(0, 5)).toMatchObject([
      { headingPath: ["Guide"], index: 0, isTable: false, page: 1, text: "Guide" },
      { headingPath: ["Guide"], index: 1, isTable: false, page: 1, text: "Opening" },
      { headingPath: ["Guide", "Details"], index: 2, isTable: false, page: 2, text: "Details" },
      { headingPath: ["Guide", "Details"], index: 3, isTable: false, page: 2, text: "Second page" },
      { headingPath: ["Guide", "Details"], index: 4, isTable: true, page: 2, text: "Name\tValue\nalpha\t1" }
    ]);
    expect(parsed.blocks[4]?.table).toMatchObject({ columnCount: 2, rowCount: 2 });
    expect(parsed.blocks[5]).toMatchObject({
      assetIds: ["docling-picture-0"],
      type: "image"
    });
    expect(parsed.assets).toMatchObject([{ id: "docling-picture-0", page: 1 }]);
  });

  it("rejects a success envelope without a Docling document", () => {
    expect(() => normalizeDoclingResponse({
      document: { json_content: { schema_name: "unknown" } },
      status: "success"
    }, "application/pdf")).toThrow(expect.objectContaining({ code: "parser_invalid_output" }));
  });

  it("accepts every reference collection emitted by pinned Docling documents", () => {
    const parsed = normalizeDoclingResponse({
      document: {
        json_content: {
          body: {
            children: [
              { $ref: "#/texts/0" },
              { $ref: "#/key_value_items/0" },
              { $ref: "#/form_items/0" },
              { $ref: "#/field_regions/0" }
            ]
          },
          field_items: [{
            children: [{ $ref: "#/texts/1" }],
            content_layer: "body"
          }],
          field_regions: [{
            children: [{ $ref: "#/field_items/0" }],
            content_layer: "body"
          }],
          form_items: [{
            content_layer: "body",
            graph: { cells: [], links: [] },
            prov: [{ page_no: 2 }]
          }],
          groups: [],
          key_value_items: [{
            content_layer: "body",
            graph: { cells: [], links: [] },
            prov: [{ page_no: 1 }]
          }],
          pictures: [],
          schema_name: "DoclingDocument",
          tables: [],
          texts: [
            { content_layer: "body", label: "paragraph", prov: [{ page_no: 1 }], text: "Opening" },
            { content_layer: "body", label: "field_value", prov: [{ page_no: 2 }], text: "Field value" }
          ]
        }
      },
      status: "success"
    }, "application/pdf");

    expect(parsed.text).toBe("Opening\n\nField value");
    expect(parsed.blocks).toHaveLength(2);
  });

  it.each([
    "#/unknown_items/0",
    "#/form_items/1"
  ])("rejects malformed Docling reference %s", ($ref) => {
    expect(() => normalizeDoclingResponse({
      document: {
        json_content: {
          body: { children: [{ $ref }] },
          form_items: [{ graph: { cells: [], links: [] } }],
          schema_name: "DoclingDocument"
        }
      },
      status: "success"
    }, "application/pdf")).toThrow(expect.objectContaining({ code: "parser_invalid_output" }));
  });
});

describe("Tika normalization", () => {
  it("uses XHTML page containers and retains heading/table structure", () => {
    const parsed = normalizeTikaResponse([{
      "Content-Type": "application/msword",
      "X-TIKA:content": `
        <html><body>
          <div class="page"><h1>Sample guide</h1><p>First page</p></div>
          <div class="page"><h2>Details</h2><p>Second page</p>
            <table><tr><th>Key</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>
          </div>
        </body></html>`
    }], "application/msword");

    expect(parsed.pageCount).toBe(2);
    expect(parsed.blocks).toMatchObject([
      { headingPath: ["Sample guide"], index: 0, isTable: false, page: 1, text: "Sample guide" },
      { headingPath: ["Sample guide"], index: 1, isTable: false, page: 1, text: "First page" },
      { headingPath: ["Sample guide", "Details"], index: 2, isTable: false, page: 2, text: "Details" },
      { headingPath: ["Sample guide", "Details"], index: 3, isTable: false, page: 2, text: "Second page" },
      { headingPath: ["Sample guide", "Details"], index: 4, isTable: true, page: 2, text: "Key\tValue\na\t1" }
    ]);
    expect(parsed.blocks[4]?.table).toMatchObject({ columnCount: 2, rowCount: 2 });
  });

  it("falls back to one page for Tika XHTML without page containers", () => {
    const parsed = normalizeTikaResponse([{
      "X-TIKA:content": "<html><body><p>Only page</p></body></html>"
    }], "application/rtf");
    expect(parsed.pageCount).toBe(1);
    expect(parsed.blocks[0]).toMatchObject({ page: 1, text: "Only page" });
  });
});

import { describe, expect, it } from "vitest";
import { ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import { snapshotToolLoopJson, toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";
import { ARTIFACT_RESULT_PATHS, artifactRenderNotes, artifactToolResult, decodeArtifactVersionReport, type ArtifactVersionReport } from "./toolResult";
import { ARTIFACT_UNPACK_SKIPPED_FILES } from "./unpack";

const call = { id: "call", name: "create_artifact" };
const version = (files: Array<{ path: string; byteSize: number; group?: "authored" | "vendored" }>, report?: ArtifactVersionReport) => ({
  artifactId: "artifact", id: "version", versionNumber: 2, kind: "html", title: "Site", entrypoint: "index.html", manifest: { files },
  ...(report ? { report } : {})
});
const receipt = { artifact_id: "artifact", version_id: "version", version_number: 2, kind: "html", title: "Site", entrypoint: "index.html" };

describe("artifact tool results", () => {
  it("keeps the compact receipt for versions that unpacked nothing", () => {
    const result = artifactToolResult(call, version([{ path: "index.html", byteSize: 10 }, { path: "_vendor/abc/lib.js", byteSize: 5, group: "vendored" }]));
    expect(result).toEqual({ callId: "call", name: "create_artifact", status: "complete",
      content: [{ type: "json", value: { ...receipt, byte_size: 15 } }],
      artifacts: [{ type: "artifact", data: { artifactType: "generated_artifact", payload: { ...receipt, byte_size: 15 } } }] });
  });

  it("tells the model what an archive became, with a bounded sorted path list, and keeps the card compact", () => {
    const files = Array.from({ length: ARTIFACT_RESULT_PATHS + 20 }, (_, index) => ({ path: `p/${String(index).padStart(3, "0")}.html`, byteSize: 1 }));
    const report = { unpacked: { rootFolder: "site", skippedEntries: 4, skippedFiles: ["site/.nojekyll"] } };
    const vendored = { path: "_vendor/abc/lib.js", byteSize: 1, group: "vendored" as const };
    const result = artifactToolResult(call, version([...[...files].reverse(), vendored], report));
    const value = (result.content[0] as { value: Record<string, unknown> }).value;
    expect(value).toEqual({ ...receipt, byte_size: files.length + 1, unpacked: {
      root_folder: "site", skipped_entries: 4, skipped_files: ["site/.nojekyll"], file_count: files.length,
      paths: files.slice(0, ARTIFACT_RESULT_PATHS).map(file => file.path), more_paths: 20
    } });
    expect(result.artifacts).toEqual([{ type: "artifact", data: { artifactType: "generated_artifact", payload: { ...receipt, byte_size: files.length + 1 } } }]);
    const small = artifactToolResult(call, version([{ path: "index.html", byteSize: 1 }], { unpacked: { rootFolder: null, skippedEntries: 0, skippedFiles: [] } }));
    expect((small.content[0] as { value: Record<string, unknown> }).value.unpacked).toEqual({ root_folder: null, skipped_entries: 0, file_count: 1, paths: ["index.html"] });
  });

  it("reports render notes with a repair hint and keeps the card compact", () => {
    const renderNotes = { removedLinks: [{ page: "index.html", rel: "preload", href: "/app.js" }], missingLinks: [{ page: "index.html", href: "about.html", path: "about.html" }],
      invalidPages: [{ page: "docs/bad.html", code: "artifact_element_unsupported" }], omitted: 3, unvalidatedPages: 0 };
    const result = artifactToolResult(call, version([{ path: "index.html", byteSize: 1 }], { renderNotes }));
    const value = (result.content[0] as { value: Record<string, unknown> }).value;
    expect(value.render_notes).toEqual({ removed_links: renderNotes.removedLinks, missing_links: renderNotes.missingLinks, invalid_pages: renderNotes.invalidPages, omitted: 3,
      hint: expect.stringMatching(/invalid_pages.*fix it with edits.*missing_links/u) });
    expect(value).not.toHaveProperty("unpacked");
    expect(result.artifacts).toEqual([{ type: "artifact", data: { artifactType: "generated_artifact", payload: { ...receipt, byte_size: 1 } } }]);
    // Only non-empty lists appear; removed service links alone need no repair.
    const removedOnly = artifactToolResult(call, version([{ path: "index.html", byteSize: 1 }], { renderNotes: { ...renderNotes, missingLinks: [], invalidPages: [], omitted: 0 } }));
    expect((removedOnly.content[0] as { value: Record<string, unknown> }).value.render_notes).toEqual({ removed_links: renderNotes.removedLinks });
  });

  it("reports only the findings of a build that has any", () => {
    const clean = { pages: ["index.html", "about.html"], removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, unvalidatedPages: 0 };
    expect(artifactRenderNotes(clean)).toBeUndefined();
    expect(artifactRenderNotes({ ...clean, omitted: 1 })).toEqual({ removedLinks: [], missingLinks: [], invalidPages: [], omitted: 1, unvalidatedPages: 0 });
    const invalidPages = [{ page: "about.html", code: "artifact_element_unsupported" }];
    expect(artifactRenderNotes({ ...clean, invalidPages })).toEqual({ removedLinks: [], missingLinks: [], invalidPages, omitted: 0, unvalidatedPages: 0 });
    expect(artifactRenderNotes({ ...clean, unvalidatedPages: 7 })).toEqual({ removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, unvalidatedPages: 7 });
  });

  it("stays within the persisted result bound at the largest report", () => {
    const longPath = (index: number) => `${String(index).padStart(3, "0")}/${"a".repeat(ARTIFACT_LIMITS.maxPathBytes - 9)}.html`;
    const files = Array.from({ length: ARTIFACT_LIMITS.maxBundleFiles }, (_, index) => ({ path: longPath(index), byteSize: 1 }));
    const note = "n".repeat(256);
    const report: ArtifactVersionReport = {
      unpacked: { rootFolder: "r".repeat(512), skippedEntries: 2_000, skippedFiles: Array.from({ length: ARTIFACT_UNPACK_SKIPPED_FILES }, () => "s".repeat(512)) },
      renderNotes: { removedLinks: Array.from({ length: 32 }, () => ({ page: note, rel: note, href: note })),
        missingLinks: Array.from({ length: 32 }, () => ({ page: note, href: note, path: note })),
        invalidPages: Array.from({ length: 32 }, () => ({ page: note, code: note })), omitted: 99, unvalidatedPages: ARTIFACT_LIMITS.maxBundleFiles - 1 }
    };
    expect(decodeArtifactVersionReport({ report })).toEqual(report);
    const result = artifactToolResult(call, version(files, report));
    expect(snapshotToolLoopJson(result, toolLoopPersistenceLimits.resultBytes)).not.toBeNull();
  });

  it("reads back only a well-formed stored report", () => {
    const unpacked = { rootFolder: null, skippedEntries: 1, skippedFiles: [".nojekyll"] };
    expect(decodeArtifactVersionReport({ files: [], report: { unpacked, extra: "ignored" } })).toEqual({ unpacked });
    expect(decodeArtifactVersionReport({ files: [] })).toBeUndefined();
    for (const report of [null, [], { unpacked: { ...unpacked, skippedEntries: -1 } }, { unpacked: { ...unpacked, rootFolder: 3 } },
      { unpacked: { ...unpacked, skippedFiles: Array.from({ length: ARTIFACT_UNPACK_SKIPPED_FILES + 1 }, () => "x") } },
      { renderNotes: { removedLinks: [{ page: "a", rel: "preload" }], missingLinks: [], invalidPages: [], omitted: 0 } },
      { renderNotes: { removedLinks: [], missingLinks: Array.from({ length: 33 }, () => ({ page: "a", href: "b", path: "c" })), invalidPages: [], omitted: 0 } },
      { renderNotes: { removedLinks: [], missingLinks: [], omitted: 0 } },
      { renderNotes: { removedLinks: [], missingLinks: [], invalidPages: [{ page: "a", code: "x".repeat(257) }], omitted: 0 } },
      { renderNotes: { removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, unvalidatedPages: -1 } },
      { renderNotes: { removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, unvalidatedPages: "2" } },
      { renderNotes: { removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, unvalidatedPages: ARTIFACT_LIMITS.maxBundleFiles + 1 } }]) {
      expect(decodeArtifactVersionReport({ report })).toBeUndefined();
    }
    expect(decodeArtifactVersionReport({ report: { renderNotes: { removedLinks: [{ page: "a", rel: "preload", href: "b", extra: 1 }], missingLinks: [],
      invalidPages: [{ page: "c", code: "artifact_element_unsupported" }], omitted: 2 } } }))
      .toEqual({ renderNotes: { removedLinks: [{ page: "a", rel: "preload", href: "b" }], missingLinks: [], invalidPages: [{ page: "c", code: "artifact_element_unsupported" }], omitted: 2, unvalidatedPages: 0 } });
    expect(decodeArtifactVersionReport({ report: { renderNotes: { removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, unvalidatedPages: 3 } } }))
      .toEqual({ renderNotes: { removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, unvalidatedPages: 3 } });
  });

  it("reports pages left for validation when opened, with a hint, and reads the same receipt back", () => {
    const renderNotes = { removedLinks: [], missingLinks: [], invalidPages: [], omitted: 0, unvalidatedPages: 12 };
    const result = artifactToolResult(call, version([{ path: "index.html", byteSize: 1 }], { renderNotes }));
    expect((result.content[0] as { value: Record<string, unknown> }).value.render_notes).toEqual({ unvalidated_pages: 12,
      hint: expect.stringMatching(/unvalidated_pages.*checked when opened/u) });
    const stored = decodeArtifactVersionReport(JSON.parse(JSON.stringify({ report: { renderNotes } })));
    expect(artifactToolResult(call, version([{ path: "index.html", byteSize: 1 }], stored))).toEqual(result);
  });
});

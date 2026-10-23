// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ApplyPatchError, applyChunks, parsePatch, type PatchHunk } from "./applyPatchFormat";

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

function update(text: string): Extract<PatchHunk, { kind: "update" }> {
  const [hunk] = parsePatch(text);
  if (hunk?.kind !== "update") throw new Error("expected update");
  return hunk;
}

function failure(run: () => unknown): ApplyPatchError {
  try { run(); } catch (error) { if (error instanceof ApplyPatchError) return error; throw error; }
  throw new Error("expected ApplyPatchError");
}

describe("apply_patch parsing", () => {
  it("parses add, delete and update with a move, as Codex does", () => {
    expect(parsePatch(patch(
      "*** Add File: path/add.py", "+abc", "+def",
      "*** Delete File: path/delete.py",
      "*** Update File: path/update.py", "*** Move to: path/update2.py", "@@ def f():", "-    pass", "+    return 123"
    ))).toEqual([
      { contents: "abc\ndef\n", kind: "add", line: 2, path: "path/add.py" },
      { kind: "delete", line: 5, path: "path/delete.py" },
      { chunks: [{ context: "def f():", endOfFile: false, line: 8, ops: [{ kind: "remove", text: "    pass" }, { kind: "add", text: "    return 123" }] }],
        kind: "update", line: 6, movePath: "path/update2.py", path: "path/update.py" }
    ]);
  });

  it("accepts a heredoc wrapper, surrounding whitespace and CRLF line ends", () => {
    expect(parsePatch(`<<'EOF'\n${patch("*** Add File: a.txt", "+x")}\nEOF`)).toEqual([{ contents: "x\n", kind: "add", line: 3, path: "a.txt" }]);
    expect(parsePatch(`  ${patch("*** Delete File: a.txt").replaceAll("\n", "\r\n")}\r\n`)).toEqual([{ kind: "delete", line: 2, path: "a.txt" }]);
  });

  it("allows the first hunk of an update to omit @@ and treats a bare blank line as context", () => {
    expect(update(patch("*** Update File: a.txt", " one", "", "-two", "+three")).chunks[0]!.ops).toEqual([
      { kind: "context", text: "one" }, { kind: "context", text: "" }, { kind: "remove", text: "two" }, { kind: "add", text: "three" }
    ]);
  });

  it.each([
    ["", "Patch line 1: the patch must start with '*** Begin Patch'"],
    ["*** Begin Patch\n*** Add File: a\n+x", "Patch line 3: the patch must end with '*** End Patch' on its own line."],
    [patch(), "Patch line 2: the patch has no file sections."],
    [patch("*** Edit File: a.txt"), "Patch line 2: \"*** Edit File: a.txt\" is not a valid file header. Expected '*** Add File: <path>'"],
    [patch("*** Add File:"), "Patch line 2: '*** Add File:' needs a file path after it."],
    [patch("*** Update File: a.txt"), "Patch line 2: '*** Update File: a.txt' has no changes."],
    [patch("*** Update File: a.txt", "x line"), "Patch line 3: unexpected line \"x line\" in a hunk. Every hunk line starts with ' '"],
    [patch("*** Update File: a.txt", "@@", "-a", "bad"), "Patch line 5: expected a hunk starting with '@@' (optionally '@@ <line to find>'), found \"bad\"."],
    [patch("*** Update File: a.txt", "@@", "*** End of File"), "Patch line 3: the hunk has no lines."]
  ])("refuses %j with the line and the expected form", (text, message) => {
    const error = failure(() => parsePatch(text));
    expect(error.code).toBe("apply_patch_invalid");
    expect(error.message).toContain(message);
  });

  it("requires @@ before a second hunk", () => {
    const parsed = update(patch("*** Update File: a.txt", "@@ first", "-a", "+b", "@@", "-c", "+d"));
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunks[1]).toMatchObject({ line: 6 });
  });
});

describe("apply_patch matching", () => {
  it("replaces lines found by context, keeping the file's line endings and a final newline", () => {
    const hunk = update(patch("*** Update File: a.py", "@@ def greet():", "-    print('Hi')", "+    print('Hello')"));
    expect(applyChunks("x = 1\ndef greet():\n    print('Hi')\n", hunk.chunks, "a.py")).toBe("x = 1\ndef greet():\n    print('Hello')\n");
    expect(applyChunks("def greet():\r\n    print('Hi')", hunk.chunks, "a.py")).toBe("def greet():\r\n    print('Hello')\r\n");
  });

  it("matches loosely on whitespace and Unicode punctuation but keeps the file's context text", () => {
    const hunk = update(patch("*** Update File: a.txt", "@@", " say \"hi\" - now", "-old", "+new"));
    expect(applyChunks("  say \u201Chi\u201D \u2014 now  \nold\n", hunk.chunks, "a.txt")).toBe("  say \u201Chi\u201D \u2014 now  \nnew\n");
  });

  it("applies several hunks in order and anchors an End of File hunk to the end", () => {
    const hunk = update(patch("*** Update File: a.txt", "@@", "-x", "+X", "@@", "-x", "+Y", "*** End of File"));
    expect(applyChunks("x\nx\nmid\nx\n", hunk.chunks, "a.txt")).toBe("X\nx\nmid\nY\n");
  });

  it("inserts an addition-only hunk after its @@ line, or at the end without one", () => {
    expect(applyChunks("class A:\n    pass\n", update(patch("*** Update File: a.py", "@@ class A:", "+    x = 1")).chunks, "a.py"))
      .toBe("class A:\n    x = 1\n    pass\n");
    expect(applyChunks("a\n", update(patch("*** Update File: a.txt", "@@", "+b")).chunks, "a.txt")).toBe("a\nb\n");
  });

  it("retries without a trailing blank context line", () => {
    expect(applyChunks("a\nb", update(patch("*** Update File: a.txt", "@@", " a", "-b", "+c", "")).chunks, "a.txt")).toBe("a\nc\n");
  });

  it("names the hunk and the expected lines when they are not found", () => {
    const error = failure(() => applyChunks("a\nb\n", update(patch("*** Update File: a.txt", "@@", " a", "-zzz", "+c")).chunks, "/workspace/project/a.txt"));
    expect(error.code).toBe("apply_patch_mismatch");
    expect(error.message).toBe("/workspace/project/a.txt: the context and removed lines of the hunk at patch line 3 were not found. Expected these lines:\na\nzzz\nRead the file again and copy these lines exactly as they are now.");
    expect(failure(() => applyChunks("a\n", update(patch("*** Update File: a.txt", "@@ missing", "-a", "+b")).chunks, "a.txt")).message)
      .toContain("the '@@ missing' line of the hunk at patch line 3 was not found");
  });
});

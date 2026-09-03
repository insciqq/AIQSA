import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { tarEntryBlocks, tarGzipStream, tarHeader } from "./tarArchive";

const decoder = new TextDecoder();

function field(header: Uint8Array, offset: number, length: number): string {
  return decoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/s, "");
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

describe("tar archive writer", () => {
  it("writes a ustar header whose checksum matches its bytes", () => {
    const header = tarHeader("archived/release-2026-09-01.md", 7, new Date("2026-09-01T00:00:00Z"));
    expect(header.length).toBe(512);
    expect(field(header, 0, 100)).toBe("archived/release-2026-09-01.md");
    expect(field(header, 124, 12)).toBe("00000000007");
    expect(field(header, 257, 6)).toBe("ustar");
    expect(field(header, 156, 1)).toBe("0");
    const stored = parseInt(field(header, 148, 8).trim(), 8);
    const recomputed = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
      0
    );
    expect(stored).toBe(recomputed);
  });

  it("splits long paths into prefix and name", () => {
    const directory = "d".repeat(90);
    const header = tarHeader(`${directory}/${"n".repeat(60)}.md`, 0, new Date(0));
    expect(field(header, 345, 155)).toBe(directory);
    expect(field(header, 0, 100)).toBe(`${"n".repeat(60)}.md`);
  });

  it("pads entries to 512-byte blocks and ends with two zero blocks", async () => {
    const blocks = tarEntryBlocks({ content: "hello", mtime: new Date(0), path: "a.txt" });
    expect(blocks.map((block) => block.length)).toEqual([512, 5, 507]);
    const archive = gunzipSync(await collect(tarGzipStream((async function* entries() {
      yield { content: "hello", mtime: new Date(0), path: "a.txt" };
      yield { content: new Uint8Array(512), mtime: new Date(0), path: "b.bin" };
    })())));
    expect(archive.length).toBe(512 + 512 + 512 + 512 + 1024);
    expect(decoder.decode(archive.subarray(512, 517))).toBe("hello");
    expect(archive.subarray(archive.length - 1024).every((byte) => byte === 0)).toBe(true);
  });
});

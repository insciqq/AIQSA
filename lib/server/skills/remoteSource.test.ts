import { describe, expect, it, vi } from "vitest";
import { SKILL_ARCHIVE_MAX_BYTES, SKILL_FILE_MAX_BYTES } from "../../contracts/skills";
import { writeZip } from "../artifacts/zip";
import { createMcpSafeFetch } from "../mcp/safeFetch";
import { createRemoteSkillSourceFetcher } from "./remoteSource";

const commit = "a".repeat(40);
const markdown = Buffer.from("---\nname: example\ndescription: Read companion references.\n---\nUse references/guide.txt.\n");
const file = (path: string, bytes: Buffer | string) => ({ path, bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });
const zip = (...files: ReturnType<typeof file>[]) => writeZip(files);
const response = (bytes: Buffer) => new Response(new Uint8Array(bytes));
const symlink = (archive: Buffer, path: string) => {
  const result = Buffer.from(archive);
  let cursor = result.readUInt32LE(result.length - 6);
  while (result.readUInt32LE(cursor) === 0x02014b50) {
    const size = result.readUInt16LE(cursor + 28);
    if (result.toString("utf8", cursor + 46, cursor + 46 + size) === path) {
      result.writeUInt16LE((3 << 8) | 20, cursor + 4);
      result.writeUInt32LE((0o120777 << 16) >>> 0, cursor + 38);
      return result;
    }
    cursor += 46 + size + result.readUInt16LE(cursor + 30) + result.readUInt16LE(cursor + 32);
  }
  throw new Error("fixture_member_missing");
};

describe("remote Skill source fetching", () => {
  it.each([
    "git@github.com:owner/repo.git", "ssh://github.com/owner/repo", "http://example.com/SKILL.md",
    "https://user:secret@example.com/SKILL.md", "https://example.com/SKILL.md?token=secret",
    "https://example.com/SKILL.md#part", "https://example.com:8443/SKILL.md", "https://example.com/readme.md",
    "https://github.com/owner/repo/issues/1", "https://gitlab.com/group/repo/-/blob/main/README.md",
    "https://gitlab.com/group/repo/-/tree/main?ref_type=heads&token=secret"
  ])("rejects unsupported input before I/O (%s)", async (url) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(createRemoteSkillSourceFetcher({ fetch })(url)).rejects.toThrow(/^skill_source_/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("imports a standalone markdown document and binds its exact bytes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(markdown));
    const source = await createRemoteSkillSourceFetcher({ fetch })("https://example.com/SKILL.md");
    expect(source.source).toEqual({ kind: "markdown", url: "https://example.com/SKILL.md", revision: source.fingerprint });
    expect(source.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(source.candidates).toMatchObject([{ path: ".", candidate: { name: "example", bundle: { fileCount: 0 } } }]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "follow", credentials: "omit", cache: "no-store" });
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });

  it("discovers nested ZIP bundles with companion binaries, per-Skill validation and ignored files", async () => {
    const archive = zip(file("library/demo/SKILL.md", markdown), file("library/demo/assets/a.bin", Buffer.from([0, 255])),
      file("library/broken/SKILL.md", "no frontmatter"), file("README.txt", "outside"));
    const source = await createRemoteSkillSourceFetcher({ fetch: vi.fn(async () => response(archive)) })("https://example.com/skills.zip");
    expect(source.ignoredFiles).toBe(1);
    expect(source.candidates).toMatchObject([
      { path: "library/demo", candidate: { bundle: { fileCount: 1, files: [{ path: "assets/a.bin", bytes: Buffer.from([0, 255]) }] } } },
      { path: "library/broken", candidate: { error: { code: "skill_frontmatter_required" } } }
    ]);
  });

  it("pins GitHub branch downloads and preserves the parent bundle of a blob link", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/commits/main")) {
        expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.github.sha");
        return new Response(commit);
      }
      if (url.includes("/commits/")) return new Response(null, { status: 422 });
      expect(url).toBe(`https://github.com/owner/repo/archive/${commit}.zip`);
      expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.github+json");
      return response(zip(file("repo-changing-wrapper/skills/demo/SKILL.md", markdown),
        file("repo-changing-wrapper/skills/demo/references/guide.txt", "procedure"), file("repo-changing-wrapper/other/SKILL.md", markdown)));
    });
    const source = await createRemoteSkillSourceFetcher({ fetch })("https://github.com/owner/repo/blob/main/skills/demo/SKILL.md");
    expect(source.source).toMatchObject({ kind: "github", revision: commit });
    expect(source.candidates).toMatchObject([{ path: "skills/demo", candidate: { bundle: { fileCount: 1 } } }]);
  });

  it("resolves slash-bearing refs and keeps candidate paths stable across archive wrapper changes", async () => {
    let wrapper = "repo-first";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith("/commits/release%2Fnext")) return new Response(commit);
      if (String(input).includes("/commits/")) return new Response(null, { status: 404 });
      return response(zip(file(`${wrapper}/demo/SKILL.md`, markdown)));
    });
    const get = createRemoteSkillSourceFetcher({ fetch });
    const first = await get("https://github.com/owner/repo/tree/release/next/demo");
    wrapper = "repo-second";
    const second = await get("https://github.com/owner/repo/tree/release/next/demo");
    expect(first.candidates[0]?.path).toBe("demo");
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("imports repository roots using the current default commit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("/commits/HEAD")
      ? new Response(commit) : response(zip(file("repo-wrapper/SKILL.md", markdown))));
    const source = await createRemoteSkillSourceFetcher({ fetch })("https://github.com/owner/repo.git/");
    expect(source.source.url).toBe("https://github.com/owner/repo");
    expect(source.candidates[0]?.path).toBe(".");
  });

  it("uses one archive request for a pinned commit and one ref lookup for ordinary deep folders", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("/commits/main")
      ? new Response(commit) : response(zip(file("repo-wrapper/a/b/c/demo/SKILL.md", markdown))));
    const get = createRemoteSkillSourceFetcher({ fetch });
    await get(`https://github.com/owner/repo/tree/${commit}/a/b/c/demo`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`https://github.com/owner/repo/archive/${commit}.zip`);
    fetch.mockClear();
    await get("https://github.com/owner/repo/tree/main/a/b/c/demo");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("imports a small selected folder from a large catalog without inflating unrelated members", async () => {
    const archive = symlink(zip(file("repo/skills/demo/SKILL.md", markdown), file("repo/skills/demo/ref.txt", "reference"),
      file("repo/elsewhere/link", "../skills"),
      ...Array.from({ length: 2_100 }, (_, index) => file(`repo/unrelated/file-${index}`, "other"))), "repo/elsewhere/link");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(archive));
    const source = await createRemoteSkillSourceFetcher({ fetch })(`https://github.com/owner/repo/tree/${commit}/skills/demo`);
    expect(source.candidates).toMatchObject([{ path: "skills/demo", candidate: { bundle: { fileCount: 1 } } }]);
    expect(source.ignoredFiles).toBe(0);
  });

  it("ignores root catalog symlinks outside Skills but rejects them in a selected bundle", async () => {
    const outside = symlink(zip(file("repo/skills/demo/SKILL.md", markdown), file("repo/other/link", "../skills")), "repo/other/link");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(outside));
    const get = createRemoteSkillSourceFetcher({ fetch });
    const source = await get(`https://github.com/owner/repo/tree/${commit}`);
    expect(source.candidates).toHaveLength(1);
    expect(source.ignoredFiles).toBe(1);
    fetch.mockImplementation(async () => response(symlink(zip(file("repo/skills/demo/SKILL.md", markdown), file("repo/skills/demo/link", "../../other")), "repo/skills/demo/link")));
    await expect(get(`https://github.com/owner/repo/tree/${commit}`)).rejects.toThrow("skill_archive_special_file");
    fetch.mockImplementation(async () => response(outside));
    await expect(get("https://example.com/skills.zip")).rejects.toThrow("skill_archive_special_file");
  });

  it.each(["heads", "tags"])("encodes nested GitLab namespaces and removes the harmless %s UI query", async (refType) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname.startsWith("/api/v4/projects/team%2Fsubgroup%2Frepo/repository/")).toBe(true);
      if (url.pathname.endsWith("/commits/main")) return Response.json({ id: commit });
      if (url.pathname.includes("/commits/")) return new Response(null, { status: 404 });
      expect(url.searchParams.get("sha")).toBe(commit);
      expect(url.searchParams.get("path")).toBe("skills/demo");
      expect(url.searchParams.get("include_lfs_blobs")).toBe("false");
      return response(zip(file("repo-wrapper/skills/demo/SKILL.md", markdown), file("repo-wrapper/skills/demo/ref.txt", "reference")));
    });
    const source = await createRemoteSkillSourceFetcher({ fetch })(`https://gitlab.com/team/subgroup/repo/-/tree/main/skills/demo?ref_type=${refType}`);
    expect(source.source.url).toBe("https://gitlab.com/team/subgroup/repo/-/tree/main/skills/demo");
    expect(source.candidates).toMatchObject([{ path: "skills/demo", candidate: { bundle: { fileCount: 1 } } }]);
  });

  it.each([404, 429, 403])("maps HTTP %s without reflecting remote bodies", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("sensitive upstream diagnostics", {
      status, ...(status === 403 ? { headers: { "x-ratelimit-remaining": "0" } } : {})
    }));
    await expect(createRemoteSkillSourceFetcher({ fetch })("https://example.com/SKILL.md"))
      .rejects.toThrow(status === 404 ? "skill_source_unavailable" : "skill_source_rate_limited");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([["https://example.com/SKILL.md", SKILL_FILE_MAX_BYTES], ["https://example.com/skills.zip", SKILL_ARCHIVE_MAX_BYTES]])
    ("bounds declared bytes before reading %s", async (url, limit) => {
      const cancel = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(Number(limit) + 1) } }));
      await expect(createRemoteSkillSourceFetcher({ fetch })(String(url))).rejects.toThrow("skill_source_too_large");
      expect(cancel).toHaveBeenCalledTimes(1);
    });

  it("bounds actual bytes despite a smaller declared body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new Uint8Array(SKILL_FILE_MAX_BYTES + 1), { headers: { "content-length": "1" } }));
    await expect(createRemoteSkillSourceFetcher({ fetch })("https://example.com/SKILL.md")).rejects.toThrow("skill_source_too_large");
  });

  it("cancels a stalled body on the total deadline", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel })));
    await expect(createRemoteSkillSourceFetcher({ fetch, timeoutMs: 10 })("https://example.com/SKILL.md"))
      .rejects.toThrow("skill_source_timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels caller-aborted imports before I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(createRemoteSkillSourceFetcher({ fetch })("https://example.com/SKILL.md", { signal: AbortSignal.abort() }))
      .rejects.toThrow("skill_source_cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("repins and blocks redirect DNS to private addresses without dispatching there", async () => {
    const dispatch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://private.example/SKILL.md" } }));
    const fetch = createMcpSafeFetch({ dispatch, lookupHostname: async (hostname) => [{ address: hostname === "public.example" ? "93.184.216.34" : "127.0.0.1", family: 4 }] });
    await expect(createRemoteSkillSourceFetcher({ fetch })("https://public.example/SKILL.md")).rejects.toThrow("skill_source_forbidden");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not follow redirects carrying credentials or downgrading HTTPS", async () => {
    for (const location of ["https://user:secret@public.example/SKILL.md", "http://public.example/SKILL.md"]) {
      const dispatch = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
      const fetch = createMcpSafeFetch({ dispatch, lookupHostname: async () => [{ address: "93.184.216.34", family: 4 }] });
      await expect(createRemoteSkillSourceFetcher({ fetch })("https://public.example/SKILL.md")).rejects.toThrow("skill_source_forbidden");
      expect(dispatch).toHaveBeenCalledTimes(1);
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_DOWNLOAD_LIMITS,
  artifactDownloadDecision,
  artifactDownloadName,
  artifactUserActivation,
  createArtifactDownloadTurns,
  parseArtifactDownloadMessage,
  saveArtifactDownload
} from "./artifactDownload";

const message = (fields: Record<string, unknown> = {}) => ({ type: "aiqsa_artifact_download", name: "report.csv", blob: new Blob(["a,b\n"]), ...fields });
const activation = (isActive: unknown) => vi.stubGlobal("navigator", { userActivation: { isActive } });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("artifact download names", () => {
  it("removes separators, control and bidi or zero-width characters and reserved names, and keeps a short extension when bounding", () => {
    for (const [requested, saved] of [
      ["report.csv", "report.csv"],
      ["../../etc/passwd", "_.._etc_passwd"],
      ["C:\\Users\\me\\run.bat", "C__Users_me_run.bat"],
      ["invoice\u202Etxt.exe", "invoicetxt.exe"],
      ["a\u2066b\u2069c\u200Bd\u200Ee\uFEFF.pdf", "abcde.pdf"],
      ["line\nbreak\ttab\u0000.txt", "linebreaktab.txt"],
      ["  ...hidden. ", "hidden"],
      ["<script>alert(1)</script>.html", "_script_alert(1)__script_.html"],
      ["what?*|\"name\".txt", "what____name_.txt"],
      ["wide\u3000space\u00a0name.txt", "wide space name.txt"],
      ["CON", "_CON"], ["con.txt", "_con.txt"], ["Lpt9.tar.gz", "_Lpt9.tar.gz"], ["com¹.log", "_com¹.log"], ["console.log", "console.log"],
      ["", "download"], ["...", "download"], ["\u202E\u200B", "download"], ["/", "_"],
      ["e\u0301tude.txt", "étude.txt"]
    ]) expect(artifactDownloadName(requested!), JSON.stringify(requested)).toBe(saved);
    const long = artifactDownloadName(`${"я".repeat(300)}.xlsx`);
    expect(Array.from(long)).toHaveLength(ARTIFACT_DOWNLOAD_LIMITS.maxNameCharacters);
    expect(long.endsWith(".xlsx")).toBe(true);
    expect(Array.from(artifactDownloadName(`${"😀".repeat(200)}`))).toHaveLength(ARTIFACT_DOWNLOAD_LIMITS.maxNameCharacters);
    expect(artifactDownloadName(`${"a".repeat(200)}.${"b".repeat(40)}`)).toBe("a".repeat(120));
  });
});

describe("artifact download messages", () => {
  it("accepts exactly a type, a bounded string name and a Blob, and cleans the name", () => {
    expect(parseArtifactDownloadMessage(message({ name: "../секрет\u202E.csv" }))).toEqual({ name: "_секрет.csv", blob: expect.any(Blob) });
    const file = new File(["x"], "local-path.txt");
    expect(parseArtifactDownloadMessage(message({ blob: file }))?.blob).toBe(file);
    expect(parseArtifactDownloadMessage(message({ name: "x".repeat(ARTIFACT_DOWNLOAD_LIMITS.maxRequestedNameCharacters) }))).not.toBeNull();
    for (const forged of [null, "aiqsa_artifact_download", [message()], message({ type: "aiqsa_artifact_open_link" }), message({ extra: true }),
      message({ name: 7 }), message({ name: "x".repeat(ARTIFACT_DOWNLOAD_LIMITS.maxRequestedNameCharacters + 1) }),
      message({ blob: new Uint8Array([1]) }), message({ blob: "a,b" }), message({ blob: { size: 1, type: "text/plain" } }),
      { type: "aiqsa_artifact_download", name: "x" }, { type: "aiqsa_artifact_download", blob: new Blob(["x"]) }]) {
      expect(parseArtifactDownloadMessage(forged), JSON.stringify(forged)).toBeNull();
    }
  });
});

describe("artifact download decisions", () => {
  it("saves at once only during user activation and within the burst and minute limits, and asks otherwise", () => {
    const turns = createArtifactDownloadTurns();
    const request = parseArtifactDownloadMessage(message())!;
    vi.stubGlobal("navigator", {});
    expect(artifactUserActivation()).toBe("unsupported");
    expect(artifactDownloadDecision(request, 0, true, turns)).toBe("ask");
    activation("yes");
    expect(artifactUserActivation()).toBe("unsupported");
    activation(false);
    expect(artifactDownloadDecision(request, 0, true, turns)).toBe("ask");
    activation(true);
    // Activation from typing or clicking elsewhere in the app, with focus outside the frame, saves nothing by itself.
    expect(artifactDownloadDecision(request, 0, false, turns)).toBe("ask");
    // A burst of three, then a pause; at most twelve within any minute.
    expect([0, 1, 2, 3].map(now => artifactDownloadDecision(request, now, true, turns))).toEqual(["save", "save", "save", "ask"]);
    expect(artifactDownloadDecision(request, 9_999, true, turns)).toBe("ask");
    const decisions = [10_000, 10_001, 10_002, 20_000, 20_001, 20_002, 30_000, 30_001, 30_002, 40_000]
      .map(now => artifactDownloadDecision(request, now, true, turns));
    expect(decisions).toEqual([...Array(9).fill("save"), "ask"]);
    expect(artifactDownloadDecision(request, 60_000, true, turns)).toBe("save");
    // Asking never spends a turn: refusals while inactive leave the budget intact.
    const fresh = createArtifactDownloadTurns();
    activation(false);
    for (let now = 0; now < 50; now++) artifactDownloadDecision(request, now, true, fresh);
    activation(true);
    expect(artifactDownloadDecision(request, 50, true, fresh)).toBe("save");
    fresh.reset();
  });

  it("refuses a file larger than the limit before spending a turn", () => {
    activation(true);
    const turns = { take: vi.fn(() => true) };
    const blob = new Blob(["x"]);
    Object.defineProperty(blob, "size", { value: ARTIFACT_DOWNLOAD_LIMITS.maxBytes + 1 });
    expect(artifactDownloadDecision({ name: "huge.bin", blob }, 0, true, turns)).toBe("too_large");
    expect(turns.take).not.toHaveBeenCalled();
  });
});

describe("saving an artifact download", () => {
  it("saves an octet-stream copy under the cleaned name through a detached anchor and revokes its address later", async () => {
    vi.useFakeTimers();
    const created: Blob[] = [];
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: (blob: Blob) => { created.push(blob); return "blob:https://app.example/1"; }, revokeObjectURL: revoke }));
    const clicks: Array<{ href: string; download: string; rel: string; connected: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.getAttribute("href")!, download: this.download, rel: this.rel, connected: this.isConnected });
    });
    saveArtifactDownload({ name: "page.html", blob: new Blob(["<script>alert(1)</script>"], { type: "text/html" }) });
    expect(clicks).toEqual([{ href: "blob:https://app.example/1", download: "page.html", rel: "noopener", connected: true }]);
    expect(created.map(blob => blob.type)).toEqual(["application/octet-stream"]);
    expect(await created[0]!.text()).toBe("<script>alert(1)</script>");
    expect(document.querySelector("a")).toBeNull();
    vi.advanceTimersByTime(ARTIFACT_DOWNLOAD_LIMITS.revokeAfterMs - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:https://app.example/1");
  });
});

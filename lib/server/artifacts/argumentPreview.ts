import { ARTIFACT_KINDS, ARTIFACT_LIMITS, normalizedArtifactPath, type ArtifactKind } from "@/lib/contracts/artifacts";
import { ARTIFACT_GENERATION_LIMITS, type ArtifactGenerationEvent } from "@/lib/contracts/artifactGeneration";

type Path = (string | number)[];
type Frame = { type: "object" | "array"; path: Path; state: "key" | "colon" | "value" | "comma"; key?: string; index: number; empty: boolean; keys: Set<string> };
type Target = { kind: "text" | "path"; index: number } | { kind: "title" | "kind" };

/** A bounded lexical JSON parser. It never retains or emits unrelated values. */
export class ArtifactArgumentPreview {
  private frames: Frame[] = [];
  private rootConsumed = false;
  private string: { key: boolean; target?: Target; value: string; escape: boolean; unicode: string | null; surrogate: string } | null = null;
  private literal: string | null = null;
  private disabled = false;
  private totalBytes = 0;
  private offsets = new Map<number, number>();
  private fileBytes = new Map<number, number>();
  private paths = new Map<number, string>();
  private pending = new Map<number, string>();
  private events: ArtifactGenerationEvent[] = [];
  private lastFlush = 0;

  constructor(private readonly draftId: string) {}

  private fail(): never { throw new Error("artifact_preview_invalid"); }
  private frame() { return this.frames.at(-1); }
  private beginValue(): Path {
    const frame = this.frame();
    if (!frame) { if (this.rootConsumed) this.fail(); this.rootConsumed = true; return []; }
    if (frame.state !== "value") this.fail();
    frame.state = "comma";
    frame.empty = false;
    return [...frame.path, frame.type === "object" ? frame.key! : frame.index++];
  }
  private target(path: Path): Target | undefined {
    if (path.length === 1 && (path[0] === "title" || path[0] === "kind")) return { kind: path[0] };
    if (path.length === 3 && path[0] === "files" && typeof path[1] === "number" && (path[2] === "text" || path[2] === "path")) {
      if (path[1] >= ARTIFACT_LIMITS.maxFiles) this.fail();
      return { kind: path[2], index: path[1] };
    }
  }
  private flush(index: number) {
    const text = this.pending.get(index) ?? "";
    if (!text) return;
    const offset = this.offsets.get(index) ?? 0;
    this.events.push({ phase: "file", draftId: this.draftId, index, offset, text,
      ...(this.paths.has(index) ? { path: this.paths.get(index)! } : {}) });
    this.offsets.set(index, offset + text.length);
    this.pending.delete(index);
  }
  private decoded(character: string) {
    const string = this.string!;
    // Delay high surrogates until the following code unit, including across
    // both wire frames and escaped unicode sequences.
    if (string.surrogate) {
      if (!/^[\uDC00-\uDFFF]$/u.test(character)) this.fail();
      character = string.surrogate + character;
      string.surrogate = "";
    } else if (/^[\uD800-\uDBFF]$/u.test(character)) { string.surrogate = character; return; }
    else if (/^[\uDC00-\uDFFF]$/u.test(character)) this.fail();
    if (string.key || string.target && string.target.kind !== "text") {
      string.value += character;
      if (string.value.length > 256) this.fail();
    } else if (string.target?.kind === "text") {
      const index = string.target.index;
      const bytes = Buffer.byteLength(character);
      const fileBytes = (this.fileBytes.get(index) ?? 0) + bytes;
      this.totalBytes += bytes;
      if (fileBytes > ARTIFACT_LIMITS.maxTextFileBytes || this.totalBytes > ARTIFACT_GENERATION_LIMITS.maxPreviewBytes) this.fail();
      this.fileBytes.set(index, fileBytes);
      if ((this.pending.get(index)?.length ?? 0) + character.length > ARTIFACT_GENERATION_LIMITS.maxChunkChars) this.flush(index);
      this.pending.set(index, (this.pending.get(index) ?? "") + character);
    }
  }
  private finishString() {
    const string = this.string!;
    if (string.surrogate) this.fail();
    if (string.key) {
      const frame = this.frame()!;
      if (frame.keys.has(string.value) || frame.keys.size >= 128) this.fail();
      frame.keys.add(string.value); frame.key = string.value; frame.state = "colon"; frame.empty = false;
    } else if (string.target) {
      const target = string.target;
      if (target.kind === "text") this.flush(target.index);
      else if (target.kind === "path") {
        const path = normalizedArtifactPath(string.value);
        if (!path || [...this.paths.entries()].some(([index, prior]) => index !== target.index && prior === path)) this.fail();
        this.paths.set(target.index, path);
        this.events.push({ draftId: this.draftId, phase: "file", index: target.index, path, offset: this.offsets.get(target.index) ?? 0, text: "" });
      } else if (target.kind === "kind") {
        if (!ARTIFACT_KINDS.includes(string.value as ArtifactKind)) this.fail();
        this.events.push({ draftId: this.draftId, phase: "metadata", kind: string.value as ArtifactKind });
      } else {
        if (!string.value.trim() || Buffer.byteLength(string.value) > ARTIFACT_LIMITS.maxTitleBytes || /[\u0000-\u001f\u007f]/u.test(string.value)) this.fail();
        this.events.push({ draftId: this.draftId, phase: "metadata", title: string.value });
      }
    }
    this.string = null;
  }
  private consume(character: string) {
    const string = this.string;
    if (string) {
      if (string.unicode !== null) {
        if (!/^[a-f0-9]$/iu.test(character)) this.fail();
        string.unicode += character;
        if (string.unicode.length === 4) { const decoded = String.fromCharCode(parseInt(string.unicode, 16)); string.unicode = null; this.decoded(decoded); }
      } else if (string.escape) {
        string.escape = false;
        if (character === "u") string.unicode = "";
        else { const escaped = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[character]; if (escaped === undefined) this.fail(); this.decoded(escaped); }
      } else if (character === "\\") string.escape = true;
      else if (character === '"') this.finishString();
      else { if (character.charCodeAt(0) < 32) this.fail(); this.decoded(character); }
      return;
    }
    if (this.literal !== null) {
      if (!/[\s,\]}]/u.test(character)) { this.literal += character; if (this.literal.length > 128) this.fail(); return; }
      if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(this.literal)) this.fail();
      this.literal = null;
    }
    if (/\s/u.test(character)) return;
    const frame = this.frame();
    if (character === '"') {
      const key = frame?.type === "object" && frame.state === "key";
      this.string = { key, ...(!key ? { target: this.target(this.beginValue()) } : {}), value: "", escape: false, unicode: null, surrogate: "" };
    } else if (character === "{" || character === "[") {
      const path = this.beginValue();
      if (this.frames.length >= 16) this.fail();
      this.frames.push({ type: character === "{" ? "object" : "array", path, state: character === "{" ? "key" : "value", index: 0, empty: true, keys: new Set() });
    } else if (character === "}" || character === "]") {
      if (!frame || frame.type !== (character === "}" ? "object" : "array") || (!frame.empty && frame.state !== "comma")) this.fail();
      this.frames.pop();
    } else if (character === ":") {
      if (frame?.type !== "object" || frame.state !== "colon") this.fail(); frame.state = "value";
    } else if (character === ",") {
      if (!frame || frame.state !== "comma") this.fail(); frame.state = frame.type === "object" ? "key" : "value";
    } else { this.beginValue(); this.literal = character; }
  }
  feed(delta: string): ArtifactGenerationEvent[] {
    if (this.disabled) return [];
    this.events = [];
    try {
      // Iterate code units so surrogate pairs split across provider frames use
      // exactly the same decoder as escaped JSON unicode.
      for (let index = 0; index < delta.length; index++) this.consume(delta[index]!);
      if (Date.now() - this.lastFlush >= 50) { for (const index of this.pending.keys()) this.flush(index); this.lastFlush = Date.now(); }
    } catch { this.disabled = true; this.pending.clear(); this.frames = []; this.string = null; this.events = [{ draftId: this.draftId, phase: "reset" }]; }
    return this.events;
  }
}

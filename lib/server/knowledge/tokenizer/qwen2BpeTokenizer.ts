import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { QWEN2_BPE_MERGES_GZ_BASE64 } from "./qwen2BpeMergesData";
import type { KnowledgeTokenCounter, KnowledgeTokenizerIdentity } from "./types";

/**
 * Pure-JS byte-level BPE token counter for the Qwen2-family tokenizer used by
 * the built-in Qwen3 embedding and reranker model family. Tokenizer-only local
 * execution: no model inference, no network access, no Python sidecar. The
 * vendored asset is version-pinned and fingerprint-verified before first use;
 * the runtime never downloads tokenizer data.
 *
 * Asset provenance (one-time derivation, runtime never repeats it):
 * - source repository: https://huggingface.co/Qwen/Qwen3-Embedding-8B
 * - pinned revision:   1d8ad4ca9b3dd8059ad90a75d4983776a23d44af (main, 2025-07-07)
 * - source file:       tokenizer.json
 *   sha256 83cdf8c3a34f68862319cb1810ee7b1e2c0a44e0864ae930194ddb76bb7feb8d
 *   (tokenizer_config.json, sha256
 *   2f58f4bbd7bbce15d683f525954ef3a92cd82f5e06415a9c513859bf8ab72436,
 *   declares tokenizer_class Qwen2Tokenizer)
 * - derived asset:     ./qwen2BpeMergesData.ts — gzip (mtime=0) of the
 *   newline-joined 151,387-entry merge list ("<left> <right>" per line in the
 *   GPT-2 byte-level alphabet), base64-chunked.
 *   gzip sha256   737d388d13925651b989c51d48d45d58badb12d31cbd0be9d6fde87e422efb89
 *   merges sha256 bbeef245f0b03a9613753068e5799c2496290005594c68f09eed68feedbe6d1f
 *
 * Faithfulness notes, verified against the pinned tokenizer.json:
 * - model.type BPE with ignore_merges=false and byte_fallback=false, so token
 *   counting is fully determined by the merge list plus the byte-level
 *   alphabet; the vocabulary is exactly the 256 base byte tokens plus one
 *   entry per merge product and adds no counting information.
 * - normalizer: NFC.
 * - pre_tokenizer: Split(Regex, Isolated) with the Qwen pattern
 *   (?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}|
 *   ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+
 *   then ByteLevel(add_prefix_space=false, use_regex=false). JavaScript has no
 *   inline (?i:) groups, so the contraction branch is expanded per character
 *   (including U+017F, the only extra simple case-fold of the letters used),
 *   and \s/\S are expressed as the Unicode White_Space property to match the
 *   upstream Rust regex semantics (JS \s differs on U+0085 and U+FEFF).
 * - added special tokens are never counted: Knowledge budgets measure content
 *   text only.
 */
export const KNOWLEDGE_QWEN2_BPE_TOKENIZER_NAME = "qwen2-bpe" as const;
export const KNOWLEDGE_QWEN2_BPE_TOKENIZER_VERSION = 1 as const;
export const KNOWLEDGE_QWEN2_BPE_ASSET_SHA256 =
  "737d388d13925651b989c51d48d45d58badb12d31cbd0be9d6fde87e422efb89" as const;

export const KNOWLEDGE_QWEN2_BPE_IDENTITY: KnowledgeTokenizerIdentity = Object.freeze({
  assetSha256: KNOWLEDGE_QWEN2_BPE_ASSET_SHA256,
  name: KNOWLEDGE_QWEN2_BPE_TOKENIZER_NAME,
  version: KNOWLEDGE_QWEN2_BPE_TOKENIZER_VERSION
});

export type KnowledgeTokenizerErrorCode = "knowledge_tokenizer_asset_invalid";

export class KnowledgeTokenizerError extends Error {
  constructor(readonly code: KnowledgeTokenizerErrorCode) {
    super(code);
    this.name = "KnowledgeTokenizerError";
  }
}

/** A byte-level BPE can never emit more content tokens than UTF-8 input
 * bytes. This conservative bound is used only if the verified asset is
 * unavailable at query time, so rerank/parent limits remain hard limits
 * rather than relying on the generic estimator's non-guaranteed ratio. */
export function conservativeQwen2TokenUpperBound(text: string): number {
  return text ? Buffer.byteLength(text.normalize("NFC"), "utf8") : 0;
}

const PRETOKEN_PATTERN = new RegExp(
  "'(?:[sſS]|[tT]|[rR][eE]|[vV][eE]|[mM]|[lL][lL]|[dD])" +
  "|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+" +
  "|\\p{N}" +
  "| ?[^\\p{White_Space}\\p{L}\\p{N}]+[\\r\\n]*" +
  "|\\p{White_Space}*[\\r\\n]+" +
  "|\\p{White_Space}+(?![^\\p{White_Space}])" +
  "|\\p{White_Space}+",
  "gu"
);

/** GPT-2 byte-to-unicode alphabet: printable bytes map to themselves, the
 * rest map to U+0100.. in discovery order. */
function byteAlphabet(): readonly string[] {
  const direct: number[] = [];
  for (let byte = 0x21; byte <= 0x7e; byte += 1) direct.push(byte);
  for (let byte = 0xa1; byte <= 0xac; byte += 1) direct.push(byte);
  for (let byte = 0xae; byte <= 0xff; byte += 1) direct.push(byte);
  const directSet = new Set(direct);
  const table = new Array<string>(256);
  let shifted = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    if (directSet.has(byte)) {
      table[byte] = String.fromCharCode(byte);
    } else {
      table[byte] = String.fromCharCode(0x100 + shifted);
      shifted += 1;
    }
  }
  return table;
}

const BYTE_ALPHABET = byteAlphabet();
const textEncoder = new TextEncoder();
const PAIR_SEPARATOR = "\u0000";
const CACHEABLE_PRETOKEN_MAX_CHARS = 64;
const PRETOKEN_CACHE_MAX_ENTRIES = 20_000;

type HeapEntry = Readonly<{ pair: string; position: number; rank: number }>;

/** Minimal binary min-heap over (rank, position). */
class RankHeap {
  private readonly entries: HeapEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(entry: HeapEntry): void {
    const entries = this.entries;
    entries.push(entry);
    let index = entries.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.less(entries[index]!, entries[parent]!)) {
        const swap = entries[index]!;
        entries[index] = entries[parent]!;
        entries[parent] = swap;
        index = parent;
      } else break;
    }
  }

  pop(): HeapEntry | undefined {
    const entries = this.entries;
    const top = entries[0];
    const last = entries.pop();
    if (top === undefined || last === undefined) return top;
    if (entries.length > 0 && top !== last) {
      entries[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < entries.length && this.less(entries[left]!, entries[smallest]!)) {
          smallest = left;
        }
        if (right < entries.length && this.less(entries[right]!, entries[smallest]!)) {
          smallest = right;
        }
        if (smallest === index) break;
        const swap = entries[index]!;
        entries[index] = entries[smallest]!;
        entries[smallest] = swap;
        index = smallest;
      }
    }
    return top;
  }

  private less(left: HeapEntry, right: HeapEntry): boolean {
    return left.rank < right.rank ||
      (left.rank === right.rank && left.position < right.position);
  }
}

class Qwen2BpeCounter {
  private readonly cache = new Map<string, number>();

  constructor(private readonly ranks: ReadonlyMap<string, number>) {}

  countTokens(text: string): number {
    if (!text) return 0;
    const normalized = text.normalize("NFC");
    let total = 0;
    for (const match of normalized.matchAll(PRETOKEN_PATTERN)) {
      total += this.countPretoken(match[0]);
    }
    return total;
  }

  private countPretoken(pretoken: string): number {
    const cacheable = pretoken.length <= CACHEABLE_PRETOKEN_MAX_CHARS;
    if (cacheable) {
      const cached = this.cache.get(pretoken);
      if (cached !== undefined) return cached;
    }
    const bytes = textEncoder.encode(pretoken);
    const count = this.countByteLevel(bytes);
    if (cacheable) {
      if (this.cache.size >= PRETOKEN_CACHE_MAX_ENTRIES) this.cache.clear();
      this.cache.set(pretoken, count);
    }
    return count;
  }

  private countByteLevel(bytes: Uint8Array): number {
    if (bytes.length === 0) return 0;
    if (bytes.length === 1) return 1;
    // Doubly linked list over byte-level symbols with a lazy-invalidation
    // rank heap; O(n log n) even for hostile single-word inputs.
    const tokens: string[] = new Array(bytes.length);
    const previous: number[] = new Array(bytes.length);
    const next: number[] = new Array(bytes.length);
    const alive: boolean[] = new Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      tokens[index] = BYTE_ALPHABET[bytes[index]!]!;
      previous[index] = index - 1;
      next[index] = index + 1 < bytes.length ? index + 1 : -1;
      alive[index] = true;
    }
    const heap = new RankHeap();
    const offer = (position: number): void => {
      const following = next[position]!;
      if (following === -1) return;
      const pair = tokens[position]! + PAIR_SEPARATOR + tokens[following]!;
      const rank = this.ranks.get(pair);
      if (rank !== undefined) heap.push({ pair, position, rank });
    };
    for (let index = 0; index < bytes.length - 1; index += 1) offer(index);
    let count = bytes.length;
    for (;;) {
      const entry = heap.pop();
      if (!entry) break;
      const position = entry.position;
      if (!alive[position]) continue;
      const following = next[position]!;
      if (following === -1 || !alive[following]) continue;
      if (tokens[position]! + PAIR_SEPARATOR + tokens[following]! !== entry.pair) continue;
      tokens[position] = tokens[position]! + tokens[following]!;
      alive[following] = false;
      const afterFollowing = next[following]!;
      next[position] = afterFollowing;
      if (afterFollowing !== -1) previous[afterFollowing] = position;
      count -= 1;
      const before = previous[position]!;
      if (before !== -1 && alive[before]) offer(before);
      offer(position);
    }
    return count;
  }
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Pure factory used by the pinned loader below and by verification tests. The
 * asset fingerprint is checked before any decoding output is trusted; any
 * mismatch or malformed content fails closed with a stable error code.
 */
export function createQwen2BpeTokenCounterFromAsset(input: Readonly<{
  expectedSha256: string;
  gzBase64Parts: readonly string[];
  identity: KnowledgeTokenizerIdentity;
}>): KnowledgeTokenCounter {
  let compressed: Buffer;
  let merges: string[];
  try {
    compressed = Buffer.from(input.gzBase64Parts.join(""), "base64");
    if (sha256Hex(compressed) !== input.expectedSha256) {
      throw new KnowledgeTokenizerError("knowledge_tokenizer_asset_invalid");
    }
    merges = gunzipSync(compressed).toString("utf8").split("\n");
  } catch (error) {
    if (error instanceof KnowledgeTokenizerError) throw error;
    throw new KnowledgeTokenizerError("knowledge_tokenizer_asset_invalid");
  }
  if (merges.length < 100_000) {
    throw new KnowledgeTokenizerError("knowledge_tokenizer_asset_invalid");
  }
  const ranks = new Map<string, number>();
  for (const [rank, line] of merges.entries()) {
    const separator = line.indexOf(" ");
    if (separator < 1 || separator !== line.lastIndexOf(" ") ||
      separator === line.length - 1) {
      throw new KnowledgeTokenizerError("knowledge_tokenizer_asset_invalid");
    }
    ranks.set(
      line.slice(0, separator) + PAIR_SEPARATOR + line.slice(separator + 1),
      rank
    );
  }
  if (ranks.size !== merges.length) {
    throw new KnowledgeTokenizerError("knowledge_tokenizer_asset_invalid");
  }
  const counter = new Qwen2BpeCounter(ranks);
  return Object.freeze({
    countTokens: (text: string) => counter.countTokens(text),
    identity: input.identity
  });
}

let loaded: KnowledgeTokenCounter | null = null;
let loadFailure: KnowledgeTokenizerError | null = null;

/**
 * Lazily builds the pinned counter once per process. A verification failure is
 * deterministic (the asset is a bundled constant), so it is cached and every
 * later call fails with the same stable code instead of re-decoding.
 */
export function qwen2BpeTokenCounter(): KnowledgeTokenCounter {
  if (loaded) return loaded;
  if (loadFailure) throw loadFailure;
  try {
    loaded = createQwen2BpeTokenCounterFromAsset({
      expectedSha256: KNOWLEDGE_QWEN2_BPE_ASSET_SHA256,
      gzBase64Parts: QWEN2_BPE_MERGES_GZ_BASE64,
      identity: KNOWLEDGE_QWEN2_BPE_IDENTITY
    });
    return loaded;
  } catch (error) {
    loadFailure = error instanceof KnowledgeTokenizerError
      ? error
      : new KnowledgeTokenizerError("knowledge_tokenizer_asset_invalid");
    throw loadFailure;
  }
}

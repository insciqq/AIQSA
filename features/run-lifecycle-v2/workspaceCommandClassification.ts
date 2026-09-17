/** A presentation hint only. This is deliberately narrower than shell syntax. */
function words(command: string): string[] | null {
  if (/[\n\r;|&<>`$]/u.test(command)) return null;
  const output: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\" && quote !== "'") {
      if (++index >= command.length) return null;
      word += command[index];
      started = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) output.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) return null;
  if (started) output.push(word);
  return output;
}

type Flags = { short: string; values?: string; long?: string; longValues?: string };
const flags: Record<string, Flags> = {
  rg: { short: "nNhilLwxsSvVqocFaAbBIruUzZEFP", values: "efgmtABC", long: "files hidden no-ignore no-ignore-vcs line-number no-line-number ignore-case case-sensitive smart-case fixed-strings word-regexp line-regexp count count-matches files-with-matches files-without-match only-matching invert-match no-heading heading no-messages stats", longValues: "glob iglob type type-not max-count max-depth context before-context after-context encoding color sort sortr path-separator" },
  grep: { short: "nHhilLwxsRvqocFaAbIEFGPZ", values: "efmABC", long: "line-number ignore-case invert-match word-regexp line-regexp extended-regexp fixed-strings perl-regexp recursive files-with-matches files-without-match count only-matching no-messages", longValues: "max-count context before-context after-context include exclude exclude-dir color" },
  ls: { short: "laAhRrtSdFipn1CQmULd", long: "all almost-all recursive human-readable inode numeric-uid-gid directory reverse size", longValues: "sort time time-style format color block-size" },
  cat: { short: "nbsveAtTEu", long: "number number-nonblank squeeze-blank show-ends show-tabs show-all show-nonprinting" },
  head: { short: "qv", values: "nc", long: "quiet verbose", longValues: "lines bytes" },
  tail: { short: "qvfF", values: "nc", long: "quiet verbose retry", longValues: "lines bytes follow" },
  wc: { short: "clmwL", long: "bytes chars lines words max-line-length" },
  stat: { short: "fLt", values: "c", long: "file-system dereference terse", longValues: "format printf" },
  file: { short: "bhiLrskz0N", values: "mfF", long: "brief mime mime-type mime-encoding dereference no-dereference raw keep-going", longValues: "magic-file files-from separator" },
  tree: { short: "aAdfFghilnpqrstuxCDL", values: "LPHI", long: "dirsfirst noreport filelimit gitignore", longValues: "charset sort" },
  pwd: { short: "LP", long: "logical physical" },
  "git status": { short: "sbz", long: "short branch show-stash long null ignored", longValues: "porcelain untracked-files ignore-submodules" },
  "git diff": { short: "pUwb", values: "U", long: "stat numstat shortstat name-only name-status check summary patch no-patch cached staged no-ext-diff no-textconv ignore-space-change ignore-all-space", longValues: "diff-filter unified" },
  "git log": { short: "p", values: "n", long: "oneline stat name-only name-status graph all no-merges first-parent decorate no-decorate no-patch", longValues: "max-count format pretty since until author grep" },
  "git show": { short: "p", long: "stat name-only name-status summary no-patch no-ext-diff no-textconv", longValues: "format pretty" }
};

function allowedFlags(args: readonly string[], allowed: Flags): boolean {
  let positional = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (positional || arg === "-" || !arg.startsWith("-")) continue;
    if (arg === "--") { positional = true; continue; }
    if (arg.startsWith("--")) {
      const [name, value] = arg.slice(2).split("=", 2);
      if (allowed.longValues?.split(" ").includes(name!)) {
        if (value === undefined && ++index >= args.length) return false;
      } else if (value !== undefined || !allowed.long?.split(" ").includes(name!)) return false;
    } else {
      for (let offset = 1; offset < arg.length; offset += 1) {
        const flag = arg[offset]!;
        if (allowed.values?.includes(flag)) {
          if (offset === arg.length - 1 && ++index >= args.length) return false;
          break;
        }
        if (!allowed.short.includes(flag)) return false;
      }
    }
  }
  return true;
}

/** Pinned Codex 0.154 exec emits `/usr/bin/bash -lc pwd` or a quoted command argument. */
export function isExploredWorkspaceCommand(preview: string, truncated = false): boolean {
  if (truncated || preview.includes("•••")) return false;
  let tokens = words(preview);
  if (!tokens?.length) return false;
  if (/^(?:\/(?:usr\/)?bin\/)?(?:bash|sh)$/u.test(tokens[0]!)) {
    if (tokens.length !== 3 || !["-lc", "-c"].includes(tokens[1]!)) return false;
    tokens = words(tokens[2]!);
    if (!tokens?.length) return false;
  }
  if (tokens.some((token) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "--in-place", "xargs"].includes(token))) return false;
  const program = tokens[0]!.replace(/^\/(?:usr\/)?bin\//u, "");
  const args = tokens.slice(1);
  if (program === "sed") return args[0] === "-n" && /^\d+(?:,\d+)?p$/u.test(args[1] ?? "") &&
    args.slice(2).every((arg) => !arg.startsWith("-"));
  if (program === "find") {
    const unary = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-newer"]);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (unary.has(arg)) { if (++index >= args.length) return false; }
      else if (arg.startsWith("-") && !["-print", "-print0", "-ls", "-empty", "-readable", "-a", "-o", "-not"].includes(arg)) return false;
    }
    return true;
  }
  const command = program === "git" ? `git ${args.shift() ?? ""}` : program;
  return !!flags[command] && allowedFlags(args, flags[command]);
}

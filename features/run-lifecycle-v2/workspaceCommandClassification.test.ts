import { describe, expect, it } from "vitest";
import { isExploredWorkspaceCommand } from "./workspaceCommandClassification";

describe("conservative command labels", () => {
  it.each([
    "pwd", "ls -la project", "rg -n --glob '*.ts' needle .", "grep -Rin pattern src",
    "find . -maxdepth 2 -type f -name '*.ts' -print", "cat -- 'my file.txt'", "head -n20 file",
    "tail -n 30 file", "sed -n '1,120p' file", "wc -l file", "stat -c '%s' file", "file -b file",
    "tree -L 2", "git status --short", "git diff --stat", "git log -n 4 --oneline", "git show HEAD:file",
    "/usr/bin/bash -lc pwd", '/usr/bin/bash -lc "rg -n needle ."', "sh -c 'ls -la'", "/bin/ls -l"
  ])("labels a simple read as Explored: %s", (command) => expect(isExploredWorkspaceCommand(command)).toBe(true));

  it.each([
    "", "npm test", "rm file", "ls && rm file", "ls; pwd", "ls || pwd", "cat file | head", "ls > file",
    "ls < file", "ls $(pwd)", "ls `pwd`", "ls\nrm file", "ls\rwhoami", "ls \\\nrm file",
    "find . -delete", "find . -exec touch file {} +", "find . -ok rm file {} ;", "find . -fprint output",
    "xargs cat", "sed -i '1p' file", "sed -n '1,120w out' file", "sed -n '1,120p;w out' file",
    "sed --in-place 's/a/b/' file", "rg --pre evil pattern .", "file -C", "tree -o output", "git diff --output=out",
    "git config user.name value", "git show --output out", "ls --unknown", "cat --invalid", "ls 'unfinished",
    "bash -lc 'ls; pwd'", 'bash -lc "ls\nrm file"', "bash -lc ls extra", "bash -c 'cat file | head'",
    "python -c 'print(1)'", "./cat file", "env ls", "cat •••"
  ])("keeps Ran when syntax or flags are uncertain: %s", (command) => expect(isExploredWorkspaceCommand(command)).toBe(false));

  it("never classifies a truncated prefix", () => expect(isExploredWorkspaceCommand("ls", true)).toBe(false));
});

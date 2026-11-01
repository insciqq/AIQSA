export const AGENT_DOC_BUDGETS: Readonly<{
  files: number;
  nonEmptyLines: number;
  nonEmptyLinesPerFile: number;
  words: number;
  wordsPerFile: number;
}>;
export const HANDWRITTEN_AGENT_DOCS: readonly string[];
export const INSTRUCTION_BUDGETS: ReadonlyArray<Readonly<{
  filename: string;
  lines: number;
  words: number;
}>>;
export const NESTED_AGENT_INSTRUCTIONS: readonly string[];
export const NESTED_CLAUDE_INSTRUCTIONS: readonly string[];
export const REQUIRED_DOCS: readonly string[];

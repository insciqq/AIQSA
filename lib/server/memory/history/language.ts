export type MemoryTextLanguage = string;

export function detectMemoryTextLanguage(_value: string): "und" {
  // Script detection cannot establish a language; history language metadata
  // stays undetermined.
  return "und";
}

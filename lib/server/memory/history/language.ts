export type MemoryTextLanguage = string;

export function detectMemoryTextLanguage(_value: string): "und" {
  // Script detection cannot establish a language. Only model-provided,
  // structurally valid BCP-47 metadata may be more specific.
  return "und";
}

export type MemoryTextLanguage = "en" | "mixed" | "ru" | "und";

export function detectMemoryTextLanguage(value: string): MemoryTextLanguage {
  const cyrillicCount = value.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  const latinCount = value.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (cyrillicCount === 0 && latinCount === 0) return "und";
  if (cyrillicCount > 0 && latinCount > 0) return "mixed";
  return cyrillicCount > 0 ? "ru" : "en";
}

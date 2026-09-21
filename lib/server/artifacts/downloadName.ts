export function artifactDownloadName(title: string, extension: string): { ascii: string; utf8: string } {
  const clean = title.normalize("NFC").replace(/[\uD800-\uDFFF]/gu, "").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, "").replace(/^[. ]+|[. ]+$/gu, "");
  const name = [...clean].slice(0, 80).join("").replace(/[. ]+$/u, "") || "artifact";
  const fallback = name.replace(/[^A-Za-z0-9._-]+/gu, "-");
  const suffix = extension.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return { ascii: `${/[A-Za-z0-9]/u.test(fallback) ? fallback : "artifact"}.${suffix}`, utf8: `${name}.${suffix}` };
}

export function artifactDownloadDisposition(title: string, extension: string): string {
  const name = artifactDownloadName(title, extension);
  const encoded = encodeURIComponent(name.utf8).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${name.ascii}"; filename*=UTF-8''${encoded}`;
}

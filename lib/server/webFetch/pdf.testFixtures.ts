/**
 * A tiny synthetic one-page PDF with a text layer and an optional Info
 * `Title`: a real document for the isolated PDF worker, built in memory.
 * `text` and `title` must not contain parentheses or backslashes.
 */
export function syntheticPdf(options: Readonly<{ text: string; title?: string }>): Buffer {
  const stream = options.text ? `BT /F1 12 Tf 40 140 Td (${options.text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...(options.title === undefined ? [] : [`<< /Title (${options.title}) >>`])
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  const info = options.title === undefined ? "" : ` /Info ${objects.length} 0 R`;
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1}${info} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

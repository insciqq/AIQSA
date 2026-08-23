import { deflateSync } from "node:zlib";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import type { ProviderCredentialSource } from "./providerCredentialSource";
import { createProviderSafeFetch } from "./providerSafeFetch";
import {
  createProviderRuntimeBinding,
  type ProviderExecutionSnapshot
} from "./runtimeFactory";
import type { ProviderAdapter, ProviderRunRequest } from "./types";
import {
  pdfInputVerificationEvidence,
  supportsPdfInputAdapter,
  type PdfInputVerificationEvidence
} from "./pdfInputEvidence";

export const PDF_INPUT_PROBE_CODE = "Q7K4P9";
export const PDF_INPUT_PROBE_MIME_TYPE = "application/pdf";
export const PDF_INPUT_PROBE_WIDTH = 480;
export const PDF_INPUT_PROBE_HEIGHT = 240;

const PDF_INPUT_PROBE_PROMPT = [
  "Read the attached image-only PDF.",
  "Return exactly the code shown in the bottom-right table cell.",
  "Return no explanation, punctuation, Markdown, or additional text."
].join("\n");

const glyphs: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "11100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"]
});

function drawRectangle(
  raster: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  value = 0
): void {
  for (let row = Math.max(0, y); row < Math.min(PDF_INPUT_PROBE_HEIGHT, y + height); row += 1) {
    const offset = row * PDF_INPUT_PROBE_WIDTH;
    for (let column = Math.max(0, x); column < Math.min(PDF_INPUT_PROBE_WIDTH, x + width); column += 1) {
      raster[offset + column] = value;
    }
  }
}

function drawRasterText(
  raster: Uint8Array,
  text: string,
  x: number,
  y: number,
  scale: number
): void {
  let cursor = x;
  for (const character of text) {
    const glyph = glyphs[character];
    if (!glyph) throw new Error("pdf_input_probe_glyph_missing");
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel === "1") {
          drawRectangle(
            raster,
            cursor + columnIndex * scale,
            y + rowIndex * scale,
            scale,
            scale
          );
        }
      });
    });
    cursor += 6 * scale;
  }
}

function imageOnlyProbeRaster(): Uint8Array {
  const raster = new Uint8Array(PDF_INPUT_PROBE_WIDTH * PDF_INPUT_PROBE_HEIGHT);
  raster.fill(255);

  drawRectangle(raster, 18, 18, 444, 3);
  drawRectangle(raster, 18, 118, 444, 3);
  drawRectangle(raster, 18, 218, 444, 3);
  drawRectangle(raster, 18, 18, 3, 203);
  drawRectangle(raster, 238, 18, 3, 203);
  drawRectangle(raster, 459, 18, 3, 203);

  drawRasterText(raster, "ALPHA", 55, 52, 5);
  drawRasterText(raster, "17", 320, 52, 5);
  drawRasterText(raster, "BETA", 65, 152, 5);
  drawRasterText(raster, PDF_INPUT_PROBE_CODE, 274, 154, 4);
  return raster;
}

function pdfObject(id: number, body: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n`, "ascii"),
    typeof body === "string" ? Buffer.from(body, "ascii") : body,
    Buffer.from("\nendobj\n", "ascii")
  ]);
}

function buildImageOnlyProbePdf(): Buffer {
  const compressedRaster = deflateSync(imageOnlyProbeRaster(), { level: 9 });
  const content = Buffer.from(
    `q\n${PDF_INPUT_PROBE_WIDTH} 0 0 -${PDF_INPUT_PROBE_HEIGHT} 0 ${PDF_INPUT_PROBE_HEIGHT} cm\n/Im0 Do\nQ\n`,
    "ascii"
  );
  const objects = [
    pdfObject(1, "<< /Type /Catalog /Pages 2 0 R >>"),
    pdfObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    pdfObject(
      3,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_INPUT_PROBE_WIDTH} ${PDF_INPUT_PROBE_HEIGHT}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
    ),
    pdfObject(4, Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${PDF_INPUT_PROBE_WIDTH} /Height ${PDF_INPUT_PROBE_HEIGHT} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedRaster.length} >>\nstream\n`,
        "ascii"
      ),
      compressedRaster,
      Buffer.from("\nendstream", "ascii")
    ])),
    pdfObject(5, Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, "ascii"),
      content,
      Buffer.from("endstream", "ascii")
    ]))
  ];
  const header = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "binary");
  const offsets = [0];
  let byteOffset = header.length;
  for (const object of objects) {
    offsets.push(byteOffset);
    byteOffset += object.length;
  }
  const xrefOffset = byteOffset;
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    ""
  ].join("\n");
  return Buffer.concat([header, ...objects, Buffer.from(xref, "ascii")]);
}

const probePdfBytes = buildImageOnlyProbePdf();

export function imageOnlyPdfInputProbeFixture(): Readonly<{
  bytes: Buffer;
  fileName: string;
  mimeType: typeof PDF_INPUT_PROBE_MIME_TYPE;
}> {
  return {
    bytes: Buffer.from(probePdfBytes),
    fileName: "aiqsa-image-only-pdf-probe.pdf",
    mimeType: PDF_INPUT_PROBE_MIME_TYPE
  };
}

export type ProviderPdfInputProbeInput = Readonly<{
  connection: ProviderExecutionSnapshot["connection"];
  connectionDisplayName: string;
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  model: ProviderModelConfiguration;
  modelDisplayName: string;
  providerFamily: string;
  providerModelId: string;
  secret: ProviderCredentialSource | null;
  signal?: AbortSignal;
}>;

export type ProviderPdfInputProbe = Readonly<{
  probe(input: ProviderPdfInputProbeInput): Promise<PdfInputVerificationEvidence | null>;
}>;

type ProbeOptions = Readonly<{
  createAdapter?: (input: ProviderPdfInputProbeInput) => Pick<ProviderAdapter, "stream">;
  createFetch?: (configuration: ProviderPdfInputProbeInput["connection"]) => typeof fetch;
}>;

function executionSnapshot(input: ProviderPdfInputProbeInput): ProviderExecutionSnapshot {
  return {
    connection: input.connection,
    connectionDisplayName: input.connectionDisplayName,
    connectionId: input.connectionId,
    credentialId: input.credentialId,
    credentialVersionId: input.credentialVersionId,
    model: input.model,
    modelDisplayName: input.modelDisplayName,
    providerFamily: input.providerFamily,
    providerModelId: input.providerModelId,
    version: 1
  };
}

function probeRequest(input: ProviderPdfInputProbeInput): ProviderRunRequest {
  const fixture = imageOnlyPdfInputProbeFixture();
  return {
    attachmentIds: ["pdf-input-probe"],
    attachments: [{
      base64Data: fixture.bytes.toString("base64"),
      byteSize: fixture.bytes.length,
      extractedText: null,
      fileName: fixture.fileName,
      id: "pdf-input-probe",
      kind: "pdf",
      metadata: { pdf: { pageCount: 1 } },
      mimeType: fixture.mimeType,
      status: "ready"
    }],
    chatId: "provider-pdf-input-probe",
    content: { blocks: [{ text: PDF_INPUT_PROBE_PROMPT, type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: {
      ...input.model.capabilities,
      nativePdfInput: true
    },
    modelId: input.model.upstreamModelId,
    params: {
      ...input.model.defaultParams,
      background: false,
      maxOutputTokens: 64,
      maxTokens: 64,
      max_output_tokens: 64,
      store: false,
      stream: false
    },
    prompt: { developer: null, system: null },
    provider: input.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "none",
    toolMode: "none",
    tools: []
  };
}

function adapterFor(
  input: ProviderPdfInputProbeInput,
  options: ProbeOptions
): Pick<ProviderAdapter, "stream"> {
  if (options.createAdapter) return options.createAdapter(input);
  const fetchFn = options.createFetch?.(input.connection) ?? createProviderSafeFetch({
    configuration: input.connection
  });
  return createProviderRuntimeBinding({
    options: { allowFake: false, fetchFn },
    secret: input.secret,
    snapshot: executionSnapshot(input)
  }).adapter;
}

export function createProviderPdfInputProbe(
  options: ProbeOptions = {}
): ProviderPdfInputProbe {
  return {
    async probe(input) {
      if (
        input.model.modelClass !== "answer" ||
        !input.model.capabilities.nativePdfInput ||
        !supportsPdfInputAdapter(input.model.adapterKind)
      ) return null;

      const stream = adapterFor(input, options).stream(probeRequest(input), {
        signal: input.signal
      });
      let next = await stream.next();
      while (!next.done) next = await stream.next();
      if (next.value.finalText.trim() !== PDF_INPUT_PROBE_CODE) return null;
      return pdfInputVerificationEvidence(
        input.model.adapterKind,
        input.model.upstreamModelId
      );
    }
  };
}

import { deflateSync } from "node:zlib";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import type { ProviderCredentialSource } from "./providerCredentialSource";
import { declaredModelOutputTokenLimit, lowestConfiguredReasoningEffort } from "./providerModelCapabilities";
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

import { receiptProbeRaster, RECEIPT_PROBE_ANSWER as PDF_INPUT_PROBE_ANSWER,
  RECEIPT_PROBE_WIDTH as PDF_INPUT_PROBE_WIDTH, RECEIPT_PROBE_HEIGHT as PDF_INPUT_PROBE_HEIGHT } from "./receiptProbeFixture";
export { PDF_INPUT_PROBE_ANSWER, PDF_INPUT_PROBE_WIDTH, PDF_INPUT_PROBE_HEIGHT };
export const PDF_INPUT_PROBE_MIME_TYPE = "application/pdf";

const PDF_INPUT_PROBE_MAX_OUTPUT_TOKENS = 512;

const PDF_INPUT_PROBE_PROMPT = [
  "Read the attached image-only PDF.",
  "Which item on the receipt has a quantity of 7? Return only the item name in uppercase.",
  "Return no explanation, punctuation, Markdown, or additional text."
].join("\n");


function pdfObject(id: number, body: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n`, "ascii"),
    typeof body === "string" ? Buffer.from(body, "ascii") : body,
    Buffer.from("\nendobj\n", "ascii")
  ]);
}

function buildImageOnlyProbePdf(): Buffer {
  const compressedRaster = deflateSync(receiptProbeRaster(), { level: 9 });
  const content = Buffer.from(
    `q\n${PDF_INPUT_PROBE_WIDTH} 0 0 ${PDF_INPUT_PROBE_HEIGHT} 0 0 cm\n/Im0 Do\nQ\n`,
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
  maxOutputTokens?: number;
}>;

export type ProviderPdfInputProbe = Readonly<{
  /** Null means a statically unsupported adapter; inconclusive answers throw. */
  probe(input: ProviderPdfInputProbeInput): Promise<PdfInputVerificationEvidence | null>;
}>;

type ProbeOptions = Readonly<{
  disableRequestRetries?: boolean;
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
  const requestedTokens = input.maxOutputTokens ?? PDF_INPUT_PROBE_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = Math.min(requestedTokens, declaredModelOutputTokenLimit(input.model, input.providerFamily) ?? requestedTokens);
  const fixture = imageOnlyPdfInputProbeFixture();
  const responsesAdapter = input.model.adapterKind === "openai_responses_native" ||
    input.model.adapterKind === "openai_responses_compatible";
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
      maxOutputTokens,
      maxTokens: maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      ...(responsesAdapter
        ? { reasoning: { effort: lowestConfiguredReasoningEffort(input.model, input.providerFamily), summary: "none" } }
        : {}),
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
    options: { allowFake: false, fetchFn, disableRequestRetries: options.disableRequestRetries },
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
        !supportsPdfInputAdapter(input.model.adapterKind)
      ) return null;

      const stream = adapterFor(input, options).stream(probeRequest(input), {
        signal: input.signal
      });
      let next = await stream.next();
      while (!next.done) next = await stream.next();
      input.signal?.throwIfAborted();
      const finishReason = next.value.finalProviderResponsePreview.finishReason;
      if (finishReason === "length" || finishReason === "content_filter" ||
        next.value.finalText.trim() !== PDF_INPUT_PROBE_ANSWER) {
        throw Object.assign(new Error("pdf_input_probe_inconclusive"), finishReason === "length" || finishReason === "content_filter"
          ? { capabilityFailureReason: finishReason === "length" ? "budget_exhausted" : "refusal" } : {});
      }
      return pdfInputVerificationEvidence(
        input.model.adapterKind,
        input.model.upstreamModelId
      );
    }
  };
}

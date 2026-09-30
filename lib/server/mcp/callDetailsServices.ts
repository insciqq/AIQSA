import type { PrismaClient } from "@prisma/client";
import { createMcpCallDetailsService } from "./callDetails";
import { createPrismaMcpCallDetailsRepository } from "./callDetailsRepository";
import { getStoredObjectStream, isStoredObjectMissingError, type StorageAdapter } from "../uploads/storage";
import { ObservationReadError, OBSERVATION_READ_LIMITS } from "../toolObservations/byteReader";
import { readMcpDisplayOriginal } from "../toolObservations/mcpDisplayReader";
import { admitToolObservation } from "../toolObservations/admission";
import { mcpDisplayRedactionValues } from "./resultRedaction";

export function mcpCallDetailsForStorage(prisma: PrismaClient, storage: StorageAdapter) {
  return createMcpCallDetailsService({ repository: createPrismaMcpCallDetailsRepository(prisma),
    async readObservation(row, signal) {
      const original = row.observation;
      if (!original?.checksum || !original.byteSize || original.byteSize > OBSERVATION_READ_LIMITS.documentBytes) return null;
      const identity = { byteSize: original.byteSize, checksum: original.checksum };
      const readSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
      try {
        return await admitToolObservation(256 * 1024, async () => {
          let body: ReadableStream<Uint8Array>;
          if (original.storageMode === "INLINE" && original.inlineText !== null) {
            const bytes = Buffer.from(original.inlineText, "utf8");
            body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
          } else if (original.storageMode === "OBJECT" && original.storageKey) {
            body = (await getStoredObjectStream(storage, original.storageKey, { requireStreaming: true, maxBytes: original.byteSize!, signal: readSignal })).body;
          } else return null;
          return readMcpDisplayOriginal({ body, identity, secrets: mcpDisplayRedactionValues(row.values), signal: readSignal });
        }, { signal: readSignal, whenBusy: "reject" });
      } catch (error) {
        if (isStoredObjectMissingError(error) || error instanceof ObservationReadError && !error.transient) return null;
        throw error;
      }
    }
  });
}

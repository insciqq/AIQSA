import { MemoryConsumerServiceError } from "../../../lib/server/memory/consumer/service";

export async function missingMemoryReference(
  get: (userId: string, memoryRef: string) => Promise<unknown>,
  userId: string,
  memoryRef: string
): Promise<boolean> {
  try {
    await get(userId, memoryRef);
    return false;
  } catch (error) {
    if (error instanceof MemoryConsumerServiceError && error.code === "memory_not_found") return true;
    throw error;
  }
}

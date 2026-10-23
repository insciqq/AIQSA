import { createToolObservationRepository } from "./repository";
import { createToolObservationService } from "./service";
import { createObservationSourceOwners } from "./sourceOwners";

export async function defaultToolObservations() {
  const [{ prisma }, { createS3StorageAdapter }] = await Promise.all([import("../prisma"), import("../uploads/storage")]);
  const storage = createS3StorageAdapter();
  const repository = createToolObservationRepository({ prisma, ...createObservationSourceOwners() });
  return createToolObservationService({ repository, storage });
}

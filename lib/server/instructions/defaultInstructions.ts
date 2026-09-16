import { prisma } from "../prisma";
import { createInstructionPresetStore } from "./store";

export const defaultInstructionPresets = createInstructionPresetStore(prisma);

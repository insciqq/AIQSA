export type UploadPermitGateSnapshot = {
  active: number;
  capacity: number;
  rejected: number;
};

export type UploadPermitGate = {
  snapshot(): UploadPermitGateSnapshot;
  tryAcquire(): (() => void) | null;
};

export function createUploadPermitGate(capacity: number): UploadPermitGate {
  let active = 0;
  let rejected = 0;

  return {
    snapshot() {
      return { active, capacity, rejected };
    },
    tryAcquire() {
      if (active >= capacity) {
        rejected = Math.min(Number.MAX_SAFE_INTEGER, rejected + 1);
        if (Number.isInteger(Math.log2(rejected))) {
          console.warn(JSON.stringify({ active, capacity, event: "aiqsa_upload_busy", rejected }));
        }
        return null;
      }

      active += 1;
      let released = false;

      return () => {
        if (released) {
          return;
        }

        released = true;
        active = Math.max(0, active - 1);
      };
    }
  };
}

let defaultGate: { capacity: number; gate: UploadPermitGate } | null = null;

export function resolveUploadPermitGate(capacity: number): UploadPermitGate {
  if (!defaultGate || (defaultGate.capacity !== capacity && defaultGate.gate.snapshot().active === 0)) {
    defaultGate = { capacity, gate: createUploadPermitGate(capacity) };
  }

  return defaultGate.gate;
}

export const AUTH_RESPONSE_FLOOR_MS = 100;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function waitForAuthResponseFloor(input: {
  clock: () => number;
  floorMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  startedAtMs: number;
}): Promise<void> {
  const remainingMs = Math.max(
    0,
    (input.floorMs ?? AUTH_RESPONSE_FLOOR_MS) - (input.clock() - input.startedAtMs)
  );

  if (remainingMs > 0) {
    await (input.sleep ?? defaultSleep)(remainingMs);
  }
}

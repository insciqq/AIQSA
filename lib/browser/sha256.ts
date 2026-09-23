/** Upload integrity also works on an operator-admitted non-loopback HTTP origin. */
export async function sha256(bytes: ArrayBuffer): Promise<string> {
  let digest: Uint8Array;
  if (globalThis.crypto?.subtle) digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  else {
    const { Sha256 } = await import("@aws-crypto/sha256-js");
    const hash = new Sha256();
    hash.update(new Uint8Array(bytes));
    digest = await hash.digest();
  }
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

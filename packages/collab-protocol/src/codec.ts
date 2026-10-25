/**
 * Ported from https://github.com/can1357/oh-my-pi (MIT License)
 * Upstream files:
 * - packages/collab-web/src/lib/codec.ts
 * - packages/coding-agent/src/collab/crypto.ts
 */

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const FULL_KEY_LENGTH = 48;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy as Uint8Array<ArrayBuffer>;
}

export function generateRoomKey(): Uint8Array {
  const key = new Uint8Array(KEY_LENGTH);
  globalThis.crypto.getRandomValues(key);
  return key;
}

/**
 * Import a 32-byte (view) or 48-byte (full control) raw secret into an AES-GCM CryptoKey.
 * Full links contain a 16-byte write token appended to the 32-byte room key.
 */
export async function importRoomKey(secret: Uint8Array): Promise<{ key: CryptoKey; writeToken?: Uint8Array }> {
  if (secret.byteLength !== KEY_LENGTH && secret.byteLength !== FULL_KEY_LENGTH) {
    throw new Error(`Room key secret must be 32 or 48 bytes, got ${secret.byteLength}`);
  }
  const rawKey = secret.subarray(0, KEY_LENGTH);
  const writeToken = secret.byteLength === FULL_KEY_LENGTH ? secret.subarray(KEY_LENGTH) : undefined;
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    asStrict(rawKey),
    AES_ALGORITHM,
    false,
    ["encrypt", "decrypt"]
  );
  return { key, writeToken };
}

/**
 * Seal data using AES-256-GCM.
 * Output layout: `[12B IV][ciphertext + tag]`.
 */
export async function seal(key: CryptoKey, plaintext: unknown): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_LENGTH);
  globalThis.crypto.getRandomValues(iv);
  let encoded: Uint8Array;
  if (typeof plaintext === "string") {
    encoded = TEXT_ENCODER.encode(plaintext);
  } else if (plaintext instanceof Uint8Array) {
    encoded = plaintext;
  } else {
    encoded = TEXT_ENCODER.encode(JSON.stringify(plaintext));
  }
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, asStrict(encoded))
  );
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, IV_LENGTH);
  return out;
}

/**
 * Inverse of seal. Throws on authentication failure or corrupted/tampered bytes.
 */
export async function open<T = unknown>(key: CryptoKey, sealed: Uint8Array): Promise<T> {
  if (sealed.byteLength <= IV_LENGTH) {
    throw new Error("Sealed frame too short");
  }
  const iv = asStrict(sealed.subarray(0, IV_LENGTH));
  const ciphertext = asStrict(sealed.subarray(IV_LENGTH));
  const decrypted = new Uint8Array(
    await globalThis.crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext)
  );
  const decodedText = TEXT_DECODER.decode(decrypted);
  try {
    return JSON.parse(decodedText) as T;
  } catch {
    return decodedText as unknown as T;
  }
}

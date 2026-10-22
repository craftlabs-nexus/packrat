/**
 * Hashing helpers (Web Crypto): lowercase hex digests, and the runner's
 * default check of downloaded bytes against the hashes a pack lists. The
 * SHA-512 is what Modrinth's version_files API looks up and what a consumer
 * keeps to recognise a JAR it already holds (`ExistingSource.sha512`).
 */

type Bytes = ArrayBuffer | Uint8Array;

async function digestHex(
  algorithm: "SHA-1" | "SHA-256" | "SHA-512",
  data: Bytes,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    algorithm,
    data as ArrayBuffer | Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Lowercase hex SHA-512 of the given bytes. */
export function sha512Hex(data: Bytes): Promise<string> {
  return digestHex("SHA-512", data);
}

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(data: Bytes): Promise<string> {
  return digestHex("SHA-256", data);
}

/** Lowercase hex SHA-1 of the given bytes. */
export function sha1Hex(data: Bytes): Promise<string> {
  return digestHex("SHA-1", data);
}

function hasWebCrypto(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

/**
 * Like {@link sha512Hex}, but undefined when Web Crypto is unavailable
 * (insecure contexts such as plain http on a LAN address) or fails.
 */
export async function trySha512Hex(data: Bytes): Promise<string | undefined> {
  if (!hasWebCrypto()) return undefined;
  try {
    return await sha512Hex(data);
  } catch {
    return undefined;
  }
}

/** The hashes a pack lists for a file (hex, any case). */
export interface ExpectedHashes {
  sha512?: string;
  sha1?: string;
  sha256?: string;
}

/**
 * "ok": every expected hash matched; "mismatch": one did not;
 * "unavailable": nothing could be checked (no expected hash, or no hashing).
 */
export type HashCheck = "ok" | "mismatch" | "unavailable";

const DIGESTS = { sha512: sha512Hex, sha256: sha256Hex, sha1: sha1Hex } as const;

/**
 * The runner's default `verify`: checks every expected hash with Web Crypto
 * (case-insensitive). "unavailable" when none is given, or when Web Crypto
 * is missing (insecure context) or fails.
 */
export async function verifyWithWebCrypto(
  data: Bytes,
  expected: ExpectedHashes,
): Promise<HashCheck> {
  const algorithms = (["sha512", "sha256", "sha1"] as const).filter((a) => expected[a]);
  if (algorithms.length === 0 || !hasWebCrypto()) return "unavailable";
  try {
    for (const a of algorithms) {
      if ((await DIGESTS[a](data)) !== expected[a]!.toLowerCase()) return "mismatch";
    }
    return "ok";
  } catch {
    return "unavailable";
  }
}

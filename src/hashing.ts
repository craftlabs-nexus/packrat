/**
 * Hashing helpers (Web Crypto). Used to identify JARs by content: the
 * SHA-512 is stored on JarSource and is what Modrinth's version_files API
 * looks up.
 */

/** Lowercase hex SHA-512 of the given bytes. */
export async function sha512Hex(
  data: ArrayBuffer | Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-512",
    data as ArrayBuffer | Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Like {@link sha512Hex}, but undefined when Web Crypto is unavailable
 * (insecure contexts such as plain http on a LAN address) or fails.
 */
export async function trySha512Hex(
  data: ArrayBuffer | Uint8Array,
): Promise<string | undefined> {
  if (typeof crypto === "undefined" || !crypto.subtle) return undefined;
  try {
    return await sha512Hex(data);
  } catch {
    return undefined;
  }
}

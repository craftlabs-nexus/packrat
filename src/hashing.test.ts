import { describe, expect, it, vi } from "vitest";
import { sha1Hex, sha256Hex, sha512Hex, trySha512Hex, verifyWithWebCrypto } from "./hashing";

// FIPS 180 test vectors for "abc"
const ABC = new TextEncoder().encode("abc");
const SHA1 = "a9993e364706816aba3e25717850c26c9cd0d89d";
const SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA512 =
  "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";

describe("hashing", () => {
  it("computes one known vector per algorithm", async () => {
    expect(await sha1Hex(ABC)).toBe(SHA1);
    expect(await sha256Hex(ABC)).toBe(SHA256);
    expect(await sha512Hex(ABC)).toBe(SHA512);
    expect(await sha512Hex(ABC.buffer)).toBe(SHA512);
    expect(await trySha512Hex(ABC)).toBe(SHA512);
  });

  it("verifies every expected hash, case-insensitively", async () => {
    expect(await verifyWithWebCrypto(ABC, { sha512: SHA512.toUpperCase() })).toBe("ok");
    expect(await verifyWithWebCrypto(ABC, { sha1: SHA1, sha256: SHA256 })).toBe("ok");
    expect(await verifyWithWebCrypto(ABC, { sha512: SHA512, sha1: "00" })).toBe("mismatch");
    expect(await verifyWithWebCrypto(ABC, { sha256: "00" })).toBe("mismatch");
    expect(await verifyWithWebCrypto(ABC, {})).toBe("unavailable");
  });

  it("is unavailable without Web Crypto", async () => {
    vi.stubGlobal("crypto", {});
    try {
      expect(await verifyWithWebCrypto(ABC, { sha512: SHA512 })).toBe("unavailable");
      expect(await trySha512Hex(ABC)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifyDownloadUrl,
  describeBlockedDownload,
  describeBlockedGroup,
  isInternalHost,
  isPrivateIp,
  type ClassifyContext,
  type UrlVerdict,
} from "./downloadUrl";

const HTTPS: ClassifyContext = { pageProtocol: "https:" };

describe("classifyDownloadUrl", () => {
  const cases: [string, ClassifyContext, UrlVerdict][] = [
    // 1. invalid
    ["not a url", HTTPS, { kind: "blocked", reason: "invalid-url", detail: "not a URL" }],
    ["file:///C:/mods/a.jar", HTTPS, { kind: "blocked", reason: "invalid-url", detail: "file:// URL" }],
    ["ftp://files.example/a.jar", HTTPS, { kind: "blocked", reason: "invalid-url", detail: "ftp:// URL" }],
    [
      "https://user:pw@files.example/a.jar",
      HTTPS,
      { kind: "blocked", reason: "invalid-url", detail: "credentials in the URL" },
    ],
    // 2. pack origin wins over the internal-host and http rules
    ["http://pack/jars/a.jar", { ...HTTPS, packOrigin: "http://pack" }, { kind: "ok", via: "pack-origin" }],
    [
      "http://192.168.1.24:8080/mods/a.jar",
      { pageProtocol: "https:", packOrigin: "http://192.168.1.24:8080" },
      { kind: "ok", via: "pack-origin" },
    ],
    // the port is part of the origin
    [
      "http://192.168.1.24:9000/a.jar",
      { pageProtocol: "http:", packOrigin: "http://192.168.1.24:8080" },
      { kind: "blocked", reason: "internal-host", detail: "192.168.1.24:9000" },
    ],
    // 3. loopback (even http on an https page)
    ["http://localhost:8080/a.jar", HTTPS, { kind: "ok", via: "loopback" }],
    ["http://mods.localhost/a.jar", HTTPS, { kind: "ok", via: "loopback" }],
    ["http://127.0.0.2/a.jar", HTTPS, { kind: "ok", via: "loopback" }],
    ["http://0x7f.1/a.jar", HTTPS, { kind: "ok", via: "loopback" }],
    ["http://[::1]:25565/a.jar", HTTPS, { kind: "ok", via: "loopback" }],
    ["http://[::ffff:127.0.0.1]/a.jar", HTTPS, { kind: "ok", via: "loopback" }],
    // 4. internal hosts
    ["http://pack/jars/a.jar", HTTPS, { kind: "blocked", reason: "internal-host", detail: "pack" }],
    ["http://pack./jars/a.jar", HTTPS, { kind: "blocked", reason: "internal-host", detail: "pack." }],
    ["https://nas.local/a.jar", HTTPS, { kind: "blocked", reason: "internal-host", detail: "nas.local" }],
    ["https://mc.home.arpa/a.jar", HTTPS, { kind: "blocked", reason: "internal-host", detail: "mc.home.arpa" }],
    ["http://10.0.0.5/a.jar", { pageProtocol: "http:" }, { kind: "blocked", reason: "internal-host", detail: "10.0.0.5" }],
    ["https://172.20.1.1/a.jar", HTTPS, { kind: "blocked", reason: "internal-host", detail: "172.20.1.1" }],
    ["https://169.254.1.1/a.jar", HTTPS, { kind: "blocked", reason: "internal-host", detail: "169.254.1.1" }],
    ["https://[fd00::1]/a.jar", HTTPS, { kind: "blocked", reason: "internal-host", detail: "[fd00::1]" }],
    ["https://[fe80::1]/a.jar", HTTPS, { kind: "blocked", reason: "internal-host", detail: "[fe80::1]" }],
    // 5. mixed content, only on an https page
    ["http://files.example/a.jar", HTTPS, { kind: "blocked", reason: "mixed-content", detail: "files.example" }],
    ["http://files.example/a.jar", { pageProtocol: "http:" }, { kind: "unverified", host: "files.example" }],
    // 6. known good
    ["https://cdn.modrinth.com/data/x/versions/y/a.jar", HTTPS, { kind: "ok", via: "known-host" }],
    ["https://CDN.Modrinth.com/data/x/a.jar", HTTPS, { kind: "ok", via: "known-host" }],
    ["https://raw.githubusercontent.com/o/r/main/a.jar", HTTPS, { kind: "ok", via: "known-host" }],
    // 7. known blocked
    [
      "https://github.com/o/r/releases/download/v1/a.jar",
      HTTPS,
      { kind: "blocked", reason: "host-no-cors", detail: "github.com" },
    ],
    [
      "https://objects.githubusercontent.com/x/a.jar",
      HTTPS,
      { kind: "blocked", reason: "host-no-cors", detail: "objects.githubusercontent.com" },
    ],
    ["https://gitlab.com/o/r/-/raw/main/a.jar", HTTPS, { kind: "blocked", reason: "host-no-cors", detail: "gitlab.com" }],
    [
      "https://edge.forgecdn.net/files/1/2/a.jar",
      HTTPS,
      { kind: "blocked", reason: "host-no-cors", detail: "edge.forgecdn.net" },
    ],
    // 8. the rest
    ["https://github.com/o/r/raw/main/a.jar", HTTPS, { kind: "unverified", host: "github.com" }],
    ["https://files.example:8443/a.jar", HTTPS, { kind: "unverified", host: "files.example:8443" }],
    ["https://bücher.example/a.jar", HTTPS, { kind: "unverified", host: "xn--bcher-kva.example" }],
    ["https://203.0.113.9/a.jar", HTTPS, { kind: "unverified", host: "203.0.113.9" }],
  ];

  it.each(cases)("%s (%o)", (url, ctx, expected) => {
    expect(classifyDownloadUrl(url, ctx)).toEqual(expected);
  });
});

describe("isInternalHost / isPrivateIp", () => {
  it("knows private ranges and their edges", () => {
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("[2001:db8::1]")).toBe(false);
    expect(isPrivateIp("[::ffff:c0a8:118]")).toBe(true); // 192.168.1.24
  });

  it("treats single labels and local suffixes as internal", () => {
    expect(isInternalHost("pack")).toBe(true);
    expect(isInternalHost("server.lan")).toBe(true);
    expect(isInternalHost("db.internal")).toBe(true);
    expect(isInternalHost("box.localdomain")).toBe(true);
    expect(isInternalHost("gg.craftlabs.nexus")).toBe(false);
    expect(isInternalHost("[2001:db8::1]")).toBe(false);
  });
});

describe("blocked copy", () => {
  it("describes a row and a group of rows", () => {
    const internal = { kind: "blocked", reason: "internal-host", detail: "pack" } as const;
    expect(describeBlockedDownload(internal)).toBe("internal host pack (not reachable from a web page)");
    expect(describeBlockedGroup(internal, 12)).toBe(
      "12 files on pack are internal to the server; a folder import gets them.",
    );
    expect(describeBlockedGroup(internal, 1)).toBe(
      "1 file on pack is internal to the server; a folder import gets it.",
    );
    expect(
      describeBlockedDownload({ kind: "blocked", reason: "host-no-cors", detail: "github.com" }),
    ).toBe("github.com doesn't allow downloads from a web page");
    expect(
      describeBlockedDownload({ kind: "blocked", reason: "mixed-content", detail: "files.example" }),
    ).toBe("http:// download (blocked on an https page)");
  });
});

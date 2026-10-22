import { afterEach, describe, expect, it, vi } from "vitest";
import { getProjects, getVersionsFromHashes, MODRINTH_API_BASE } from "./modrinth";

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("getProjects", () => {
  it("asks for the ids as a JSON array in one query", async () => {
    const fetchMock = stubFetch(() => Response.json([{ id: "P1" }]));
    expect(await getProjects(["P1", "slug-2"])).toEqual([{ id: "P1" }]);
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${MODRINTH_API_BASE}/projects`);
    expect(JSON.parse(parsed.searchParams.get("ids")!)).toEqual(["P1", "slug-2"]);
    expect(init?.headers).toEqual({ Accept: "application/json" });
  });

  it("sends the configured User-Agent to the configured base", async () => {
    const fetchMock = stubFetch(() => Response.json([]));
    await getProjects(["P1"], { userAgent: "craftlabs/test/1.0", baseUrl: "https://api.test/v2" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.startsWith("https://api.test/v2/projects?ids=")).toBe(true);
    expect(init?.headers).toEqual({ Accept: "application/json", "User-Agent": "craftlabs/test/1.0" });
  });

  it("makes no request for an empty list and throws on a non-OK response", async () => {
    const fetchMock = stubFetch(() => new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
    expect(await getProjects([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(getProjects(["P1"])).rejects.toThrow("Modrinth API error: 429 Too Many Requests");
  });
});

describe("getVersionsFromHashes", () => {
  it("posts the hashes and the algorithm as JSON", async () => {
    const fetchMock = stubFetch(() => Response.json({ aa: { id: "V1" } }));
    expect(await getVersionsFromHashes(["aa", "bb"], "sha1", { userAgent: "ua" })).toEqual({ aa: { id: "V1" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${MODRINTH_API_BASE}/version_files`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Accept: "application/json",
      "User-Agent": "ua",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ hashes: ["aa", "bb"], algorithm: "sha1" });
  });

  it("makes no request for an empty list and throws on a non-OK response", async () => {
    const fetchMock = stubFetch(() => new Response("", { status: 500, statusText: "Internal Server Error" }));
    expect(await getVersionsFromHashes([], "sha512")).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(getVersionsFromHashes(["aa"], "sha512")).rejects.toThrow("Modrinth API error: 500");
  });
});

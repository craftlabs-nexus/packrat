/**
 * packwiz pack by URL: pack.toml -> index.toml -> one .pw.toml metafile per
 * mod (download URL, hash, side, Modrinth/CurseForge ids). Paths in the
 * index are relative to the index file. The host must allow cross-origin
 * requests (CORS), e.g. GitHub Pages, a CDN or a local server with CORS;
 * the plan checks each mod's download URL (downloadUrl.ts).
 */
import { parse as parseToml } from "smol-toml";
import { getErrorMessage } from "../utils";
import { currentPageProtocol, isMixedContent, parseWebUrl } from "../downloadUrl";
import { isJarFilename } from "../jarScan";
import { createLimiter } from "../limiter";
import {
  describeZodError,
  indexTomlSchema,
  packTomlSchema,
  safeRelativePath,
} from "../schemas";
import {
  PackImportError,
  type PackAnalysis,
  type PackEntry,
  type PackLoaderId,
} from "../types";
import { applyPwToml, parsePwToml } from "./folder";

export const PACKWIZ_FETCH_CONCURRENCY = 6;

/** Top-level folders whose metafiles are never mods (not fetched). */
const NON_MOD_FOLDERS = new Set([
  "resourcepacks",
  "shaderpacks",
  "datapacks",
  "config",
  "defaultconfigs",
  "kubejs",
]);

const LOADER_KEYS: PackLoaderId[] = ["fabric", "neoforge", "forge", "quilt"];

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Accept http(s) URLs a page can fetch: https, or http on an http page
 * (dev server) or for this machine (local test servers). The download URL
 * rules' parse and mixed-content checks (downloadUrl.ts).
 */
export function validatePackUrl(raw: string, pageProtocol = currentPageProtocol()): URL {
  const parsed = parseWebUrl(raw);
  if (!parsed.ok && parsed.problem === "not-a-url") {
    throw new PackImportError(
      "UNSUPPORTED_INPUT",
      "Enter the full URL of a packwiz pack.toml (https://...)",
    );
  }
  if (!parsed.ok && parsed.problem === "credentials") {
    throw new PackImportError(
      "UNSUPPORTED_INPUT",
      "The pack URL can't contain a user name or password",
    );
  }
  if (!parsed.ok || isMixedContent(parsed.url, pageProtocol)) {
    throw new PackImportError(
      "UNSUPPORTED_INPUT",
      "The pack URL must use https:// (http:// only for localhost)",
    );
  }
  return parsed.url;
}

async function fetchText(fetchImpl: FetchImpl, url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "text/plain, */*" },
    });
  } catch {
    throw new PackImportError(
      "FETCH_FAILED",
      `Could not fetch ${url}. The pack host must allow cross-origin requests (CORS) and be reachable.`,
    );
  }
  if (!response.ok) {
    throw new PackImportError(
      "FETCH_FAILED",
      `${response.status} fetching ${url}`,
    );
  }
  return response.text();
}

function parseTomlOrThrow(text: string, what: string): unknown {
  try {
    return parseToml(text);
  } catch (e) {
    throw new PackImportError(
      "INVALID_PACK",
      `${what} is not valid TOML: ${getErrorMessage(e)}`,
    );
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A pack file's URL: `path` must be a safe relative path (no `..`, no
 * leading `/`, so no `//host`) and resolve to the pack.toml's origin
 * (no absolute URL elsewhere); undefined otherwise.
 */
function packFileUrl(path: string, base: URL, packUrl: URL): URL | undefined {
  if (!safeRelativePath.safeParse(path).success) return undefined;
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    return undefined;
  }
  return url.origin === packUrl.origin ? url : undefined;
}

export const OUTSIDE_THE_PACK = "outside the pack";

export async function analyzePackwiz(
  packUrl: string,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
): Promise<PackAnalysis> {
  const url = validatePackUrl(packUrl);

  const pack = packTomlSchema.safeParse(
    parseTomlOrThrow(await fetchText(fetchImpl, url.href), "pack.toml"),
  );
  if (!pack.success) {
    throw new PackImportError(
      "INVALID_PACK",
      `Invalid pack.toml: ${describeZodError(pack.error)}`,
    );
  }

  const indexUrl = packFileUrl(pack.data.index.file, url, url);
  if (!indexUrl) {
    throw new PackImportError(
      "INVALID_PACK",
      `pack.toml's index file ${pack.data.index.file} is outside the pack`,
    );
  }
  const index = indexTomlSchema.safeParse(
    parseTomlOrThrow(await fetchText(fetchImpl, indexUrl.href), "index.toml"),
  );
  if (!index.success) {
    throw new PackImportError(
      "INVALID_PACK",
      `Invalid index.toml: ${describeZodError(index.error)}`,
    );
  }
  const indexHashFormat = index.data["hash-format"]?.toLowerCase();

  const limit = createLimiter(PACKWIZ_FETCH_CONCURRENCY);
  const tasks: Promise<PackEntry | undefined>[] = [];
  for (const f of index.data.files) {
    const path = f.file.replace(/^\.\//, "");
    if (NON_MOD_FOLDERS.has(path.split("/")[0])) continue;
    const isMetafile = f.metafile === true && path.endsWith(".pw.toml");
    const isPackJar = !f.metafile && path.startsWith("mods/") && isJarFilename(path);
    if (!isMetafile && !isPackJar) continue;
    const fileUrl = packFileUrl(path, indexUrl, url)?.href;
    if (!fileUrl) {
      tasks.push(
        Promise.resolve({
          key: f.file,
          filename: basename(path).replace(/\.pw\.toml$/, ""),
          unresolvable: OUTSIDE_THE_PACK,
        }),
      );
      continue;
    }

    if (isMetafile) {
      tasks.push(
        limit(async (): Promise<PackEntry | undefined> => {
          let text: string;
          try {
            text = await fetchText(fetchImpl, fileUrl);
          } catch (e) {
            return {
              key: fileUrl,
              filename: basename(path).replace(/\.pw\.toml$/, ""),
              unresolvable: getErrorMessage(e),
            };
          }
          const pw = parsePwToml(text);
          if (!pw) {
            return {
              key: fileUrl,
              filename: basename(path),
              unresolvable: "invalid .pw.toml",
            };
          }
          if (!isJarFilename(pw.filename)) return undefined;
          const entry: PackEntry = { key: fileUrl, filename: pw.filename };
          applyPwToml(entry, pw);
          if (pw.download.url) {
            entry.origin = { type: "remote", url: pw.download.url };
          } else if (pw.download.mode === "metadata:curseforge") {
            entry.unresolvable =
              "CurseForge-hosted (not downloadable in the browser)";
          } else {
            entry.unresolvable = "no download URL";
          }
          return entry;
        }),
      );
    } else {
      // A JAR stored in the pack itself
      const entry: PackEntry = {
        key: fileUrl,
        filename: basename(path),
        origin: { type: "remote", url: fileUrl },
      };
      if (f.hash && indexHashFormat === "sha512") entry.sha512 = f.hash.toLowerCase();
      if (f.hash && indexHashFormat === "sha1") entry.sha1 = f.hash.toLowerCase();
      tasks.push(Promise.resolve(entry));
    }
  }

  const entries = (await Promise.all(tasks)).filter(
    (e): e is PackEntry => e !== undefined,
  );

  const versions = pack.data.versions ?? {};
  const loaderId = LOADER_KEYS.find((k) => versions[k]);

  return {
    manifest: {
      kind: "packwiz",
      name: pack.data.name,
      // pack.toml and the index loaded from here, so its files are reachable
      packOrigin: url.origin,
      minecraftVersion: versions.minecraft,
      loader: loaderId ? { id: loaderId, version: versions[loaderId] } : undefined,
    },
    entries,
  };
}

/**
 * The two Modrinth API calls the resolver makes, and the parts of their
 * responses it reads (https://docs.modrinth.com/api/). Browser and worker
 * safe: plain fetch, no token (both endpoints are public).
 *
 * Modrinth asks every client for a unique User-Agent: pass it in
 * `config.userAgent` (resolveModrinth's `config`, BuildPlanContext's
 * `modrinth`). The Fetch spec no longer forbids the header; Chromium and
 * Firefox send it, Safari drops it, and in a browser it costs a CORS
 * preflight (the page's Origin identifies it either way). The limit is 300
 * requests per minute per IP; the resolver batches hashes (200) and project
 * ids (100).
 */

export const MODRINTH_API_BASE = "https://api.modrinth.com/v2";

export interface ModrinthClientConfig {
  /** Sent as User-Agent (dropped by runtimes that refuse it, such as Safari) */
  userAgent?: string;
  /** Another API base (tests, a proxy) */
  baseUrl?: string;
}

export type SideRequirement = "required" | "optional" | "unsupported" | "unknown";

/** A project as GET /projects returns it (the fields the resolver reads, and the rest as Modrinth sends them). */
export interface ModrinthProjectDetails {
  id: string;
  slug: string;
  title: string;
  description: string;
  client_side: SideRequirement;
  server_side: SideRequirement;
  project_type: string;
  icon_url: string | null;
  downloads: number;
  versions: string[];
  license?: { id: string; name: string; url: string | null };
  [key: string]: unknown;
}

export interface ModrinthFile {
  hashes: { sha512: string; sha1: string };
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  file_type: string | null;
}

/** A version as POST /version_files returns it. */
export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: "release" | "beta" | "alpha";
  files: ModrinthFile[];
  game_versions: string[];
  loaders: string[];
  date_published: string;
  [key: string]: unknown;
}

function headers(config?: ModrinthClientConfig): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (config?.userAgent) h["User-Agent"] = config.userAgent;
  return h;
}

async function failed(response: Response): Promise<never> {
  throw new Error(`Modrinth API error: ${response.status} ${response.statusText}`);
}

/** GET /projects?ids=[...]: several projects at once (none for an empty list, without a request). */
export async function getProjects(
  projectIds: string[],
  config?: ModrinthClientConfig,
): Promise<ModrinthProjectDetails[]> {
  if (projectIds.length === 0) return [];
  const url = new URL(`${config?.baseUrl ?? MODRINTH_API_BASE}/projects`);
  url.searchParams.set("ids", JSON.stringify(projectIds));
  const response = await fetch(url.toString(), { headers: headers(config) });
  if (!response.ok) await failed(response);
  return response.json();
}

/**
 * POST /version_files: the version of each known hash, keyed by hash;
 * hashes Modrinth does not know are absent ({} for an empty list, without
 * a request).
 */
export async function getVersionsFromHashes(
  hashes: string[],
  algorithm: "sha1" | "sha512",
  config?: ModrinthClientConfig,
): Promise<Record<string, ModrinthVersion>> {
  if (hashes.length === 0) return {};
  const response = await fetch(`${config?.baseUrl ?? MODRINTH_API_BASE}/version_files`, {
    method: "POST",
    headers: { ...headers(config), "Content-Type": "application/json" },
    body: JSON.stringify({ hashes, algorithm }),
  });
  if (!response.ok) await failed(response);
  return response.json();
}

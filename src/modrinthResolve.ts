/**
 * Resolve pack entries to Modrinth projects: file hashes to versions
 * (POST /version_files), then project ids to titles, icons and side
 * requirements (GET /projects). Modrinth allows CORS from any origin.
 * Failures are not fatal: the plan just lacks Modrinth details.
 */
import { getErrorMessage } from "./utils";
import {
  getProjects,
  getVersionsFromHashes,
  type ModrinthClientConfig,
} from "./modrinth";
import {
  modrinthProjectLiteSchema,
  modrinthVersionLiteSchema,
  type ModrinthProjectLite,
} from "./schemas";
import type { ModrinthProjectInfo } from "./types";

export const HASH_BATCH_SIZE = 200;
export const PROJECT_BATCH_SIZE = 100;

export interface ResolveInput {
  key: string;
  sha512?: string;
  sha1?: string;
  modrinth?: { projectId?: string; versionId?: string };
}

export interface ResolvedModrinth {
  projectId: string;
  versionId?: string;
  project?: ModrinthProjectInfo;
  /**
   * Modrinth's download URL for the file whose sha512 matched the entry's
   * (sha512 lookups only): the plan downloads it when the pack's own URL
   * can't be fetched from a web page.
   */
  cdnUrl?: string;
}

export interface ResolveResult {
  resolved: Map<string, ResolvedModrinth>;
  /** Set when a lookup failed (the result is then partial) */
  warning?: string;
}

export interface ResolveDeps {
  getVersionsFromHashes: (
    hashes: string[],
    algorithm: "sha1" | "sha512",
  ) => Promise<Record<string, unknown>>;
  getProjects: (ids: string[]) => Promise<unknown[]>;
}

export interface ResolveOptions {
  /** For the default Modrinth calls: User-Agent, API base */
  config?: ModrinthClientConfig;
  /** Other calls in place of Modrinth's (tests, a cache); config is then unused */
  deps?: ResolveDeps;
}

function clientDeps(config?: ModrinthClientConfig): ResolveDeps {
  return {
    getVersionsFromHashes: (hashes, algorithm) =>
      getVersionsFromHashes(hashes, algorithm, config),
    getProjects: (ids) => getProjects(ids, config),
  };
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function toProjectInfo(p: ModrinthProjectLite): ModrinthProjectInfo {
  return {
    id: p.id,
    title: p.title,
    iconUrl: p.icon_url ?? null,
    clientSide: p.client_side,
    serverSide: p.server_side,
  };
}

/**
 * Resolve entries on Modrinth: ceil(n/200) sha512 lookups, then a sha1 pass
 * for the entries with only a sha1, then ceil(p/100) project lookups.
 * `options` is `{ config?, deps? }`; a bare ResolveDeps (the 0.1 form) still
 * works.
 */
export async function resolveModrinth(
  entries: ResolveInput[],
  options: ResolveOptions | ResolveDeps = {},
): Promise<ResolveResult> {
  const opts: ResolveOptions =
    "getVersionsFromHashes" in options ? { deps: options } : options;
  const deps = opts.deps ?? clientDeps(opts.config);
  const resolved = new Map<string, ResolvedModrinth>();
  const failures: string[] = [];

  // Entries that already carry a project id (packwiz/Prism .index, mrpack)
  for (const e of entries) {
    if (e.modrinth?.projectId) {
      resolved.set(e.key, {
        projectId: e.modrinth.projectId,
        versionId: e.modrinth.versionId,
      });
    }
  }

  // 1. Hashes without ids -> versions
  for (const algorithm of ["sha512", "sha1"] as const) {
    const pending = entries.filter(
      (e) =>
        !resolved.has(e.key) &&
        e[algorithm] &&
        (algorithm === "sha512" || !e.sha512),
    );
    const byHash = new Map<string, string[]>();
    for (const e of pending) {
      const hash = e[algorithm]!.toLowerCase();
      byHash.set(hash, [...(byHash.get(hash) ?? []), e.key]);
    }
    for (const batch of chunks([...byHash.keys()], HASH_BATCH_SIZE)) {
      try {
        const versions = await deps.getVersionsFromHashes(batch, algorithm);
        for (const [hash, raw] of Object.entries(versions ?? {})) {
          const parsed = modrinthVersionLiteSchema.safeParse(raw);
          if (!parsed.success) continue;
          const queried = hash.toLowerCase();
          const cdnUrl =
            algorithm === "sha512"
              ? parsed.data.files.find(
                  (f) => f.hashes.sha512?.toLowerCase() === queried,
                )?.url
              : undefined;
          for (const key of byHash.get(queried) ?? []) {
            resolved.set(key, {
              projectId: parsed.data.project_id,
              versionId: parsed.data.id,
              ...(cdnUrl ? { cdnUrl } : {}),
            });
          }
        }
      } catch (e) {
        failures.push(getErrorMessage(e));
      }
    }
  }

  // 2. Project ids -> project details
  const projectIds = [...new Set([...resolved.values()].map((r) => r.projectId))];
  const projects = new Map<string, ModrinthProjectInfo>();
  for (const batch of chunks(projectIds, PROJECT_BATCH_SIZE)) {
    try {
      for (const raw of (await deps.getProjects(batch)) ?? []) {
        const parsed = modrinthProjectLiteSchema.safeParse(raw);
        if (!parsed.success) continue;
        const info = toProjectInfo(parsed.data);
        projects.set(parsed.data.id, info);
        // packwiz "mod-id" is usually the id, but accept a slug too
        projects.set(parsed.data.slug, info);
      }
    } catch (e) {
      failures.push(getErrorMessage(e));
    }
  }
  for (const r of resolved.values()) {
    const project = projects.get(r.projectId);
    if (project) {
      r.project = project;
      r.projectId = project.id;
    }
  }

  return {
    resolved,
    warning:
      failures.length > 0
        ? `Modrinth lookup failed: ${failures[0]}; client-only detection and mod names may be incomplete`
        : undefined,
  };
}

/**
 * Build the reviewable import plan from a pack analysis: hash and scan
 * local JARs, check remote download URLs, resolve Modrinth projects, and
 * give every entry a status (import / skip with a reason / unresolvable).
 */
import { getErrorMessage } from "./utils";
import { trySha512Hex } from "./hashing";
import {
  classifyDownloadUrl,
  describeBlockedDownload,
  describeBlockedGroup,
  type ClassifyContext,
  type UrlVerdict,
} from "./downloadUrl";
import { scanJar } from "./jarScan";
import { resolveModrinth, type ResolveResult } from "./modrinthResolve";
import type {
  ExistingSource,
  ImportPlan,
  LocalJarScan,
  PackAnalysis,
  PackEntry,
  PackFileOrigin,
  ReviewRow,
  ReviewStatus,
  VersionAction,
} from "./types";

/** The parts of a bundled vanilla version the plan needs. */
export interface BundledVersionRef {
  version: string;
  coversVersions: string[];
}

export interface BuildPlanContext {
  existingSources: ExistingSource[];
  availableVersions: BundledVersionRef[];
  selectedBundledVersion: string;
  /** Version of an imported client JAR (it overrides the bundled data) */
  importedClientVersion?: string;
  /** location.protocol: an https page can't download http:// files */
  pageProtocol: string;
  resolve?: (entries: PackEntry[]) => Promise<ResolveResult>;
  scan?: (buffer: ArrayBuffer) => Promise<LocalJarScan>;
  hash?: (buffer: ArrayBuffer) => Promise<string | undefined>;
  /** Progress of the local JAR scan */
  onProgress?: (done: number, total: number) => void;
}

/** A source's display name, as the Sources modal shows it. */
export function sourceDisplayName(s: ExistingSource): string {
  return (
    s.displayName || s.modDisplayName || s.modId || s.filename.replace(/\.jar$/i, "")
  );
}

/** Which bundled version to propose for the pack's Minecraft version. */
export function proposeVersionAction(
  minecraftVersion: string | undefined,
  ctx: Pick<
    BuildPlanContext,
    "availableVersions" | "selectedBundledVersion" | "importedClientVersion"
  >,
): VersionAction {
  const v = minecraftVersion;
  if (!v) return { kind: "none" };
  if (ctx.importedClientVersion) {
    return {
      kind: "note",
      text: `Using your imported client (${ctx.importedClientVersion}); the pack targets Minecraft ${v}`,
    };
  }
  const match = ctx.availableVersions.find(
    (a) => a.version === v || a.coversVersions.includes(v),
  );
  if (!match) {
    return {
      kind: "note",
      text: `The pack targets Minecraft ${v}; there is no bundled data for it, keeping ${ctx.selectedBundledVersion}`,
    };
  }
  if (match.version === ctx.selectedBundledVersion) return { kind: "none" };
  return { kind: "switch", to: match.version };
}

type RemoteOrigin = Extract<PackFileOrigin, { type: "remote" }>;
type BlockedVerdict = Extract<UrlVerdict, { kind: "blocked" }>;

const VERDICT_RANK: Record<UrlVerdict["kind"], number> = {
  ok: 0,
  unverified: 1,
  blocked: 2,
};

/**
 * Of a remote file's URLs (url + altUrls, e.g. an mrpack's mirrors), make
 * the first one a page can fetch the primary; the rest stay alternatives.
 */
function chooseDownload(
  origin: RemoteOrigin,
  urlCtx: ClassifyContext,
): { origin: RemoteOrigin; verdict: UrlVerdict } {
  const candidates = [origin.url, ...(origin.altUrls ?? [])];
  const verdicts = candidates.map((u) => classifyDownloadUrl(u, urlCtx));
  let best = 0;
  verdicts.forEach((v, i) => {
    if (VERDICT_RANK[v.kind] < VERDICT_RANK[verdicts[best].kind]) best = i;
  });
  if (best === 0) return { origin, verdict: verdicts[0] };
  const altUrls = candidates.filter((_, i) => i !== best);
  return { origin: { ...origin, url: candidates[best], altUrls }, verdict: verdicts[best] };
}

export async function buildPlan(
  input: PackAnalysis,
  ctx: BuildPlanContext,
): Promise<ImportPlan> {
  const scan = ctx.scan ?? scanJar;
  const hash = ctx.hash ?? trySha512Hex;
  const resolve = ctx.resolve ?? resolveModrinth;
  const notes = [...(input.notes ?? [])];

  // 1. Local JARs: hash (the actual bytes win over a possibly stale .index
  //    hash) and scan. One buffer at a time; the runner re-reads the File.
  const entries = input.entries.map((e) => ({ ...e }));
  const scans = new Map<string, LocalJarScan>();
  const unreadable = new Map<string, string>();
  const locals = entries.filter((e) => e.origin?.type === "local");
  let done = 0;
  ctx.onProgress?.(0, locals.length);
  for (const entry of locals) {
    if (entry.origin?.type !== "local") continue;
    try {
      const buffer = await entry.origin.file.arrayBuffer();
      const sha512 = await hash(buffer);
      if (sha512) entry.sha512 = sha512;
      scans.set(entry.key, await scan(buffer));
    } catch (e) {
      unreadable.set(entry.key, `Not a readable JAR: ${getErrorMessage(e)}`);
    }
    ctx.onProgress?.(++done, locals.length);
  }

  // 2. Remote downloads: can the page fetch them? (static, no network)
  const urlCtx: ClassifyContext = {
    pageProtocol: ctx.pageProtocol,
    packOrigin: input.manifest.packOrigin,
  };
  const verdicts = new Map<string, UrlVerdict>();
  for (const entry of entries) {
    if (entry.unresolvable || entry.origin?.type !== "remote") continue;
    const chosen = chooseDownload(entry.origin, urlCtx);
    entry.origin = chosen.origin;
    verdicts.set(entry.key, chosen.verdict);
  }

  // 3. Modrinth projects (non-fatal). Blocked entries are looked up too:
  //    Modrinth may host the same file.
  let resolved: ResolveResult["resolved"] = new Map();
  const lookups = entries.filter(
    (e) => !e.unresolvable && (e.sha512 || e.sha1 || e.modrinth?.projectId),
  );
  if (lookups.length > 0) {
    try {
      const result = await resolve(lookups);
      resolved = result.resolved;
      if (result.warning) notes.push(result.warning);
    } catch (e) {
      notes.push(`Modrinth lookup failed: ${getErrorMessage(e)}`);
    }
  }

  // 4. A blocked download whose sha512 Modrinth knows comes from Modrinth's
  //    CDN instead (the runner checks the bytes against entry.sha512)
  for (const entry of entries) {
    const cdnUrl = resolved.get(entry.key)?.cdnUrl;
    if (
      verdicts.get(entry.key)?.kind !== "blocked" ||
      !cdnUrl ||
      !entry.sha512 ||
      entry.origin?.type !== "remote" ||
      classifyDownloadUrl(cdnUrl, urlCtx).kind === "blocked"
    ) {
      continue;
    }
    const original = [entry.origin.url, ...(entry.origin.altUrls ?? [])];
    entry.origin = { ...entry.origin, url: cdnUrl, altUrls: original };
    verdicts.set(entry.key, { kind: "ok", via: "modrinth-substitute" });
  }

  // 5. Status per entry (first match wins)
  const blockedGroups = new Map<string, { verdict: BlockedVerdict; count: number }>();
  const seenHashes = new Set<string>();
  const seenModIds = new Set<string>();
  const seenProjects = new Set<string>();
  const rows: ReviewRow[] = entries.map((entry) => {
    const s = scans.get(entry.key);
    const modrinth = resolved.get(entry.key);
    const project = modrinth?.project;
    const download = verdicts.get(entry.key);

    const status = ((): ReviewStatus => {
      if (entry.unresolvable) {
        return { kind: "unresolvable", reason: entry.unresolvable };
      }
      const unreadableReason = unreadable.get(entry.key);
      if (unreadableReason) {
        return { kind: "unresolvable", reason: unreadableReason };
      }

      const existing =
        (entry.sha512 &&
          ctx.existingSources.find((x) => x.sha512 === entry.sha512)) ||
        (modrinth &&
          ctx.existingSources.find(
            (x) => x.modrinthProjectId === modrinth.projectId,
          )) ||
        (s?.modId &&
          ctx.existingSources.find(
            (x) => x.type === "mod" && x.modId === s.modId,
          )) ||
        ctx.existingSources.find(
          (x) => x.type !== "bundled" && x.filename === entry.filename,
        );
      if (existing) {
        return {
          kind: "skip",
          reason: "already-imported",
          detail: sourceDisplayName(existing),
        };
      }

      if (download?.kind === "blocked") {
        const group = `${download.reason}\0${download.detail}`;
        const counted = blockedGroups.get(group) ?? { verdict: download, count: 0 };
        counted.count++;
        blockedGroups.set(group, counted);
        return { kind: "unresolvable", reason: describeBlockedDownload(download) };
      }

      const duplicate =
        (entry.sha512 && seenHashes.has(entry.sha512)) ||
        (s?.modId && seenModIds.has(s.modId)) ||
        (modrinth && seenProjects.has(modrinth.projectId));
      if (entry.sha512) seenHashes.add(entry.sha512);
      if (s?.modId) seenModIds.add(s.modId);
      if (modrinth) seenProjects.add(modrinth.projectId);
      if (duplicate) return { kind: "skip", reason: "duplicate-in-pack" };

      if (s && !s.hasClassFiles) {
        return {
          kind: "skip",
          reason: "no-items",
          detail: "no code (resource/data pack or jar-in-jar)",
        };
      }
      // A mod with code but no items of its own can still add item tags
      // (e.g. c:chains listing other mods' chains): import those.
      const tagsOnly = !!s && !s.hasItemDefinitions;
      if (s && tagsOnly && !s.hasItemTags) {
        return {
          kind: "skip",
          reason: "no-items",
          detail: "no items or item tags (library)",
        };
      }

      if (
        entry.side === "client" ||
        (project &&
          project.serverSide === "unsupported" &&
          project.clientSide !== "unsupported")
      ) {
        return { kind: "skip", reason: "client-only" };
      }

      if (entry.optional) return { kind: "skip", reason: "optional" };

      return tagsOnly ? { kind: "import", tagsOnly: true } : { kind: "import" };
    })();

    const selectable =
      status.kind === "import" ||
      (status.kind === "skip" &&
        (status.reason === "client-only" || status.reason === "optional"));

    return {
      entry,
      status,
      selectable,
      selected: status.kind === "import",
      title: project?.title ?? s?.displayName ?? entry.filename,
      iconUrl: project?.iconUrl ?? undefined,
      modrinthProject: project,
      modrinthProjectId: modrinth?.projectId,
      modrinthVersionId: modrinth?.versionId,
      scan: s,
      download,
    };
  });

  // One note per blocked host instead of a reason on each of its rows only
  for (const { verdict, count } of blockedGroups.values()) {
    notes.push(describeBlockedGroup(verdict, count));
  }

  rows.sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );

  return {
    manifest: input.manifest,
    rows,
    versionAction: proposeVersionAction(input.manifest.minecraftVersion, ctx),
    notes,
  };
}

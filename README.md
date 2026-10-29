# Packrat

Reads a Minecraft modpack from wherever it is, plans its import and fetches its JARs, entirely on the client: no
server, nothing uploaded, every file read or fetched by the page (or worker, or Node script) itself. It hoards packs
from every source:

- **a launcher instance or mods folder** (`analyzeFolder`): finds the mods folder (Prism/MultiMC `.minecraft/mods`
  preferred, a choice when several), reads `mods/.index/*.pw.toml` (Prism and packwiz: Modrinth ids, side, hashes)
  and the instance files (`mmc-pack.json`, `instance.cfg`, `minecraftinstance.json`, ATLauncher `instance.json`,
  Modrinth app `profile.json`; the nearest one wins) for the name, Minecraft version and loader; a zipped folder works
  too (`analyzeModsZip`);
- **a Modrinth `.mrpack`** (`analyzeMrpack`): the remote mods from its index (every listed download as `url` plus
  `altUrls`, hashes, client/server env) and the override JARs;
- **a CurseForge zip** (`analyzeCurseforgeZip`): the `overrides/mods` JARs; the listed CurseForge files cannot be
  downloaded without an API key and come back unresolvable, with one note;
- **a packwiz `pack.toml` URL** (`analyzePackwiz`): the index and metafiles resolved relative to it; the host must
  allow CORS (its origin is `manifest.packOrigin`); `metadata:curseforge` entries are unresolvable.

`detectPackZip` tells the three zip kinds apart (`analyzePackZip` detects and analyzes, reading the zip once). Every
pack file is validated with zod (`schemas.ts`). Paths are kept inside the pack: an `.mrpack` entry with an unsafe path
is dropped (with a note); a packwiz index or file must be a safe relative path that resolves to the `pack.toml`'s
origin, so an absolute URL, a `//host` or a `../` path is never fetched (an index outside the pack is an
`INVALID_PACK` error, a file outside it an unresolvable entry, "outside the pack").

**The plan** (`buildPlan`): hashes and scans the local JARs (`scanJar`: class files, item definitions and item tags
from the zip directory, the mod's id and name from its loader metadata), resolves the files on Modrinth by hash
(`resolveModrinth`; a failure is a note, not an error), checks each remote download URL without a network probe
(`classifyDownloadUrl`: same origin as the pack, loopback, internal hosts, mixed content, a known allow and block
list) and gives every entry a status: import, already imported, duplicate in the pack, client-only, optional,
unresolvable, or what the content rule says. Of a file's mirrors the first a page can fetch becomes the URL; the other
unblocked ones stay `altUrls`, a blocked one is never kept. A blocked download whose sha512 Modrinth knows is fetched
from Modrinth's CDN instead (unless that URL is blocked too).

What a JAR is for is the consumer's. The plan's `contentStatus` rule sees each scanned local JAR after the
already-imported and duplicate checks: the default, `itemContentRule`, is CategoryCraft's (no code: skipped "no
items"; code but neither items nor item tags: skipped; item tags only: imported "tags only"); pass your own, or `null`
for none. `skipClientOnly: false` keeps client-only mods ticked. The runner reports what the consumer's `commit`
returns and never looks inside an extraction.

**The run**, in two stages. `fetchRows` downloads up to `downloadConcurrency` (3) files ahead, verifies every hash
the pack lists (sha512, sha256, sha1) and yields each selected row's bytes in plan order; it retries a failed
connection on the file's alternative URLs and trips a per-host breaker: any `TypeError` from `download` counts as a
connect failure, the first row on that host fails and later ones are skipped without a request, though the rows
already in the download window have started theirs, so a blocked host costs up to `downloadConcurrency` requests.
`runImport` composes it with the consumer's `extract` and `commit`, one JAR at a time (memory: one extraction plus a
few downloads). Both cancel on the signal (whatever a download rejects with once it has fired); sources already
committed stay. `RunOptions.allowUrl` refuses a URL before it is fetched; `requireHash` fails a row whose listed hash
could not be checked (Web Crypto is missing on an insecure page); `ImportMetadata.hashVerified` says whether the bytes
matched, and its `sha512` is the verified or computed one, never the pack's unchecked claim.

Also exported: `extractModMetadata` (Fabric, Quilt, Forge and NeoForge metadata in one pass), the hash helpers
(`sha512Hex`, `sha256Hex`, `sha1Hex`, `verifyWithWebCrypto`), the URL rules (`parseWebUrl`, `isMixedContent`,
`isInternalHost`, `isPrivateIp`, `describeBlockedDownload`) and the two Modrinth calls.

## Use

CategoryCraft (items: the default content rule, its bundled vanilla data, its own store):

```ts
import { analyzeFolder, buildPlan, fromFileList, runImport } from "@craftlabs/packrat";

const analysis = await analyzeFolder(fromFileList(input.files));
const plan = await buildPlan(analysis, {
  existingSources: myStore.sources.map(toExistingSource), // sha512, modrinthProjectId, modId, filename
  availableVersions: [{ version: "26.2", coversVersions: ["26.2", "26.2.1"] }],
  selectedBundledVersion: "26.2",
});
// show plan.rows (grouped with rowGroup and DEFAULT_ROW_GROUP_LABELS), let the user tick and untick, then:
const summary = await runImport(plan.rows, {
  download: (url, filename, { onProgress, signal }) => myDownload(url, { onProgress, signal }),
  extract: (buffer, filename) => myExtract(buffer, filename),
  commit: async (result, metadata) => {
    const tags = Object.keys(result.data.tags).length;
    if (result.data.items.length === 0 && !(result.hasCode && tags > 0)) {
      return { status: "skipped", reason: "no items" };
    }
    const added = await myStore.add(result, { ...metadata, importSource: "pack" });
    return { status: added.status, counts: { items: added.itemCount, tags: added.tagCount } };
  },
}, { signal: controller.signal, packName: plan.manifest.name, onRow: (key, progress) => render(key, progress) });
// summary.counts: { items, tags } summed over the imported JARs
```

`ExistingSource` matches by sha512, Modrinth project, mod id and filename; `matchByModId` and `matchByFilename`
(default true) turn the last two off per source. CategoryCraft maps its `JarSource.type` to them: `"bundled"` →
`{ matchByModId: false, matchByFilename: false }`, `"mod"` → neither set, any other type →
`{ matchByModId: false }` (what `type` did in 0.1).

Blockscope (a resource pack from the user's mods: client mods included, nothing about items):

```ts
import { analyzePackwiz, buildPlan, fetchRows } from "@craftlabs/packrat";

const analysis = await analyzePackwiz(packUrl, { signal });
const plan = await buildPlan(analysis, {
  skipClientOnly: false,
  contentStatus: null,                                    // every readable JAR is wanted
  modrinth: { userAgent: "craftlabs-nexus/blockscope/1.0" },
});
const run = fetchRows(plan.rows, { download: (url, _name, { signal }) => fetchFile(url, signal) }, {
  signal,
  requireHash: true,
});
for await (const { row, buffer } of run) {
  await addToResourcePack(row.entry.filename, buffer);    // the next JARs download meanwhile
}
console.log(run.summary.failed, run.summary.skipped);     // complete once the loop ends
```

`fetchRows` returns an async generator with a `summary` (skipped, failed, notRun, cancelled) that is complete when
the iteration ends; iterate it once. Breaking out of the loop aborts the downloads in flight (the rows not yet
yielded are left out of the summary).

The package is one ES module with its type declarations, built by tsup into `dist/index.js`, whose only imports are
its three dependencies (jszip, smol-toml, zod); it runs anywhere ES modules do, a bundler or Node 20+ alike.

## Modrinth

Modrinth's API license covers querying and downloading through your own service; its terms permit personal,
non-commercial use. Packrat keeps to them: lookups only on the user's own action (the 300 requests per minute limit
is per IP, the user's), no scraping, no inline linking of Modrinth's content. A plan of n hashed files costs ceil(n/200)
sha512 lookups (`POST /version_files`), a sha1 pass for the files that have only a sha1, and ceil(p/100) project
lookups (`GET /projects`) for the p projects found.

Modrinth asks every client for a unique `User-Agent`: pass it as `BuildPlanContext.modrinth.userAgent` (or
`resolveModrinth(entries, { config: { userAgent } })`). The Fetch spec no longer forbids the header: Chromium and
Firefox send one a page sets, Safari drops it, and in a browser it costs a CORS preflight (the request's `Origin`
identifies the page either way). A worker or Node caller should always set it.

## Breaking changes in 0.2.0

- `RunnerDeps.hash` is gone: `verify(buffer, { sha512?, sha256?, sha1? })` returns `"ok" | "mismatch" |
  "unavailable"` (optional, default `verifyWithWebCrypto`), and `sha512(buffer)` (optional, default `trySha512Hex`)
  computes the SHA-512 reported when verify did not confirm the pack's.
- The runner no longer judges an extraction: `RunnerDeps<R>` is unconstrained (`ExtractedJar` is gone) and a JAR
  with no items is committed like any other. `commit` returns `{ status: "added" | "duplicate" | "skipped"; reason?;
  counts? }` instead of `{ status, itemCount, tagCount }`; a `"skipped"` row is in the summary as
  `"commit-skipped"` with the reason as its detail (CategoryCraft's "no items" check moves into its `commit`, see
  above). `isNoContent` still makes an extraction error a `"no-items"` skip.
- `RowProgress` `done` carries `counts` instead of `itemCount`/`tagCount`; `ImportSummary.counts` replaces `items` and
  `tags`.
- `ImportMetadata.importSource` is gone (the consumer adds its own); `hashVerified` is new; `sha512` is never the
  pack's unchecked hash.
- `ROW_GROUPS` is `DEFAULT_ROW_GROUP_LABELS` (same shape).
- `ExistingSource.type` is replaced by `matchByModId` and `matchByFilename` (see the mapping above). A source that set
  no `type` used to match by filename only; it now matches by mod id too unless `matchByModId: false`.
- `getProjects` and `getVersionsFromHashes` return the response unparsed (`unknown`); `ModrinthProjectDetails`,
  `ModrinthVersion` and `ModrinthFile` are the zod-inferred types of the fields the resolver reads.
- Behaviour: a blocked mirror is no longer kept in `altUrls`; a blocked group's plan note no longer ends with "a
  folder import gets them"; `analyzePackwiz` rethrows an abort as it is instead of a `FETCH_FAILED` error; a packwiz
  path outside the pack is refused.

Still accepted: `analyzeFolder(files, preferred?, fallbackName?)` beside `analyzeFolder(files, { preferred?,
fallbackName? })`, `analyzePackwiz(url, fetch)` beside `analyzePackwiz(url, { fetch?, signal?, pageProtocol? })`, and
`resolveModrinth(entries, deps)` beside `resolveModrinth(entries, { config?, deps? })`. `BuildPlanContext`'s
`availableVersions`, `selectedBundledVersion`, `existingSources` and `pageProtocol` (default `currentPageProtocol()`)
are optional; without `availableVersions`, `versionAction` is `{ kind: "none" }`.

## Development

```
pnpm install
pnpm run check    # typecheck, lint, tests, build
```

pnpm (the version is in `package.json`'s `packageManager`). `pnpm-workspace.yaml` keeps `node_modules` flat and
installs the Windows and Linux x64 native binaries both, so a checkout shared by Windows and WSL runs from either.

Tests are vitest in Node (synthetic JARs built in `src/test/jarFixtures.ts`; no real mod JAR is committed).

## Provenance

Carved out of [CategoryCraft](https://categorycraft.pages.dev)'s pack import on 2026-10-22, so that it could be
shared with [Blockscope](https://github.com/craftlabs-nexus/blockscope), a schematic viewer that builds its resource
pack from the user's own mods. MIT, see `LICENSE`.

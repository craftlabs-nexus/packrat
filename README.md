# Packrat

Reads a Minecraft modpack from wherever it is and plans its import, entirely in the browser: no server, nothing
uploaded, every file read or fetched by the page itself. It hoards packs from every source:

- **a launcher instance or mods folder** (`analyzeFolder`): finds the mods folder (Prism/MultiMC `.minecraft/mods`
  preferred, a choice when several), reads `mods/.index/*.pw.toml` (Prism and packwiz: Modrinth ids, side, hashes)
  and the instance files (`mmc-pack.json`, `instance.cfg`, `minecraftinstance.json`, ...) for the name, Minecraft
  version and loader; a zipped folder works too (`analyzeModsZip`);
- **a Modrinth `.mrpack`** (`analyzeMrpack`): the remote mods from its index (every listed download as `url` plus
  `altUrls`, hashes, client/server env) and the override JARs;
- **a CurseForge zip** (`analyzeCurseforgeZip`): the `overrides/mods` JARs; the listed CurseForge files cannot be
  downloaded without an API key and come back unresolvable, with one note;
- **a packwiz `pack.toml` URL** (`analyzePackwiz`): the index and metafiles resolved relative to it; the host must
  allow CORS (its origin is `manifest.packOrigin`); `metadata:curseforge` entries are unresolvable.

`detectPackZip` tells the three zip kinds apart. Every pack file is validated with zod (`schemas.ts`; unsafe paths are
dropped).

**The plan** (`buildPlan`): hashes and scans the local JARs (`scanJar`: class files, item definitions and item tags
from the zip directory, the mod's id and name from its loader metadata), resolves the files on Modrinth by sha512
(`resolveModrinth`: one batched `POST /version_files`, then `GET /projects`; a failure is a note, not an error), checks
each remote download URL without a network probe (`classifyDownloadUrl`: same origin as the pack, loopback, internal
hosts, mixed content, a known allow and block list), and gives every entry a status: import, tags only, already
imported, duplicate in the pack, no items, client-only, optional, unresolvable. A blocked download whose hash Modrinth
knows is fetched from Modrinth's CDN instead.

**The run** (`runImport`): downloads up to three files ahead while it verifies hashes, extracts and commits one JAR at
a time (memory: one extraction plus a few downloads), cancels between rows, retries a failed connection on the file's
alternative URLs, and trips a per-host breaker so one blocked host costs one request. What "extract" and "commit" do
is the caller's (`RunnerDeps`): Packrat never decides what a JAR is for.

Also exported: `extractModMetadata` (Fabric, Quilt, Forge and NeoForge metadata in one pass), `sha512Hex`, and the
two Modrinth calls.

## Use

```ts
import { analyzeFolder, buildPlan, runImport, fromFileList } from "@craftlabs-nexus/packrat";

const analysis = await analyzeFolder(fromFileList(input.files));
const plan = await buildPlan(analysis, {
  existingSources: myStore.sources,            // sha512, modrinthProjectId, modId, filename
  availableVersions: [{ version: "26.2", coversVersions: ["26.2", "26.2.1"] }],
  selectedBundledVersion: "26.2",
  pageProtocol: location.protocol,
});
// show plan.rows, let the user tick and untick, then:
const summary = await runImport(plan.rows, {
  download: (url, filename, { onProgress, signal }) => myDownload(url, { onProgress, signal }),
  extract: (buffer, filename) => myExtract(buffer, filename),   // anything with { hasCode, data: { items, tags } }
  commit: (result, metadata) => myStore.add(result, metadata),
  hash: trySha512Hex,
}, { signal: controller.signal, onRow: (key, progress) => render(key, progress) });
```

The package is ES modules with type declarations, built by `tsc` without file extensions on its imports, so it is
meant for a bundler (Vite, esbuild, webpack), which is where a browser library runs anyway.

## Modrinth

Modrinth's API license covers querying and downloading through your own service; its terms permit personal,
non-commercial use. Packrat keeps to them: one batched hash lookup per pack on the user's own action (the 300 requests
per minute limit is per IP, the user's), no scraping, no inline linking of Modrinth's content. Modrinth asks every
client for a unique `User-Agent`; a browser cannot set one (the request's `Origin` identifies the page), a worker or
Node caller passes it in `ModrinthClientConfig.userAgent`.

## Development

```
npm install
npm run check     # typecheck, lint, tests, build
```

Tests are vitest in Node (synthetic JARs built in `src/test/jarFixtures.ts`; no real mod JAR is committed).

## Provenance

Carved out of [CategoryCraft](https://categorycraft.pages.dev)'s pack import on 2026-10-22, so that it could be
shared with [Blockscope](https://github.com/craftlabs-nexus/blockscope), a schematic viewer that builds its resource
pack from the user's own mods. MIT, see `LICENSE`.

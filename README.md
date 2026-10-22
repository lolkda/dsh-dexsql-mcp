# @lolkda/dsh-dexsql-mcp

[![ci](https://github.com/lolkda/dsh-dexsql-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/lolkda/dsh-dexsql-mcp/actions/workflows/ci.yml)
[![publish](https://github.com/lolkda/dsh-dexsql-mcp/actions/workflows/publish.yml/badge.svg)](https://github.com/lolkda/dsh-dexsql-mcp/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/@lolkda/dsh-dexsql-mcp.svg)](https://www.npmjs.com/package/@lolkda/dsh-dexsql-mcp)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that connects [DexSQL](https://github.com/LSPosed/dexsql-release) to DSH through the official `@deepseek-ai/dsh-mcp-client` Host plugin.

The published npm package contains:

- the DSH bundle configuration;
- a small launcher;
- the DexSQL binaries for all six supported platforms.

Installing the bundle is the only installation step. It does not require a separate `dexsql` installation, a global `PATH` entry, or a runtime download.

The git checkout remains configuration-only and is marked `private`. The release build downloads the compiled binaries from upstream, verifies their checksums, and publishes them inside the npm tarball.

## Requirements

- DSH `>=0.2.1-rc.2 <0.3.0`
- One of the supported platforms:
  - Linux x64 or arm64 (glibc)
  - macOS x64 or arm64
  - Windows x64 or arm64
- About 62MB for the npm tarball and 132MB after extraction, because all platforms are bundled

## Install

```bash
dsh plugin --profile web add @lolkda/dsh-dexsql-mcp
```

Or use the Web UI: **插件 → 添加插件**, then enter `@lolkda/dsh-dexsql-mcp`.

The package declares `dsh.bundle.patch`, so `dsh plugin add` registers it in `dsh.profile.bundles` automatically. After loading, the bundle inserts one row:

```text
dexsql-mcp -> @deepseek-ai/dsh-mcp-client
```

The MCP tools are exposed as `mcp__dexsql__*`.

## Use

Once connected, the server exposes:

- `open_dataset`, `list_datasets`, `close_dataset`
- `list_tables`, `describe_table`, `query`
- `decode`, `get_manifest`, `get_manifest_components`
- `list_resource_files`, `read_resource`, `query_resources`

Typical first call:

```text
Use mcp__dexsql__open_dataset with the absolute path to an APK or DEX file,
then mcp__dexsql__query against the returned dataset_id.
```

## Configuration

The default connection is in [cordis.patch.yml](cordis.patch.yml):

```yaml
- insert:
    - id: dexsql-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dexsql
        transport: stdio
        command: !!js process.execPath
        args:
          - !!js decodeURIComponent(new URL('./node_modules/@lolkda/dsh-dexsql-mcp/bin/dexsql.mjs', baseUrl).pathname).replace(/^\/([A-Za-z]:)/, '$1')
          - mcp
          - --timeout-ms
          - "300000"
        failOnStartupError: true
        toolCallTimeoutMs: 300000
```

`baseUrl` is the profile directory. The row starts the launcher at `node_modules/@lolkda/dsh-dexsql-mcp/bin/dexsql.mjs` in the same profile, so no global `dexsql` is needed.

`failOnStartupError: true` makes a missing launcher or broken DexSQL binary visible instead of silently dropping the tools. If you prefer best-effort startup, override it to `false`.

To use an external `dexsql` instead of the bundled binary, override the row in the profile's `cordis.patch.yml`:

```yaml
- id: dexsql-mcp
  config:
    command: /usr/local/bin/dexsql
    args: [mcp, --timeout-ms, "300000"]
```

## How it works

```text
@lolkda/dsh-dexsql-mcp (npm package)
  -> cordis.patch.yml (DSH configuration)
  -> @deepseek-ai/dsh-mcp-client (Host plugin)
  -> node .../node_modules/@lolkda/dsh-dexsql-mcp/bin/dexsql.mjs mcp
  -> vendor/<os>-<cpu>/dexsql[.exe]
  -> registers mcp__dexsql__* tools
```

The bundle reuses the official DSH MCP client for tool registration, schema handling, timeouts, reconnect behavior, and resources.

## Verify

Unit tests:

```bash
npm install
npm test
npm run pack:check
```

The sync and packaging tests run offline:

```bash
npm run test:sync
```

Stage a real upstream release without publishing:

```bash
npm run sync:dexsql -- --version 0.2.0 --out .build/npm
npm pack .build/npm/package --dry-run
```

The staged package is under `.build/npm/package`; `.build/npm/manifest.json` records the upstream tag, checksums, and whether the release was already packaged.

For local DSH testing, install the staged package rather than the source checkout, because the source checkout intentionally has no `vendor/` binaries:

```bash
dsh plugin --profile test add .build/npm/package
```

The MCP integration test is a direct binary smoke test and runs only when `dexsql` is on `PATH`:

```bash
npm run test:mcp
```

It performs a real `initialize` + `tools/list` handshake against `dexsql mcp`. The bundled launcher path is covered by the packaging tests and should also be checked in a temporary DSH profile before a release.

To inspect the composed DSH profile:

```bash
dsh --profile web --dump-config | grep -A 12 dexsql-mcp
```

## Automatic upstream sync

[publish.yml](.github/workflows/publish.yml) runs on every push to `main`, on published releases, on manual dispatch, and four times a day at 08:17, 12:17, 18:17, and 22:17 Asia/Shanghai. GitHub cron uses UTC, so the workflow expression is `17 0,4,10,14 * * *`.

Each run:

1. Resolves the latest stable release from `LSPosed/dexsql-release`.
2. Requires all six platform binaries, `LICENSE`, `LICENSE-AUXILIARY`, and `SHA256SUMS`.
3. Downloads the assets and verifies every checksum.
4. Refuses to republish if the upstream `LICENSE` is no longer the DexSQL Binary License or `LICENSE-AUXILIARY` is no longer MIT.
5. Checks the latest published npm package's `dexsql.version`.
6. If the upstream version is already packaged, exits without publishing.
7. Otherwise builds one npm package containing the launcher and all six binaries, increments the package patch version when needed, and publishes it with npm trusted publishing.

The package version is independent of the upstream DexSQL version. The upstream version is recorded in the package's `dexsql.version` field and in `vendor/manifest.json`. The first built-in release is `0.2.0` for DexSQL `0.1.1`; later upstream releases become `0.2.1`, `0.2.2`, and so on.

Manual dispatch supports a tag and a dry run:

```bash
gh workflow run publish.yml -f dry_run=true
gh workflow run publish.yml -f tag=v0.1.1 -f dry_run=false
```

The workflow never commits binaries; it stages them under `.build/npm` and publishes from the runner. It uses npm trusted publishing (`id-token: write` + `--provenance`) and does not use an `NPM_TOKEN` secret.

To pick up a new upstream release in an existing profile, update the plugin and restart:

```bash
dsh plugin --profile web add @lolkda/dsh-dexsql-mcp
```

The profile lockfile pins the installed package version, so a new npm release is not applied implicitly.

## Publishing

The first built-in publication can be done in either way:

- create a GitHub release `v0.2.0`; [publish.yml](.github/workflows/publish.yml) builds the package from the latest upstream release and publishes it;
- or run `gh workflow run publish.yml -f dry_run=false` to let the workflow choose the next version automatically.

The npm trusted publisher must be configured for:

- repository: `lolkda/dsh-dexsql-mcp`
- workflow: `publish.yml`
- permission: allow publish

The workflow publishes only the staged package `0.2.0` (or a later auto-selected version) from `.build/npm/package`; it does not publish separate platform packages. Publishing the repository root directly is intentionally blocked by `private: true` because that source package has no binaries.

The release tag must match `package.json` (`v0.2.0` for `0.2.0`). The workflow skips a package version that already exists on npm.

## Security

- The npm package contains a small MIT-licensed JavaScript launcher plus the compiled upstream binaries and their licenses.
- The sync workflow verifies every binary and license against the upstream `SHA256SUMS` before packaging, and npm publishes the tarball with provenance.
- The MCP client starts the launcher with the permissions of the DSH host process.
- Only open APK/DEX files you trust. DexSQL can read files accessible to that process.
- The DexSQL binary is closed-source and covered by the DexSQL Binary License 1.0. This repository redistributes only published compiled binaries and does not contain the engine source.

## License

MIT for the DSH bundle and launcher. DexSQL itself is distributed under the DexSQL Binary License 1.0; see the [DexSQL release repository](https://github.com/LSPosed/dexsql-release).

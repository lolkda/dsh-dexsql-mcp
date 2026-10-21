# @lolkda/dsh-dexsql-mcp

[![ci](https://github.com/lolkda/dsh-dexsql-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/lolkda/dsh-dexsql-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@lolkda/dsh-dexsql-mcp.svg)](https://www.npmjs.com/package/@lolkda/dsh-dexsql-mcp)

A configuration-only [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that connects [DexSQL](https://github.com/LSPosed/dexsql-release) to DSH through the official `@deepseek-ai/dsh-mcp-client` Host plugin.

It does not contain the DexSQL binary. Install `dexsql` separately and make sure it is on `PATH`.

## Requirements

- DSH `>=0.2.1-rc.2 <0.3.0`
- `dexsql` available on `PATH`
- A platform supported by both DSH and the DexSQL binary

Check the prerequisite:

```bash
dexsql --version
dexsql mcp --help
```

## Install

From npm:

```bash
dsh plugin --profile web add @lolkda/dsh-dexsql-mcp
```

Or use the Web UI: **插件 → 添加插件**, then enter the package name.

The package declares `dsh.bundle.patch`, so `dsh plugin add` registers it in `dsh.profile.bundles` automatically.

To install a local checkout during development:

```bash
dsh plugin --profile web add "link:$PWD"
```

Restart the profile if it does not use HMR. After loading, the bundle inserts one row:

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
        command: dexsql
        args:
          - mcp
          - --timeout-ms
          - "300000"
        failOnStartupError: true
        toolCallTimeoutMs: 300000
```

To use an absolute binary path, override the row in the profile's `cordis.patch.yml`:

```yaml
- id: dexsql-mcp
  config:
    command: /usr/local/bin/dexsql
```

`failOnStartupError: true` makes a missing or broken DexSQL installation visible instead of silently dropping the tools. If you prefer best-effort startup, override it to `false`.

## How it works

```text
@lolkda/dsh-dexsql-mcp (configuration-only bundle)
  -> inserts dexsql-mcp row
  -> @deepseek-ai/dsh-mcp-client (Host plugin)
  -> starts `dexsql mcp` as a stdio child process
  -> registers mcp__dexsql__* tools
```

This package is intentionally a configuration bundle, not a custom MCP implementation. It reuses the official DSH MCP client for tool registration, schema handling, timeouts, reconnect behavior, and resources.

## Verify

Unit tests:

```bash
npm install
npm test
npm run pack:check
```

The MCP integration test runs only when `dexsql` is on `PATH`:

```bash
npm run test:mcp
```

It performs a real `initialize` + `tools/list` handshake against `dexsql mcp`.

To inspect the composed DSH profile:

```bash
dsh --profile web --dump-config | grep -A 8 dexsql-mcp
```

## Publishing

The first publication is done locally so the npm package exists before trusted publishing is configured:

```bash
npm publish --access public --registry=https://registry.npmjs.org
```

After that, create a GitHub release and let [publish.yml](.github/workflows/publish.yml) publish subsequent versions through npm trusted publishing (OIDC). The workflow uses `id-token: write` and does not use an `NPM_TOKEN` secret.

The npm trusted publisher must be configured for:

- repository: `lolkda/dsh-dexsql-mcp`
- workflow: `publish.yml`
- permission: allow publish

The package version must match the release tag (`v0.1.0` for `0.1.0`). Do not publish a version that already exists on npm.

## Security

- This bundle itself has no executable JavaScript. It configures the official DSH MCP client.
- The MCP client starts `dexsql mcp` with the permissions of the DSH host process.
- Only open APK/DEX files you trust. DexSQL can read files accessible to that process.
- The DexSQL binary is closed-source and is covered by its own license; this package does not redistribute it.

## License

MIT for this bundle. DexSQL itself is distributed separately under the DexSQL Binary License 1.0; see the [DexSQL release repository](https://github.com/LSPosed/dexsql-release).

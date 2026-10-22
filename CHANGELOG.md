# Changelog

## 0.2.0

- Publish the launcher and DexSQL binaries for all six platforms inside `@lolkda/dsh-dexsql-mcp`, so installing the bundle is the only installation step and no global `PATH` entry is required.
- Add scheduled upstream sync to `publish.yml` at 08:17, 12:17, 18:17, and 22:17 Asia/Shanghai. It verifies upstream `SHA256SUMS` and licenses, builds the single package, and publishes new upstream versions through npm trusted publishing.
- Keep the git checkout configuration-only; the release build stages the binaries under `.build/npm/package`.
- Add offline tests for version resolution, release validation, checksum verification, package generation, and launcher resolution.

## 0.1.2

- Remove the custom plugin icon; the DSH plugin manager falls back to its default artwork.

## 0.1.1

- Publish through GitHub Actions with npm trusted publishing (OIDC).
- Add the publish workflow badge to the README.

## 0.1.0

- Initial configuration-only DSH bundle for DexSQL MCP.
- Requires `dexsql` on `PATH`; does not bundle the DexSQL binary.

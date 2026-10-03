# Upstream maintenance

Lonora forks `openclaw/openclaw`. Security fixes from upstream should be reviewed and merged selectively.

## How to take a fix

1. Read the upstream commit and the files it touches.
2. Prefer commits that stay inside the Gateway, plugin SDK, provider auth, Telegram, or secret handling.
3. Replay the patch onto this fork. Do not take product-copy or marketplace changes that fight the Lonora navigation.
4. Re-run `pnpm test extensions/lonora/src/lonora.test.ts --maxWorkers=1` and the UI navigation tests.
5. Record the upstream SHA in the PR.

## Do not delete during an upstream merge

- `extensions/*` you do not own. Hiding a surface is safer than deleting a plugin upstream still patches.
- MIT license headers and `LICENSE`.
- Internal CLI commands used by Doctor, migrations, and CI.

## Lonora-owned paths

- `extensions/lonora`
- `docs/lonora`
- Owner navigation in `ui/src/app-navigation.ts`
- Market and recommendation pages

Leave upstream names inside those runtime modules when renaming them would make the next security merge impossible to read.

# ClawHub publish checklist

Maintainer guide for publishing **@identyclaw/openclaw-identyclaw-webhooks-plugin** to ClawHub.

| Artifact | Command | ClawHub install |
| --- | --- | --- |
| Code plugin | `npm run publish:clawhub` | `openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-webhooks-plugin` |

This is **ClawHub registry login** — unrelated to IdentyClaw API login or RODiT Passport auth.

## Pre-flight

From the repository root, Node **≥ 22.19** (`.nvmrc`):

```bash
npm install
npm run prepare:publish
```

## ClawHub credentials

```bash
npx clawhub whoami   # must show access to publisher @identyclaw
```

### ClawHub CLI login

**Device flow (remote / headless):**

```bash
npx clawhub login --device
```

**API token:**

```bash
npx clawhub login --no-browser --token clh_<your-token>
```

See [ClawHub troubleshooting](https://docs.openclaw.ai/clawhub/troubleshooting#clawhub-login-opens-a-browser-but-never-completes).

## Dry run

```bash
npm run publish:clawhub:dry-run
```

Expected: family `code-plugin`, version from `package.json`, files `dist/index.js`, `openclaw.plugin.json`, `package.json`, `README.md`, `LICENSE`.

`prepare:publish` runs esbuild and `scripts/verify-pack.mjs` to ensure the npm pack tarball includes required plugin files and that `openclaw.plugin.json` version matches `package.json`.

## Publish

```bash
npm run publish:clawhub
```

Install after registry review:

```bash
openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-webhooks-plugin
```

## Post-publish

1. `npx clawhub package inspect @identyclaw/openclaw-identyclaw-webhooks-plugin`
2. `git tag openclaw-identyclaw-webhooks-plugin-v<version>`
3. Runtime test on a Gateway: enable `plugins.entries.identyclaw-webhooks`, POST signed webhook to `/hooks/wake`, exercise `send_rodit_webhook`
4. Security scan may show **pending** until review completes

## License

[Apache-2.0](./LICENSE). `package.json` must declare `"license": "Apache-2.0"`.

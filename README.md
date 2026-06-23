# OpenClaw IdentyClaw Webhooks Plugin

OpenClaw plugin for **RODiT-signed webhook ingress** on agent gateways (`/hooks/wake`, `/hooks/agent`) and outbound delivery via `send_rodit_webhook`.

Install alongside [`openclaw-a2a-idc-plugin`](https://github.com/discernible-io/openclaw-a2a-idc-plugin) and [`openclaw-identyclaw-plugin`](https://github.com/discernible-io/openclaw-identyclaw-plugin).

| Artifact | Install |
| --- | --- |
| **This plugin** (`identyclaw-webhooks`) | `openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-webhooks-plugin` |
| A2A plugin (`identyclaw-a2a`) | `openclaw plugins install clawhub:@identyclaw/openclaw-a2a-plugin` |
| IdentyClaw tools (`identyclaw-tools`) | `openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin` |

## Install

**ClawHub (recommended):**

```bash
openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-webhooks-plugin
```

**Git:**

```bash
openclaw plugins install https://github.com/discernible-io/openclaw-identyclaw-webhooks-plugin.git
```

**Local checkout:**

```bash
cd openclaw-identyclaw-webhooks-plugin
npm install
npm run build
openclaw plugins install .
```

## Plugin id

`identyclaw-webhooks` — enable in `openclaw.json`:

```json
"plugins": {
  "entries": {
    "identyclaw-webhooks": {
      "enabled": true,
      "config": {
        "endpoints": ["/hooks/wake", "/hooks/agent"],
        "logLevel": "error"
      }
    }
  }
}
```

## Requirements

- OpenClaw gateway **≥ 2026.5.27**
- NEAR Passport credentials (`NEAR_CREDENTIALS_FILE_PATH` or `secrets/near-credentials/*.json`)
- For outbound `send_rodit_webhook`: `plugins.entries.a2a.config.outbound.agents` peer map

## Build

```bash
npm install
npm run build
```

## Publish (maintainers)

See [PUBLISH.md](./PUBLISH.md). Pre-flight:

```bash
npm run prepare:publish
npm run publish:clawhub:dry-run
```

## License

[Apache-2.0](./LICENSE) — Copyright (c) Discernible IO.

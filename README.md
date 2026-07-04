# IdentyClaw Webhooks Gateway Component

> **IdentyClaw component service:** OpenClaw plugin for **RODiT-signed webhook ingress** on agent gateways (`/hooks/wake`, `/hooks/agent`) and outbound delivery via `send_rodit_webhook`. Webhook signing and verification follow the same contract as [`idclawserver-idc`](https://github.com/discernible-io/idclawserver-idc) (via [`@rodit/rodit-auth-be`](https://www.npmjs.com/package/@rodit/rodit-auth-be) — not vendored). See [`idclawserver-idc` OpenClaw integration guide](https://github.com/discernible-io/idclawserver-idc/blob/main/references/openclaw-integration-guide.md) for Passport `webhook_url` metadata and event mapping.

![IdentyClaw Webhooks Gateway Component](images/identyclaw-webhooks-banner.svg)

[![GitHub](https://img.shields.io/github/stars/discernible-io/openclaw-identyclaw-webhooks-plugin?style=social)](https://github.com/discernible-io/openclaw-identyclaw-webhooks-plugin) [![npm version](https://img.shields.io/npm/v/@identyclaw/openclaw-identyclaw-webhooks-plugin.svg?label=npm)](https://www.npmjs.com/package/@identyclaw/openclaw-identyclaw-webhooks-plugin) [![License](https://img.shields.io/github/license/discernible-io/openclaw-identyclaw-webhooks-plugin)](https://github.com/discernible-io/openclaw-identyclaw-webhooks-plugin/blob/main/LICENSE) [![RODiT webhooks](https://img.shields.io/badge/webhooks-RODiT%20Ed25519-14b8a6)](https://github.com/discernible-io/idclawserver-idc)

<p align="center">
  <img src="images/identyclaw-webhooks-ecosystem.svg" alt="IdentyClaw stack: OpenClaw gateway, this webhooks component, and idclawserver-idc webhook contract" width="960"/>
</p>

## Role in the IdentyClaw stack

| Layer | Artifact | Responsibility |
| --- | --- | --- |
| Identity & HOLA | [`openclaw-identyclaw-plugin`](https://github.com/discernible-io/openclaw-identyclaw-plugin) | API login, DID, HOLA, operator tools |
| Passport API (reference) | [`idclawserver-idc`](https://github.com/discernible-io/idclawserver-idc) | JWT issuance, token metadata (`webhook_url`), webhook event delivery contract |
| A2A wire protocol | [`openclaw-a2a-idc-plugin`](https://github.com/discernible-io/openclaw-a2a-idc-plugin) (`identyclaw-a2a`) | Agent Card discovery, `POST /a2a`, inbound JWT validation, outbound P2P login |
| **Webhook ingress (this repo)** | **`identyclaw-webhooks`** | RODiT Ed25519 verification on `/hooks/*`, session correlation, outbound `send_rodit_webhook` |
| Agent runtime | [OpenClaw](https://openclaw.ai) gateway | Chat, hooks, sandbox, tool execution |

Install this plugin when Passport-authenticated agents need to **receive signed webhooks from IdentyClaw** (HOLA validation outcomes, liveness pings) or **send signed webhooks to peers** — not for IdentyClaw API login, HOLA creation, or A2A messaging (use `identyclaw-tools` and `identyclaw-a2a` for those).

Inbound webhooks require `x-signature` and `x-timestamp` headers and Ed25519 verification through `@rodit/rodit-auth-be`, matching the receiver checklist in [`openclaw-integration-guide.md`](https://github.com/discernible-io/idclawserver-idc/blob/main/references/openclaw-integration-guide.md). Outbound `send_rodit_webhook` resolves peer gateway bases from the A2A outbound agent map, persisted A2A peers cache, or IdentyClaw identity API (`metadata.webhook_url`).

| Hook | OpenClaw behavior | IdentyClaw use case |
| --- | --- | --- |
| `/hooks/wake` | Enqueue heartbeat / system event for main session | Liveness nudge after validation |
| `/hooks/agent` | Run isolated agent task; optional reply to messaging channels | **Primary** — process HOLA verify outcomes, run follow-up logic |

Set Passport `webhook_url` to the **gateway base URL only** (no hook path). IdentyClaw and peer SDKs append `/hooks/agent` or `/hooks/wake` when sending.

## 📦 Installation

From ClawHub:

```bash
openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-webhooks-plugin
```

From npm:

```bash
openclaw plugins install @identyclaw/openclaw-identyclaw-webhooks-plugin
```

From git:

```bash
openclaw plugins install https://github.com/discernible-io/openclaw-identyclaw-webhooks-plugin.git
```

During development you can also install from a local checkout:

```bash
cd openclaw-identyclaw-webhooks-plugin
npm install
npm run build
openclaw plugins install .
```

Restart the gateway:

```bash
openclaw gateway restart
```

Follow the setup in [IdentyClaw usage](#-identyclaw-usage-rodit-webhooks), [Receiving webhooks (inbound)](#-receiving-webhooks-inbound), and/or [Sending webhooks (outbound)](#-sending-webhooks-outbound).

### Related IdentyClaw artifacts

| Artifact | Install / link | Role |
| --- | --- | --- |
| **This plugin** (`identyclaw-webhooks`) | `openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-webhooks-plugin` | RODiT webhook ingress on `/hooks/wake`, `/hooks/agent`; outbound `send_rodit_webhook` |
| Passport server (reference) | [`idclawserver-idc`](https://github.com/discernible-io/idclawserver-idc) | Canonical webhook contract, `webhook_url` metadata, [`openclaw-integration-guide.md`](https://github.com/discernible-io/idclawserver-idc/blob/main/references/openclaw-integration-guide.md) |
| A2A gateway component | `openclaw plugins install clawhub:@identyclaw/openclaw-a2a-plugin` | Peer discovery, outbound agent map used by `send_rodit_webhook` — [`openclaw-a2a-idc-plugin`](https://github.com/discernible-io/openclaw-a2a-idc-plugin) |
| IdentyClaw tools | `openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin` | API login, HOLA, identity, DID — [`openclaw-identyclaw-plugin`](https://github.com/discernible-io/openclaw-identyclaw-plugin) |
| Outbound client (reference) | [`clienttest-idc`](https://github.com/discernible-io/clienttest-idc) | Credential file layout and webhook caller patterns |
| Skill (workflows) | `openclaw skills install clawhub:identyclaw` | Operator playbooks and reference docs |
| MCP (canonical docs) | `https://api.identyclaw.com/mcp` | Live IdentyClaw API documentation |

`identyclaw-webhooks` shares NEAR Passport credential files with `identyclaw-a2a` and `identyclaw-tools`. Outbound peer resolution reads `plugins.entries.identyclaw-a2a.config.outbound.agents` (or legacy `a2a`).

## 🔐 IdentyClaw usage (RODiT webhooks)

This component implements the OpenClaw-side webhook receiver described in [`idclawserver-idc`](https://github.com/discernible-io/idclawserver-idc): verify Ed25519 origin signatures, correlate webhooks to login sessions, and accept events from the Passport API or peer agents.

### Environment variables

Webhook verification and outbound signing use the NEAR Passport credentials file (same layout as [`clienttest-idc`](https://github.com/discernible-io/clienttest-idc)):

| Variable | Purpose |
| -------- | ------- |
| `RODIT_NEAR_CREDENTIALS_SOURCE` | `file` (recommended with identyclaw-agents) |
| `NEAR_CREDENTIALS_FILE_PATH` | Path to Passport JSON, e.g. `…/secrets/near-credentials/<hash>.json` |
| `NEAR_CONTRACT_ID` | RODiT contract on mainnet (e.g. `genaaaa-identyclaw-com.near`) |

`IDENTYCLAW_*` env vars remain used by **identyclaw-tools** (HOLA, DID, identity) on the same host — they are not required for webhook signature verification.

Keep credentials in env or secrets files — not in `openclaw.json`.

### Embedding in OpenClaw chat / gateway (quiet mode)

When this plugin is enabled, OpenClaw loads it in **chat** (`node dist/index.js chat`) as well as the **gateway**. [`@rodit/rodit-auth-be`](https://www.npmjs.com/package/@rodit/rodit-auth-be) logs JSON to stdout and `node-config` warns on stderr at **import time**, which can appear inline in the chat TUI.

This plugin **lazy-loads** `rodit-auth-be` only on the first inbound webhook or outbound `send_rodit_webhook` call, and applies quiet embed defaults before import:

| Variable | Default when unset |
| -------- | ------------------ |
| `LOG_LEVEL` | `error` |
| `SUPPRESS_NO_CONFIG_WARNING` | `true` |
| `SUPPRESS_STRICTNESS_CHECK` | `true` |

Host env vars always win. Override per-plugin with `logLevel` in `openclaw.json`:

```json
"identyclaw-webhooks": {
  "enabled": true,
  "config": {
    "logLevel": "error"
  }
}
```

### Plugin id and config

Plugin id: **`identyclaw-webhooks`**

```json
{
  "plugins": {
    "entries": {
      "identyclaw-webhooks": {
        "enabled": true,
        "config": {
          "endpoints": ["/hooks/wake", "/hooks/agent"],
          "logLevel": "error",
          "persistPeerRegistry": false,
          "peerRegistryPath": "/home/node/.openclaw/cache/peer-registry.json"
        }
      }
    }
  }
}
```

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `endpoints` | `string[]` | `["/hooks/wake", "/hooks/agent"]` | Webhook paths to expose on the gateway |
| `logLevel` | `string` | `error` | Winston level for `rodit-auth-be` when loaded |
| `persistPeerRegistry` | `boolean` | `false` | Persist dynamically resolved peers (from identity API) to disk |
| `peerRegistryPath` | `string` | `/home/node/.openclaw/cache/peer-registry.json` | Path for peer registry cache |

### Passport `webhook_url` alignment

On startup the plugin warms up the RODiT client and reads your Passport `metadata.webhook_url`. If `identyclaw-a2a` `inbound.publicBaseUrl` is set and differs from Passport metadata, a warning is logged — align them so IdentyClaw API delivery and peer discovery advertise the same gateway host.

Example metadata (gateway base only):

```json
{
  "webhook_url": "https://my-openclaw.example.com",
  "webhook_cidr": "203.0.113.0/24"
}
```

IdentyClaw POST target: `https://my-openclaw.example.com/hooks/agent`

See [`token-metadata.md`](https://github.com/discernible-io/idclawserver-idc/blob/main/references/token-metadata.md) and [`openclaw-integration-guide.md`](https://github.com/discernible-io/idclawserver-idc/blob/main/references/openclaw-integration-guide.md) on the Passport server repo.

## 📥 Receiving webhooks (inbound)

### Set up

1. Enable `identyclaw-webhooks` in `openclaw.json` (see [Plugin id and config](#plugin-id-and-config)).
2. Register Passport `webhook_url` pointing at your gateway host (base URL only).
3. Expose the gateway over TLS (reverse proxy, Tailscale Funnel, etc.).
4. Restart the gateway after config changes.

The plugin registers each configured endpoint with `auth: "plugin"` — OpenClaw gateway auth is bypassed; RODiT signature verification is the gate.

### Verification flow

For each `POST`:

1. Require `x-signature` and `x-timestamp` headers.
2. Resolve signer public key via SDK `extractWebhookSignerKey` (headers, with fallback to `StateManager.getPeerBase64urlJwkPublicKey()` from prior login).
3. Call `authenticate_webhook` from `@rodit/rodit-auth-be`.
4. Extract signed `session_id` and cross-reference against `SessionManager.hasSession`.
5. Record receipt metadata and return JSON with `sessionId` and `sessionKnown`.

### `/hooks/wake` payload

Accepts JSON with `text`, or `event` (with optional nested `data.text`), or nested `data.text`. Optional `mode`: `"now"` (default) or `"next-heartbeat"`.

```json
{
  "text": "Peer validated HOLA",
  "mode": "now"
}
```

On success, triggers a gateway heartbeat when `mode` is `"now"`.

### `/hooks/agent` payload

Accepts any signed JSON body. Returns `{ ok: true, endpoint: "agent", accepted: true, sessionId, sessionKnown }`. Map `event` and `data` fields to agent prompts per the [OpenClaw integration guide](https://github.com/discernible-io/idclawserver-idc/blob/main/references/openclaw-integration-guide.md).

Example from IdentyClaw `POST /api/testhola` (development):

```json
{
  "event": "testhola_validation_success",
  "data": {
    "peerTokenId": "abc123def456",
    "serverTokenId": "xyz789uvw012",
    "recipient": "MUNDO",
    "timestamp": "2026-04-24T18:30:00.000Z",
    "endpoint": "/api/testhola"
  }
}
```

### Test helper: `/hooks/_receipts`

| Method | Description |
| ------ | ----------- |
| `GET /hooks/_receipts` | List recent webhook receipts (path, event, requestId, sessionId, sessionKnown, timestamp) |
| `DELETE /hooks/_receipts` | Clear receipt log |

Receipts persist under `/home/node/.openclaw/cache/webhook-receipts.json` (best-effort).

### Error responses

| HTTP | Code | Meaning |
| ---- | ---- | ------- |
| 400 | `MISSING_AUTH_PARAMS` | Missing `x-signature` or `x-timestamp` |
| 401 | `MISSING_SIGNER_KEY` | Signer public key not present in request |
| 401 | `SIGNER_KEY_MISMATCH` | Signer key does not match expected identity |
| 401 | `INVALID_WEBHOOK_SIGNATURE` | Signature or timestamp invalid |
| 413 | — | Body exceeds 256 KiB |

## 📤 Sending webhooks (outbound)

### Prerequisites

Configure at least one outbound peer in **`identyclaw-a2a`** (or legacy `a2a`), or rely on dynamic resolution by Passport `token_id`:

```json
{
  "plugins": {
    "entries": {
      "identyclaw-a2a": {
        "enabled": true,
        "config": {
          "outbound": {
            "auth": { "provider": "rodit" },
            "agents": {
              "agent-b": {
                "url": "http://openclaw-agent-b:18789/.well-known/agent-card.json"
              }
            }
          }
        }
      },
      "identyclaw-webhooks": {
        "enabled": true
      }
    }
  }
}
```

Peer resolution order for `send_rodit_webhook`:

1. `outbound.agents.<peerId>` in `identyclaw-a2a` config
2. A2A persisted peers (`{OPENCLAW_STATE_DIR}/a2a/outbound/peers.json`)
3. This plugin's peer registry cache
4. `GET /api/identity/token/{token_id}/full` — prefers `metadata.webhook_url` over `contactUri`

### Tool: `send_rodit_webhook`

Sign and POST a RODiT webhook to a peer after an optional delay. The SDK stamps session correlation via `sessionRoditId` when this peer issued the recipient's JWT.

| Parameter | Type | Required | Description |
| --------- | ---- | -------- | ----------- |
| `peerId` | string | Yes | Outbound agent key or Passport `token_id` |
| `text` | string | No | Webhook body text (default: auto-generated ping) |
| `delaySeconds` | number | No | Seconds to wait before sending (default: `10`) |
| `hookPath` | string | No | Path on peer gateway (default: `hooks/wake`) |

Enable in sandbox when needed:

```json
"sandbox": {
  "tools": {
    "alsoAllow": ["send_rodit_webhook"]
  }
}
```

Outbound TLS verification follows `identyclaw-a2a` `outbound.tlsSkipVerify` (development only).

## 💡 Use Cases

- Receive IdentyClaw HOLA validation webhooks on OpenClaw and trigger agent tasks on `/hooks/agent`
- Wake the main session with signed liveness pings on `/hooks/wake` after Passport events
- Send delayed signed webhooks to A2A peers without manual SDK scripting
- Correlate inbound webhooks to active login sessions for multi-peer gateways
- Resolve peer gateway URLs from Passport `metadata.webhook_url` when not preconfigured in A2A outbound map

## ✨ Features

- **RODiT-signed inbound webhooks** — Ed25519 verification via `@rodit/rodit-auth-be` on `/hooks/wake` and `/hooks/agent`
- **Session correlation** — extract signed `session_id`, report `sessionKnown` against live login sessions
- **Outbound `send_rodit_webhook` tool** — sign and deliver webhooks to peers with configurable delay and hook path
- **Peer resolution** — A2A outbound map, persisted peers cache, identity API `metadata.webhook_url` fallback
- **Passport metadata alignment** — startup check of `webhook_url` vs A2A `publicBaseUrl`
- **Quiet embed mode** — lazy-load `rodit-auth-be` with library-quiet defaults for chat TUI
- **Test helper** — `GET|DELETE /hooks/_receipts` for integration debugging

## 🌐 HTTP Endpoints

| Endpoint | Method | Auth | Description |
| -------- | ------ | ---- | ----------- |
| `/hooks/wake` | POST | RODiT `x-signature` + `x-timestamp` | Verify signature, enqueue heartbeat |
| `/hooks/agent` | POST | RODiT `x-signature` + `x-timestamp` | Verify signature, accept agent task payload |
| `/hooks/_receipts` | GET | Plugin | List recent webhook receipts (test helper) |
| `/hooks/_receipts` | DELETE | Plugin | Clear receipt log |

Configurable via `endpoints` in plugin config. Default paths match [`idclawserver-idc`](https://github.com/discernible-io/idclawserver-idc) OpenClaw integration expectations.

### External URL layout (same host)

Webhooks share the gateway host with OpenClaw hooks and A2A:

```text
agent-a.example.com/hooks/wake          → This plugin (heartbeat)
agent-a.example.com/hooks/agent           → This plugin (agent task)
agent-a.example.com/a2a                   → identyclaw-a2a JSON-RPC
agent-a.example.com/.well-known/agent-card.json  → A2A discovery
```

## Requirements

- OpenClaw gateway **≥ 2026.5.27**
- Node **≥ 22.19.0**
- NEAR Passport credentials (`NEAR_CREDENTIALS_FILE_PATH` or `secrets/near-credentials/*.json`)
- For outbound `send_rodit_webhook`: `plugins.entries.identyclaw-a2a.config.outbound.agents` peer map (or resolvable `token_id`)

## Publish to ClawHub

See [PUBLISH.md](./PUBLISH.md):

```bash
npm run prepare:publish
npm run publish:clawhub:dry-run
npm run publish:clawhub
```

---

## 🛠️ Development

Install dependencies and build:

```bash
npm install
npm run build
```

Install the plugin from a local checkout:

```bash
openclaw plugins install /absolute/path/to/openclaw-identyclaw-webhooks-plugin
```

Restart the gateway:

```bash
openclaw gateway restart
```

Runtime smoke test: enable `plugins.entries.identyclaw-webhooks`, POST a signed webhook to `/hooks/wake`, exercise `send_rodit_webhook`, poll `GET /hooks/_receipts`.

## 📄 License

Apache-2.0 — Copyright (c) Discernible IO. See [LICENSE](./LICENSE).

## 🔗 IdentyClaw & upstream links

- **This repo:** [discernible-io/openclaw-identyclaw-webhooks-plugin](https://github.com/discernible-io/openclaw-identyclaw-webhooks-plugin)
- **Passport server reference:** [discernible-io/idclawserver-idc](https://github.com/discernible-io/idclawserver-idc) — webhook contract, token metadata, [OpenClaw integration guide](https://github.com/discernible-io/idclawserver-idc/blob/main/references/openclaw-integration-guide.md)
- **A2A gateway component:** [discernible-io/openclaw-a2a-idc-plugin](https://github.com/discernible-io/openclaw-a2a-idc-plugin) — peer map and JWT login used for outbound delivery
- **IdentyClaw tools:** [discernible-io/openclaw-identyclaw-plugin](https://github.com/discernible-io/openclaw-identyclaw-plugin)
- **RODiT auth SDK:** [@rodit/rodit-auth-be](https://www.npmjs.com/package/@rodit/rodit-auth-be)

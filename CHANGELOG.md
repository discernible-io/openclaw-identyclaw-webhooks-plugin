# Changelog

## Unreleased

## 0.1.9 — 2026-08-07

- Security: `/hooks/_receipts` is no longer registered by default. Set
  `enableReceiptsEndpoint: true` for local debugging only; receipt recording and
  disk persistence are skipped when the endpoint is disabled.

## 0.1.8 — 2026-07-16

- Bump `@rodit/rodit-auth-be` to `9.14.0`.

## 0.1.7 — 2026-07-06

- Fix `send_rodit_webhook`: catch identity API `IDENTITY_NOT_FOUND` (404) for
  unknown/unconfigured `peerId` and return `{ ok: false, … }` instead of throwing.

## 0.1.6 — 2026-07-04

- Fix inbound signer lookup: delegate to SDK `webhookhandlermw.extractWebhookSignerKey`
  instead of reimplementing it. The local resolver wrongly treated `X-Rodit-Token-Id`
  (Passport id) as a 64-char NEAR implicit account hex, causing immediate
  `SIGNER_KEY_MISMATCH` for all rodit-auth-be signed webhooks that send
  `X-Rodit-Implicit-Account` / `X-Rodit-Public-Key`. Session id extraction now
  also uses the SDK helper.

## 0.1.5 — 2026-07-04

- Inbound verification resolves the signer key from webhook headers when present,
  otherwise falls back to `StateManager.getPeerBase64urlJwkPublicKey()` from login
  (same contract as SDK `webhookhandlermw.js`), then calls `authenticate_webhook`.
- Outbound peer resolution prefers `metadata.webhook_url` from identity `/full`
  before falling back to `contactUri` parsing (fixes wrong targets like
  `https://agenthood.me/hooks/wake` when email authority differs from gateway).

## 0.1.4 — 2026-07-04

- Fix inbound webhook verification for published `@rodit/rodit-auth-be` 9.12.0: use
  `StateManager.getPeerBase64urlJwkPublicKey()` + `authenticate_webhook` (same as SDK
  `webhookhandlermw.js`) instead of requiring the unpublished `webhookkeyresolver.js`
  module. Resolves HTTP 500 `Cannot find module .../webhookkeyresolver.js` on upgrade.

## 0.1.3 — 2026-07-02

- Inbound webhook verification now uses the shared `resolveWebhookSignerKey`
  from `@rodit/rodit-auth-be` (>= 9.12.0), so SDK-middleware servers and
  plugin-based agents use the exact same deterministic, per-identity key
  resolution. This fixes false `401`s when an agent is connected to several peers
  and the single mutable "current peer" slot is clobbered.
- Bumped `@rodit/rodit-auth-be` to `9.12.0` (hard requirement).
- BREAKING: removed the local resolver fallback. The plugin now requires an SDK
  that ships `lib/auth/webhookkeyresolver.js`; older SDKs fail fast at load.
- Inbound webhooks are now linked to their originating session: after signature
  verification the handler reads the signed `session_id` via the SDK's
  `extractWebhookSessionId`, records it in the webhook receipt (`sessionId`), and
  returns it in the `/hooks/*` JSON response.
- Outbound `send_rodit_webhook` passes `sessionRoditId` (the recipient peer id)
  so the SDK can resolve the shared session id from session storage and stamp it
  into the signed payload when this peer issued the peer's JWT.
- Inbound handler cross-references the webhook's `session_id` against the
  sessions this peer holds open (via the SDK's `SessionManager.hasSession`) and
  reports `sessionKnown` in the receipt and `/hooks/*` response.

## 0.1.2 — 2026-06-24

- Read outbound config from `plugins.entries.identyclaw-a2a`, falling back to legacy `a2a`.
- Support string or object entries in `outbound.agents`.
- Use A2A plugin persisted peers (`{OPENCLAW_STATE_DIR}/a2a/outbound/peers.json`) before identity API lookup.

## 0.1.1 — 2026-06-23

- Resolve outbound peers by `token_id` via `GET /api/identity/token/{token_id}/full` when not in `outbound.agents`.
- Parse `contactUri` from identity DN and register peers in memory (optional disk cache via `persistPeerRegistry`).
- Fix `send_rodit_webhook` to set `peerTokenId` to the target peer, not the signer.

## 0.1.0 — 2026-06-23

- Initial release: RODiT-signed webhook ingress on `/hooks/wake` and `/hooks/agent`.
- Outbound `send_rodit_webhook` tool for delayed peer webhook delivery via A2A outbound agent map.
- ClawHub publish tooling (`prepare:publish`, `publish:clawhub`, pack verification).

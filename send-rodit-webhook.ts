import { readFileSync } from "node:fs";
import { a2aOutboundConfig, type OpenClawConfig } from "./a2a-config.js";
import {
  agentCardUrlToBase,
  getA2aPersistedPeer,
  getRegisteredPeer,
  registerPeerFromTokenId,
  resolvePeerBaseFromEntry,
} from "./peer-registry.js";
import {
  applyWebhookTlsSkip,
  buildPeerWebhookReq,
  getRoditClient,
  peerBaseToRoditWebhookUrl,
} from "./rodit-runtime.js";

export { agentCardUrlToBase } from "./peer-registry.js";
export type { OpenClawConfig } from "./a2a-config.js";

export function resolveConfiguredPeerBase(
  config: OpenClawConfig,
  peerId: string,
): string | null {
  const peer = a2aOutboundConfig(config)?.agents?.[peerId];
  if (!peer) return null;
  const cardUrl = (typeof peer === "string" ? peer : peer?.url)?.trim();
  const loginBase = (typeof peer === "object" ? peer?.loginBaseUrl : "")?.trim();
  if (cardUrl) return agentCardUrlToBase(cardUrl);
  if (loginBase) return loginBase.replace(/\/$/, "");
  return null;
}

export async function resolveOutboundPeerBase(config: OpenClawConfig, peerId: string): Promise<string> {
  const configured = resolveConfiguredPeerBase(config, peerId);
  if (configured) return configured;

  const a2aCached = getA2aPersistedPeer(peerId);
  if (a2aCached) return resolvePeerBaseFromEntry(a2aCached);

  const cached = getRegisteredPeer(peerId);
  if (cached) return resolvePeerBaseFromEntry(cached);

  const entry = await registerPeerFromTokenId(peerId);
  return resolvePeerBaseFromEntry(entry);
}

export function outboundTlsSkipVerify(config: OpenClawConfig): boolean {
  return a2aOutboundConfig(config)?.tlsSkipVerify === true;
}

export function loadNearSignerFromEnv(): { accountId: string; privateKey: string } {
  const credPath = process.env.NEAR_CREDENTIALS_FILE_PATH?.trim();
  if (!credPath) {
    throw new Error("NEAR_CREDENTIALS_FILE_PATH is not set");
  }
  const data = JSON.parse(readFileSync(credPath, "utf8")) as Record<string, string>;
  const accountId = data.implicit_account_id || data.account_id || data.accountId;
  const privateKey = data.private_key || data.privateKey;
  if (!accountId || !privateKey) {
    throw new Error(`Missing account_id/private_key in ${credPath}`);
  }
  return { accountId: String(accountId).trim(), privateKey: String(privateKey).trim() };
}

export type SendRoditWebhookResult = {
  url: string;
  peerId: string;
  requestId: string;
  delaySeconds: number;
  status: number;
  ok: boolean;
  response: unknown;
};

export async function sendRoditWebhook(opts: {
  config: OpenClawConfig;
  peerId: string;
  text?: string;
  delaySeconds?: number;
  hookPath?: string;
}): Promise<SendRoditWebhookResult> {
  const delaySeconds = opts.delaySeconds ?? 10;
  const hookPath = (opts.hookPath ?? "hooks/wake").replace(/^\/+/, "");
  const targetBase = await resolveOutboundPeerBase(opts.config, opts.peerId);
  const tlsSkipVerify = outboundTlsSkipVerify(opts.config);
  const signer = loadNearSignerFromEnv();
  const endpoint = `/${hookPath}`;
  const url = `${targetBase.replace(/\/+$/, "")}${endpoint}`;
  const wakeText = opts.text?.trim() || `Webhook ping to ${opts.peerId} via send_rodit_webhook`;

  if (delaySeconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
  }

  applyWebhookTlsSkip(tlsSkipVerify);
  const client = await getRoditClient();
  const peerReq = buildPeerWebhookReq(targetBase);

  const payload = {
    event: wakeText,
    data: {
      mode: "now",
      token_id: signer.accountId,
      peerTokenId: opts.peerId.trim(),
    },
  };

  // Best-effort session correlation: if this peer issued a JWT to the recipient
  // (login_client), its SessionManager holds a session keyed by the recipient's
  // roditId; the SDK resolves the shared session id from storage and stamps it
  // into the signed webhook payload.
  const sendOptions = { sessionRoditId: opts.peerId.trim() };

  let sdkResult;
  try {
    sdkResult =
      endpoint === "/hooks/wake"
        ? await client.sendWakeHook(payload, peerReq, sendOptions)
        : await client.sendWebhookToEndpoint(payload, endpoint, peerReq, sendOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      peerId: opts.peerId,
      requestId: "",
      delaySeconds,
      status: 502,
      ok: false,
      response: { error: message, webhookUrl: peerBaseToRoditWebhookUrl(targetBase) },
    };
  }

  const ok = sdkResult.isValid === true;
  return {
    url,
    peerId: opts.peerId,
    requestId: sdkResult.requestId ?? "",
    delaySeconds,
    status: ok ? 200 : 502,
    ok,
    response: sdkResult,
  };
}

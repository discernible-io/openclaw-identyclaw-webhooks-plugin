import { readFileSync } from "node:fs";
import {
  applyWebhookTlsSkip,
  buildPeerWebhookReq,
  getRoditClient,
  peerBaseToRoditWebhookUrl,
} from "./rodit-runtime.js";

type OpenClawConfig = {
  plugins?: {
    entries?: {
      a2a?: {
        config?: {
          outbound?: {
            tlsSkipVerify?: boolean;
            agents?: Record<string, { url?: string; loginBaseUrl?: string }>;
          };
        };
      };
    };
  };
};

export function agentCardUrlToBase(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/.well-known/agent-card.json")) {
    return trimmed.slice(0, -"/.well-known/agent-card.json".length);
  }
  return trimmed;
}

export function resolveOutboundPeerBase(config: OpenClawConfig, peerId: string): string {
  const peer = config.plugins?.entries?.a2a?.config?.outbound?.agents?.[peerId];
  const cardUrl = peer?.url?.trim();
  const loginBase = peer?.loginBaseUrl?.trim();
  if (cardUrl) return agentCardUrlToBase(cardUrl);
  if (loginBase) return loginBase.replace(/\/$/, "");
  const known = Object.keys(config.plugins?.entries?.a2a?.config?.outbound?.agents ?? {});
  throw new Error(
    `Peer '${peerId}' not found in plugins.entries.a2a.config.outbound.agents` +
      (known.length ? ` (configured: ${known.join(", ")})` : ""),
  );
}

export function outboundTlsSkipVerify(config: OpenClawConfig): boolean {
  return config.plugins?.entries?.a2a?.config?.outbound?.tlsSkipVerify === true;
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
  const targetBase = resolveOutboundPeerBase(opts.config, opts.peerId);
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
      peerTokenId: signer.accountId,
    },
  };

  let sdkResult;
  try {
    sdkResult =
      endpoint === "/hooks/wake"
        ? await client.sendWakeHook(payload, peerReq)
        : await client.sendWebhookToEndpoint(payload, endpoint, peerReq);
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

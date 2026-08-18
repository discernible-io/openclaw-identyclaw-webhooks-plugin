import { readFileSync } from "node:fs";
import { a2aOutboundConfig, a2aPluginEntryKey, type OpenClawConfig } from "./a2a-config.js";
import {
  agentCardUrlToBase,
  getA2aPersistedPeer,
  getRegisteredPeer,
  registerPeerFromTokenId,
  resolvePeerBaseFromEntry,
} from "./peer-registry.js";
import { logWithContext, type PluginLogger } from "./plugin-log.js";
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

export async function resolveOutboundPeerBase(
  config: OpenClawConfig,
  peerId: string,
  logger?: PluginLogger,
): Promise<string> {
  const configured = resolveConfiguredPeerBase(config, peerId);
  if (configured) return configured;

  const a2aCached = getA2aPersistedPeer(peerId);
  if (a2aCached) {
    logWithContext(logger, "info", "Peer resolution used fallback", {
      operation: "outbound.resolvePeer",
      peerId,
      used: "a2a.peers",
      skipped: ["outbound.agents"],
    });
    return resolvePeerBaseFromEntry(a2aCached);
  }

  const cached = getRegisteredPeer(peerId);
  if (cached) {
    logWithContext(logger, "info", "Peer resolution used fallback", {
      operation: "outbound.resolvePeer",
      peerId,
      used: "plugin.registry",
      skipped: ["outbound.agents", "a2a.peers"],
    });
    return resolvePeerBaseFromEntry(cached);
  }

  logWithContext(logger, "info", "Peer resolution used fallback", {
    operation: "outbound.resolvePeer",
    peerId,
    used: "identity.api",
    skipped: ["outbound.agents", "a2a.peers", "plugin.registry"],
  });
  const entry = await registerPeerFromTokenId(peerId, { logger });
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

function isIdentityNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const apiErr = err as { code?: string; statusCode?: number };
    if (apiErr.code === "IDENTITY_NOT_FOUND") return true;
    if (apiErr.statusCode === 404) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("IDENTITY_NOT_FOUND");
}

export async function sendRoditWebhook(opts: {
  config: OpenClawConfig;
  peerId: string;
  text?: string;
  delaySeconds?: number;
  hookPath?: string;
  logger?: PluginLogger;
}): Promise<SendRoditWebhookResult> {
  const delaySeconds = opts.delaySeconds ?? 10;
  const hookPath = (opts.hookPath ?? "hooks/wake").replace(/^\/+/, "");
  const peerId = opts.peerId.trim();
  const logger = opts.logger;

  if (a2aPluginEntryKey(opts.config) === "a2a") {
    logWithContext(logger, "info", "A2A plugin config used fallback", {
      operation: "config.a2aPluginEntry",
      used: "a2a",
      skipped: ["identyclaw-a2a"],
    });
  }

  let targetBase: string;
  try {
    targetBase = await resolveOutboundPeerBase(opts.config, peerId, logger);
  } catch (err) {
    if (isIdentityNotFoundError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      logWithContext(logger, "warn", "Outbound webhook failed", {
        operation: "outbound.sendRoditWebhook",
        peerId,
        statusCode: 404,
        error: { name: "Error", message, code: "IDENTITY_NOT_FOUND" },
      });
      return {
        url: "",
        peerId: opts.peerId,
        requestId: "",
        delaySeconds,
        status: 404,
        ok: false,
        response: { error: message, code: "IDENTITY_NOT_FOUND", peerId },
      };
    }
    throw err;
  }

  const tlsSkipVerify = outboundTlsSkipVerify(opts.config);
  const signer = loadNearSignerFromEnv();
  const endpoint = `/${hookPath}`;
  const url = `${targetBase.replace(/\/+$/, "")}${endpoint}`;
  const wakeText = opts.text?.trim() || `Webhook ping to ${peerId} via send_rodit_webhook`;

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
      peerTokenId: peerId,
    },
  };

  // Best-effort session correlation: if this peer issued a JWT to the recipient
  // (login_client), its SessionManager holds a session keyed by the recipient's
  // roditId; the SDK resolves the shared session id from storage and stamps it
  // into the signed webhook payload.
  const sendOptions = { sessionRoditId: peerId };

  let sdkResult;
  try {
    sdkResult =
      endpoint === "/hooks/wake"
        ? await client.sendWakeHook(payload, peerReq, sendOptions)
        : await client.sendWebhookToEndpoint(payload, endpoint, peerReq, sendOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWithContext(
      logger,
      "error",
      "Outbound webhook failed",
      {
        operation: "outbound.sendRoditWebhook",
        peerId,
        path: endpoint,
        statusCode: 502,
      },
      err,
    );
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
  const requestId = sdkResult.requestId ?? "";
  logWithContext(logger, ok ? "info" : "warn", ok ? "Outbound webhook sent" : "Outbound webhook failed", {
    operation: "outbound.sendRoditWebhook",
    peerId,
    path: endpoint,
    requestId,
    statusCode: ok ? 200 : 502,
  });
  return {
    url,
    peerId: opts.peerId,
    requestId,
    delaySeconds,
    status: ok ? 200 : 502,
    ok,
    response: sdkResult,
  };
}

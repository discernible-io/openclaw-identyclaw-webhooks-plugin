import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { a2aPluginConfig } from "./a2a-config.js";
import { sendRoditWebhook } from "./send-rodit-webhook.js";
import { configurePeerRegistry } from "./peer-registry.js";
import { getOwnPassportUrls, getRoditAuth, getRoditClient, getWebhookKeyResolver } from "./rodit-runtime.js";

const DEFAULT_ENDPOINTS = ["/hooks/wake", "/hooks/agent"];
const RECEIPTS_PATH = "/home/node/.openclaw/cache/webhook-receipts.json";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RECEIPTS = 200;

type WebhookReceipt = {
  path: string;
  event: string | null;
  requestId: string | null;
  sessionId: string | null;
  sessionKnown: boolean;
  timestamp: string;
};

const webhookReceipts: WebhookReceipt[] = [];

function persistReceipts() {
  try {
    mkdirSync(dirname(RECEIPTS_PATH), { recursive: true });
    writeFileSync(RECEIPTS_PATH, `${JSON.stringify(webhookReceipts, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort — tests can also poll via GET /hooks/_receipts.
  }
}

function clearReceipts() {
  webhookReceipts.length = 0;
  persistReceipts();
}

function recordReceipt(
  path: string,
  rawPayload: string,
  requestIdHeader: string,
  sessionId: string | null = null,
  sessionKnown = false,
) {
  let event: string | null = null;
  let requestId: string | null = requestIdHeader || null;
  try {
    const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
    if (typeof parsed.event === "string") event = parsed.event;
    if (!requestId && typeof parsed.requestId === "string") requestId = parsed.requestId;
    const nested =
      parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
        ? (parsed.data as Record<string, unknown>)
        : null;
    if (!requestId && nested && typeof nested.requestId === "string") requestId = nested.requestId;
  } catch {
    // ignore parse errors for receipt metadata
  }
  webhookReceipts.push({
    path,
    event,
    requestId,
    sessionId: sessionId || null,
    sessionKnown,
    timestamp: new Date().toISOString(),
  });
  if (webhookReceipts.length > MAX_RECEIPTS) {
    webhookReceipts.splice(0, webhookReceipts.length - MAX_RECEIPTS);
  }
  persistReceipts();
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) && raw.length > 0) return String(raw[0]).trim();
  return "";
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function requestGatewayHeartbeat(mode: "now" | "next-heartbeat") {
  if (mode !== "now") return;
  const dist = "/app/dist";
  const entry = readdirSync(dist).find((name) => name.startsWith("heartbeat-wake-") && name.endsWith(".js"));
  if (!entry) return;
  const mod = (await import(pathToFileURL(join(dist, entry)).href)) as {
    requestHeartbeat?: (opts: { source: string; reason: string }) => void;
  };
  mod.requestHeartbeat?.({ source: "hook", reason: "hook:wake" });
}

function normalizeWakePayload(rawPayload: string):
  | { ok: true; text: string; mode: "now" | "next-heartbeat" }
  | { ok: false; error: string } {
  try {
    const payload = JSON.parse(rawPayload) as Record<string, unknown>;
    if (typeof payload.text === "string" && payload.text.trim()) {
      const mode = payload.mode === "next-heartbeat" ? "next-heartbeat" : "now";
      return { ok: true, text: payload.text.trim(), mode };
    }
    if (typeof payload.event === "string" && payload.event.trim()) {
      const nested =
        payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
          ? (payload.data as Record<string, unknown>)
          : null;
      const mode = nested?.mode === "next-heartbeat" ? "next-heartbeat" : "now";
      return { ok: true, text: payload.event.trim(), mode };
    }
    const nested =
      payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? (payload.data as Record<string, unknown>)
        : null;
    if (nested && typeof nested.text === "string" && nested.text.trim()) {
      const mode = nested.mode === "next-heartbeat" ? "next-heartbeat" : "now";
      return { ok: true, text: nested.text.trim(), mode };
    }
    return { ok: false, error: "text required" };
  } catch {
    return { ok: false, error: "invalid json" };
  }
}

type PluginLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

function createRoditWebhookHandler(endpoint: string, logLevel: string | undefined, logger: PluginLogger) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }
    const signature = headerValue(req, "x-signature");
    const timestamp = headerValue(req, "x-timestamp");
    if (!signature || !timestamp) {
      sendJson(res, 400, {
        ok: false,
        code: "MISSING_AUTH_PARAMS",
        message: "Missing required authentication parameters",
      });
      return;
    }
    let rawPayload = "";
    try {
      rawPayload = await readRawBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, message === "payload too large" ? 413 : 400, { ok: false, error: message });
      return;
    }
    if (!rawPayload.trim()) {
      sendJson(res, 400, { ok: false, error: "empty body" });
      return;
    }
    try {
      const [auth, client, keyResolver] = await Promise.all([
        getRoditAuth(logLevel),
        getRoditClient(logLevel),
        getWebhookKeyResolver(logLevel),
      ]);
      const stateManager = client.getStateManager();
      const resolution = await keyResolver.resolveWebhookSignerKey({
        headers: req.headers,
        rawPayload,
        stateManager,
      });
      const publicKey = resolution.key;
      if (!publicKey) {
        sendJson(res, 500, {
          ok: false,
          code: "SIGNER_KEY_UNAVAILABLE",
          message: "Unable to resolve signer public key for webhook verification",
        });
        return;
      }
      const authResult = await auth.authenticate_webhook(rawPayload, signature, timestamp, publicKey);
      if (!authResult.isValid) {
        sendJson(res, 401, {
          ok: false,
          code: authResult.error?.code ?? "INVALID_WEBHOOK_SIGNATURE",
          message: authResult.error?.message ?? "Invalid webhook signature",
        });
        return;
      }
      // Signature verified: the session id carried in the signed payload is now
      // trustworthy and links this webhook to the session opened at login.
      const sessionId = keyResolver.extractWebhookSessionId({ headers: req.headers, rawPayload }) || null;
      // Cross-reference against the sessions this peer holds open (recorded in
      // the SessionManager at login), so we can tell whether the webhook maps to
      // a live session we actually opened.
      let sessionKnown = false;
      if (sessionId) {
        try {
          sessionKnown = await client.getSessionManager().hasSession(sessionId);
        } catch {
          sessionKnown = false;
        }
      }
      recordReceipt(endpoint, rawPayload, headerValue(req, "x-request-id"), sessionId, sessionKnown);
      if (endpoint === "/hooks/wake") {
        const wake = normalizeWakePayload(rawPayload);
        if (!wake.ok) {
          sendJson(res, 400, { ok: false, error: wake.error });
          return;
        }
        await requestGatewayHeartbeat(wake.mode);
        sendJson(res, 200, { ok: true, mode: wake.mode, sessionId, sessionKnown });
        return;
      }
      if (endpoint === "/hooks/agent") {
        sendJson(res, 200, { ok: true, endpoint: "agent", accepted: true, sessionId, sessionKnown });
        return;
      }
      sendJson(res, 200, { ok: true, endpoint, sessionId, sessionKnown });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[identyclaw-webhooks] ${endpoint} failed: ${message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "webhook processing failed" });
      }
    }
  };
}

export default definePluginEntry({
  id: "identyclaw-webhooks",
  name: "IdentyClaw Webhooks",
  description: "Inbound OpenClaw webhooks with RODiT Ed25519 origin signatures (x-signature + x-timestamp)",
  register(api) {
    const config = (api.config?.plugins?.entries?.["identyclaw-webhooks"]?.config ?? {}) as {
      endpoints?: string[];
      logLevel?: string;
      persistPeerRegistry?: boolean;
      peerRegistryPath?: string;
    };
    configurePeerRegistry({
      persist: config.persistPeerRegistry === true,
      cachePath: config.peerRegistryPath?.trim() || undefined,
    });
    const endpoints = (config.endpoints?.length ? config.endpoints : DEFAULT_ENDPOINTS).map((path) =>
      path.startsWith("/") ? path : `/${path}`,
    );
    const logLevel = config.logLevel?.trim() || undefined;

    for (const endpoint of endpoints) {
      api.registerHttpRoute({
        path: endpoint,
        auth: "plugin",
        handler: createRoditWebhookHandler(endpoint, logLevel, api.logger),
      });
      api.logger.info(`[identyclaw-webhooks] registered ${endpoint} (RODiT x-signature + x-timestamp)`);
    }

    api.registerHttpRoute({
      path: "/hooks/_receipts",
      auth: "plugin",
      handler: async (req, res) => {
        if (req.method === "DELETE") {
          clearReceipts();
          sendJson(res, 200, { ok: true, cleared: true });
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, DELETE");
          res.end("Method Not Allowed");
          return;
        }
        sendJson(res, 200, { ok: true, receipts: webhookReceipts });
      },
    });
    api.logger.info("[identyclaw-webhooks] registered GET|DELETE /hooks/_receipts (test helper)");

    api.registerTool({
      name: "send_rodit_webhook",
      description:
        "Sign and POST a RODiT webhook (/hooks/wake) to an A2A peer after a delay. " +
        "Resolves the peer from plugins.entries.identyclaw-a2a (or legacy a2a) outbound.agents, A2A peers.json cache, or by token_id via GET /api/identity/token/{token_id}/full (contactUri).",
      parameters: {
        type: "object",
        properties: {
          peerId: {
            type: "string",
            description:
              "Outbound peer id (outbound.agents key) or RODiT token_id (resolved via identity API when not configured)",
          },
          text: {
            type: "string",
            description: "Webhook body text (default: auto-generated ping message)",
          },
          delaySeconds: {
            type: "number",
            minimum: 0,
            description: "Seconds to wait before sending (default: 10)",
          },
          hookPath: {
            type: "string",
            description: "Webhook path on the peer (default: hooks/wake)",
          },
        },
        required: ["peerId"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params: {
        peerId: string;
        text?: string;
        delaySeconds?: number;
        hookPath?: string;
      }) {
        const result = await sendRoditWebhook({
          config: (api.config ?? {}) as Parameters<typeof sendRoditWebhook>[0]["config"],
          peerId: params.peerId,
          text: params.text,
          delaySeconds: params.delaySeconds ?? 10,
          hookPath: params.hookPath,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    });
    api.logger.info("[identyclaw-webhooks] registered tool send_rodit_webhook");

    api.registerService({
      id: "identyclaw-webhooks",
      start: async () => {
        try {
          await getRoditClient(logLevel);
          const passport = await getOwnPassportUrls(logLevel);
          if (passport.webhook_url) {
            api.logger.info(`[identyclaw-webhooks] Passport metadata.webhook_url=${passport.webhook_url}`);
          }
          const configured = a2aPluginConfig((api.config ?? {}) as Parameters<typeof a2aPluginConfig>[0])
            ?.inbound?.publicBaseUrl?.replace(/\/+$/, "");
          if (configured && passport.webhook_url && configured !== passport.webhook_url) {
            api.logger.warn(
              `[identyclaw-webhooks] inbound.publicBaseUrl (${configured}) differs from Passport webhook_url (${passport.webhook_url})`,
            );
          }
          api.logger.info("[identyclaw-webhooks] RODiT passport warmed up for webhook verification");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          api.logger.error(`[identyclaw-webhooks] warmup failed: ${message}`);
        }
      },
    });
  },
});

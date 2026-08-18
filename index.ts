import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { a2aPluginConfig, a2aPluginEntryKey } from "./a2a-config.js";
import { sendRoditWebhook } from "./send-rodit-webhook.js";
import { configurePeerRegistry } from "./peer-registry.js";
import {
  canonicalError,
  createRequestId,
  logWithContext,
  type PluginLogger,
} from "./plugin-log.js";
import {
  extractWebhookSessionId,
  extractWebhookSignerKey,
  getOwnPassportUrls,
  getRoditAuth,
  getRoditClient,
} from "./rodit-runtime.js";

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

function errorEnvelope(opts: {
  requestId: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    error: {
      code: opts.code,
      message: opts.message,
      ...(opts.details ? { details: opts.details } : {}),
    },
    requestId: opts.requestId,
    timestamp: new Date().toISOString(),
  };
}

function webhookSignatureCode(code?: string): string {
  if (!code || code === "INVALID_WEBHOOK_SIGNATURE") {
    return "WEBHOOK_SIGNATURE_INVALID";
  }
  return code;
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

type WakePayload =
  | { ok: true; text: string; mode: "now" | "next-heartbeat" }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

function normalizeWakePayload(rawPayload: string): WakePayload {
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
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Wake payload is missing required text",
      details: { reason: "text required" },
    };
  } catch {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Wake payload is not valid JSON",
      details: { reason: "invalid json" },
    };
  }
}

function createRoditWebhookHandler(
  endpoint: string,
  logLevel: string | undefined,
  logger: PluginLogger,
  receiptsEnabled: boolean,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const requestId = headerValue(req, "x-request-id") || createRequestId();
    const method = req.method ?? "";

    const respond = (
      status: number,
      body: Record<string, unknown>,
      failure?: { code?: string; message: string; error?: unknown },
    ) => {
      sendJson(res, status, body);
      const context: Record<string, unknown> = {
        operation: "webhook.handle",
        requestId,
        method,
        path: endpoint,
        statusCode: status,
        duration: Date.now() - started,
      };
      if (status >= 400 && failure) {
        context.error = {
          ...(failure.error ? canonicalError(failure.error) : { message: failure.message }),
          ...(failure.code ? { code: failure.code } : {}),
        };
      }
      if (status >= 500) {
        logWithContext(logger, "error", failure?.message ?? "Webhook request failed", context);
      } else if (status >= 400) {
        logWithContext(logger, "warn", failure?.message ?? "Webhook request failed", context);
      } else {
        logWithContext(logger, "info", "Webhook request completed", context);
      }
    };

    const fail = (
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
      error?: unknown,
    ) => {
      respond(status, errorEnvelope({ requestId, code, message, details }), { code, message, error });
    };

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      fail(405, "METHOD_NOT_ALLOWED", "Method Not Allowed");
      return;
    }
    const signature = headerValue(req, "x-signature");
    const timestamp = headerValue(req, "x-timestamp");
    if (!signature || !timestamp) {
      fail(400, "MISSING_AUTH_PARAMS", "Missing required authentication parameters", {
        missing: [
          ...(!signature ? ["x-signature"] : []),
          ...(!timestamp ? ["x-timestamp"] : []),
        ],
      });
      return;
    }
    let rawPayload = "";
    try {
      rawPayload = await readRawBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "payload too large") {
        fail(413, "INVALID_PARAMETERS", "Webhook body exceeds size limit", { maxBytes: MAX_BODY_BYTES }, err);
        return;
      }
      fail(400, "INVALID_REQUEST", message, undefined, err);
      return;
    }
    if (!rawPayload.trim()) {
      fail(400, "INVALID_REQUEST", "Webhook body is empty", { reason: "empty body" });
      return;
    }
    try {
      const [auth, client] = await Promise.all([getRoditAuth(logLevel), getRoditClient(logLevel)]);
      const stateManager = client.getStateManager();
      const resolution = extractWebhookSignerKey(req.headers, stateManager);
      const publicKey = resolution.key?.trim() || null;
      if (resolution.source === "state_manager_peer") {
        logWithContext(logger, "info", "Webhook signer key used fallback", {
          operation: "webhook.extractSignerKey",
          requestId,
          path: endpoint,
          used: "state_manager_peer",
          skipped: ["headers"],
        });
      }
      if (!publicKey) {
        fail(
          401,
          resolution.source === "implicit_mismatch" ? "SIGNER_KEY_MISMATCH" : "MISSING_SIGNER_KEY",
          "Webhook signer public key not present in request",
        );
        return;
      }
      const authResult = await auth.authenticate_webhook(rawPayload, signature, timestamp, publicKey);
      if (!authResult.isValid) {
        fail(
          401,
          webhookSignatureCode(authResult.error?.code),
          authResult.error?.message ?? "Webhook payload Ed25519 signature did not verify",
        );
        return;
      }
      // Signature verified: the session id carried in the signed payload is now
      // trustworthy and links this webhook to the session opened at login.
      const sessionId = extractWebhookSessionId({
        headers: req.headers,
        rawPayload,
      });
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
      if (receiptsEnabled) {
        recordReceipt(endpoint, rawPayload, requestId, sessionId, sessionKnown);
      }
      if (endpoint === "/hooks/wake") {
        const wake = normalizeWakePayload(rawPayload);
        if (!wake.ok) {
          fail(400, wake.code, wake.message, wake.details);
          return;
        }
        await requestGatewayHeartbeat(wake.mode);
        respond(200, { ok: true, mode: wake.mode, sessionId, sessionKnown, requestId });
        return;
      }
      if (endpoint === "/hooks/agent") {
        respond(200, { ok: true, endpoint: "agent", accepted: true, sessionId, sessionKnown, requestId });
        return;
      }
      respond(200, { ok: true, endpoint, sessionId, sessionKnown, requestId });
    } catch (err) {
      if (!res.headersSent) {
        fail(500, "WEBHOOK_PROCESSING_FAILED", "Webhook processing failed", undefined, err);
      } else {
        logWithContext(
          logger,
          "error",
          "Webhook processing failed",
          {
            operation: "webhook.handle",
            requestId,
            method,
            path: endpoint,
            duration: Date.now() - started,
          },
          err,
        );
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
      enableReceiptsEndpoint?: boolean;
    };
    configurePeerRegistry({
      persist: config.persistPeerRegistry === true,
      cachePath: config.peerRegistryPath?.trim() || undefined,
    });
    const endpoints = (config.endpoints?.length ? config.endpoints : DEFAULT_ENDPOINTS).map((path) =>
      path.startsWith("/") ? path : `/${path}`,
    );
    const logLevel = config.logLevel?.trim() || undefined;
    // Opt-in only: exposes session-linked receipt metadata. Keep off in production.
    const receiptsEnabled = config.enableReceiptsEndpoint === true;

    const logger = api.logger as PluginLogger;

    for (const endpoint of endpoints) {
      api.registerHttpRoute({
        path: endpoint,
        auth: "plugin",
        handler: createRoditWebhookHandler(endpoint, logLevel, logger, receiptsEnabled),
      });
      logWithContext(logger, "info", "HTTP route registered", {
        operation: "plugin.registerHttpRoute",
        path: endpoint,
      });
    }

    if (receiptsEnabled) {
      api.registerHttpRoute({
        path: "/hooks/_receipts",
        auth: "plugin",
        handler: async (req, res) => {
          const requestId = headerValue(req, "x-request-id") || createRequestId();
          if (req.method === "DELETE") {
            clearReceipts();
            sendJson(res, 200, { ok: true, cleared: true, requestId });
            return;
          }
          if (req.method !== "GET") {
            res.setHeader("Allow", "GET, DELETE");
            sendJson(
              res,
              405,
              errorEnvelope({
                requestId,
                code: "METHOD_NOT_ALLOWED",
                message: "Method Not Allowed",
              }),
            );
            return;
          }
          sendJson(res, 200, { ok: true, receipts: webhookReceipts, requestId });
        },
      });
      logWithContext(logger, "info", "HTTP route registered", {
        operation: "plugin.registerHttpRoute",
        path: "/hooks/_receipts",
      });
    } else {
      logWithContext(logger, "info", "Receipts endpoint disabled", {
        operation: "plugin.registerHttpRoute",
        path: "/hooks/_receipts",
      });
    }

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
          logger,
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
    logWithContext(logger, "info", "Tool registered", {
      operation: "plugin.registerTool",
      tool: "send_rodit_webhook",
    });

    api.registerService({
      id: "identyclaw-webhooks",
      start: async () => {
        try {
          await getRoditClient(logLevel);
          const passport = await getOwnPassportUrls(logLevel);
          if (passport.webhook_url) {
            logWithContext(logger, "info", "Passport webhook URL loaded", {
              operation: "startup.warmup",
              webhook_url: passport.webhook_url,
            });
          }
          const pluginConfig = (api.config ?? {}) as Parameters<typeof a2aPluginConfig>[0];
          if (a2aPluginEntryKey(pluginConfig) === "a2a") {
            logWithContext(logger, "info", "A2A plugin config used fallback", {
              operation: "config.a2aPluginEntry",
              used: "a2a",
              skipped: ["identyclaw-a2a"],
            });
          }
          const configured = a2aPluginConfig(pluginConfig)?.inbound?.publicBaseUrl?.replace(/\/+$/, "");
          if (configured && passport.webhook_url && configured !== passport.webhook_url) {
            logWithContext(logger, "warn", "Inbound public base URL differs from Passport webhook URL", {
              operation: "startup.warmup",
              publicBaseUrl: configured,
              webhook_url: passport.webhook_url,
            });
          }
          logWithContext(logger, "info", "RODiT passport warmed up for webhook verification", {
            operation: "startup.warmup",
          });
        } catch (err) {
          logWithContext(
            logger,
            "error",
            "RODiT passport warmup failed",
            { operation: "startup.warmup" },
            err,
          );
        }
      },
    });
  },
});

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type RoditWebhookSendResult = {
  isValid: boolean;
  message?: string;
  requestId?: string;
  duration?: number;
  error?: { code?: string; message?: string; requestId?: string };
};

export type OwnPassportUrls = {
  webhook_url: string;
  api_base: string;
  owner_id: string;
};

export type RoditClientLike = {
  getStateManager: () => {
    getOwnBase64urlJwkPublicKey: () => string | null | undefined;
    getPeerBase64urlJwkPublicKey: () => string | null | undefined;
  };
  getSessionManager: () => {
    hasSession: (sessionId: string) => Promise<boolean>;
  };
  getConfigOwnRodit: () => Promise<{
    own_rodit?: {
      owner_id?: string;
      metadata?: Record<string, string>;
    };
  }>;
  getSessionToken: () => Promise<string | null>;
  login_server: (opts?: { loginPath?: string }) => Promise<{ success?: boolean; jwt_token?: string }>;
  request: (
    method: string,
    path: string,
    data?: unknown,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  sendWakeHook: (
    data: Record<string, unknown>,
    req: { user: { rodit_webhookurl: string } },
    options?: WebhookSendOptions,
  ) => Promise<RoditWebhookSendResult>;
  sendWebhookToEndpoint: (
    data: Record<string, unknown>,
    endpoint: string,
    req: { user: { rodit_webhookurl: string } },
    options?: WebhookSendOptions,
  ) => Promise<RoditWebhookSendResult>;
};

export type WebhookSendOptions = {
  sessionId?: string;
  sessionRoditId?: string;
};

function normalizeWebhookBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.includes("://")) return trimmed;
  return `https://${trimmed}`;
}

export async function getOwnPassportUrls(logLevel?: string): Promise<OwnPassportUrls> {
  const client = await getRoditClient(logLevel);
  const own = await client.getConfigOwnRodit();
  const meta = own?.own_rodit?.metadata ?? {};
  return {
    webhook_url: normalizeWebhookBase(String(meta.webhook_url || "")),
    api_base: String(meta.subjectuniqueidentifier_url || "").trim().replace(/\/+$/, ""),
    owner_id: String(own?.own_rodit?.owner_id || "").trim(),
  };
}

let roditClientPromise: Promise<RoditClientLike> | null = null;

export function applyRoditEmbedEnv(logLevel?: string) {
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = logLevel ?? "error";
  }
  if (process.env.SUPPRESS_NO_CONFIG_WARNING === undefined) {
    process.env.SUPPRESS_NO_CONFIG_WARNING = "true";
  }
  if (process.env.SUPPRESS_STRICTNESS_CHECK === undefined) {
    process.env.SUPPRESS_STRICTNESS_CHECK = "true";
  }
}

export function applyWebhookTlsSkip(skip: boolean) {
  if (skip) {
    process.env.SECURITY_OPTIONS_WEBHOOK_TLS_SKIP_VERIFY = "true";
  }
}

export function peerBaseToRoditWebhookUrl(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function buildPeerWebhookReq(peerBaseUrl: string): { user: { rodit_webhookurl: string } } {
  return { user: { rodit_webhookurl: peerBaseToRoditWebhookUrl(peerBaseUrl) } };
}

export async function getRoditClient(logLevel?: string): Promise<RoditClientLike> {
  applyRoditEmbedEnv(logLevel);
  if (!roditClientPromise) {
    const require = createRequire(import.meta.url);
    const { RoditClient } = require("@rodit/rodit-auth-be") as {
      RoditClient: { create: (opts: { role: string }) => Promise<RoditClientLike> };
    };
    if (
      !process.env.NEAR_CREDENTIALS_FILE_PATH?.trim() &&
      !process.env.RODIT_NEAR_CREDENTIALS_SOURCE?.trim()
    ) {
      throw new Error("RODiT credentials not configured (NEAR_CREDENTIALS_FILE_PATH)");
    }
    roditClientPromise = RoditClient.create({ role: "client" });
  }
  return roditClientPromise;
}

export type RoditAuth = {
  authenticate_webhook: (
    payload: string,
    signatureHex: string,
    timestamp: string,
    publicKeyBase64url: string,
  ) => Promise<{ isValid: boolean; error?: { code?: string; message?: string } }>;
};

let roditAuthPromise: Promise<RoditAuth> | null = null;

export function loadRoditAuth(logLevel?: string): RoditAuth {
  applyRoditEmbedEnv(logLevel);
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(require.resolve("@rodit/rodit-auth-be"));
  return require(join(pkgRoot, "lib/auth/authentication.js")) as RoditAuth;
}

export async function getRoditAuth(logLevel?: string): Promise<RoditAuth> {
  if (!roditAuthPromise) {
    roditAuthPromise = Promise.resolve(loadRoditAuth(logLevel));
  }
  return roditAuthPromise;
}

export type WebhookKeyResolution = { key: string | null; source: string; tokenId: string };

export type WebhookKeyResolver = {
  resolveWebhookSignerKey: (params: {
    headers?: Record<string, string | string[] | undefined>;
    rawPayload?: string;
    parsedBody?: unknown;
    stateManager?: unknown;
    tokenId?: string;
    advertisedKeyBase64url?: string;
  }) => Promise<WebhookKeyResolution>;
  rememberPeerKey: (tokenId: string, base64urlKey: string) => void;
  configureWebhookKeyResolver: (options: {
    lookup?: (tokenId: string) => Promise<string | null>;
    allowUnboundAdvertisedKey?: boolean;
  }) => void;
  extractWebhookSessionId: (params: {
    headers?: Record<string, string | string[] | undefined>;
    rawPayload?: string;
    parsedBody?: unknown;
  }) => string;
};

// Cached load of the SDK's shared resolver. Requires @rodit/rodit-auth-be
// >= 9.12.0; if the module is absent the require throws, which is intentional —
// the plugin depends on the shared resolver and must not silently degrade.
let webhookKeyResolverPromise: Promise<WebhookKeyResolver> | null = null;

export function loadWebhookKeyResolver(logLevel?: string): WebhookKeyResolver {
  applyRoditEmbedEnv(logLevel);
  const require = createRequire(import.meta.url);
  const pkgRoot = dirname(require.resolve("@rodit/rodit-auth-be"));
  return require(join(pkgRoot, "lib/auth/webhookkeyresolver.js")) as WebhookKeyResolver;
}

export async function getWebhookKeyResolver(logLevel?: string): Promise<WebhookKeyResolver> {
  if (!webhookKeyResolverPromise) {
    webhookKeyResolverPromise = Promise.resolve(loadWebhookKeyResolver(logLevel));
  }
  return webhookKeyResolverPromise;
}

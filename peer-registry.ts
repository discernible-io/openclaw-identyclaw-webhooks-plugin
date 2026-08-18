import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logWithContext, type PluginLogger } from "./plugin-log.js";
import { getRoditClient } from "./rodit-runtime.js";

const A2A_PEERS_PATH = join(
  (process.env.OPENCLAW_STATE_DIR ?? "/home/node/.openclaw").trim(),
  "a2a",
  "outbound",
  "peers.json",
);

type A2aPersistedPeer = {
  url?: string;
  resolvedAt?: string;
};

let a2aPeersCache: Record<string, A2aPersistedPeer> | null = null;
let a2aPeersCacheMtime = 0;

export function agentCardUrlToBase(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/.well-known/agent-card.json")) {
    return trimmed.slice(0, -"/.well-known/agent-card.json".length);
  }
  return trimmed;
}

export type OutboundPeerEntry = {
  url?: string;
  loginBaseUrl?: string;
  webhookHost?: string;
  contactUri?: string;
  tokenId: string;
  registeredAt: string;
};

export type TokenIdentityFull = {
  tokenId?: string;
  metadata?: Record<string, unknown> | null;
  dn?: {
    contactUri?: string | null;
  } | null;
};

type RoditApiClient = {
  getSessionToken: () => Promise<string | null>;
  login_server: (opts?: { loginPath?: string }) => Promise<{ success?: boolean; jwt_token?: string }>;
  request: (method: string, path: string, data?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
};

type PeerRegistryOptions = {
  persist?: boolean;
  cachePath?: string;
};

const DEFAULT_CACHE_PATH = "/home/node/.openclaw/cache/peer-registry.json";
const memoryRegistry = new Map<string, OutboundPeerEntry>();
let registryOptions: PeerRegistryOptions = {};

export function configurePeerRegistry(options: PeerRegistryOptions = {}) {
  registryOptions = { ...registryOptions, ...options };
  loadPersistedPeers(registryOptions.cachePath ?? DEFAULT_CACHE_PATH);
}

function loadPersistedPeers(cachePath: string) {
  try {
    const raw = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, OutboundPeerEntry>;
    for (const [tokenId, entry] of Object.entries(parsed)) {
      if (entry?.tokenId) memoryRegistry.set(tokenId, entry);
    }
  } catch {
    // No cache yet — start empty.
  }
}

function persistPeers(cachePath: string) {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const payload = Object.fromEntries(memoryRegistry.entries());
    writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort persistence only.
  }
}

export function parseContactUri(contactUri: string): Omit<OutboundPeerEntry, "tokenId" | "registeredAt"> {
  const trimmed = contactUri.trim();
  if (!trimmed) {
    throw new Error("contactUri is empty");
  }

  const firstColon = trimmed.indexOf(":");
  const secondColon = trimmed.indexOf(":", firstColon + 1);
  if (firstColon <= 0 || secondColon <= firstColon + 1) {
    throw new Error(`Invalid contactUri (expected scheme:authority:identifier): ${contactUri}`);
  }

  const scheme = trimmed.slice(0, firstColon).toLowerCase();
  const authority = trimmed.slice(firstColon + 1, secondColon);
  const identifier = trimmed.slice(secondColon + 1);

  if (!authority) {
    throw new Error(`Invalid contactUri authority: ${contactUri}`);
  }

  if (scheme === "https" || scheme === "http") {
    const origin = `${scheme}://${authority}`;
    if (!identifier) {
      return { loginBaseUrl: origin, contactUri: trimmed };
    }
    if (/^\d+$/.test(identifier)) {
      return { loginBaseUrl: `${origin}:${identifier}`, contactUri: trimmed };
    }
    const path = identifier.startsWith("/") ? identifier : `/${identifier}`;
    const absolute = `${origin}${path}`;
    if (path.includes(".well-known") || path.endsWith(".json")) {
      return { url: absolute, loginBaseUrl: origin, contactUri: trimmed };
    }
    return { loginBaseUrl: absolute.replace(/\/$/, ""), contactUri: trimmed };
  }

  if (scheme === "webhook" || scheme === "rodit") {
    const loginBaseUrl = authority.includes("://") ? authority : `https://${authority}`;
    return { webhookHost: authority.replace(/^https?:\/\//i, "").replace(/\/+$/, ""), loginBaseUrl, contactUri: trimmed };
  }

  const loginBaseUrl = authority.includes("://") ? authority : `https://${authority}`;
  return { loginBaseUrl: loginBaseUrl.replace(/\/$/, ""), contactUri: trimmed };
}

function parseWebhookBase(raw: string): string {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return trimmed;
  }
}

function extractWebhookUrlFromIdentity(identity: TokenIdentityFull): string {
  const meta = identity?.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const fromMeta = String(meta.webhook_url ?? meta.webhookUrl ?? "").trim();
    if (fromMeta) return fromMeta;
  }
  return "";
}

function entryFromWebhookUrl(webhookUrl: string, contactUri: string): Omit<OutboundPeerEntry, "tokenId" | "registeredAt"> {
  const base = parseWebhookBase(webhookUrl);
  if (!base || !/^https?:\/\//i.test(base)) {
    throw new Error(`Identity has no usable metadata.webhook_url for outbound delivery`);
  }
  return {
    url: `${base}/.well-known/agent-card.json`,
    loginBaseUrl: base,
    contactUri: contactUri || webhookUrl,
  };
}

export function resolvePeerBaseFromEntry(entry: Pick<OutboundPeerEntry, "url" | "loginBaseUrl" | "webhookHost">): string {
  const cardUrl = entry.url?.trim();
  if (cardUrl) return agentCardUrlToBase(cardUrl);
  const loginBase = entry.loginBaseUrl?.trim();
  if (loginBase) return loginBase.replace(/\/$/, "");
  const webhookHost = entry.webhookHost?.trim();
  if (webhookHost) return `https://${webhookHost.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`;
  throw new Error("Peer entry has no resolvable base URL");
}

function loadA2aPersistedPeers(): Record<string, A2aPersistedPeer> {
  try {
    const mtime = statSync(A2A_PEERS_PATH).mtimeMs;
    if (a2aPeersCache && mtime === a2aPeersCacheMtime) {
      return a2aPeersCache;
    }
    const parsed = JSON.parse(readFileSync(A2A_PEERS_PATH, "utf8")) as Record<string, A2aPersistedPeer>;
    a2aPeersCache = parsed && typeof parsed === "object" ? parsed : {};
    a2aPeersCacheMtime = mtime;
    return a2aPeersCache;
  } catch {
    a2aPeersCache = {};
    a2aPeersCacheMtime = 0;
    return a2aPeersCache;
  }
}

export function getA2aPersistedPeer(tokenId: string): OutboundPeerEntry | undefined {
  const normalized = tokenId.trim();
  const entry = loadA2aPersistedPeers()[normalized];
  const url = entry?.url?.trim();
  if (!url) return undefined;
  return {
    tokenId: normalized,
    url,
    registeredAt: entry.resolvedAt ?? new Date().toISOString(),
  };
}

export function getRegisteredPeer(tokenId: string): OutboundPeerEntry | undefined {
  return memoryRegistry.get(tokenId.trim());
}

export function registerPeer(tokenId: string, entry: Omit<OutboundPeerEntry, "tokenId" | "registeredAt">): OutboundPeerEntry {
  const normalized = tokenId.trim();
  const record: OutboundPeerEntry = {
    ...entry,
    tokenId: normalized,
    registeredAt: new Date().toISOString(),
  };
  memoryRegistry.set(normalized, record);
  if (registryOptions.persist) {
    persistPeers(registryOptions.cachePath ?? DEFAULT_CACHE_PATH);
  }
  return record;
}

export async function ensureApiSession(client: RoditApiClient): Promise<void> {
  const existing = await client.getSessionToken();
  if (existing) return;
  await client.login_server();
}

export async function fetchTokenIdentityFull(client: RoditApiClient, tokenId: string): Promise<TokenIdentityFull> {
  await ensureApiSession(client);
  const path = `/api/identity/token/${encodeURIComponent(tokenId.trim())}/full`;
  return (await client.request("GET", path)) as TokenIdentityFull;
}

export async function registerPeerFromTokenId(
  tokenId: string,
  options?: { client?: RoditApiClient; logger?: PluginLogger },
): Promise<OutboundPeerEntry> {
  const normalized = tokenId.trim();
  const cached = getRegisteredPeer(normalized);
  if (cached) return cached;

  const roditClient = (options?.client ?? (await getRoditClient())) as RoditApiClient;
  const identity = await fetchTokenIdentityFull(roditClient, normalized);
  const contactUri = identity?.dn?.contactUri?.trim() ?? "";
  const webhookUrl = extractWebhookUrlFromIdentity(identity);
  if (webhookUrl) {
    return registerPeer(normalized, entryFromWebhookUrl(webhookUrl, contactUri));
  }
  if (!contactUri) {
    throw new Error(`Peer '${normalized}' has no metadata.webhook_url or contactUri in identity token/full response`);
  }

  logWithContext(options?.logger, "info", "Peer identity URL used fallback", {
    operation: "outbound.registerPeerFromTokenId",
    peerId: normalized,
    used: "identity.contactUri",
    skipped: ["identity.webhook_url"],
  });
  const parsed = parseContactUri(contactUri);
  return registerPeer(normalized, parsed);
}

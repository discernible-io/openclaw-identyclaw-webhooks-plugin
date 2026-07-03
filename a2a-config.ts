export type A2aOutboundPeer = string | { url?: string; loginBaseUrl?: string };

export type A2aOutboundConfig = {
  tlsSkipVerify?: boolean;
  agents?: Record<string, A2aOutboundPeer>;
};

export type OpenClawConfig = {
  plugins?: {
    entries?: Record<
      string,
      | {
          config?: {
            outbound?: A2aOutboundConfig;
            inbound?: { publicBaseUrl?: string };
          };
        }
      | undefined
    >;
  };
};

export function a2aPluginEntryKey(config: OpenClawConfig): "identyclaw-a2a" | "a2a" {
  const entries = config.plugins?.entries ?? {};
  return entries["identyclaw-a2a"] ? "identyclaw-a2a" : "a2a";
}

export function a2aPluginConfig(config: OpenClawConfig) {
  const key = a2aPluginEntryKey(config);
  return config.plugins?.entries?.[key]?.config;
}

export function a2aOutboundConfig(config: OpenClawConfig): A2aOutboundConfig | undefined {
  return a2aPluginConfig(config)?.outbound;
}

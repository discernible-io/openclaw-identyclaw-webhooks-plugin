import { randomBytes } from "node:crypto";

export const PLUGIN_COMPONENT = "identyclaw-webhooks";

export type PluginLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type LogContext = Record<string, unknown>;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID for webhook `requestId` (error-handling standard). */
export function createRequestId(now = Date.now()): string {
  let time = now;
  let chars = "";
  for (let i = 0; i < 10; i++) {
    chars = CROCKFORD[time % 32] + chars;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(10);
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars += CROCKFORD[(buffer >> bits) & 31];
    }
  }
  return chars;
}

export function canonicalError(err: unknown): {
  name?: string;
  message: string;
  code?: string;
} {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      name: err.name,
      message: err.message,
      ...(typeof code === "string" && code ? { code } : {}),
    };
  }
  return { message: String(err) };
}

export function logWithContext(
  logger: PluginLogger | undefined,
  level: "info" | "warn" | "error",
  message: string,
  context: LogContext = {},
  err?: unknown,
): void {
  if (!logger) return;
  const payload: LogContext = {
    component: PLUGIN_COMPONENT,
    ...context,
  };
  if (err !== undefined) {
    payload.error = canonicalError(err);
  }
  const emit =
    (level === "warn" ? logger.warn : logger[level]) ??
    (level === "error" ? logger.error : logger.info);
  emit.call(logger, message, payload);
}

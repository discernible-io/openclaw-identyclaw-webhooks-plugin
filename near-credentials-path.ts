import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveNearCredentialsDir(): string {
  return (
    nonEmptyTrimmed(process.env.IDENTYCLAW_NEAR_CREDENTIALS_DIR) ??
    path.join(os.homedir(), ".openclaw", "secrets", "near-credentials")
  );
}

/**
 * Prefer explicit NEAR_CREDENTIALS_FILE_PATH; else discover under
 * IDENTYCLAW_NEAR_CREDENTIALS_DIR / ~/.openclaw/secrets/near-credentials
 * (`.active` → `<id>.json`, else the sole `*.json`).
 */
export function resolveNearCredentialsFilePath(): string | undefined {
  const fromEnv = nonEmptyTrimmed(process.env.NEAR_CREDENTIALS_FILE_PATH);
  if (fromEnv) {
    return fromEnv;
  }

  const outputDir = resolveNearCredentialsDir();
  try {
    if (!fs.existsSync(outputDir)) {
      return undefined;
    }
    const activePath = path.join(outputDir, ".active");
    if (fs.existsSync(activePath)) {
      const activeId = nonEmptyTrimmed(fs.readFileSync(activePath, "utf8").split(/\r?\n/)[0]);
      if (activeId) {
        const activeFile = path.join(outputDir, `${activeId}.json`);
        if (fs.existsSync(activeFile)) {
          return activeFile;
        }
      }
    }
    const jsonFiles = fs
      .readdirSync(outputDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(outputDir, name));
    if (jsonFiles.length === 1) {
      return jsonFiles[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Ensure Rodit has a credential source. Keeps a non-file
 * RODIT_NEAR_CREDENTIALS_SOURCE if already set; otherwise discovers a file.
 */
export function ensureNearCredentialsFileEnv(): void {
  if (process.env.RODIT_NEAR_CREDENTIALS_SOURCE?.trim()) {
    return;
  }

  const filePath = resolveNearCredentialsFilePath();
  if (!filePath) {
    throw new Error(
      "RODiT credentials not configured: set NEAR_CREDENTIALS_FILE_PATH or place a single Passport JSON under secrets/near-credentials (optional .active)",
    );
  }

  process.env.NEAR_CREDENTIALS_FILE_PATH = filePath;
  process.env.RODIT_NEAR_CREDENTIALS_SOURCE = "file";
}

/** Resolve a concrete credentials JSON path for outbound signing. */
export function requireNearCredentialsFilePath(): string {
  const filePath = resolveNearCredentialsFilePath();
  if (!filePath) {
    throw new Error(
      "NEAR credentials file not found: set NEAR_CREDENTIALS_FILE_PATH or place a single Passport JSON under secrets/near-credentials (optional .active)",
    );
  }
  if (!process.env.NEAR_CREDENTIALS_FILE_PATH?.trim()) {
    process.env.NEAR_CREDENTIALS_FILE_PATH = filePath;
  }
  if (!process.env.RODIT_NEAR_CREDENTIALS_SOURCE?.trim()) {
    process.env.RODIT_NEAR_CREDENTIALS_SOURCE = "file";
  }
  return filePath;
}

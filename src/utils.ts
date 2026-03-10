import fs from "node:fs";
import path from "node:path";
import type { AgentIndex, SoulHubConfig, InstalledAgent } from "./types.js";

// Registry base URL - points to GitHub raw content
const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/soulhub-community/soulhub/main/registry";

export function getRegistryUrl(): string {
  return process.env.SOULHUB_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

/**
 * Fetch the agent index from the registry
 */
export async function fetchIndex(): Promise<AgentIndex> {
  const url = `${getRegistryUrl()}/index.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch registry index: ${response.statusText}`);
  }
  return (await response.json()) as AgentIndex;
}

/**
 * Fetch a file from the registry for a specific agent
 */
export async function fetchAgentFile(
  agentName: string,
  fileName: string
): Promise<string> {
  const url = `${getRegistryUrl()}/agents/${agentName}/${fileName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${fileName} for ${agentName}: ${response.statusText}`
    );
  }
  return await response.text();
}

/**
 * Fetch a recipe file from the registry
 */
export async function fetchRecipeFile(
  recipeName: string,
  fileName: string
): Promise<string> {
  const url = `${getRegistryUrl()}/recipes/${recipeName}/${fileName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${fileName} for recipe ${recipeName}: ${response.statusText}`
    );
  }
  return await response.text();
}

/**
 * Detect OpenClaw installation directory
 */
export function findOpenClawDir(): string | null {
  const candidates = [
    path.join(process.env.HOME || "~", ".openclaw"),
    path.join(process.cwd(), ".openclaw"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Get the SoulHub config file path
 */
export function getConfigPath(): string {
  const home = process.env.HOME || "~";
  return path.join(home, ".soulhub", "config.json");
}

/**
 * Load SoulHub config
 */
export function loadConfig(): SoulHubConfig {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  return {
    installed: [],
    registryUrl: DEFAULT_REGISTRY_URL,
  };
}

/**
 * Save SoulHub config
 */
export function saveConfig(config: SoulHubConfig): void {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Record an installed agent
 */
export function recordInstall(
  name: string,
  version: string,
  workspace: string
): void {
  const config = loadConfig();
  // Remove existing entry if any
  config.installed = config.installed.filter((a) => a.name !== name);
  config.installed.push({
    name,
    version,
    installedAt: new Date().toISOString(),
    workspace,
  });
  saveConfig(config);
}

/**
 * Remove install record
 */
export function removeInstallRecord(name: string): void {
  const config = loadConfig();
  config.installed = config.installed.filter((a) => a.name !== name);
  saveConfig(config);
}

/**
 * Get workspace directory for an agent
 */
export function getWorkspaceDir(
  clawDir: string,
  agentName: string
): string {
  return path.join(clawDir, `workspace-${agentName}`);
}

/**
 * Category display names
 */
export const CATEGORY_LABELS: Record<string, string> = {
  "self-media": "Self Media",
  development: "Development",
  operations: "Operations",
  support: "Support",
  education: "Education",
  dispatcher: "Dispatcher",
};

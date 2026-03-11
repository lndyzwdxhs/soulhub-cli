import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import type {
  AgentIndex,
  SoulHubConfig,
  InstalledAgent,
  SoulHubPackage,
  OpenClawConfig,
} from "./types.js";

// Registry base URL
const DEFAULT_REGISTRY_URL =
  "http://soulhub.store";

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
 * 优先级：customDir 参数 > OPENCLAW_HOME 环境变量 > 默认路径 ~/.openclaw > 当前目录 .openclaw
 */
export function findOpenClawDir(customDir?: string): string | null {
  // 1. 如果传入了自定义路径，直接使用
  if (customDir) {
    const resolved = path.resolve(customDir);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    // 自定义路径不存在，也返回它（调用方可能会创建）
    return resolved;
  }

  // 2. 检查 OPENCLAW_HOME 环境变量
  const envHome = process.env.OPENCLAW_HOME;
  if (envHome) {
    const resolved = path.resolve(envHome);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    // 环境变量指定的路径不存在，仍然返回（信任用户配置）
    return resolved;
  }

  // 3. 默认路径候选列表
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
 * Get workspace directory for a worker agent (workspace-xxx)
 */
export function getWorkspaceDir(
  clawDir: string,
  agentName: string
): string {
  return path.join(clawDir, `workspace-${agentName}`);
}

/**
 * Get main workspace directory (主 agent 的 workspace)
 * 主 agent（dispatcher 或唯一的 agent）使用 ~/.openclaw/workspace
 */
export function getMainWorkspaceDir(clawDir: string): string {
  return path.join(clawDir, "workspace");
}

/**
 * 检查主 agent workspace 是否存在且有内容
 */
export function checkMainAgentExists(clawDir: string): {
  exists: boolean;
  hasContent: boolean;
  workspaceDir: string;
} {
  const workspaceDir = getMainWorkspaceDir(clawDir);
  if (!fs.existsSync(workspaceDir)) {
    return { exists: false, hasContent: false, workspaceDir };
  }
  const entries = fs.readdirSync(workspaceDir);
  // 检查是否有 IDENTITY.md 或 SOUL.md（标志着有实质内容）
  const hasIdentity = entries.includes("IDENTITY.md");
  const hasSoul = entries.includes("SOUL.md");
  return {
    exists: true,
    hasContent: hasIdentity || hasSoul,
    workspaceDir,
  };
}

// ==========================================
// OpenClaw 配置文件 (openclaw.json) 操作
// ==========================================

/**
 * 获取 openclaw.json 文件路径
 */
export function getOpenClawConfigPath(clawDir: string): string {
  return path.join(clawDir, "openclaw.json");
}

/**
 * 读取 openclaw.json 配置
 */
export function readOpenClawConfig(clawDir: string): OpenClawConfig | null {
  const configPath = getOpenClawConfigPath(clawDir);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenClawConfig;
  } catch {
    return null;
  }
}

/**
 * 写入 openclaw.json 配置
 */
export function writeOpenClawConfig(clawDir: string, config: OpenClawConfig): void {
  const configPath = getOpenClawConfigPath(clawDir);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * 更新 openclaw.json 配置（读取 → 修改 → 写入）
 */
export function updateOpenClawConfig(
  clawDir: string,
  updater: (config: OpenClawConfig) => OpenClawConfig
): boolean {
  const config = readOpenClawConfig(clawDir);
  if (!config) {
    return false;
  }
  const updated = updater(config);
  writeOpenClawConfig(clawDir, updated);
  return true;
}

/**
 * 配置多 Agent 通信（修改 openclaw.json）
 * 设置 dispatcher 的 subagents.allowAgents、tools.agentToAgent、tools.sessions.visibility
 */
export function configureMultiAgentCommunication(
  clawDir: string,
  dispatcherId: string,
  workerIds: string[]
): boolean {
  return updateOpenClawConfig(clawDir, (config) => {
    // 确保 agents.list 存在
    if (!config.agents) config.agents = {};
    if (!config.agents.list) config.agents.list = [];

    // 找到 dispatcher agent，设置 subagents.allowAgents
    const dispatcherAgent = config.agents.list.find((a) => a.id === dispatcherId);
    if (dispatcherAgent) {
      dispatcherAgent.subagents = {
        ...dispatcherAgent.subagents,
        allowAgents: workerIds,
      };
    }

    // 配置 tools.sessions.visibility = "all"
    if (!config.tools) config.tools = {};
    config.tools.sessions = {
      ...config.tools.sessions,
      visibility: "all",
    };

    // 配置 tools.agentToAgent
    const allAgentIds = [dispatcherId, ...workerIds];
    config.tools.agentToAgent = {
      enabled: true,
      allow: allAgentIds,
    };

    return config;
  });
}

/**
 * 向 openclaw.json 中添加一个 agent 配置（不通过 CLI）
 * 用于直接修改 openclaw.json，而不是调用 openclaw agents add
 */
export function addAgentToOpenClawConfig(
  clawDir: string,
  agentId: string,
  agentName: string,
  isMain: boolean
): boolean {
  return updateOpenClawConfig(clawDir, (config) => {
    if (!config.agents) config.agents = {};
    if (!config.agents.list) config.agents.list = [];

    // 检查是否已存在
    const existing = config.agents.list.find((a) => a.id === agentId);
    if (existing) {
      // 更新名称
      existing.name = agentName;
      return config;
    }

    if (isMain) {
      // 主 agent 不需要 workspace 和 agentDir（使用默认值）
      config.agents.list.push({
        id: agentId,
        name: agentName,
      });
    } else {
      // 子 agent 需要指定 workspace 和 agentDir
      config.agents.list.push({
        id: agentId,
        name: agentName,
        workspace: path.join(clawDir, `workspace-${agentId}`),
        agentDir: path.join(clawDir, `agents/${agentId}/agent`),
      });
    }

    return config;
  });
}

// ==========================================
// soulhub.yaml 解析与包类型识别
// ==========================================

/**
 * 从目录中读取 soulhub.yaml 包描述
 */
export function readSoulHubPackage(dir: string): SoulHubPackage | null {
  const yamlPath = path.join(dir, "soulhub.yaml");
  if (!fs.existsSync(yamlPath)) {
    return null;
  }
  try {
    return yaml.load(fs.readFileSync(yamlPath, "utf-8")) as SoulHubPackage;
  } catch {
    return null;
  }
}



/**
 * 自动识别本地目录/文件是单 agent 还是多 agent team
 */
export function detectPackageKind(dir: string): "agent" | "team" | "unknown" {
  // 1. 检查 soulhub.yaml
  const pkg = readSoulHubPackage(dir);
  if (pkg) {
    return pkg.kind;
  }

  // 2. 检查是否直接包含 IDENTITY.md（单 agent）
  if (fs.existsSync(path.join(dir, "IDENTITY.md"))) {
    return "agent";
  }

  return "unknown";
}

/**
 * 检查 OpenClaw 是否已安装
 * 优先级：customDir 参数（--claw-dir）> OPENCLAW_HOME 环境变量 > 默认路径检测 > PATH 命令检测
 */
export function checkOpenClawInstalled(customDir?: string): {
  installed: boolean;
  clawDir: string | null;
  message: string;
} {
  const clawDir = findOpenClawDir(customDir);

  if (clawDir) {
    return {
      installed: true,
      clawDir,
      message: `OpenClaw detected at: ${clawDir}`,
    };
  }

  // 尝试检测 openclaw 命令是否可用
  try {
    execSync("which openclaw 2>/dev/null || where openclaw 2>nul", {
      stdio: "pipe",
    });
    return {
      installed: true,
      clawDir: null,
      message: "OpenClaw command found in PATH, but workspace directory not detected.",
    };
  } catch {
    // openclaw 命令不在 PATH 中
  }

  return {
    installed: false,
    clawDir: null,
    message: "OpenClaw is not installed. Please install OpenClaw first, use --claw-dir to specify OpenClaw directory, or set OPENCLAW_HOME environment variable.",
  };
}

/**
 * 备份 agent 工作目录
 * 将 workspace 目录复制（cp）到 ~/.openclaw/agentbackup/ 下，原目录保持不变
 * 例如：~/.openclaw/workspace → 复制到 ~/.openclaw/agentbackup/workspace
 * 如果备份目录中已存在同名文件夹，则追加时间戳
 */
export function backupAgentWorkspace(workspaceDir: string): string | null {
  if (!fs.existsSync(workspaceDir)) {
    return null; // 目录不存在，无需备份
  }

  // 检查目录中是否有内容
  const entries = fs.readdirSync(workspaceDir);
  if (entries.length === 0) {
    return null; // 空目录，无需备份
  }

  // 在 openclaw 目录下创建 agentbackup 目录
  const clawDir = path.dirname(workspaceDir);
  const backupBaseDir = path.join(clawDir, "agentbackup");
  if (!fs.existsSync(backupBaseDir)) {
    fs.mkdirSync(backupBaseDir, { recursive: true });
  }

  // 确定备份目标路径，如果已存在同名目录则追加时间戳
  const dirName = path.basename(workspaceDir);
  let backupDir = path.join(backupBaseDir, dirName);
  if (fs.existsSync(backupDir)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    backupDir = path.join(backupBaseDir, `${dirName}-${timestamp}`);
  }

  // 复制文件夹到备份目录（保持原目录不变）
  fs.cpSync(workspaceDir, backupDir, { recursive: true });

  return backupDir;
}

/**
 * 列出指定 OpenClaw 目录下所有已安装的 agent workspace
 * 返回 workspace 文件夹名称列表
 */
export function listAgentWorkspaces(clawDir: string): string[] {
  if (!fs.existsSync(clawDir)) {
    return [];
  }

  return fs.readdirSync(clawDir).filter((entry) => {
    const fullPath = path.join(clawDir, entry);
    return (
      fs.statSync(fullPath).isDirectory() &&
      entry.startsWith("workspace-")
    );
  });
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

/**
 * 将安装的 agent 注册到 OpenClaw 配置中
 * 调用 `openclaw agents add` 命令（非交互模式），由 OpenClaw 负责生成完整的目录结构和依赖文件。
 * 必须依赖 openclaw CLI，不提供降级方案。
 */
export function registerAgentToOpenClaw(
  agentName: string,
  workspaceDir: string,
  _clawDir?: string
): { success: boolean; message: string } {
  // 规范化 agent ID（与 OpenClaw 的 normalizeAgentId 逻辑一致：转小写，空格/下划线转连字符）
  const agentId = agentName.toLowerCase().replace(/[\s_]+/g, "-");

  try {
    execSync(
      `openclaw agents add "${agentId}" --workspace "${workspaceDir}" --non-interactive --json`,
      { stdio: "pipe", timeout: 15000 }
    );
    return {
      success: true,
      message: `Agent "${agentId}" registered via OpenClaw CLI.`,
    };
  } catch (cliError: unknown) {
    // 检查是否是 "already exists" 错误，这种情况也视为成功
    const stderr =
      cliError && typeof cliError === "object" && "stderr" in cliError
        ? String((cliError as { stderr: unknown }).stderr)
        : "";
    if (stderr.includes("already exists")) {
      return {
        success: true,
        message: `Agent "${agentId}" already registered in OpenClaw.`,
      };
    }

    // 判断具体失败原因，给出明确的错误提示
    const isCommandNotFound =
      (cliError && typeof cliError === "object" && "code" in cliError &&
        (cliError as { code: unknown }).code === "ENOENT") ||
      stderr.includes("not found") ||
      stderr.includes("not recognized");

    if (isCommandNotFound) {
      return {
        success: false,
        message: "OpenClaw CLI not found. Please install OpenClaw first: https://github.com/anthropics/openclaw",
      };
    }

    const errMsg =
      cliError instanceof Error ? cliError.message : String(cliError);
    return {
      success: false,
      message: `openclaw agents add failed: ${stderr || errMsg}`,
    };
  }
}

/**
 * 重启 OpenClaw Gateway
 * 执行 `openclaw gateway restart`，如果失败则提示用户手动重启
 * @returns 重启结果
 */
export function restartOpenClawGateway(): { success: boolean; message: string } {
  try {
    execSync("openclaw gateway restart", {
      stdio: "pipe",
      timeout: 30000, // 30 秒超时
    });
    return {
      success: true,
      message: "OpenClaw Gateway restarted successfully.",
    };
  } catch (error: unknown) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : "";
    const errMsg = stderr || (error instanceof Error ? error.message : String(error));
    return {
      success: false,
      message: errMsg,
    };
  }
}

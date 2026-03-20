import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { select, checkbox, confirm as inquirerConfirm } from "@inquirer/prompts";
import yaml from "js-yaml";
import { extract as tarExtract } from "tar";
import type {
  AgentIndex,
  SoulHubConfig,
  InstalledAgent,
  SoulHubPackage,
  OpenClawConfig,
  BackupRecord,
  BackupItem,
  BackupManifest,
} from "./types.js";
import { logger } from "./logger.js";

// Registry base URL（COS 直连）
const DEFAULT_REGISTRY_URL =
  "https://soulhub-1251783334.cos.accelerate.myqcloud.com/registry";

export function getRegistryUrl(): string {
  return process.env.SOULHUB_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

/**
 * Fetch the agent index from the registry
 */
export async function fetchIndex(): Promise<AgentIndex> {
  const url = `${getRegistryUrl()}/index.json`;
  logger.debug(`Fetching registry index`, { url });
  const response = await fetch(url);
  if (!response.ok) {
    logger.error(`Failed to fetch registry index`, { url, status: response.status, statusText: response.statusText });
    throw new Error(`Failed to fetch registry index: ${response.statusText}`);
  }
  return (await response.json()) as AgentIndex;
}

/**
 * 下载 agent 包（.tar.gz）并解压到临时目录
 * @returns 解压后的临时目录路径
 */
export async function downloadAgentPackage(
  agentName: string,
  version: string = "latest"
): Promise<string> {
  const url = `${getRegistryUrl()}/agents/${agentName}/${version}.tar.gz`;
  logger.debug(`Downloading agent package`, { agentName, version, url });

  const tmpDir = path.join(os.tmpdir(), ".soulhub", `pkg-${Date.now()}-${agentName}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    // 清理临时目录
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logger.error(`Failed to download agent package`, { agentName, version, url, status: response.status });
    throw new Error(
      `Failed to download ${agentName}@${version}: ${response.statusText}`
    );
  }

  // 将响应流通过 gunzip → tar extract 管道解压到临时目录
  const body = response.body;
  if (!body) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`Empty response body for ${agentName}@${version}`);
  }

  try {
    // 先将内容写入临时文件，再用 tar 解压（兼容性更好）
    const tmpTarPath = path.join(tmpDir, "_package.tar.gz");
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpTarPath, buffer);

    await tarExtract({
      file: tmpTarPath,
      cwd: tmpDir,
    });

    // 清理临时 tar 文件
    fs.unlinkSync(tmpTarPath);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `Failed to extract ${agentName}@${version}: ${err instanceof Error ? err.message : err}`
    );
  }

  logger.debug(`Agent package extracted`, { agentName, version, tmpDir });
  return tmpDir;
}

/**
 * 下载 Team 描述文件（.yaml）
 * @returns YAML 文件内容字符串
 */
export async function fetchRecipeYaml(
  recipeName: string,
  version: string = "latest"
): Promise<string> {
  const url = `${getRegistryUrl()}/recipes/${recipeName}/${version}.yaml`;
  logger.debug(`Fetching recipe yaml`, { recipeName, version, url });
  const response = await fetch(url);
  if (!response.ok) {
    logger.error(`Failed to fetch recipe yaml`, { recipeName, version, url, status: response.status });
    throw new Error(
      `Failed to fetch recipe ${recipeName}@${version}: ${response.statusText}`
    );
  }
  return await response.text();
}

/**
 * 从解压后的 agent 包目录复制文件到目标 workspace
 * 支持的文件列表：IDENTITY.md, SOUL.md, USER.md, TOOLS.md, AGENTS.md, HEARTBEAT.md, manifest.yaml
 */
export function copyAgentFilesFromPackage(packageDir: string, targetDir: string): void {
  const filesToCopy = [
    "IDENTITY.md", "SOUL.md", "USER.md", "TOOLS.md",
    "AGENTS.md", "HEARTBEAT.md", "manifest.yaml",
    "USER.md.template", "TOOLS.md.template",
  ];
  fs.mkdirSync(targetDir, { recursive: true });

  for (const fileName of filesToCopy) {
    const sourcePath = path.join(packageDir, fileName);
    if (fs.existsSync(sourcePath)) {
      // .template 文件去掉后缀
      const destName = fileName.endsWith(".template")
        ? fileName.replace(".template", "")
        : fileName;
      fs.copyFileSync(sourcePath, path.join(targetDir, destName));
    }
  }

  // 复制 skills 目录（如果存在）
  const skillsSource = path.join(packageDir, "skills");
  if (fs.existsSync(skillsSource) && fs.statSync(skillsSource).isDirectory()) {
    const skillsTarget = path.join(targetDir, "skills");
    fs.cpSync(skillsSource, skillsTarget, { recursive: true });
    logger.debug(`Skills directory copied`, { from: skillsSource, to: skillsTarget });
  }
}

/**
 * Detect OpenClaw/LightClaw installation directory（同步版本，返回第一个找到的）
 * 优先级：customDir 参数 > OPENCLAW_HOME/LIGHTCLAW_HOME 环境变量 > 默认路径 ~/.openclaw 或 ~/.lightclaw > 当前目录
 */
export function findOpenClawDir(customDir?: string): string | null {
  // 1. 如果指定了 --claw-type，映射到对应的品牌目录
  if (customDir) {
    const home = os.homedir();
    const lower = customDir.toLowerCase();
    if (lower === "openclaw") {
      return path.join(home, ".openclaw");
    }
    if (lower === "lightclaw") {
      return path.join(home, ".lightclaw");
    }
    // 只支持 OpenClaw 和 LightClaw，其他值直接报错
    throw new Error(`Unsupported claw type: "${customDir}". Only "OpenClaw" or "LightClaw" is supported (case-insensitive).`);
  }

  // 2. 检查 OPENCLAW_HOME / LIGHTCLAW_HOME 环境变量
  const envHome = process.env.OPENCLAW_HOME || process.env.LIGHTCLAW_HOME;
  if (envHome) {
    const resolved = path.resolve(envHome);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    // 环境变量指定的路径不存在，仍然返回（信任用户配置）
    return resolved;
  }

  // 3. 默认路径候选列表：只检测 ~/ 目录下（不扫描 cwd，避免嵌套误判）
  const home = process.env.HOME || "~";
  const candidates = [
    path.join(home, ".openclaw"),
    path.join(home, ".lightclaw"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 查找所有已安装的 claw 目录（用于多选场景）
 * 当 customDir 或环境变量已指定时，只返回那一个；
 * 否则返回所有存在的默认候选目录。
 */
export function findAllClawDirs(customDir?: string): string[] {
  // 1. 指定了 --claw-type → 唯一
  if (customDir) {
    const home = os.homedir();
    const lower = customDir.toLowerCase();
    if (lower === "openclaw") {
      return [path.join(home, ".openclaw")];
    }
    if (lower === "lightclaw") {
      return [path.join(home, ".lightclaw")];
    }
    // 只支持 OpenClaw 和 LightClaw，其他值直接报错
    throw new Error(`Unsupported claw type: "${customDir}". Only "OpenClaw" or "LightClaw" is supported (case-insensitive).`);
  }

  // 2. 环境变量 → 唯一
  const envHome = process.env.OPENCLAW_HOME || process.env.LIGHTCLAW_HOME;
  if (envHome) {
    const resolved = path.resolve(envHome);
    return [resolved];
  }

  // 3. 默认候选列表：只检测 ~/ 目录下（不扫描 cwd，避免嵌套误判）
  const home = process.env.HOME || "~";
  const candidates = [
    path.join(home, ".openclaw"),
    path.join(home, ".lightclaw"),
  ];
  return candidates.filter((c) => fs.existsSync(c));
}

/**
 * 交互式提示用户选择 claw 目录（当检测到多个时）
 * 如果只有一个，直接返回；如果没有，返回 null。
 */
export async function promptSelectClawDir(customDir?: string): Promise<string | null> {
  const dirs = findAllClawDirs(customDir);

  if (dirs.length === 0) {
    return null;
  }

  if (dirs.length === 1) {
    return dirs[0];
  }

  // 多个候选目录，使用上下键选择
  try {
    const selected = await select({
      message: "Select target Claw installation:",
      choices: dirs.map((dir) => {
        const brand = detectClawBrand(dir);
        return { name: `${brand}  ${dir}`, value: dir };
      }),
    });
    return selected;
  } catch {
    // 用户按 Ctrl+C 取消
    return null;
  }
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
  logger.debug(`Recorded install`, { name, version, workspace });
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
// OpenClaw/LightClaw 配置文件 (openclaw.json / lightclaw.json) 操作
// ==========================================

/**
 * 根据 claw 目录路径自动检测品牌（openclaw 或 lightclaw）
 */
export function detectClawBrand(clawDir: string): "OpenClaw" | "LightClaw" {
  // 根据目录名判断品牌
  const dirName = path.basename(clawDir).toLowerCase();
  if (dirName.includes("lightclaw")) {
    return "LightClaw";
  }
  // 也检查是否存在 lightclaw.json 配置文件
  if (fs.existsSync(path.join(clawDir, "lightclaw.json"))) {
    return "LightClaw";
  }
  return "OpenClaw";
}

/**
 * 获取 claw 配置文件名（openclaw.json 或 lightclaw.json）
 */
export function getClawConfigFileName(clawDir: string): string {
  const brand = detectClawBrand(clawDir);
  return brand === "LightClaw" ? "lightclaw.json" : "openclaw.json";
}

/**
 * 获取 openclaw.json / lightclaw.json 文件路径
 */
export function getOpenClawConfigPath(clawDir: string): string {
  return path.join(clawDir, getClawConfigFileName(clawDir));
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
  let config = readOpenClawConfig(clawDir);
  if (!config) {
    // 配置文件不存在时，创建默认空配置
    logger.info(`Config file not found in ${clawDir}, creating default config.`);
    config = { agents: { list: [] } } as OpenClawConfig;
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
      // 更新所有字段（用户预期是更新 agent 内容）
      existing.name = agentName;
      if (!isMain) {
        existing.workspace = path.join(clawDir, `workspace-${agentId}`);
        existing.agentDir = path.join(clawDir, `agents/${agentId}/agent`);
      }
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
 * 检查 OpenClaw/LightClaw 是否已安装
 * 优先级：customDir 参数（--claw-type）> OPENCLAW_HOME/LIGHTCLAW_HOME 环境变量 > 默认路径检测 > PATH 命令检测
 */
export function checkOpenClawInstalled(customDir?: string): {
  installed: boolean;
  clawDir: string | null;
  message: string;
} {
  const clawDir = findOpenClawDir(customDir);

  if (clawDir) {
    const brand = detectClawBrand(clawDir);
    return {
      installed: true,
      clawDir,
      message: `${brand} detected at: ${clawDir}`,
    };
  }

  // 尝试检测 openclaw / lightclaw 命令是否可用
  try {
    execSync("which openclaw 2>/dev/null || which lightclaw 2>/dev/null || where openclaw 2>nul || where lightclaw 2>nul", {
      stdio: "pipe",
    });
    return {
      installed: true,
      clawDir: null,
      message: "OpenClaw/LightClaw command found in PATH, but workspace directory not detected.",
    };
  } catch {
    // openclaw/lightclaw 命令不在 PATH 中
  }

  return {
    installed: false,
    clawDir: null,
    message: "OpenClaw/LightClaw is not installed. Please install first, use --claw-type to specify type, or set OPENCLAW_HOME/LIGHTCLAW_HOME environment variable.",
  };
}

/**
 * 获取统一的备份基础目录
 * 按 claw 品牌分文件夹存放：~/.soulhub/backups/openclaw/ 或 ~/.soulhub/backups/lightclaw/
 */
export function getBackupBaseDir(clawDir: string): string {
  const home = process.env.HOME || "~";
  const brand = detectClawBrand(clawDir).toLowerCase(); // "openclaw" | "lightclaw"
  return path.join(home, ".soulhub", "backups", brand);
}

/**
 * 备份 agent 工作目录
 * 将 workspace 目录复制（cp）到 ~/.soulhub/backups/<brand>/ 下，原目录保持不变
 * 例如：~/.openclaw/workspace → 复制到 ~/.soulhub/backups/openclaw/workspace
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

  // 在统一备份目录下创建对应品牌的子目录
  const clawDir = path.dirname(workspaceDir);
  const backupBaseDir = getBackupBaseDir(clawDir);
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
  logger.info(`Workspace backed up`, { from: workspaceDir, to: backupDir });

  return backupDir;
}

/**
 * 备份 agent 工作目录（mv 移动方式）
 * 将 workspace 目录直接移动到 ~/.soulhub/backups/<brand>/ 下，原目录被移走
 * 适用于子 agent 备份场景，避免磁盘空间翻倍
 */
export function moveBackupAgentWorkspace(workspaceDir: string): string | null {
  if (!fs.existsSync(workspaceDir)) {
    return null; // 目录不存在，无需备份
  }

  // 检查目录中是否有内容
  const entries = fs.readdirSync(workspaceDir);
  if (entries.length === 0) {
    return null; // 空目录，无需备份
  }

  // 在统一备份目录下创建对应品牌的子目录
  const clawDir = path.dirname(workspaceDir);
  const backupBaseDir = getBackupBaseDir(clawDir);
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

  // 跨设备 mv 兼容：先尝试 rename，失败则 cp + rm
  try {
    fs.renameSync(workspaceDir, backupDir);
  } catch {
    // rename 跨文件系统失败时，使用 cp + rm
    fs.cpSync(workspaceDir, backupDir, { recursive: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  logger.info(`Workspace moved to backup`, { from: workspaceDir, to: backupDir });

  return backupDir;
}

/**
 * 批量备份存量子 agent 工作目录（mv 移动方式）
 * 在安装多 agent 团队前调用，把所有 workspace-* 目录移动到 ~/.soulhub/backups/<brand>/
 * @returns 备份结果列表
 */
export function backupAllWorkerWorkspaces(clawDir: string): { name: string; backupDir: string }[] {
  const results: { name: string; backupDir: string }[] = [];
  const workerDirs = listAgentWorkspaces(clawDir);

  for (const dirName of workerDirs) {
    const fullPath = path.join(clawDir, dirName);
    const backupDir = moveBackupAgentWorkspace(fullPath);
    if (backupDir) {
      results.push({ name: dirName, backupDir });
    }
  }

  return results;
}

/**
 * 列出指定 OpenClaw/LightClaw 目录下所有已安装的 agent workspace
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

// ==========================================
// 备份记录管理（用于回滚）
// ==========================================

/** 备份记录文件路径 */
function getBackupManifestPath(): string {
  const home = process.env.HOME || "~";
  return path.join(home, ".soulhub", "backups.json");
}

/**
 * 读取所有备份记录
 */
export function loadBackupManifest(): BackupManifest {
  const manifestPath = getBackupManifestPath();
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as BackupManifest;
    } catch {
      return { records: [] };
    }
  }
  return { records: [] };
}

/**
 * 保存备份记录
 */
export function saveBackupManifest(manifest: BackupManifest): void {
  const manifestPath = getBackupManifestPath();
  const manifestDir = path.dirname(manifestPath);
  if (!fs.existsSync(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }
  // 只保留最近 50 条记录，防止文件无限增长
  manifest.records = manifest.records.slice(0, 50);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * 生成备份记录 ID
 */
function generateBackupId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.\-T]/g, "").slice(0, 14); // YYYYMMDDHHmmss
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

/**
 * 创建一个新的备份记录（初始状态，安装过程中逐步填充 items）
 */
export function createBackupRecord(
  installType: BackupRecord["installType"],
  packageName: string,
  clawDir: string
): BackupRecord {
  // 快照 openclaw.json / lightclaw.json
  let openclawJsonSnapshot: string | null = null;
  const configPath = getOpenClawConfigPath(clawDir);
  if (fs.existsSync(configPath)) {
    try {
      openclawJsonSnapshot = fs.readFileSync(configPath, "utf-8");
    } catch {
      // 读取失败，忽略
    }
  }

  return {
    id: generateBackupId(),
    installType,
    packageName,
    createdAt: new Date().toISOString(),
    clawDir,
    openclawJsonSnapshot,
    items: [],
    installedWorkerIds: [],
    installedMainAgent: null,
  };
}

/**
 * 向备份记录中添加一个备份项
 */
export function addBackupItem(
  record: BackupRecord,
  item: BackupItem
): void {
  record.items.push(item);
}

/**
 * 保存备份记录到 manifest 文件（安装完成后调用）
 */
export function commitBackupRecord(record: BackupRecord): void {
  // 如果没有任何备份项且没有安装新 worker，跳过记录
  if (record.items.length === 0 && record.installedWorkerIds.length === 0 && !record.installedMainAgent) {
    logger.debug("No backup items to record, skipping.");
    return;
  }

  const manifest = loadBackupManifest();
  // 插入到列表头部（最新的在前）
  manifest.records.unshift(record);
  saveBackupManifest(manifest);
  logger.info(`Backup record saved`, { id: record.id, items: record.items.length, workers: record.installedWorkerIds.length });
}

// ==========================================
// 交互式提示辅助函数
// ==========================================

/**
 * 交互式提示用户选择安装角色（main / worker）
 * @returns "main" 或 "worker"，用户取消时返回 null
 */
export async function promptSelectRole(): Promise<"main" | "worker" | null> {
  try {
    const selected = await select({
      message: "Install as:",
      choices: [
        { name: "👷  Worker agent  (子Agent，安装到 workspace-<name>/ 目录)", value: "worker" as const },
        { name: "👑  Main agent    (主Agent，安装到 workspace/ 目录)", value: "main" as const },
      ],
      default: "worker",
    });
    return selected;
  } catch {
    // 用户按 Ctrl+C 取消
    return null;
  }
}

/**
 * 交互式提示用户多选 claw 目录
 * 如果只有一个 claw 目录，自动选中并返回。
 * @returns 选中的 claw 目录列表，用户取消时返回空数组
 */
export async function promptMultiSelectClawDirs(): Promise<string[]> {
  const dirs = findAllClawDirs();

  if (dirs.length === 0) {
    return [];
  }

  if (dirs.length === 1) {
    const brand = detectClawBrand(dirs[0]);
    console.log();
    console.log(`  ✔ Detected ${brand}: ${dirs[0]}`);
    return dirs;
  }

  // 多个候选目录，使用上下键多选（空格选中，回车确认）
  try {
    const selected = await checkbox({
      message: "Select target Claw installations (space to toggle, enter to confirm):",
      choices: dirs.map((dir) => {
        const brand = detectClawBrand(dir);
        return { name: `${brand}  ${dir}`, value: dir, checked: true };
      }),
    });

    if (selected.length === 0) {
      console.log("  No claw selected, operation cancelled.");
    }
    return selected;
  } catch {
    // 用户按 Ctrl+C 取消
    return [];
  }
}

/**
 * 交互式确认提示
 * @param message 提示信息
 * @param defaultYes 默认值是否为 yes
 * @returns true = 确认，false = 取消
 */
export async function promptConfirm(message: string, defaultYes: boolean = true): Promise<boolean> {
  try {
    return await inquirerConfirm({
      message,
      default: defaultYes,
    });
  } catch {
    // 用户按 Ctrl+C 取消
    return false;
  }
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
 * 将安装的 agent 注册到 OpenClaw/LightClaw 配置中
 * 调用 `openclaw/lightclaw agents add` 命令（非交互模式），由 OpenClaw/LightClaw 负责生成完整的目录结构和依赖文件。
 * 必须依赖 openclaw/lightclaw CLI，不提供降级方案。
 */
export function registerAgentToOpenClaw(
  agentName: string,
  workspaceDir: string,
  clawDir?: string
): { success: boolean; message: string } {
  // 规范化 agent ID（与 OpenClaw/LightClaw 的 normalizeAgentId 逻辑一致：转小写，空格/下划线转连字符）
  const agentId = agentName.toLowerCase().replace(/[\s_]+/g, "-");
  const brandName = clawDir ? detectClawBrand(clawDir) : "OpenClaw/LightClaw";
  logger.debug(`Registering agent to ${brandName}`, { agentId, workspaceDir });

  try {
    const clawCmd = detectClawCommand(clawDir);
    execSync(
      `${clawCmd} agents add "${agentId}" --workspace "${workspaceDir}" --non-interactive --json`,
      { stdio: "pipe", timeout: 15000 }
    );
    return {
      success: true,
      message: `Agent "${agentId}" registered via CLI.`,
    };
  } catch (cliError: unknown) {
    // 检查是否是 "already exists" 错误，这种情况也视为成功
    const stderr =
      cliError && typeof cliError === "object" && "stderr" in cliError
        ? String((cliError as { stderr: unknown }).stderr)
        : "";
    if (stderr.includes("already exists")) {
      // agent 已注册，但仍需更新配置（用户预期是更新 agent 内容）
      logger.info(`Agent "${agentId}" already exists in CLI, updating config...`);
      try {
        const resolvedClawDir = clawDir || path.dirname(workspaceDir);
        addAgentToOpenClawConfig(resolvedClawDir, agentId, agentName, false);
      } catch {
        // 更新配置失败不影响整体流程
        logger.warn(`Failed to update config for existing agent "${agentId}", skipping.`);
      }
      return {
        success: true,
        message: `Agent "${agentId}" already registered, config updated.`,
      };
    }

    // CLI 命令失败，fallback 到直接修改配置文件
    const errMsg =
      cliError instanceof Error ? cliError.message : String(cliError);
    logger.warn(`CLI agents add failed, falling back to config file modification`, { agentId, stderr, error: errMsg });

    try {
      // 从 workspaceDir 推导 clawDir（workspaceDir 格式为 <clawDir>/workspace-<agentId>）
      const resolvedClawDir = clawDir || path.dirname(workspaceDir);
      const configUpdated = addAgentToOpenClawConfig(resolvedClawDir, agentId, agentName, false);
      if (configUpdated) {
        logger.info(`Agent "${agentId}" registered via config file fallback.`);
        return {
          success: true,
          message: `Agent "${agentId}" registered via config file (CLI fallback).`,
        };
      } else {
        logger.error(`Failed to update config file for agent "${agentId}"`);
        return {
          success: false,
          message: `Failed to register "${agentId}": CLI command failed and config file update also failed.`,
        };
      }
    } catch (configError: unknown) {
      const configErrMsg = configError instanceof Error ? configError.message : String(configError);
      logger.error(`Config file fallback also failed`, { agentId, error: configErrMsg });
      return {
        success: false,
        message: `Failed to register "${agentId}": CLI failed (${stderr || errMsg}), config fallback also failed (${configErrMsg}).`,
      };
    }
  }
}

/**
 * 检测可用的 claw CLI 命令（lightclaw 或 openclaw）
 */
export function detectClawCommand(clawDir?: string): string {
  // 如果传了 clawDir，根据品牌决定命令
  if (clawDir) {
    const brand = detectClawBrand(clawDir);
    return brand === "LightClaw" ? "lightclaw" : "openclaw";
  }
  // 未传 clawDir 时，检测 PATH 中可用的命令（优先 lightclaw）
  try {
    execSync("which lightclaw 2>/dev/null || where lightclaw 2>nul", { stdio: "pipe" });
    return "lightclaw";
  } catch {
    // lightclaw 不可用
  }
  try {
    execSync("which openclaw 2>/dev/null || where openclaw 2>nul", { stdio: "pipe" });
    return "openclaw";
  } catch {
    // openclaw 也不可用
  }
  return "openclaw";
}

/**
 * 重启 OpenClaw/LightClaw Gateway
 * 执行 `openclaw/lightclaw gateway restart`，如果失败则提示用户手动重启
 * @returns 重启结果
 */
export function restartOpenClawGateway(clawDir?: string): { success: boolean; message: string } {
  const clawCmd = detectClawCommand(clawDir);
  logger.debug(`Restarting ${clawCmd} Gateway`);
  try {
    execSync(`${clawCmd} gateway restart`, {
      stdio: "pipe",
      timeout: 30000, // 30 秒超时
    });
    return {
      success: true,
      message: `${clawCmd} Gateway restarted successfully.`,
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

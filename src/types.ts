export interface AgentManifest {
  name: string;
  displayName: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  author: string;
  minClawVersion: string;
  files: Record<string, number>;
  downloads: number;
  stars: number;
}

export interface RecipeManifest {
  name: string;
  displayName: string;
  description: string;
  agents: string[];
  version: string;
  author: string;
}

export interface AgentIndex {
  agents: AgentManifest[];
  recipes: RecipeManifest[];
}

export interface InstalledAgent {
  name: string;
  version: string;
  installedAt: string;
  workspace: string;
}

export interface SoulHubConfig {
  installed: InstalledAgent[];
  registryUrl: string;
}

// ==========================================
// soulhub.yaml 统一包描述格式（类似 Helm 的 Chart.yaml）
// ==========================================

/**
 * SoulHub 包类型
 * - agent: 单 Agent 包
 * - team: 多 Agent 团队包
 */
export type SoulHubPackageKind = "agent" | "team";

/**
 * SoulHub 包描述文件（soulhub.yaml）
 * 统一的包描述格式，类似 Helm 的 Chart.yaml
 */
export interface SoulHubPackage {
  apiVersion: string;         // 包格式版本，如 "v1"
  kind: SoulHubPackageKind;   // "agent" | "team"
  name: string;               // 包名（如 "writer-wechat" 或 "dev-squad"）
  version: string;            // 版本号
  description?: string;       // 描述

  // Team 专属字段
  dispatcher?: {
    name: string;             // dispatcher 名称（如 "总调度中心"）
    dir: string;              // 对应的目录名（解决中文目录名问题）
  };

  agents?: SoulHubPackageAgent[];  // worker agent 列表

  routing?: Array<{           // 路由规则
    keywords: string[];
    target: string;
  }>;

  metadata?: {                // 可选元数据
    author?: string;
    exportedAt?: string;
    creature?: string;
    theme?: string;
  };
}

export interface SoulHubPackageAgent {
  name: string;               // agent 名称 / ID
  dir?: string;               // 对应的目录名（默认等于 name）
  role?: "worker" | "dispatcher";
  displayName?: string;       // 显示名称
}

// ==========================================
// OpenClaw 配置文件 (openclaw.json) 类型
// ==========================================

export interface OpenClawAgentConfig {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  subagents?: {
    allowAgents?: string[];
    maxConcurrent?: number;
  };
}

// ==========================================
// 备份记录类型（用于回滚）
// ==========================================

/**
 * 单个备份项：记录一个被备份的目录
 */
export interface BackupItem {
  /** 原始路径（安装前的位置） */
  originalPath: string;
  /** 备份存放路径 */
  backupPath: string;
  /** 备份方式：cp（复制，原目录保留）或 mv（移动，原目录被移走） */
  method: "cp" | "mv";
  /** 目录角色：main=主agent workspace, worker=子agent workspace */
  role: "main" | "worker";
  /** agent 名称或 ID */
  agentId: string;
}

/**
 * 一次安装操作的完整备份记录
 */
export interface BackupRecord {
  /** 唯一 ID（时间戳 + 随机数） */
  id: string;
  /** 安装类型 */
  installType: "single-agent" | "team-registry" | "team-local" | "single-agent-local";
  /** 安装的包名 */
  packageName: string;
  /** 安装时间（ISO 8601） */
  createdAt: string;
  /** OpenClaw 目录路径 */
  clawDir: string;
  /** 安装前的 openclaw.json 快照（用于回滚配置） */
  openclawJsonSnapshot: string | null;
  /** 备份的目录列表 */
  items: BackupItem[];
  /** 新安装的 worker agent ID 列表（回滚时需要删除这些目录） */
  installedWorkerIds: string[];
  /** 新安装的主 agent 名称 */
  installedMainAgent: string | null;
}

/**
 * 备份记录文件结构
 */
export interface BackupManifest {
  /** 记录列表（按时间倒序，最新的在前） */
  records: BackupRecord[];
}

export interface OpenClawConfig {
  [key: string]: unknown;
  agents?: {
    defaults?: {
      workspace?: string;
      [key: string]: unknown;
    };
    list?: OpenClawAgentConfig[];
  };
  tools?: {
    sessions?: {
      visibility?: string;
      [key: string]: unknown;
    };
    agentToAgent?: {
      enabled?: boolean;
      allow?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}



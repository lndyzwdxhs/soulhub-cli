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



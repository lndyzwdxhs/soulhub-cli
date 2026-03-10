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

export interface ComposeConfig {
  version: string;
  agents: Array<{
    name: string;
    role: "dispatcher" | "worker";
    identity?: string;
    soul?: string;
  }>;
  routingRules?: Array<{
    keywords: string[];
    target: string;
  }>;
}

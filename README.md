# SoulHub CLI

SoulHub CLI — 用于安装和管理 OpenClaw AI Agent 人格模板的命令行工具。支持从 SoulHub Registry 或本地目录安装单 Agent 和多 Agent 团队。

## 安装

```bash
npm install -g soulhub
```

或使用 npx 直接运行：

```bash
npx soulhub <command>
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `soulhub search <keyword>` | 按关键词搜索 Agent 模板 |
| `soulhub info <name>` | 查看 Agent 详细信息 |
| `soulhub install <name>` | 从 Registry 安装 Agent 或团队 |
| `soulhub install --from <source>` | 从本地目录、ZIP 文件或 URL 安装 |
| `soulhub list` | 列出已安装的 Agent |
| `soulhub update [name]` | 更新已安装的 Agent |
| `soulhub uninstall <name>` | 卸载已安装的 Agent |
| `soulhub publish` | 验证并发布你的 Agent |

## 使用方法

### 搜索 Agent

```bash
soulhub search python
soulhub search "content writing"
```

### 安装 Agent

CLI 会自动识别目标是单 Agent 还是多 Agent 团队，无需手动区分。

**从 Registry 安装：**

```bash
# 安装单 Agent（作为主 Agent，部署到 workspace 目录）
soulhub install ops-assistant

# 安装多 Agent 团队（调度 Agent + 工作 Agent）
soulhub install dev-squad
```

**从本地安装：**

```bash
# 从本地目录安装（自动识别单/多 Agent）
soulhub install --from ./my-agent/

# 从 ZIP 文件安装
soulhub install --from ./agent-team.zip

# 从 URL 安装
soulhub install --from https://example.com/agent-team.zip
```

**指定目标目录：**

```bash
# 安装到自定义目录（不依赖 OpenClaw 环境）
soulhub install ops-assistant --dir ./my-agents

# 指定 OpenClaw 安装目录
soulhub install ops-assistant --claw-dir /opt/openclaw
```

### 列出已安装的 Agent

```bash
soulhub list
```

### 更新 Agent

```bash
soulhub update              # 更新全部
soulhub update ops-assistant # 更新指定 Agent
```

### 卸载 Agent

```bash
soulhub uninstall ops-assistant
```

## 安装行为说明

### 单 Agent 安装

- 单 Agent 会作为**主 Agent** 安装到 OpenClaw 的 `workspace/` 目录
- 如果已存在主 Agent，CLI 会**自动备份**（复制到 `agentbackup/workspace`），原目录保持不变
- 仅覆盖 `IDENTITY.md` 和 `SOUL.md` 等灵魂文件，不影响 workspace 中的其他运行时文件
- 安装完成后自动重启 OpenClaw Gateway；若重启失败会提示手动重启

### 多 Agent 团队安装

- **调度 Agent（Dispatcher）** 作为主 Agent 安装到 `workspace/` 目录
- **工作 Agent（Worker）** 安装到各自的 `workspace-<agentId>/` 目录
- 自动配置多 Agent 之间的通信
- Worker Agent 通过 `openclaw agents add` 命令注册
- 安装完成后自动重启 OpenClaw Gateway

## 配置

CLI 将配置存储在 `~/.soulhub/config.json`。

### 自定义 Registry

通过环境变量设置自定义 Registry 地址：

```bash
export SOULHUB_REGISTRY_URL=https://your-registry.example.com
```

### OpenClaw 目录

CLI 按以下优先级查找 OpenClaw 安装目录：

1. `--claw-dir` 命令行参数
2. `OPENCLAW_HOME` 环境变量
3. 默认路径 `~/.openclaw`

## 环境要求

- Node.js >= 18.0.0
- OpenClaw（可选，使用 `--dir` 参数时不需要）

## License

MIT

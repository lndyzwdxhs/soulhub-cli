import { Command } from "commander";
import chalk from "chalk";
import { createSpinner } from "../spinner.js";
import type { Spinner } from "../spinner.js";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { logger } from "../logger.js";

import {
  fetchIndex,
  downloadAgentPackage,
  fetchRecipeYaml,
  copyAgentFilesFromPackage,
  findOpenClawDir,
  getWorkspaceDir,
  getMainWorkspaceDir,
  checkMainAgentExists,
  recordInstall,
  backupAgentWorkspace,
  backupAllWorkerWorkspaces,
  registerAgentToOpenClaw,
  readSoulHubPackage,
  detectPackageKind,
  configureMultiAgentCommunication,
  addAgentToOpenClawConfig,
  createBackupRecord,
  addBackupItem,
  commitBackupRecord,
  detectClawBrand,
  detectClawCommand,
  promptSelectClawDir,
  findAllClawDirs,
  promptSelectRole,
  promptMultiSelectClawDirs,
  promptConfirm,
} from "../utils.js";
import type { SoulHubPackage, BackupRecord } from "../types.js";

/**
 * 解析 claw 目录：如果用户指定了 --claw-type，直接使用（非交互式）；
 * 否则检测所有候选目录，多个时交互选择，单个时直接使用。
 * @returns 解析后的 clawDir，如果用户取消选择则返回 null
 */
async function resolveClawDir(clawDir?: string): Promise<string | null> {
  // 如果用户通过 --claw-type 指定了，直接使用（不触发选择）
  if (clawDir) {
    return findOpenClawDir(clawDir);
  }
  // 自动检测，可能需要交互选择
  return promptSelectClawDir();
}

/**
 * 解析 claw 目录（非交互式）：
 * 如果用户指定了 --claw-type，返回该单个目录；
 * 否则返回检测到的第一个 claw 目录。
 * @returns claw 目录（包装为数组），未找到时返回空数组
 */
function resolveAllClawDirs(clawDir?: string): string[] {
  if (clawDir) {
    const resolved = findOpenClawDir(clawDir);
    return resolved ? [resolved] : [];
  }
  const all = findAllClawDirs();
  // 一次只安装到一个 claw，取第一个
  return all.length > 0 ? [all[0]] : [];
}



export const installCommand = new Command("install")
  .description("Install an agent or team from the SoulHub registry")
  .argument("[name]", "Agent or team name to install")
  .option("--from <source>", "Install from a local directory, ZIP file, or URL")
  .option("-r, --role <role>", "Install role: main or worker (skip role selection prompt)")
  .option(
    "--dir <path>",
    "Target directory (defaults to OpenClaw/LightClaw workspace)"
  )
  .option(
    "--claw-type <type>",
    "Specify claw type: OpenClaw or LightClaw (case-insensitive)"
  )
  .option("-y, --yes", "Skip all confirmation prompts (auto-confirm)")
  .action(async (name: string | undefined, options) => {
    try {
      // 判断是否通过命令行参数显式指定了角色
      const roleExplicit = !!options.role;
      // 判断是否通过命令行参数显式指定了 claw 类型
      const clawExplicit = !!options.clawType || !!options.dir;

      const skipConfirm = !!options.yes;

      // 校验 --role 参数值
      if (options.role && !['main', 'worker'].includes(options.role.toLowerCase())) {
        console.error(chalk.red(`Invalid role: "${options.role}". Must be "main" or "worker".`));
        process.exit(1);
      }

      if (options.from) {
        // 从本地目录/ZIP/URL 安装，自动识别单/多 agent
        const asMain = await resolveRole(roleExplicit ? (options.role.toLowerCase() === 'main') : undefined);
        if (asMain === null) return; // 用户取消
        await installFromSource(options.from, options.dir, options.clawType, asMain, clawExplicit, skipConfirm);
      } else if (name) {
        // 从 registry 安装，自动识别是 agent 还是 recipe
        // 对于 recipe（team），跳过角色选择（team 有自己的 dispatcher + worker 结构）
        const resolvedRole = roleExplicit ? (options.role.toLowerCase() === 'main') : undefined;
        await installFromRegistry(name, options.dir, options.clawType, resolvedRole, clawExplicit, skipConfirm);
      } else {
        console.error(chalk.red("Please specify an agent or team name, or use --from to install from a local source."));
        console.log();
        console.log(chalk.dim("  Usage:"));
        console.log(chalk.dim("    soulhub install <name>                                 # Interactive: select role & claw"));
        console.log(chalk.dim("    soulhub install <name> --role main                     # As main agent, interactive claw selection"));
        console.log(chalk.dim("    soulhub install <name> --role worker                   # As worker agent, interactive claw selection"));
        console.log(chalk.dim("    soulhub install <name> --claw-type LightClaw            # Interactive role, install to specific claw"));
        console.log(chalk.dim("    soulhub install <name> --role worker --claw-type OpenClaw  # Fully non-interactive"));
        console.log(chalk.dim("    soulhub install <name> --role main --claw-type OpenClaw -y  # Non-interactive, skip confirmation"));
        console.log(chalk.dim("    soulhub install --from ./agent-dir/                     # Install from local directory"));
        process.exit(1);
      }
    } catch (error) {
      logger.errorObj("Install command failed", error);
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      console.error(chalk.dim(`  See logs: ${logger.getTodayLogFile()}`));
      process.exit(1);
    }
  });

/**
 * 解析安装角色：如果命令行已指定则直接返回，否则交互式选择。
 * @param explicitMain true=--role main, false=--role worker, undefined=未指定（进入交互式）
 * @returns true=main, false=worker, null=用户取消
 */
async function resolveRole(explicitMain?: boolean): Promise<boolean | null> {
  if (explicitMain !== undefined) {
    return explicitMain;
  }
  // 交互式选择角色
  const role = await promptSelectRole();
  if (role === null) return null;
  return role === "main";
}

/**
 * 解析安装目标 claw 目录：如果命令行已指定 claw-type 则用指定的，否则交互式单选。
 * 一次只安装到一个 claw，更清晰。
 * @param clawDir --claw-type 参数值
 * @param clawExplicit 是否通过命令行参数显式指定了 claw
 * @returns claw 目录（包装为数组，最多一个元素），空数组表示未找到或用户取消
 */
async function resolveClawDirsInteractive(clawDir?: string, clawExplicit?: boolean): Promise<string[]> {
  if (clawDir) {
    // --claw-type 指定了，直接使用
    return resolveAllClawDirs(clawDir);
  }
  if (clawExplicit) {
    // --dir 指定了，由调用者处理
    return [];
  }
  // 交互式单选
  return promptMultiSelectClawDirs();
}

// ==========================================
// 从 Registry 安装（自动识别 agent / recipe）
// ==========================================

/**
 * 从 registry 安装，自动识别是单 agent 还是 team recipe
 * @param asMain true=--role main, false=--role worker, undefined=未指定（对 agent 进入交互式选择）
 * @param clawExplicit 是否通过命令行参数显式指定了 claw 类型
 */
async function installFromRegistry(
  name: string,
  targetDir?: string,
  clawDir?: string,
  asMain?: boolean,
  clawExplicit?: boolean,
  skipConfirm: boolean = false
): Promise<void> {
  const spinner = createSpinner(`Checking registry for ${chalk.cyan(name)}...`).start();

  const index = await fetchIndex();

  // 先检查是否是 agent
  const agent = index.agents.find((a) => a.name === name);
  // 再检查是否是 recipe
  const recipe = index.recipes.find((r) => r.name === name);

  if (agent && !recipe) {
    spinner.stop();

    // 展示 agent 基本信息
    printAgentInfo(agent);

    // 解析安装角色（交互式或命令行指定）
    const resolvedMain = await resolveRole(asMain);
    if (resolvedMain === null) return;

    // 安装为 main agent 时，提示用户会覆盖 workspace
    if (resolvedMain) {
      console.log();
      console.log(chalk.yellow("  ⚠  Installing as main agent will overwrite the current workspace/ content."));
      console.log(chalk.yellow("     The existing persona (IDENTITY.md, SOUL.md, etc.) will be replaced."));
      console.log(chalk.yellow("     Memory and conversation history will NOT be affected."));
      console.log();
      if (!skipConfirm) {
        const confirmed = await promptConfirm("Continue?", true);
        if (!confirmed) {
          console.log(chalk.dim("  Installation cancelled."));
          return;
        }
      } else {
        console.log(chalk.dim("  Auto-confirmed with --yes flag."));
      }
    }

  // 解析目标 claw 目录（交互式单选或命令行指定）
    let resolvedClawDirs: string[] | undefined;
    if (!targetDir) {
      resolvedClawDirs = await resolveClawDirsInteractive(clawDir, clawExplicit);
      if (resolvedClawDirs.length === 0) {
        console.log(chalk.red("\n  OpenClaw/LightClaw workspace directory not found."));
        printOpenClawInstallHelp();
        return;
      }
    }

    logger.info(`Installing single agent from registry: ${name}, asMain=${resolvedMain}`);
    await installSingleAgent(name, targetDir, clawDir, resolvedMain, resolvedClawDirs);
  } else if (recipe) {
    spinner.stop();
    logger.info(`Installing team recipe from registry: ${name}`);
    await installRecipeFromRegistry(name, recipe, targetDir, clawDir);
  } else {
    logger.warn(`"${name}" not found in registry`);
    spinner.fail(`"${name}" not found in registry.`);
    console.log(chalk.dim("  Use 'soulhub search' to find available agents and teams."));
  }
}

/**
 * 打印 agent 基本信息摘要
 */
function printAgentInfo(agent: { name: string; displayName: string; version: string; description?: string; category?: string; tags?: string[] }): void {
  console.log();
  console.log(chalk.bold(`  📦 ${agent.displayName}`), chalk.dim(`v${agent.version}`));
  if (agent.description) {
    console.log(chalk.dim(`     ${agent.description}`));
  }
  if (agent.category) {
    console.log(chalk.dim(`     Category: ${agent.category}`));
  }
  if (agent.tags && agent.tags.length > 0) {
    console.log(chalk.dim(`     Tags: ${agent.tags.join(", ")}`));
  }
}

// ==========================================
// 单 Agent 安装
// ==========================================

/**
 * 安装单个 agent（分发函数）
 * @param asMain true = 安装为主 agent，false = 安装为子 agent
 * @param preResolvedClawDirs 预先解析好的 claw 目录列表（交互式模式下已选择）
 */
async function installSingleAgent(
  name: string,
  targetDir?: string,
  clawDir?: string,
  asMain: boolean = false,
  preResolvedClawDirs?: string[]
): Promise<void> {
  // 如果指定了 --dir，直接安装到该目录（单一安装）
  if (targetDir) {
    await installSingleAgentToClaw(name, null, targetDir, asMain);
    return;
  }

  // 获取所有 claw 目录（优先使用预解析的列表）
  const allClawDirs = preResolvedClawDirs || resolveAllClawDirs(clawDir);
  if (allClawDirs.length === 0) {
    console.log(chalk.red("OpenClaw/LightClaw workspace directory not found."));
    printOpenClawInstallHelp();
    return;
  }

  // 先下载 agent 包（只下载一次，多个 claw 复用）
  const spinner = createSpinner(`Fetching agent ${chalk.cyan(name)}...`).start();
  const index = await fetchIndex();
  const agent = index.agents.find((a) => a.name === name);
  if (!agent) {
    spinner.fail(`Agent "${name}" not found in registry.`);
    console.log(chalk.dim("  Use 'soulhub search' to find available agents."));
    return;
  }
  spinner.text = `Downloading ${chalk.cyan(agent.displayName)} package...`;
  const pkgDir = await downloadAgentPackage(name, agent.version);
  spinner.succeed(`Package ${chalk.cyan(agent.displayName)} downloaded.`);

  // 安装到选定的 claw 目录（一次只安装一个）
  const selectedClawDir = allClawDirs[0];
  try {
    await installSingleAgentToClaw(name, selectedClawDir, undefined, asMain, pkgDir, agent);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to install to ${selectedClawDir}`, { error: errMsg });
    console.error(chalk.red(`  ✗ Installation failed for ${selectedClawDir}: ${errMsg}`));
  }

  // 清理临时包目录
  fs.rmSync(pkgDir, { recursive: true, force: true });
}

/**
 * 将单个 agent 安装到一个具体的 claw 目录
 * @param selectedClawDir claw 目录（当 targetDir 存在时可为 null）
 * @param targetDir 自定义目标目录
 * @param asMain 是否安装为主 agent
 * @param preDownloadedPkgDir 预下载的包目录（可选，避免重复下载）
 * @param preLoadedAgent 预加载的 agent 信息（可选）
 */
async function installSingleAgentToClaw(
  name: string,
  selectedClawDir: string | null,
  targetDir?: string,
  asMain: boolean = false,
  preDownloadedPkgDir?: string,
  preLoadedAgent?: { name: string; displayName: string; version: string },
): Promise<void> {
  const brand = selectedClawDir ? detectClawBrand(selectedClawDir) : null;
  const clawLabel = brand ? `${brand} (${selectedClawDir})` : targetDir!;
  const spinner = createSpinner(`Installing to ${chalk.dim(clawLabel)}...`).start();

  const agentId = name.toLowerCase().replace(/[\s_]+/g, "-");
  logger.info(`Install role resolved: asMain=${asMain}, claw=${selectedClawDir || targetDir}`);

  // 1. 获取 agent 信息（如果未预加载）
  let agent = preLoadedAgent;
  if (!agent) {
    spinner.text = `Fetching agent ${chalk.cyan(name)}...`;
    const index = await fetchIndex();
    const found = index.agents.find((a) => a.name === name);
    if (!found) {
      spinner.fail(`Agent "${name}" not found in registry.`);
      console.log(chalk.dim("  Use 'soulhub search' to find available agents."));
      return;
    }
    agent = found;
  }

  // 2. 确定目标目录
  let workspaceDir: string;
  if (targetDir) {
    workspaceDir = path.resolve(targetDir);
  } else if (asMain) {
    workspaceDir = getMainWorkspaceDir(selectedClawDir!);
  } else {
    workspaceDir = getWorkspaceDir(selectedClawDir!, agentId);
  }

  // 3. 备份已有内容
  const backupRecord = !targetDir
    ? createBackupRecord("single-agent", name, selectedClawDir!)
    : null;

  if (!targetDir && asMain) {
    const mainCheck = checkMainAgentExists(selectedClawDir!);
    if (mainCheck.hasContent) {
      spinner.warn(`Existing main agent detected. Backing up workspace...`);
      const backupDir = backupAgentWorkspace(workspaceDir);
      if (backupDir) {
        console.log(chalk.yellow(`  ⚠ Existing main agent backed up to: ${backupDir}`));
        addBackupItem(backupRecord!, {
          originalPath: workspaceDir,
          backupPath: backupDir,
          method: "cp",
          role: "main",
          agentId: "main",
        });
      }
    }
  } else if (!targetDir && !asMain) {
    if (fs.existsSync(workspaceDir)) {
      const backupDir = backupAgentWorkspace(workspaceDir);
      if (backupDir) {
        console.log(chalk.yellow(`  ⚠ Existing worker ${agentId} backed up to: ${backupDir}`));
        addBackupItem(backupRecord!, {
          originalPath: workspaceDir,
          backupPath: backupDir,
          method: "cp",
          role: "worker",
          agentId,
        });
      }
    }
  } else if (targetDir) {
    const backupDir = backupAgentWorkspace(workspaceDir);
    if (backupDir) {
      console.log(chalk.yellow(`  ⚠ Existing agent backed up to: ${backupDir}`));
    }
  }

  // 4. 确保 workspace 目录存在 + 注册到 openclaw.json / lightclaw.json
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
  if (!targetDir) {
    if (asMain) {
      spinner.text = `Registering ${chalk.cyan(agent.displayName)} as main agent...`;
      addAgentToOpenClawConfig(selectedClawDir!, "main", name, true);
    } else {
      spinner.text = `Registering ${chalk.cyan(agent.displayName)} as worker agent...`;
      const regResult = registerAgentToOpenClaw(agentId, workspaceDir, selectedClawDir || undefined);
      if (!regResult.success) {
        spinner.fail(`Failed to register ${agentId}: ${regResult.message}`);
        return;
      }
    }
  }

  // 5. 复制 agent 文件到 workspace
  if (preDownloadedPkgDir) {
    copyAgentFilesFromPackage(preDownloadedPkgDir, workspaceDir);
  } else {
    spinner.text = `Downloading ${chalk.cyan(agent.displayName)} package...`;
    const pkgDir = await downloadAgentPackage(name, agent.version);
    copyAgentFilesFromPackage(pkgDir, workspaceDir);
    fs.rmSync(pkgDir, { recursive: true, force: true });
  }

  // 6. 记录安装
  recordInstall(name, agent.version, workspaceDir);

  if (backupRecord) {
    if (asMain) {
      backupRecord.installedMainAgent = name;
    } else {
      backupRecord.installedWorkerIds = [agentId];
    }
    commitBackupRecord(backupRecord);
  }

  const roleLabel = asMain ? "main agent" : "worker agent";
  const typeLabel = asMain
    ? chalk.blue("Single Agent (Main)")
    : chalk.green("Single Agent (Worker)");

  logger.info(`Single agent installed as ${roleLabel}: ${name}`, { version: agent.version, workspace: workspaceDir });
  spinner.succeed(
    `${chalk.cyan.bold(agent.displayName)} installed as ${roleLabel} → ${chalk.dim(clawLabel)}`
  );
  console.log(`  ${chalk.dim("Location:")} ${workspaceDir}`);
  console.log(`  ${chalk.dim("Version:")}  ${agent.version}`);
  console.log(`  ${chalk.dim("Type:")}     ${typeLabel}`);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway(selectedClawDir || undefined);
  }
  console.log();
}

// ==========================================
// 多 Agent Team 安装（从 Registry Recipe）
// ==========// ==========================================

/**
 * 从 registry recipe 安装多 Agent 团队
 */
async function installRecipeFromRegistry(
  name: string,
  recipe: { name: string; displayName: string; agents: string[]; version?: string },
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = createSpinner(`Installing team ${chalk.cyan(recipe.displayName)}...`).start();

  // 1. 解析 claw 目录（可能触发交互选择）
  let resolvedClawDir: string;
  if (targetDir) {
    resolvedClawDir = path.resolve(targetDir);
  } else {
    spinner.stop();
    const selected = await resolveClawDir(clawDir);
    if (!selected) {
      console.log(chalk.red("OpenClaw/LightClaw workspace directory not found."));
      printOpenClawInstallHelp();
      return;
    }
    resolvedClawDir = selected;
    spinner.start();
  }

  // 2. 从 COS 下载 recipe yaml 描述文件
  spinner.text = `Fetching team configuration...`;
  let pkg: SoulHubPackage;
  try {
    const soulhubYamlContent = await fetchRecipeYaml(name, recipe.version || "latest");
    pkg = yaml.load(soulhubYamlContent) as SoulHubPackage;
  } catch {
    spinner.fail(`Failed to fetch recipe yaml for "${name}". Recipe must have a published yaml file.`);
    return;
  }

  // 2.5 备份存量子 agent（mv 方式）
  const recipeBackupRecord = !targetDir
    ? createBackupRecord("team-registry", name, resolvedClawDir)
    : null;

  if (!targetDir) {
    spinner.text = "Backing up existing worker agents...";
    const backupResults = backupAllWorkerWorkspaces(resolvedClawDir);
    for (const { name: dirName, backupDir } of backupResults) {
      logger.info(`Existing worker backed up (mv)`, { dirName, backupDir });
      console.log(chalk.yellow(`  ⚠ Existing ${dirName} moved to: ${backupDir}`));
      // 从目录名提取 agentId：workspace-xxx → xxx
      const agentId = dirName.replace(/^workspace-/, "");
      addBackupItem(recipeBackupRecord!, {
        originalPath: path.join(resolvedClawDir, dirName),
        backupPath: backupDir,
        method: "mv",
        role: "worker",
        agentId,
      });
    }
    if (backupResults.length > 0) {
      console.log(chalk.dim(`  ${backupResults.length} existing worker(s) backed up.`));
    }
  }

  // 3. 安装 dispatcher（主 agent）
  if (pkg.dispatcher) {
    spinner.text = `Installing dispatcher ${chalk.blue(pkg.dispatcher.name)}...`;
    await installDispatcher(pkg.dispatcher, resolvedClawDir, clawDir, targetDir, spinner, recipeBackupRecord);
  }

  // 4. 安装 worker agents
  const index = await fetchIndex();
  const workerIds: string[] = [];

  for (const worker of pkg.agents || []) {
    spinner.text = `Installing worker ${chalk.cyan(worker.name)}...`;

    const agentName = worker.dir || worker.name; // dir 可能是 registry 中的 template 名
    const agentId = worker.name; // agentId 可能是自定义短名

    try {
      const workerDir = targetDir
        ? path.join(resolvedClawDir, `workspace-${agentId}`)
        : getWorkspaceDir(resolvedClawDir, agentId);

      // 注册 worker agent
      if (!targetDir) {
        const regResult = registerAgentToOpenClaw(agentId, workerDir, resolvedClawDir);
        if (!regResult.success) {
          console.log(chalk.yellow(`  ⚠ Failed to register ${agentId}: ${regResult.message}`));
          continue;
        }
      } else {
        fs.mkdirSync(workerDir, { recursive: true });
      }

      // 从 COS 下载 agent tar.gz 包并解压
      const agentInfo = index.agents.find((a) => a.name === agentName);
      const agentVersion = agentInfo?.version || "latest";
      const pkgDir = await downloadAgentPackage(agentName, agentVersion);
      copyAgentFilesFromPackage(pkgDir, workerDir);
      fs.rmSync(pkgDir, { recursive: true, force: true });

      recordInstall(agentId, recipe.version || "1.0.0", workerDir);
      workerIds.push(agentId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to install worker ${agentId}`, { error: errMsg });
      console.log(chalk.red(`  ✗ Failed to install worker ${agentId}: ${errMsg}`));
    }
  }

  // 5. 配置多 agent 通信
  if (!targetDir) {
    spinner.text = "Configuring multi-agent communication...";
    const dispatcherId = "main"; // 主 agent 固定 id 为 "main"
    configureMultiAgentCommunication(resolvedClawDir, dispatcherId, workerIds);
  }

  // 记录备份信息
  if (recipeBackupRecord) {
    recipeBackupRecord.installedWorkerIds = workerIds;
    recipeBackupRecord.installedMainAgent = pkg.dispatcher?.name || null;
    commitBackupRecord(recipeBackupRecord);
  }

  logger.info(`Team installed from registry: ${name}`, { dispatcher: pkg.dispatcher?.name, workers: workerIds });
  spinner.succeed(
    `Team ${chalk.cyan.bold(recipe.displayName)} installed! (1 dispatcher + ${workerIds.length} workers)`
  );
  printTeamSummary(pkg, workerIds);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway(resolvedClawDir);
  }
}

// ==========================================
// 从本地目录/ZIP/URL 安装（自动识别）
// ==========================================

/**
 * 从本地源安装，自动识别单/多 agent
 */
async function installFromSource(
  source: string,
  targetDir?: string,
  clawDir?: string,
  asMain?: boolean | null,
  clawExplicit?: boolean,
  skipConfirm: boolean = false
): Promise<void> {
  if (asMain === null) return; // 用户取消了角色选择
  const spinner = createSpinner("Analyzing package...").start();

  // 处理不同的源类型
  let packageDir: string;
  let tempDir: string | null = null;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    // URL 来源 — 下载到临时目录
    logger.info(`Downloading package from URL: ${source}`);
    spinner.text = "Downloading package...";
    const response = await fetch(source, {
      headers: {
        "User-Agent": "soulhub-cli",
        "Accept": "application/zip, application/octet-stream",
      },
    });
    if (!response.ok) {
      logger.error(`Download failed`, { url: source, status: response.status, statusText: response.statusText });
      spinner.fail(`Failed to download: ${response.statusText}`);
      return;
    }
    // 下载 ZIP 文件
    const contentType = response.headers.get("content-type") || "";
    logger.debug(`Response content-type: ${contentType}`);
    if (contentType.includes("zip") || source.endsWith(".zip")) {
      const JSZip = (await import("jszip")).default;
      const arrayBuffer = await response.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuffer);
      tempDir = path.join(process.env.HOME || "/tmp", ".soulhub", "tmp", `pkg-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      await extractZipToDir(zip, tempDir);
      packageDir = tempDir;
    } else {
      logger.error(`Unsupported content type from URL`, { url: source, contentType });
      spinner.fail("Unsupported URL content type. Expected ZIP file.");
      return;
    }
  } else if (source.endsWith(".zip")) {
    // 本地 ZIP 文件
    spinner.text = "Extracting ZIP file...";
    const JSZip = (await import("jszip")).default;
    const zipData = fs.readFileSync(path.resolve(source));
    const zip = await JSZip.loadAsync(zipData);
    tempDir = path.join(process.env.HOME || "/tmp", ".soulhub", "tmp", `pkg-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    await extractZipToDir(zip, tempDir);
    packageDir = tempDir;
  } else {
    // 本地目录
    packageDir = path.resolve(source);
    if (!fs.existsSync(packageDir)) {
      spinner.fail(`Directory not found: ${packageDir}`);
      return;
    }
  }

  // 自动识别包类型
  const kind = detectPackageKind(packageDir);
  logger.info(`Detected package type: ${kind}`, { packageDir });
  spinner.text = `Detected package type: ${chalk.blue(kind)}`;

  if (kind === "agent") {
    spinner.stop();
    await installSingleAgentFromDir(packageDir, targetDir, clawDir, asMain, clawExplicit, skipConfirm);
  } else if (kind === "team") {
    spinner.stop();
    await installTeamFromDir(packageDir, targetDir, clawDir);
  } else {
    logger.error(`Cannot determine package type`, { packageDir, files: fs.existsSync(packageDir) ? fs.readdirSync(packageDir) : [] });
    spinner.fail("Cannot determine package type. Expected soulhub.yaml or IDENTITY.md.");
  }

  // 清理临时目录
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 从本地目录安装单个 agent（分发函数）
 * 默认安装为子 agent，安装到所有检测到的 claw 目录。
 * @param asMain 是否安装为主 agent，默认 false
 */
async function installSingleAgentFromDir(
  packageDir: string,
  targetDir?: string,
  clawDir?: string,
  asMain: boolean = false,
  clawExplicit?: boolean,
  skipConfirm: boolean = false
): Promise<void> {
  // 读取 soulhub.yaml 或推断元信息
  const pkg = readSoulHubPackage(packageDir);
  const agentName = pkg?.name || path.basename(packageDir);

  // 安装为 main agent 时，提示用户会覆盖 workspace
  if (asMain) {
    console.log();
    console.log(chalk.yellow("  ⚠  Installing as main agent will overwrite the current workspace/ content."));
    console.log(chalk.yellow("     The existing persona (IDENTITY.md, SOUL.md, etc.) will be replaced."));
    console.log(chalk.yellow("     Memory and conversation history will NOT be affected."));
    console.log();
    if (!skipConfirm) {
      const confirmed = await promptConfirm("Continue?", true);
      if (!confirmed) {
        console.log(chalk.dim("  Installation cancelled."));
        return;
      }
    } else {
      console.log(chalk.dim("  Auto-confirmed with --yes flag."));
    }
  }

  // 如果指定了 --dir，直接安装到该目录（单一安装）
  if (targetDir) {
    await installSingleAgentFromDirToClaw(packageDir, agentName, pkg, null, targetDir, asMain);
    return;
  }

  // 获取所有 claw 目录（交互式单选或命令行指定）
  const allClawDirs = await resolveClawDirsInteractive(clawDir, clawExplicit);
  if (allClawDirs.length === 0) {
    console.log(chalk.red("OpenClaw/LightClaw workspace directory not found."));
    printOpenClawInstallHelp();
    return;
  }

  // 安装到选定的 claw 目录（一次只安装一个）
  const selectedClawDir = allClawDirs[0];
  try {
    await installSingleAgentFromDirToClaw(packageDir, agentName, pkg, selectedClawDir, undefined, asMain);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to install to ${selectedClawDir}`, { error: errMsg });
    console.error(chalk.red(`  ✗ Installation failed for ${selectedClawDir}: ${errMsg}`));
  }
}

/**
 * 将单个本地 agent 安装到一个具体的 claw 目录
 */
async function installSingleAgentFromDirToClaw(
  packageDir: string,
  agentName: string,
  pkg: SoulHubPackage | null,
  selectedClawDir: string | null,
  targetDir?: string,
  asMain: boolean = false,
): Promise<void> {
  const brand = selectedClawDir ? detectClawBrand(selectedClawDir) : null;
  const clawLabel = brand ? `${brand} (${selectedClawDir})` : targetDir!;
  const spinner = createSpinner(`Installing to ${chalk.dim(clawLabel)}...`).start();

  const agentId = agentName.toLowerCase().replace(/[\s_]+/g, "-");
  logger.info(`Install role resolved: asMain=${asMain}, claw=${selectedClawDir || targetDir}`);

  // 1. 确定目标目录
  let workspaceDir: string;
  if (targetDir) {
    workspaceDir = path.resolve(targetDir);
  } else if (asMain) {
    workspaceDir = getMainWorkspaceDir(selectedClawDir!);
  } else {
    workspaceDir = getWorkspaceDir(selectedClawDir!, agentId);
  }

  // 2. 备份
  const localBackupRecord = !targetDir
    ? createBackupRecord("single-agent-local", agentName, selectedClawDir!)
    : null;

  if (!targetDir && asMain) {
    const mainCheck = checkMainAgentExists(selectedClawDir!);
    if (mainCheck.hasContent) {
      spinner.warn("Existing main agent detected. Backing up...");
      const backupDir = backupAgentWorkspace(workspaceDir);
      if (backupDir) {
        console.log(chalk.yellow(`  ⚠ Existing main agent backed up to: ${backupDir}`));
        addBackupItem(localBackupRecord!, {
          originalPath: workspaceDir,
          backupPath: backupDir,
          method: "cp",
          role: "main",
          agentId: "main",
        });
      }
    }
  } else if (!targetDir && !asMain) {
    if (fs.existsSync(workspaceDir)) {
      const backupDir = backupAgentWorkspace(workspaceDir);
      if (backupDir) {
        console.log(chalk.yellow(`  ⚠ Existing worker ${agentId} backed up to: ${backupDir}`));
        addBackupItem(localBackupRecord!, {
          originalPath: workspaceDir,
          backupPath: backupDir,
          method: "cp",
          role: "worker",
          agentId,
        });
      }
    }
  }

  // 3. 确保 workspace 目录存在 + 注册 agent
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
  if (!targetDir) {
    if (asMain) {
      spinner.text = `Registering ${chalk.cyan(agentName)} as main agent...`;
      addAgentToOpenClawConfig(selectedClawDir!, "main", agentName, true);
    } else {
      spinner.text = `Registering ${chalk.cyan(agentName)} as worker agent...`;
      const regResult = registerAgentToOpenClaw(agentId, workspaceDir, selectedClawDir || undefined);
      if (!regResult.success) {
        spinner.fail(`Failed to register ${agentId}: ${regResult.message}`);
        return;
      }
    }
  }

  // 4. 复制 agent 文件
  spinner.text = `Copying soul files...`;
  copyAgentFilesFromDir(packageDir, workspaceDir);

  recordInstall(agentName, pkg?.version || "local", workspaceDir);

  // 记录备份信息
  if (localBackupRecord) {
    if (asMain) {
      localBackupRecord.installedMainAgent = agentName;
    } else {
      localBackupRecord.installedWorkerIds = [agentId];
    }
    commitBackupRecord(localBackupRecord);
  }

  const roleLabel = asMain ? "main agent" : "worker agent";
  const typeLabel = asMain
    ? chalk.blue("Single Agent (Main)")
    : chalk.green("Single Agent (Worker)");

  logger.info(`Single agent installed from dir as ${roleLabel}: ${agentName}`, { source: packageDir, workspace: workspaceDir });
  spinner.succeed(`${chalk.cyan.bold(agentName)} installed as ${roleLabel} → ${chalk.dim(clawLabel)}`);
  console.log(`  ${chalk.dim("Location:")} ${workspaceDir}`);
  console.log(`  ${chalk.dim("Source:")}   ${packageDir}`);
  console.log(`  ${chalk.dim("Type:")}     ${typeLabel}`);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway(selectedClawDir || undefined);
  }
  console.log();
}

/**
 * 从本地目录安装多 Agent 团队
 */
async function installTeamFromDir(
  packageDir: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = createSpinner("Installing team...").start();

  // 1. 读取包描述
  const pkg = readSoulHubPackage(packageDir);
  if (!pkg || pkg.kind !== "team") {
    spinner.fail("Invalid team package. Missing soulhub.yaml.");
    return;
  }

  // 2. 解析 claw 目录（可能触发交互选择）
  let resolvedClawDir: string;
  if (targetDir) {
    resolvedClawDir = path.resolve(targetDir);
  } else {
    spinner.stop();
    const selected = await resolveClawDir(clawDir);
    if (!selected) {
      console.log(chalk.red("OpenClaw/LightClaw workspace directory not found."));
      printOpenClawInstallHelp();
      return;
    }
    resolvedClawDir = selected;
    spinner.start();
  }

  // 2.5 备份存量子 agent（mv 方式）
  const teamBackupRecord = !targetDir
    ? createBackupRecord("team-local", pkg.name, resolvedClawDir)
    : null;

  if (!targetDir) {
    spinner.text = "Backing up existing worker agents...";
    const backupResults = backupAllWorkerWorkspaces(resolvedClawDir);
    for (const { name: dirName, backupDir } of backupResults) {
      logger.info(`Existing worker backed up (mv)`, { dirName, backupDir });
      console.log(chalk.yellow(`  ⚠ Existing ${dirName} moved to: ${backupDir}`));
      const agentId = dirName.replace(/^workspace-/, "");
      addBackupItem(teamBackupRecord!, {
        originalPath: path.join(resolvedClawDir, dirName),
        backupPath: backupDir,
        method: "mv",
        role: "worker",
        agentId,
      });
    }
    if (backupResults.length > 0) {
      console.log(chalk.dim(`  ${backupResults.length} existing worker(s) backed up.`));
    }
  }

  // 3. 安装 dispatcher（主 agent → workspace）
  if (pkg.dispatcher) {
    spinner.text = `Installing dispatcher ${chalk.blue(pkg.dispatcher.name)}...`;

    const mainWorkspace = targetDir
      ? path.join(resolvedClawDir, "workspace")
      : getMainWorkspaceDir(resolvedClawDir);

    // 备份
    if (!targetDir) {
      const mainCheck = checkMainAgentExists(resolvedClawDir);
      if (mainCheck.hasContent) {
        spinner.warn("Existing main agent detected. Backing up...");
        const backupDir = backupAgentWorkspace(mainWorkspace);
        if (backupDir) {
          console.log(chalk.yellow(`  ⚠ Existing main agent backed up to: ${backupDir}`));
          if (teamBackupRecord) {
            addBackupItem(teamBackupRecord, {
              originalPath: mainWorkspace,
              backupPath: backupDir,
              method: "cp",
              role: "main",
              agentId: "main",
            });
          }
        }
      }
    }

    // 确保 workspace 目录存在 + 更新 openclaw.json / lightclaw.json
    //    备份是 cp（原目录不动），所以如果目录已存在无需重建
    if (!fs.existsSync(mainWorkspace)) {
      fs.mkdirSync(mainWorkspace, { recursive: true });
    }
    if (!targetDir) {
      addAgentToOpenClawConfig(resolvedClawDir, "main", pkg.dispatcher.name, true);
    }

    // 复制 dispatcher 文件
    const dispatcherSourceDir = path.join(packageDir, pkg.dispatcher.dir);
    if (fs.existsSync(dispatcherSourceDir)) {
      copyAgentFilesFromDir(dispatcherSourceDir, mainWorkspace);
    }

    recordInstall("dispatcher", pkg.version || "local", mainWorkspace);
  }

  // 4. 安装 worker agents
  const workerIds: string[] = [];

  for (const worker of pkg.agents || []) {
    const agentId = worker.name;
    const agentDir = worker.dir || worker.name;

    spinner.text = `Installing worker ${chalk.cyan(agentId)}...`;

    try {
      const workerWorkspace = targetDir
        ? path.join(resolvedClawDir, `workspace-${agentId}`)
        : getWorkspaceDir(resolvedClawDir, agentId);

      // 注册 worker（存量子 agent 已在步骤 2.5 中通过 mv 备份并移走）
      if (!targetDir) {
        const regResult = registerAgentToOpenClaw(agentId, workerWorkspace, resolvedClawDir);
        if (!regResult.success) {
          console.log(chalk.yellow(`  ⚠ Failed to register ${agentId}: ${regResult.message}`));
          continue;
        }
      } else {
        fs.mkdirSync(workerWorkspace, { recursive: true });
      }

      // 复制 worker 文件
      const workerSourceDir = path.join(packageDir, agentDir);
      if (fs.existsSync(workerSourceDir)) {
        copyAgentFilesFromDir(workerSourceDir, workerWorkspace);
      }

      recordInstall(agentId, pkg.version || "local", workerWorkspace);
      workerIds.push(agentId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to install worker ${agentId}`, { error: errMsg });
      console.log(chalk.red(`  ✗ Failed to install worker ${agentId}: ${errMsg}`));
    }
  }

  // 5. 配置多 agent 通信
  if (!targetDir && workerIds.length > 0) {
    spinner.text = "Configuring multi-agent communication...";
    configureMultiAgentCommunication(resolvedClawDir, "main", workerIds);
  }

  // 记录备份信息
  if (teamBackupRecord) {
    teamBackupRecord.installedWorkerIds = workerIds;
    teamBackupRecord.installedMainAgent = pkg.dispatcher?.name || null;
    commitBackupRecord(teamBackupRecord);
  }

  logger.info(`Team installed from dir: ${pkg.name}`, { dispatcher: pkg.dispatcher?.name, workers: workerIds, source: packageDir });
  spinner.succeed(
    `Team ${chalk.cyan.bold(pkg.name)} installed! (${pkg.dispatcher ? "1 dispatcher + " : ""}${workerIds.length} workers)`
  );
  printTeamSummary(pkg, workerIds);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway(resolvedClawDir);
  }
}

// ==========================================
// 辅助函数
// ==========================================



/**
 * 从本地目录复制 agent 文件（IDENTITY.md, SOUL.md 等）
 */
function copyAgentFilesFromDir(sourceDir: string, targetDir: string): void {
  const filesToCopy = ["IDENTITY.md", "SOUL.md", "USER.md", "TOOLS.md", "AGENTS.md", "HEARTBEAT.md"];
  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of filesToCopy) {
    const sourcePath = path.join(sourceDir, fileName);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
    }
  }

  // 复制 skills 目录（如果存在）
  const skillsSource = path.join(sourceDir, "skills");
  if (fs.existsSync(skillsSource) && fs.statSync(skillsSource).isDirectory()) {
    const skillsTarget = path.join(targetDir, "skills");
    fs.cpSync(skillsSource, skillsTarget, { recursive: true });
    logger.debug(`Skills directory copied`, { from: skillsSource, to: skillsTarget });
  }
}

/**
 * 安装 dispatcher（从 registry 下载）
 */
async function installDispatcher(
  dispatcher: { name: string; dir: string },
  resolvedClawDir: string,
  clawDir?: string,
  targetDir?: string,
  spinner?: Spinner,
  backupRecord?: BackupRecord | null
): Promise<void> {
  const mainWorkspace = targetDir
    ? path.join(resolvedClawDir, "workspace")
    : getMainWorkspaceDir(resolvedClawDir);

  // 备份
  if (!targetDir) {
    const mainCheck = checkMainAgentExists(resolvedClawDir);
    if (mainCheck.hasContent) {
      if (spinner) spinner.warn("Existing main agent detected. Backing up...");
      const backupDir = backupAgentWorkspace(mainWorkspace);
      if (backupDir) {
        console.log(chalk.yellow(`  ⚠ Existing main agent backed up to: ${backupDir}`));
        if (backupRecord) {
          addBackupItem(backupRecord, {
            originalPath: mainWorkspace,
            backupPath: backupDir,
            method: "cp",
            role: "main",
            agentId: "main",
          });
        }
      }
    }
  }

  // 确保 workspace 目录存在 + 更新 openclaw.json / lightclaw.json
  //    备份是 cp（原目录不动），所以如果目录已存在无需重建
  if (!fs.existsSync(mainWorkspace)) {
    fs.mkdirSync(mainWorkspace, { recursive: true });
  }
  if (!targetDir) {
    addAgentToOpenClawConfig(resolvedClawDir, "main", dispatcher.name, true);
  }

  // 从 COS 下载 dispatcher tar.gz 包并解压
  const templateName = dispatcher.dir || dispatcher.name;
  if (spinner) spinner.text = `Downloading dispatcher package...`;
  const pkgDir = await downloadAgentPackage(templateName);
  copyAgentFilesFromPackage(pkgDir, mainWorkspace);
  fs.rmSync(pkgDir, { recursive: true, force: true });

  recordInstall("dispatcher", "1.0.0", mainWorkspace);
}

/**
 * 将 ZIP 文件解压到目录
 */
async function extractZipToDir(
  zip: import("jszip"),
  targetDir: string
): Promise<void> {
  const entries = Object.entries(zip.files);
  for (const [relativePath, file] of entries) {
    const fullPath = path.join(targetDir, relativePath);
    if (file.dir) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const content = await file.async("nodebuffer");
      fs.writeFileSync(fullPath, content);
    }
  }
}

/**
 * 打印 OpenClaw 安装帮助信息
 */
function printOpenClawInstallHelp(): void {
  console.log(chalk.dim("  Please install OpenClaw or LightClaw first, or use one of the following options:"));
  console.log(chalk.dim("  --claw-type <type>           Specify claw type: OpenClaw or LightClaw"));
  console.log(chalk.dim("  --dir <path>                 Specify agent target directory directly"));
  console.log(chalk.dim("  OPENCLAW_HOME=<path>         Set environment variable (for OpenClaw)"));
  console.log(chalk.dim("  LIGHTCLAW_HOME=<path>        Set environment variable (for LightClaw)"));
}

/**
 * 打印团队安装概览
 */
function printTeamSummary(pkg: SoulHubPackage, workerIds: string[]): void {
  console.log();
  if (pkg.dispatcher) {
    console.log(`  ${chalk.blue("⚡ [Dispatcher]")} ${chalk.cyan(pkg.dispatcher.name)} → ${chalk.dim("workspace/")}`);
  }
  for (const id of workerIds) {
    console.log(`  ${chalk.dim("  ✓ [Worker]")}    ${chalk.cyan(id)} → ${chalk.dim(`workspace-${id}/`)}`);
  }
  console.log();
  console.log(`  ${chalk.dim("Type:")}     ${chalk.blue("Multi-Agent Team")}`);
  if (pkg.routing && pkg.routing.length > 0) {
    console.log(`  ${chalk.dim("Routing:")}  ${pkg.routing.length} rules configured`);
  }
  console.log();
}

/**
 * 提示用户手动重启 OpenClaw/LightClaw Gateway
 */
async function tryRestartGateway(clawDir?: string): Promise<void> {
  const clawCmd = detectClawCommand(clawDir);
  const brandName = clawCmd === "lightclaw" ? "LightClaw" : "OpenClaw";
  console.log();
  console.log(chalk.yellow(`  ⚠ Please restart ${brandName} Gateway to apply changes:`));
  console.log(chalk.cyan(`    ${clawCmd} gateway restart`));
}



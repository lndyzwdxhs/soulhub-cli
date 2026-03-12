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
  checkOpenClawInstalled,
  backupAgentWorkspace,
  backupAllWorkerWorkspaces,
  registerAgentToOpenClaw,
  readSoulHubPackage,
  detectPackageKind,
  configureMultiAgentCommunication,
  addAgentToOpenClawConfig,
  restartOpenClawGateway,
  createBackupRecord,
  addBackupItem,
  commitBackupRecord,
} from "../utils.js";
import type { SoulHubPackage, BackupRecord } from "../types.js";

export const installCommand = new Command("install")
  .description("Install an agent or team from the SoulHub registry")
  .argument("[name]", "Agent or team name to install")
  .option("--from <source>", "Install from a local directory, ZIP file, or URL")
  .option(
    "--dir <path>",
    "Target directory (defaults to OpenClaw workspace)"
  )
  .option(
    "--claw-dir <path>",
    "OpenClaw installation directory (overrides OPENCLAW_HOME env var, defaults to ~/.openclaw)"
  )
  .action(async (name: string | undefined, options) => {
    try {
      if (options.from) {
        // 从本地目录/ZIP/URL 安装，自动识别单/多 agent
        await installFromSource(options.from, options.dir, options.clawDir);
      } else if (name) {
        // 从 registry 安装，自动识别是 agent 还是 recipe
        await installFromRegistry(name, options.dir, options.clawDir);
      } else {
        console.error(chalk.red("Please specify an agent or team name, or use --from to install from a local source."));
        console.log(chalk.dim("  Examples:"));
        console.log(chalk.dim("    soulhub install writer-wechat          # 从 registry 安装单 agent"));
        console.log(chalk.dim("    soulhub install dev-squad              # 从 registry 安装团队"));
        console.log(chalk.dim("    soulhub install --from ./agent-team/   # 从本地目录安装"));
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

// ==========================================
// 从 Registry 安装（自动识别 agent / recipe）
// ==========================================

/**
 * 从 registry 安装，自动识别是单 agent 还是 team recipe
 */
async function installFromRegistry(
  name: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = createSpinner(`Checking registry for ${chalk.cyan(name)}...`).start();

  const index = await fetchIndex();

  // 先检查是否是 agent
  const agent = index.agents.find((a) => a.name === name);
  // 再检查是否是 recipe
  const recipe = index.recipes.find((r) => r.name === name);

  if (agent && !recipe) {
    spinner.stop();
    logger.info(`Installing single agent from registry: ${name}`);
    await installSingleAgent(name, targetDir, clawDir);
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

// ==========================================
// 单 Agent 安装
// ==========================================

/**
 * 安装单个 agent（安装到主 workspace）
 */
async function installSingleAgent(
  name: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = createSpinner(`Checking environment...`).start();

  // 1. 检查 OpenClaw 是否安装
  if (!targetDir) {
    const clawCheck = checkOpenClawInstalled(clawDir);
    if (!clawCheck.installed) {
      spinner.fail("OpenClaw is not installed.");
      printOpenClawInstallHelp();
      return;
    }
    spinner.text = chalk.dim(`OpenClaw detected: ${clawCheck.clawDir || "via PATH"}`);
  }

  // 2. 查询 registry 获取 agent 信息
  spinner.text = `Fetching agent ${chalk.cyan(name)}...`;
  const index = await fetchIndex();
  const agent = index.agents.find((a) => a.name === name);
  if (!agent) {
    spinner.fail(`Agent "${name}" not found in registry.`);
    console.log(chalk.dim("  Use 'soulhub search' to find available agents."));
    return;
  }

  // 3. 确定目标目录
  let workspaceDir: string;
  if (targetDir) {
    workspaceDir = path.resolve(targetDir);
  } else {
    const resolvedClawDir = findOpenClawDir(clawDir);
    if (!resolvedClawDir) {
      spinner.fail("OpenClaw workspace directory not found.");
      printOpenClawInstallHelp();
      return;
    }
    // 单 agent 安装到主 workspace
    workspaceDir = getMainWorkspaceDir(resolvedClawDir);
  }

  // 4. 检查主 agent 是否已存在，备份
  const resolvedClawDirForBackup = findOpenClawDir(clawDir)!;
  const backupRecord = !targetDir
    ? createBackupRecord("single-agent", name, resolvedClawDirForBackup)
    : null;

  if (!targetDir) {
    const mainCheck = checkMainAgentExists(resolvedClawDirForBackup);
    if (mainCheck.hasContent) {
      spinner.warn(
        `Existing main agent detected. Backing up workspace...`
      );
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
  } else {
    // 自定义目录也做备份
    const backupDir = backupAgentWorkspace(workspaceDir);
    if (backupDir) {
      console.log(chalk.yellow(`  ⚠ Existing agent backed up to: ${backupDir}`));
    }
  }

  // 5. 确保 workspace 目录存在 + 更新 openclaw.json
  //    备份是 cp（原目录不动），所以如果目录已存在无需重建
  //    不使用 openclaw agents add（那是给子 agent 用的，"main" 是保留 id）
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
  if (!targetDir) {
    spinner.text = `Registering ${chalk.cyan(agent.displayName)} as main agent...`;
    const resolvedClawDir = findOpenClawDir(clawDir)!;
    addAgentToOpenClawConfig(resolvedClawDir, "main", name, true);
    spinner.text = chalk.dim(`Main agent registered in openclaw.json`);
  }

  // 6. 下载 agent tar.gz 包并解压到 workspace
  spinner.text = `Downloading ${chalk.cyan(agent.displayName)} package...`;
  const pkgDir = await downloadAgentPackage(name, agent.version);
  copyAgentFilesFromPackage(pkgDir, workspaceDir);
  fs.rmSync(pkgDir, { recursive: true, force: true }); // 清理临时目录

  // 8. 记录安装
  recordInstall(name, agent.version, workspaceDir);

  // 记录备份信息
  if (backupRecord) {
    backupRecord.installedMainAgent = name;
    commitBackupRecord(backupRecord);
  }

  logger.info(`Single agent installed: ${name}`, { version: agent.version, workspace: workspaceDir });
  spinner.succeed(
    `${chalk.cyan.bold(agent.displayName)} installed as main agent!`
  );
  console.log();
  console.log(`  ${chalk.dim("Location:")} ${workspaceDir}`);
  console.log(`  ${chalk.dim("Version:")}  ${agent.version}`);
  console.log(`  ${chalk.dim("Type:")}     ${chalk.blue("Single Agent (Main)")}`);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway();
  }
  console.log();
}

// ==========================================
// 多 Agent Team 安装（从 Registry Recipe）
// ==========================================

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

  // 1. 检查 OpenClaw 是否安装
  if (!targetDir) {
    const clawCheck = checkOpenClawInstalled(clawDir);
    if (!clawCheck.installed) {
      spinner.fail("OpenClaw is not installed.");
      printOpenClawInstallHelp();
      return;
    }
  }

  const resolvedClawDir = targetDir ? path.resolve(targetDir) : findOpenClawDir(clawDir);
  if (!resolvedClawDir) {
    spinner.fail("OpenClaw workspace directory not found.");
    printOpenClawInstallHelp();
    return;
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

    const workerDir = targetDir
      ? path.join(resolvedClawDir, `workspace-${agentId}`)
      : getWorkspaceDir(resolvedClawDir, agentId);

    // 注册 worker agent
    if (!targetDir) {
      const regResult = registerAgentToOpenClaw(agentId, workerDir, clawDir);
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
    await tryRestartGateway();
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
  clawDir?: string
): Promise<void> {
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
    await installSingleAgentFromDir(packageDir, targetDir, clawDir);
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
 * 从本地目录安装单个 agent
 */
async function installSingleAgentFromDir(
  packageDir: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = createSpinner("Installing single agent...").start();

  // 读取 soulhub.yaml 或推断元信息
  const pkg = readSoulHubPackage(packageDir);
  const agentName = pkg?.name || path.basename(packageDir);

  // 1. 检查 OpenClaw
  if (!targetDir) {
    const clawCheck = checkOpenClawInstalled(clawDir);
    if (!clawCheck.installed) {
      spinner.fail("OpenClaw is not installed.");
      printOpenClawInstallHelp();
      return;
    }
  }

  // 2. 确定目标目录（主 workspace）
  let workspaceDir: string;
  if (targetDir) {
    workspaceDir = path.resolve(targetDir);
  } else {
    const resolvedClawDir = findOpenClawDir(clawDir);
    if (!resolvedClawDir) {
      spinner.fail("OpenClaw workspace directory not found.");
      return;
    }
    workspaceDir = getMainWorkspaceDir(resolvedClawDir);
  }

  // 3. 备份
  const localBackupRecord = !targetDir
    ? createBackupRecord("single-agent-local", agentName, findOpenClawDir(clawDir)!)
    : null;

  if (!targetDir) {
    const resolvedClawDir = findOpenClawDir(clawDir)!;
    const mainCheck = checkMainAgentExists(resolvedClawDir);
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
  }

  // 4. 确保 workspace 目录存在 + 注册主 agent 到 openclaw.json
  //    备份是 cp（原目录不动），所以如果目录已存在无需重建
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
  if (!targetDir) {
    spinner.text = `Registering ${chalk.cyan(agentName)} as main agent...`;
    const resolvedClawDir = findOpenClawDir(clawDir)!;
    addAgentToOpenClawConfig(resolvedClawDir, "main", agentName, true);
  }

  // 5. 复制 IDENTITY.md 和 SOUL.md
  spinner.text = `Copying soul files...`;
  copyAgentFilesFromDir(packageDir, workspaceDir);

  recordInstall(agentName, pkg?.version || "local", workspaceDir);

  // 记录备份信息
  if (localBackupRecord) {
    localBackupRecord.installedMainAgent = agentName;
    commitBackupRecord(localBackupRecord);
  }

  logger.info(`Single agent installed from dir: ${agentName}`, { source: packageDir, workspace: workspaceDir });
  spinner.succeed(`${chalk.cyan.bold(agentName)} installed as main agent!`);
  console.log();
  console.log(`  ${chalk.dim("Location:")} ${workspaceDir}`);
  console.log(`  ${chalk.dim("Source:")}   ${packageDir}`);
  console.log(`  ${chalk.dim("Type:")}     ${chalk.blue("Single Agent (Main)")}`);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway();
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

  // 2. 检查 OpenClaw
  if (!targetDir) {
    const clawCheck = checkOpenClawInstalled(clawDir);
    if (!clawCheck.installed) {
      spinner.fail("OpenClaw is not installed.");
      printOpenClawInstallHelp();
      return;
    }
  }

  const resolvedClawDir = targetDir ? path.resolve(targetDir) : findOpenClawDir(clawDir);
  if (!resolvedClawDir) {
    spinner.fail("OpenClaw workspace directory not found.");
    return;
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

    // 确保 workspace 目录存在 + 更新 openclaw.json
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

    const workerWorkspace = targetDir
      ? path.join(resolvedClawDir, `workspace-${agentId}`)
      : getWorkspaceDir(resolvedClawDir, agentId);

    // 注册 worker（存量子 agent 已在步骤 2.5 中通过 mv 备份并移走）
    if (!targetDir) {
      const regResult = registerAgentToOpenClaw(agentId, workerWorkspace, clawDir);
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
    await tryRestartGateway();
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
  for (const fileName of filesToCopy) {
    const sourcePath = path.join(sourceDir, fileName);
    if (fs.existsSync(sourcePath)) {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
    }
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

  // 确保 workspace 目录存在 + 更新 openclaw.json
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
  console.log(chalk.dim("  Please install OpenClaw first, or use one of the following options:"));
  console.log(chalk.dim("  --claw-dir <path>    Specify OpenClaw installation directory"));
  console.log(chalk.dim("  --dir <path>         Specify agent target directory directly"));
  console.log(chalk.dim("  OPENCLAW_HOME=<path> Set environment variable"));
  console.log(chalk.dim("  Visit: https://github.com/anthropics/openclaw for installation instructions."));
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
 * 尝试重启 OpenClaw Gateway
 * 成功时显示成功提示，失败时提示用户手动重启
 */
async function tryRestartGateway(): Promise<void> {
  const restartSpinner = createSpinner("Restarting OpenClaw Gateway...").start();
  const result = restartOpenClawGateway();
  if (result.success) {
    restartSpinner.succeed("OpenClaw Gateway restarted successfully.");
  } else {
    restartSpinner.warn("Failed to restart OpenClaw Gateway.");
    console.log(chalk.yellow(`  Reason: ${result.message}`));
    console.log(chalk.dim("  Please restart manually:"));
    console.log(chalk.dim("    openclaw gateway restart"));
  }
}



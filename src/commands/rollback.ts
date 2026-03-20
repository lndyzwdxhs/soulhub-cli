import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { select, confirm as inquirerConfirm } from "@inquirer/prompts";
import { createSpinner } from "../spinner.js";
import { logger } from "../logger.js";
import {
  loadBackupManifest,
  saveBackupManifest,
  findOpenClawDir,
  writeOpenClawConfig,
  getMainWorkspaceDir,
  getWorkspaceDir,
  detectClawBrand,
  detectClawCommand,
} from "../utils.js";
import type { BackupRecord } from "../types.js";

export const rollbackCommand = new Command("rollback")
  .description("Rollback to a previous agent installation state")
  .option("--list", "List available rollback records")
  .option("--id <id>", "Rollback to a specific backup record by ID")
  .option("--last <n>", "Rollback the Nth most recent installation (1 = latest, 2 = second latest, etc.)", parseInt)
  .option(
    "--claw-type <type>",
    "Specify claw type: OpenClaw or LightClaw (case-insensitive)"
  )
  .option("-y, --yes", "Skip all confirmation prompts (auto-confirm)")
  .action(async (options) => {
    try {
      const skipConfirm = !!options.yes;
      if (options.list) {
        listBackupRecords();
      } else if (options.id) {
        await performRollback(options.id, options.clawType, skipConfirm);
      } else if (options.last) {
        // --last <n>：非交互式，直接回滚倒数第 n 个
        await performRollbackByIndex(options.last, options.clawType, skipConfirm);
      } else {
        // 默认进入交互式选择
        await interactiveRollback(options.clawType);
      }
    } catch (error) {
      logger.errorObj("Rollback command failed", error);
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      console.error(chalk.dim(`  See logs: ${logger.getTodayLogFile()}`));
      process.exit(1);
    }
  });

/**
 * 列出所有可用的备份记录
 */
function listBackupRecords(): void {
  const manifest = loadBackupManifest();

  if (manifest.records.length === 0) {
    console.log(chalk.yellow("No backup records found."));
    console.log(chalk.dim("  Backup records are created automatically when you install agents."));
    return;
  }

  console.log(chalk.bold("\nAvailable rollback records:\n"));
  printRecordTable(manifest.records);

  console.log();
  console.log(chalk.dim("  Usage:"));
  console.log(chalk.dim("    soulhub rollback              # Interactive: select a record to rollback"));
  console.log(chalk.dim("    soulhub rollback --last 1     # Rollback the latest installation"));
  console.log(chalk.dim("    soulhub rollback --last 2     # Rollback the 2nd latest installation"));
  console.log(chalk.dim("    soulhub rollback --id <id>    # Rollback to a specific record by ID"));
  console.log();
}

/**
 * 打印备份记录表格（带序号）
 */
function printRecordTable(records: BackupRecord[]): void {
  console.log(
    chalk.dim(
      `  ${"#".padEnd(4)} ${"ID".padEnd(20)} ${"Type".padEnd(20)} ${"Package".padEnd(20)} ${"Claw".padEnd(14)} ${"Date".padEnd(22)} Items`
    )
  );
  console.log(chalk.dim("  " + "─".repeat(108)));

  records.forEach((record, index) => {
    const date = new Date(record.createdAt).toLocaleString();
    const typeLabel = formatInstallType(record.installType);
    const itemCount = record.items.length;
    const clawBrand = detectClawBrandFromDir(record.clawDir);

    console.log(
      `  ${chalk.yellow(String(index + 1).padEnd(4))} ${chalk.cyan(record.id.padEnd(20))} ${typeLabel.padEnd(20)} ${chalk.white(record.packageName.padEnd(20))} ${chalk.dim(clawBrand.padEnd(14))} ${chalk.dim(date.padEnd(22))} ${itemCount} backup(s)`
    );
  });
}

/**
 * 交互式回滚：展示记录列表，让用户选择要回滚的记录
 */
async function interactiveRollback(clawDir?: string): Promise<void> {
  const manifest = loadBackupManifest();

  if (manifest.records.length === 0) {
    console.log(chalk.yellow("No backup records found. Nothing to rollback."));
    console.log(chalk.dim("  Backup records are created automatically when you install agents."));
    return;
  }

  // 展示记录列表
  console.log(chalk.bold("\n  Available rollback records:\n"));
  printRecordTable(manifest.records);
  console.log();

  // 上下键选择
  let selected: BackupRecord;
  try {
    selected = await select({
      message: "Select a record to rollback:",
      choices: manifest.records.map((record, index) => {
        const date = new Date(record.createdAt).toLocaleString();
        const clawBrand = detectClawBrandFromDir(record.clawDir);
        return {
          name: `#${index + 1}  ${record.id}  ${record.packageName}  (${clawBrand}, ${date})`,
          value: record,
        };
      }),
    });
  } catch {
    console.log(chalk.dim("  Rollback cancelled."));
    return;
  }

  console.log();
  console.log(chalk.dim(`  Selected: ${chalk.cyan(selected.id)} (${selected.packageName})`));

  // 显示回滚详情并确认
  printRollbackDetails(selected);

  const confirmed = await promptConfirmRollback();
  if (!confirmed) {
    console.log(chalk.dim("  Rollback cancelled."));
    return;
  }

  await executeRollback(selected, clawDir);
}

/**
 * 按索引回滚（--last <n>）
 */
async function performRollbackByIndex(n: number, clawDir?: string, skipConfirm: boolean = false): Promise<void> {
  const manifest = loadBackupManifest();

  if (manifest.records.length === 0) {
    console.log(chalk.yellow("No backup records found. Nothing to rollback."));
    return;
  }

  if (n < 1 || n > manifest.records.length) {
    console.error(chalk.red(`Invalid index: ${n}. Available range: 1-${manifest.records.length}`));
    console.log(chalk.dim("  Use 'soulhub rollback --list' to see all available records."));
    return;
  }

  const record = manifest.records[n - 1];
  console.log(
    chalk.dim(
      `\n  Rolling back #${n}: ${chalk.cyan(record.id)} (${record.packageName})`
    )
  );

  printRollbackDetails(record);
  if (!skipConfirm) {
    let confirmed: boolean;
    try {
      confirmed = await inquirerConfirm({
        message: `${chalk.yellow("⚠")} Proceed with rollback?`,
        default: true,
      });
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      console.log(chalk.dim("  Rollback cancelled."));
      return;
    }
  } else {
    console.log(chalk.dim("  Auto-confirmed with --yes flag."));
  }
  await executeRollback(record, clawDir);
}

/**
 * 按 ID 回滚（--id <id>）
 */
async function performRollback(recordId: string, clawDir?: string, skipConfirm: boolean = false): Promise<void> {
  const manifest = loadBackupManifest();

  if (manifest.records.length === 0) {
    console.log(chalk.yellow("No backup records found. Nothing to rollback."));
    return;
  }

  const record = manifest.records.find((r) => r.id === recordId);
  if (!record) {
    console.error(chalk.red(`Backup record "${recordId}" not found.`));
    console.log(chalk.dim("  Use 'soulhub rollback --list' to see available records."));
    return;
  }

  console.log(
    chalk.dim(
      `\n  Rolling back: ${chalk.cyan(record.id)} (${record.packageName})`
    )
  );

  printRollbackDetails(record);
  if (!skipConfirm) {
    const confirmed = await promptConfirmRollback();
    if (!confirmed) {
      console.log(chalk.dim("  Rollback cancelled."));
      return;
    }
  } else {
    console.log(chalk.dim("  Auto-confirmed with --yes flag."));
  }
  await executeRollback(record, clawDir);
}

/**
 * 打印回滚详情
 */
function printRollbackDetails(record: BackupRecord): void {
  console.log();
  console.log(chalk.dim("  Rollback details:"));
  console.log(chalk.dim(`    Package:    ${record.packageName}`));
  console.log(chalk.dim(`    Type:       ${formatInstallType(record.installType)}`));
  console.log(chalk.dim(`    Claw dir:   ${record.clawDir}`));
  console.log(chalk.dim(`    Date:       ${new Date(record.createdAt).toLocaleString()}`));

  if (record.items.length > 0) {
    console.log(chalk.dim(`    Backups to restore:`));
    for (const item of record.items) {
      const methodLabel = item.method === "mv" ? "move back" : "copy back";
      console.log(chalk.dim(`      - ${item.agentId} (${item.role}, ${methodLabel})`));
    }
  }

  if (record.installedWorkerIds.length > 0) {
    console.log(chalk.dim(`    Workers to remove: ${record.installedWorkerIds.join(", ")}`));
  }
  if (record.installedMainAgent) {
    console.log(chalk.dim(`    Main agent to revert: ${record.installedMainAgent}`));
  }
  console.log();
}

/**
 * 确认回滚操作
 */
async function promptConfirmRollback(): Promise<boolean> {
  try {
    return await inquirerConfirm({
      message: `${chalk.yellow("⚠")} Proceed with rollback?`,
      default: true,
    });
  } catch {
    // 用户按 Ctrl+C 取消
    return false;
  }
}

/**
 * 执行回滚操作（核心逻辑）
 */
async function executeRollback(record: BackupRecord, clawDir?: string): Promise<void> {
  const spinner = createSpinner(
    `Rolling back ${chalk.cyan(record.packageName)}...`
  ).start();

    // 使用记录中存储的 clawDir，如果用户指定了 --claw-type 则覆盖
  const resolvedClawDir = clawDir
    ? (findOpenClawDir(clawDir) || record.clawDir)
    : record.clawDir;

  if (!resolvedClawDir || !fs.existsSync(resolvedClawDir)) {
    spinner.fail(`OpenClaw/LightClaw directory not found: ${record.clawDir}`);
    return;
  }

  const brand = detectClawBrand(resolvedClawDir);

  // 1. 恢复 openclaw.json / lightclaw.json 快照
  if (record.openclawJsonSnapshot) {
    spinner.text = `Restoring ${brand.toLowerCase()}.json...`;
    try {
      const configObj = JSON.parse(record.openclawJsonSnapshot);
      writeOpenClawConfig(resolvedClawDir, configObj);
      logger.info(`${brand.toLowerCase()}.json restored from snapshot`, { recordId: record.id });
    } catch (err) {
      logger.error(`Failed to restore ${brand.toLowerCase()}.json`, { error: err });
      console.log(chalk.yellow(`  ⚠ Failed to restore ${brand.toLowerCase()}.json, skipping...`));
    }
  }

  // 2. 清理新安装的 worker 目录
  if (record.installedWorkerIds.length > 0) {
    spinner.text = "Removing installed workers...";
    for (const workerId of record.installedWorkerIds) {
      const workerDir = getWorkspaceDir(resolvedClawDir, workerId);
      if (fs.existsSync(workerDir)) {
        fs.rmSync(workerDir, { recursive: true, force: true });
        logger.info(`Removed installed worker directory`, { workerId, dir: workerDir });
      }
      // 同时清理 agents/ 下的目录
      const agentConfigDir = path.join(resolvedClawDir, "agents", workerId);
      if (fs.existsSync(agentConfigDir)) {
        fs.rmSync(agentConfigDir, { recursive: true, force: true });
      }
    }
  }

  // 3. 清理新安装的主 agent 文件（如果有备份的话，后续会恢复）
  if (record.installedMainAgent) {
    const mainWorkspace = getMainWorkspaceDir(resolvedClawDir);
    // 只有在有备份可恢复的情况下，才清理当前的主 workspace
    const hasMainBackup = record.items.some((item) => item.role === "main");
    if (hasMainBackup && fs.existsSync(mainWorkspace)) {
      spinner.text = "Cleaning current main workspace...";
      // 清空目录内容，但保留目录本身
      const entries = fs.readdirSync(mainWorkspace);
      for (const entry of entries) {
        fs.rmSync(path.join(mainWorkspace, entry), { recursive: true, force: true });
      }
    }
  }

  // 4. 恢复备份的目录
  let restoredCount = 0;
  for (const item of record.items) {
    if (!fs.existsSync(item.backupPath)) {
      logger.warn(`Backup path not found, skipping`, { backupPath: item.backupPath });
      console.log(chalk.yellow(`  ⚠ Backup not found: ${item.backupPath}, skipping...`));
      continue;
    }

    spinner.text = `Restoring ${chalk.cyan(item.agentId)} (${item.role})...`;

    if (item.method === "mv") {
      // mv 备份：将备份目录移回原位
      if (fs.existsSync(item.originalPath)) {
        fs.rmSync(item.originalPath, { recursive: true, force: true });
      }
      fs.mkdirSync(path.dirname(item.originalPath), { recursive: true });
      // 跨设备 mv 兼容：先尝试 rename，失败则 cp + rm
      try {
        fs.renameSync(item.backupPath, item.originalPath);
      } catch {
        fs.cpSync(item.backupPath, item.originalPath, { recursive: true });
        fs.rmSync(item.backupPath, { recursive: true, force: true });
      }
      logger.info(`Restored (mv back)`, { from: item.backupPath, to: item.originalPath });
    } else {
      // cp 备份：从备份目录复制回去
      if (fs.existsSync(item.originalPath)) {
        const entries = fs.readdirSync(item.originalPath);
        for (const entry of entries) {
          fs.rmSync(path.join(item.originalPath, entry), { recursive: true, force: true });
        }
      } else {
        fs.mkdirSync(item.originalPath, { recursive: true });
      }
      fs.cpSync(item.backupPath, item.originalPath, { recursive: true });
      // 删除备份副本
      fs.rmSync(item.backupPath, { recursive: true, force: true });
      logger.info(`Restored (cp back)`, { from: item.backupPath, to: item.originalPath });
    }

    restoredCount++;
  }

  // 5. 从 manifest 中移除已回滚的记录
  const manifest = loadBackupManifest();
  manifest.records = manifest.records.filter((r) => r.id !== record.id);
  saveBackupManifest(manifest);

  spinner.succeed(
    `Rolled back ${chalk.cyan.bold(record.packageName)} successfully! (${restoredCount} item(s) restored)`
  );

  // 6. 提示用户手动重启 OpenClaw/LightClaw Gateway
  const clawCmd = detectClawCommand(resolvedClawDir);
  const brandName = clawCmd === "lightclaw" ? "LightClaw" : "OpenClaw";
  console.log();
  console.log(chalk.yellow(`  ⚠ Please restart ${brandName} Gateway to apply changes:`));
  console.log(chalk.cyan(`    ${clawCmd} gateway restart`));

  console.log();
}

/**
 * 格式化安装类型显示
 */
function formatInstallType(type: BackupRecord["installType"]): string {
  switch (type) {
    case "single-agent":
      return chalk.blue("Single Agent");
    case "team-registry":
      return chalk.magenta("Team (Registry)");
    case "team-local":
      return chalk.magenta("Team (Local)");
    case "single-agent-local":
      return chalk.blue("Agent (Local)");
    default:
      return type;
  }
}

/**
 * 从 clawDir 路径推断品牌名称（用于显示，不依赖目录存在）
 */
function detectClawBrandFromDir(clawDir: string): string {
  const dirName = path.basename(clawDir).toLowerCase();
  if (dirName.includes("lightclaw")) {
    return "LightClaw";
  }
  return "OpenClaw";
}

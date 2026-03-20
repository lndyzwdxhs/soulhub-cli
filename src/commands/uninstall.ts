import { Command } from "commander";
import chalk from "chalk";
import { createSpinner } from "../spinner.js";
import fs from "node:fs";
import { loadConfig, removeInstallRecord, loadBackupManifest, saveBackupManifest, promptConfirm } from "../utils.js";
import { logger } from "../logger.js";

export const uninstallCommand = new Command("uninstall")
  .description("Uninstall an agent template")
  .alias("rm")
  .argument("<name>", "Agent name to uninstall")
  .option("--keep-files", "Remove from registry but keep workspace files")
  .option("-y, --yes", "Skip all confirmation prompts (auto-confirm)")
  .action(async (name: string, options) => {
    try {
      const config = loadConfig();
      const installed = config.installed.find((a) => a.name === name);

      if (!installed) {
        console.error(
          chalk.red(`\n  Agent "${name}" is not installed.\n`)
        );
        console.log(
          chalk.dim("  Use 'soulhub list' to see installed agents.")
        );
        process.exit(1);
      }

      const spinner = createSpinner(
        `Uninstalling ${chalk.cyan(name)}...`
      ).start();

      // 检查是否有相关备份，提前提醒用户
      const manifest = loadBackupManifest();
      const relatedRecords = manifest.records.filter((r) => r.packageName === name);
      if (relatedRecords.length > 0) {
        spinner.stop();
        console.log(
          chalk.yellow(`\n  ⚠  Found ${relatedRecords.length} backup record(s) for "${name}".`)
        );
        console.log(
          chalk.yellow(`     Uninstalling will also delete all related backup files.`)
        );
        console.log(
          chalk.yellow(`     After deletion, you will NOT be able to rollback this agent.\n`)
        );
        if (!options.yes) {
          const confirmed = await promptConfirm("Proceed with uninstall?");
          if (!confirmed) {
            console.log(chalk.dim("\n  Uninstall cancelled.\n"));
            return;
          }
        } else {
          console.log(chalk.dim("  Auto-confirmed with --yes flag."));
        }
        spinner.start(`Uninstalling ${chalk.cyan(name)}...`);
      }

      // Remove workspace files unless --keep-files
      if (!options.keepFiles && fs.existsSync(installed.workspace)) {
        fs.rmSync(installed.workspace, { recursive: true, force: true });
        spinner.text = `Removed workspace: ${installed.workspace}`;
      }

      // Remove from config
      removeInstallRecord(name);

      // 清理与该 agent 相关的备份记录和备份文件
      if (relatedRecords.length > 0) {
        for (const record of relatedRecords) {
          for (const item of record.items) {
            if (fs.existsSync(item.backupPath)) {
              fs.rmSync(item.backupPath, { recursive: true, force: true });
              logger.info(`Cleaned backup file for uninstalled agent`, { backupPath: item.backupPath });
            }
          }
        }
        manifest.records = manifest.records.filter((r) => r.packageName !== name);
        saveBackupManifest(manifest);
        spinner.text = `Cleaned ${relatedRecords.length} backup record(s)`;
        logger.info(`Cleaned ${relatedRecords.length} backup record(s) for ${name}`);
      }

      logger.info(`Agent uninstalled: ${name}`, { workspace: installed.workspace, keepFiles: !!options.keepFiles });
      spinner.succeed(
        `${chalk.cyan.bold(name)} uninstalled.`
      );
      if (options.keepFiles) {
        console.log(
          chalk.dim(`  Files kept at: ${installed.workspace}`)
        );
      }
      console.log();
    } catch (error) {
      logger.errorObj("Uninstall command failed", error);
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      console.error(chalk.dim(`  See logs: ${logger.getTodayLogFile()}`));
      process.exit(1);
    }
  });

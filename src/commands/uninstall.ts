import { Command } from "commander";
import chalk from "chalk";
import { createSpinner } from "../spinner.js";
import fs from "node:fs";
import { loadConfig, removeInstallRecord } from "../utils.js";
import { logger } from "../logger.js";

export const uninstallCommand = new Command("uninstall")
  .description("Uninstall an agent template")
  .alias("rm")
  .argument("<name>", "Agent name to uninstall")
  .option("--keep-files", "Remove from registry but keep workspace files")
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

      // Remove workspace files unless --keep-files
      if (!options.keepFiles && fs.existsSync(installed.workspace)) {
        fs.rmSync(installed.workspace, { recursive: true, force: true });
        spinner.text = `Removed workspace: ${installed.workspace}`;
      }

      // Remove from config
      removeInstallRecord(name);

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

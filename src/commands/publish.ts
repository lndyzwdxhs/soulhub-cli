import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export const publishCommand = new Command("publish")
  .description("Publish an agent template to the SoulHub community")
  .argument(
    "[directory]",
    "Agent workspace directory (defaults to current directory)"
  )
  .action(async (directory?: string) => {
    try {
      const dir = directory ? path.resolve(directory) : process.cwd();

      const spinner = ora("Validating agent template...").start();

      // Check required files
      const requiredFiles = ["manifest.yaml", "IDENTITY.md", "SOUL.md"];
      const missing = requiredFiles.filter(
        (f) => !fs.existsSync(path.join(dir, f))
      );

      if (missing.length > 0) {
        spinner.fail("Missing required files:");
        for (const f of missing) {
          console.log(chalk.red(`  - ${f}`));
        }
        console.log();
        console.log(chalk.dim("  Required files: manifest.yaml, IDENTITY.md, SOUL.md"));
        console.log(
          chalk.dim(
            "  See: https://soulhub.dev/docs/contributing"
          )
        );
        return;
      }

      // Validate manifest
      const manifestContent = fs.readFileSync(
        path.join(dir, "manifest.yaml"),
        "utf-8"
      );
      const manifest = yaml.load(manifestContent) as Record<string, unknown>;

      const requiredFields = [
        "name",
        "displayName",
        "description",
        "category",
        "version",
        "author",
      ];
      const missingFields = requiredFields.filter(
        (f) => !manifest[f]
      );

      if (missingFields.length > 0) {
        spinner.fail("Missing required fields in manifest.yaml:");
        for (const f of missingFields) {
          console.log(chalk.red(`  - ${f}`));
        }
        return;
      }

      // Validate category
      const validCategories = [
        "self-media",
        "development",
        "operations",
        "support",
        "education",
        "dispatcher",
      ];
      if (!validCategories.includes(manifest.category as string)) {
        spinner.fail(
          `Invalid category: ${manifest.category}. Must be one of: ${validCategories.join(", ")}`
        );
        return;
      }

      spinner.succeed("Template validation passed!");
      console.log();
      console.log(chalk.bold(`  ${manifest.displayName}`));
      console.log(
        chalk.dim(`  ${manifest.name} v${manifest.version}`)
      );
      console.log(`  ${manifest.description}`);
      console.log();

      // Show next steps
      console.log(chalk.bold("  Next steps to publish:"));
      console.log();
      console.log(
        `  1. Fork ${chalk.cyan("github.com/soulhub-community/soulhub")}`
      );
      console.log(
        `  2. Copy your agent directory to ${chalk.cyan(`registry/agents/${manifest.name}/`)}`
      );
      console.log(
        `  3. Submit a Pull Request`
      );
      console.log();
      console.log(
        chalk.dim(
          "  Your template will be reviewed and added to the community registry."
        )
      );
      console.log();
    } catch (error) {
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      process.exit(1);
    }
  });

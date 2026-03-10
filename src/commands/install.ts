import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  fetchIndex,
  fetchAgentFile,
  fetchRecipeFile,
  findOpenClawDir,
  getWorkspaceDir,
  recordInstall,
} from "../utils.js";
import type { ComposeConfig } from "../types.js";

export const installCommand = new Command("install")
  .description("Install an agent template from the SoulHub registry")
  .argument("[name]", "Agent name to install")
  .option("--from <url>", "Install from a Share Link or local file")
  .option("--recipe", "Install a team recipe instead of a single agent")
  .option(
    "--dir <path>",
    "Target directory (defaults to OpenClaw workspace)"
  )
  .action(async (name: string | undefined, options) => {
    try {
      // Route to appropriate install method
      if (options.from) {
        await installFromSource(options.from, options.dir);
      } else if (options.recipe) {
        if (!name) {
          console.error(chalk.red("Please specify a recipe name."));
          console.log(
            chalk.dim("  Use 'soulhub search --category recipe' to find recipes.")
          );
          process.exit(1);
        }
        await installRecipe(name, options.dir);
      } else {
        if (!name) {
          console.error(chalk.red("Please specify an agent name."));
          console.log(
            chalk.dim("  Use 'soulhub search' to find available agents.")
          );
          process.exit(1);
        }
        await installAgent(name, options.dir);
      }
    } catch (error) {
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      process.exit(1);
    }
  });

/**
 * Install a single agent from the registry
 */
async function installAgent(name: string, targetDir?: string): Promise<void> {
  const spinner = ora(`Fetching agent ${chalk.cyan(name)}...`).start();

  // Verify agent exists
  const index = await fetchIndex();
  const agent = index.agents.find((a) => a.name === name);
  if (!agent) {
    spinner.fail(`Agent "${name}" not found in registry.`);
    console.log(
      chalk.dim(`  Use 'soulhub search' to find available agents.`)
    );
    return;
  }

  // Determine target directory
  let workspaceDir: string;
  if (targetDir) {
    workspaceDir = path.resolve(targetDir);
  } else {
    const clawDir = findOpenClawDir();
    if (!clawDir) {
      spinner.fail("OpenClaw installation not found.");
      console.log(
        chalk.dim(
          "  Use --dir to specify a custom directory, or install OpenClaw first."
        )
      );
      return;
    }
    workspaceDir = getWorkspaceDir(clawDir, name);
  }

  spinner.text = `Installing ${chalk.cyan(agent.displayName)} to ${workspaceDir}...`;

  // Create workspace directory
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Download and write files
  const filesToDownload = ["IDENTITY.md", "SOUL.md"];
  for (const fileName of filesToDownload) {
    try {
      const content = await fetchAgentFile(name, fileName);
      fs.writeFileSync(path.join(workspaceDir, fileName), content);
    } catch {
      // Optional files may not exist
      spinner.text = `Skipping optional file: ${fileName}`;
    }
  }

  // Also try to download optional template files
  const optionalFiles = ["USER.md.template", "TOOLS.md.template"];
  for (const fileName of optionalFiles) {
    try {
      const content = await fetchAgentFile(name, fileName);
      // Remove .template suffix for the actual file
      const actualName = fileName.replace(".template", "");
      fs.writeFileSync(path.join(workspaceDir, actualName), content);
    } catch {
      // Optional files - skip silently
    }
  }

  // Save manifest
  try {
    const manifestContent = await fetchAgentFile(name, "manifest.yaml");
    fs.writeFileSync(
      path.join(workspaceDir, "manifest.yaml"),
      manifestContent
    );
  } catch {
    // Write basic manifest from index data
    const manifest = {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      category: agent.category,
      tags: agent.tags,
      version: agent.version,
      author: agent.author,
    };
    fs.writeFileSync(
      path.join(workspaceDir, "manifest.yaml"),
      yaml.dump(manifest)
    );
  }

  // Record installation
  recordInstall(name, agent.version, workspaceDir);

  spinner.succeed(
    `${chalk.cyan.bold(agent.displayName)} installed successfully!`
  );
  console.log();
  console.log(`  ${chalk.dim("Location:")} ${workspaceDir}`);
  console.log(`  ${chalk.dim("Version:")}  ${agent.version}`);
  console.log();

  // Check if OpenClaw config needs updating
  const clawDir = findOpenClawDir();
  if (clawDir) {
    const configPath = path.join(clawDir, "openclaw-agents.json");
    if (fs.existsSync(configPath)) {
      console.log(
        chalk.yellow(
          "  Note: You may need to restart OpenClaw Gateway for changes to take effect."
        )
      );
    }
  }
}

/**
 * Install from a Share Link or local file
 */
async function installFromSource(
  source: string,
  targetDir?: string
): Promise<void> {
  const spinner = ora("Loading configuration...").start();

  let config: ComposeConfig;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    // Fetch from Share Link
    let url = source;
    // Handle soulhub.dev/c/<id> format
    if (url.includes("/c/")) {
      const id = url.split("/c/").pop();
      url = `${url.split("/c/")[0]}/api/compose/${id}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      spinner.fail(`Failed to fetch configuration: ${response.statusText}`);
      return;
    }
    config = (await response.json()) as ComposeConfig;
  } else {
    // Load from local file
    const filePath = path.resolve(source);
    if (!fs.existsSync(filePath)) {
      spinner.fail(`File not found: ${filePath}`);
      return;
    }

    if (filePath.endsWith(".zip")) {
      // Handle ZIP file
      spinner.text = "Extracting ZIP file...";
      const JSZip = (await import("jszip")).default;
      const zipData = fs.readFileSync(filePath);
      const zip = await JSZip.loadAsync(zipData);

      // Look for compose config in ZIP
      const configFile = zip.file("compose.json");
      if (!configFile) {
        spinner.fail("Invalid ZIP: missing compose.json");
        return;
      }
      config = JSON.parse(await configFile.async("string"));
    } else {
      // JSON file
      config = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  }

  spinner.text = `Installing ${config.agents.length} agent(s)...`;

  // Install each agent from the configuration
  const clawDir = targetDir
    ? path.resolve(targetDir)
    : findOpenClawDir();

  if (!clawDir) {
    spinner.fail("OpenClaw installation not found. Use --dir to specify a directory.");
    return;
  }

  for (const agentConfig of config.agents) {
    const agentDir = path.join(
      clawDir,
      `workspace-${agentConfig.name}`
    );
    fs.mkdirSync(agentDir, { recursive: true });

    if (agentConfig.identity) {
      fs.writeFileSync(
        path.join(agentDir, "IDENTITY.md"),
        agentConfig.identity
      );
    } else if (agentConfig.role === "worker") {
      // Try to fetch from registry
      try {
        const content = await fetchAgentFile(
          agentConfig.name,
          "IDENTITY.md"
        );
        fs.writeFileSync(path.join(agentDir, "IDENTITY.md"), content);
      } catch {
        // Skip
      }
    }

    if (agentConfig.soul) {
      fs.writeFileSync(
        path.join(agentDir, "SOUL.md"),
        agentConfig.soul
      );
    } else if (agentConfig.role === "worker") {
      try {
        const content = await fetchAgentFile(
          agentConfig.name,
          "SOUL.md"
        );
        fs.writeFileSync(path.join(agentDir, "SOUL.md"), content);
      } catch {
        // Skip
      }
    }

    recordInstall(agentConfig.name, "share-link", agentDir);
  }

  spinner.succeed(
    `${chalk.cyan.bold(config.agents.length)} agent(s) installed from share link!`
  );
  console.log();
  for (const agentConfig of config.agents) {
    const role =
      agentConfig.role === "dispatcher"
        ? chalk.blue("[Dispatcher]")
        : chalk.dim("[Worker]");
    console.log(`  ${role} ${chalk.cyan(agentConfig.name)}`);
  }
  console.log();
}

/**
 * Install a team recipe
 */
async function installRecipe(
  name: string,
  targetDir?: string
): Promise<void> {
  const spinner = ora(
    `Fetching recipe ${chalk.cyan(name)}...`
  ).start();

  const index = await fetchIndex();
  const recipe = index.recipes.find((r) => r.name === name);

  if (!recipe) {
    spinner.fail(`Recipe "${name}" not found.`);
    console.log(
      chalk.dim("  Available recipes:")
    );
    for (const r of index.recipes) {
      console.log(
        chalk.dim(`    - ${r.name}: ${r.displayName}`)
      );
    }
    return;
  }

  spinner.text = `Installing recipe ${chalk.cyan(recipe.displayName)} (${recipe.agents.length} agents)...`;

  // Install each agent in the recipe
  for (const agentName of recipe.agents) {
    spinner.text = `Installing ${chalk.cyan(agentName)}...`;

    const agent = index.agents.find((a) => a.name === agentName);
    if (!agent) {
      spinner.warn(`Agent ${agentName} not found, skipping.`);
      continue;
    }

    const clawDir = targetDir
      ? path.resolve(targetDir)
      : findOpenClawDir();
    if (!clawDir) {
      spinner.fail("OpenClaw installation not found.");
      return;
    }

    const workspaceDir = getWorkspaceDir(clawDir, agentName);
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Download files
    for (const fileName of ["IDENTITY.md", "SOUL.md", "manifest.yaml"]) {
      try {
        const content = await fetchAgentFile(agentName, fileName);
        fs.writeFileSync(path.join(workspaceDir, fileName), content);
      } catch {
        // Skip optional files
      }
    }

    recordInstall(agentName, agent.version, workspaceDir);
  }

  // Also try to install the recipe's topology
  try {
    const topology = await fetchRecipeFile(name, "topology.yaml");
    const clawDir = targetDir
      ? path.resolve(targetDir)
      : findOpenClawDir();
    if (clawDir) {
      fs.writeFileSync(
        path.join(clawDir, `recipe-${name}-topology.yaml`),
        topology
      );
    }
  } catch {
    // Optional
  }

  spinner.succeed(
    `Recipe ${chalk.cyan.bold(recipe.displayName)} installed! (${recipe.agents.length} agents)`
  );
  console.log();
  for (const agentName of recipe.agents) {
    console.log(`  ${chalk.dim("✓")} ${chalk.cyan(agentName)}`);
  }
  console.log();
}

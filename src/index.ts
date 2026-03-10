#!/usr/bin/env node

import { Command } from "commander";
import { searchCommand } from "./commands/search.js";
import { infoCommand } from "./commands/info.js";
import { installCommand } from "./commands/install.js";
import { listCommand } from "./commands/list.js";
import { updateCommand } from "./commands/update.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { publishCommand } from "./commands/publish.js";

const program = new Command();

program
  .name("soulhub")
  .description("SoulHub CLI - Install and manage AI agent persona templates")
  .version("0.1.0");

program.addCommand(searchCommand);
program.addCommand(infoCommand);
program.addCommand(installCommand);
program.addCommand(listCommand);
program.addCommand(updateCommand);
program.addCommand(uninstallCommand);
program.addCommand(publishCommand);

program.parse();

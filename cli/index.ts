#!/usr/bin/env node
import { Command } from "commander";
import { createRunCommand } from "./run.js";
import { createPipelineCommand } from "./pipeline.js";
import { createSoloCommand } from "./solo.js";
import { createScanCommand } from "./scan.js";
import { createSecurityCommand } from "./security.js";
import { createInitCommand } from "./init.js";
import { createListCommand } from "./list.js";
import { createSelfUpdateCommand } from "./self-update.js";
import { getVersion } from "./version.js";

const program = new Command();
program
  .name("essaim")
  .description("Spawn N coordinated Claude Code agents — orchestrator + behavior catalog")
  .version(getVersion());

program.addCommand(createRunCommand());
program.addCommand(createPipelineCommand());
program.addCommand(createSoloCommand());
program.addCommand(createScanCommand());
program.addCommand(createSecurityCommand());
program.addCommand(createInitCommand());
program.addCommand(createListCommand());
program.addCommand(createSelfUpdateCommand());

program.parse();

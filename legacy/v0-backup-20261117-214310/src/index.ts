#!/usr/bin/env node
import { Command } from "commander";
import { scanRepository } from "./scanner.js";
import { cleanRepository } from "./cleaner.js";
import { printReport } from "./report.js";

const program = new Command();

program
  .name("repo-cleaner")
  .description("Detecta y limpia artefactos de build de forma segura")
  .version("0.1.0");

program
  .command("scan")
  .description("Analiza un repositorio sin eliminar archivos")
  .argument("<target>", "Ruta del repositorio")
  .option("--verbose", "Muestra todos los elementos detectados", false)
  .action(async (target: string, options: { verbose: boolean }) => {
    const report = await scanRepository(target);
    printReport(report, options.verbose);
  });

program
  .command("clean")
  .description("Elimina artefactos seguros tras confirmación")
  .argument("<target>", "Ruta del repositorio")
  .option("--yes", "Confirma la eliminación sin preguntar", false)
  .option("--dry-run", "Solo muestra qué se eliminaría", true)
  .action(
    async (target: string, options: { yes: boolean; dryRun: boolean }) => {
      await cleanRepository(target, {
        yes: options.yes,
        dryRun: !options.yes
      });
    }
  );

program.parseAsync();

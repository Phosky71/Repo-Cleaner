#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadRules, DEFAULT_CONFIG_PATH } from "../rules/loader.js";
import { startServer } from "../ui/server.js";
import { scanRoot } from "../core/scanner.js";
import { inspectRepository } from "../core/inspect.js";
import { cleanRepository } from "../core/cleaner.js";
import { restoreRepository } from "../core/restore.js";
import { trashRepository } from "../core/trash-admin.js";
import { DEFAULT_AUDIT_PATH } from "../core/audit.js";
import {
  formatProjectLine,
  printArtifactDetails,
  printProjectAnalysis,
  printRootSummary,
  saveRootScanReport
} from "../core/report.js";
import { formatBytes, formatTypes } from "../core/format.js";
import type { ProjectType } from "../types/index.js";

const program = new Command();

program
  .name("repo-cleaner")
  .description("Limpia repositorios de desarrollo de forma segura")
  .version("0.4.0");

function splitSelectors(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return values.flatMap((value) => value.split(",")).filter(Boolean);
}

program
  .command("scan")
  .description(
    "Escanea una ruta raíz, detecta proyectos y artefactos (solo lectura)"
  )
  .argument("<target>", "Ruta raíz a escanear (p. ej. C:\\Trabajo)")
  .option("--config <path>", "Ruta del archivo de reglas", DEFAULT_CONFIG_PATH)
  .option("--reports-dir <path>", "Directorio de informes", "reports")
  .option("--verbose", "Muestra todos los elementos detectados", false)
  .action(
    async (
      target: string,
      options: { config: string; reportsDir: string; verbose: boolean }
    ) => {
      try {
        const { rules, source } = await loadRules(options.config);
        console.log(`Escaneando ${path.resolve(target)}`);
        console.log(`Reglas: ${source}`);
        console.log("");
        console.log(
          `  ${"PROYECTO".padEnd(36)}${"TIPO".padEnd(22)}${"TAMAÑO".padStart(10)}${"MODIFICADO".padStart(12)}  ARTEFACTOS`
        );
        const report = await scanRoot(target, rules, {
          rulesSource: source,
          onProject: (project) => console.log(formatProjectLine(project))
        });
        if (report.projects.length === 0) {
          console.log("  (no se detectaron proyectos)");
        }
        printRootSummary(report);
        if (options.verbose) printArtifactDetails(report);
        const paths = await saveRootScanReport(report, options.reportsDir);
        console.log("");
        console.log(`Informe JSON:     ${paths.json}`);
        console.log(`Informe Markdown: ${paths.markdown}`);
        console.log(
          "Escaneo de solo lectura: no se ha modificado ningún archivo."
        );
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
      }
    }
  );

program
  .command("inspect")
  .description(
    "Analiza un proyecto en profundidad (solo lectura) y genera informe"
  )
  .argument("<target>", "Ruta del proyecto")
  .option("--config <path>", "Ruta del archivo de reglas", DEFAULT_CONFIG_PATH)
  .option("--reports-dir <path>", "Directorio de informes", "reports")
  .option("--verbose", "Muestra también los elementos protegidos", false)
  .action(
    async (
      target: string,
      options: { config: string; reportsDir: string; verbose: boolean }
    ) => {
      try {
        const { rules, source } = await loadRules(options.config);
        console.log(`Inspeccionando ${path.resolve(target)}`);
        console.log(`Reglas: ${source}`);
        console.log("");
        const { report, paths } = await inspectRepository(target, rules, {
          reportsDir: options.reportsDir
        });
        printProjectAnalysis(report, options.verbose);
        console.log("");
        console.log(`Informe JSON:     ${paths.json}`);
        console.log(`Informe Markdown: ${paths.markdown}`);
        console.log(
          "Inspección de solo lectura: no se ha modificado ningún archivo."
        );
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
      }
    }
  );

program
  .command("clean")
  .description(
    "Analiza, propone un plan y limpia SOLO tras confirmación humana (papelera por defecto)"
  )
  .argument("<target>", "Ruta del proyecto")
  .option("--config <path>", "Ruta del archivo de reglas", DEFAULT_CONFIG_PATH)
  .option("--dry-run", "Solo muestra el plan; no elimina ni mueve nada", false)
  .option(
    "--yes",
    "Confirma automáticamente (automatización consciente)",
    false
  )
  .option(
    "--permanent",
    "Eliminación permanente en vez de papelera (requiere elección explícita)",
    false
  )
  .option("--include-review", "Incluye los elementos review en el plan", false)
  .option("--only <paths...>", "Selecciona solo estas rutas relativas")
  .option("--exclude <paths...>", "Excluye estas rutas relativas del plan")
  .option("--trash-dir <path>", "Directorio de papelera alternativo")
  .option("--audit-path <path>", "Log de auditoría JSONL", DEFAULT_AUDIT_PATH)
  .option("--reports-dir <path>", "Directorio de informes", "reports")
  .action(
    async (
      target: string,
      options: {
        config: string;
        dryRun: boolean;
        yes: boolean;
        permanent: boolean;
        includeReview: boolean;
        only?: string[];
        exclude?: string[];
        trashDir?: string;
        auditPath: string;
        reportsDir: string;
      }
    ) => {
      try {
        const { rules, source } = await loadRules(options.config);
        console.log(`Analizando ${path.resolve(target)}`);
        console.log(`Reglas: ${source}`);
        console.log("");
        await cleanRepository(target, rules, {
          dryRun: options.dryRun,
          yes: options.yes,
          permanent: options.permanent,
          includeReview: options.includeReview,
          only: splitSelectors(options.only),
          exclude: splitSelectors(options.exclude),
          trashDir: options.trashDir,
          auditPath: options.auditPath,
          reportsDir: options.reportsDir
        });
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
      }
    }
  );

program
  .command("restore")
  .description(
    "Restaura elementos de la papelera local a sus rutas originales (con confirmación)"
  )
  .argument("<target>", "Ruta del proyecto")
  .option("--session <id>", "Sesión de papelera (timestamp)")
  .option("--only <paths...>", "Restaura solo estas rutas relativas")
  .option("--all", "Restaura todos los elementos pendientes", false)
  .option(
    "--on-conflict <mode>",
    "Si el destino existe: cancel | suffix | overwrite",
    "cancel"
  )
  .option("--dry-run", "Solo muestra el plan; no restaura nada", false)
  .option(
    "--yes",
    "Confirma automáticamente (automatización consciente)",
    false
  )
  .option("--config <path>", "Ruta del archivo de reglas", DEFAULT_CONFIG_PATH)
  .option("--audit-path <path>", "Log de auditoría JSONL", DEFAULT_AUDIT_PATH)
  .option("--reports-dir <path>", "Directorio de informes", "reports")
  .action(
    async (
      target: string,
      options: {
        session?: string;
        only?: string[];
        all: boolean;
        onConflict: string;
        dryRun: boolean;
        yes: boolean;
        config: string;
        auditPath: string;
        reportsDir: string;
      }
    ) => {
      try {
        if (!["cancel", "suffix", "overwrite"].includes(options.onConflict)) {
          throw new Error(
            `--on-conflict inválido: ${options.onConflict} (cancel | suffix | overwrite)`
          );
        }
        const { rules, source } = await loadRules(options.config);
        console.log(`Restaurando en ${path.resolve(target)}`);
        console.log(`Reglas: ${source}`);
        await restoreRepository(target, rules, {
          session: options.session,
          only: splitSelectors(options.only),
          all: options.all,
          onConflict: options.onConflict as "cancel" | "suffix" | "overwrite",
          dryRun: options.dryRun,
          yes: options.yes,
          auditPath: options.auditPath,
          reportsDir: options.reportsDir
        });
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
      }
    }
  );

program
  .command("trash")
  .description(
    "Gestiona la papelera local: listar, inspeccionar y purgar sesiones completadas"
  )
  .argument("<target>", "Ruta del proyecto")
  .option("--session <id>", "Sesión de papelera (timestamp)")
  .option("--remove", "Elimina la sesión seleccionada (si es elegible)", false)
  .option(
    "--remove-completed",
    "Elimina todas las sesiones sin elementos pendientes de restaurar",
    false
  )
  .option("--dry-run", "Muestra qué se eliminaría sin tocar nada", false)
  .option(
    "--yes",
    "Confirma automáticamente (automatización consciente)",
    false
  )
  .option("--config <path>", "Ruta del archivo de reglas", DEFAULT_CONFIG_PATH)
  .option("--audit-path <path>", "Log de auditoría JSONL", DEFAULT_AUDIT_PATH)
  .option("--reports-dir <path>", "Directorio de informes", "reports")
  .action(
    async (
      target: string,
      options: {
        session?: string;
        remove: boolean;
        removeCompleted: boolean;
        dryRun: boolean;
        yes: boolean;
        config: string;
        auditPath: string;
        reportsDir: string;
      }
    ) => {
      try {
        const { source } = await loadRules(options.config);
        console.log(`Papelera de ${path.resolve(target)}`);
        console.log(`Reglas: ${source}`);
        await trashRepository(target, {
          session: options.session,
          remove: options.remove,
          removeCompleted: options.removeCompleted,
          dryRun: options.dryRun,
          yes: options.yes,
          auditPath: options.auditPath,
          reportsDir: options.reportsDir
        });
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
      }
    }
  );

program
  .command("ui")
  .description("Abre la interfaz web local minimalista (solo 127.0.0.1)")
  .argument("<target>", "Ruta raíz autorizada")
  .option("--port <port>", "Puerto del servidor", "4321")
  .option("--config <path>", "Ruta del archivo de reglas", DEFAULT_CONFIG_PATH)
  .action(async (target: string, options: { port: string; config: string }) => {
    try {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Puerto inválido: ${options.port}`);
      }
      const allowedRoot = path.resolve(target);
      const stat = await fs.stat(allowedRoot).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new Error(
          `La ruta raíz no existe o no es un directorio: ${allowedRoot}`
        );
      }
      const { rules, source } = await loadRules(options.config);
      const server = startServer(
        { allowedRoot, rules, rulesSource: source },
        port
      );
      server.on("error", (error: Error) => {
        console.error(`Error del servidor: ${error.message}`);
        process.exitCode = 1;
      });
      console.log(`Repo Cleaner UI disponible en http://127.0.0.1:${port}`);
      console.log(`Raíz autorizada: ${allowedRoot}`);
      console.log("Pulsa Ctrl+C para detener el servidor.");
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    }
  });

program
  .command("rules")
  .description("Muestra las reglas de limpieza cargadas")
  .option("--config <path>", "Ruta del archivo de reglas", DEFAULT_CONFIG_PATH)
  .action(async (options: { config: string }) => {
    try {
      const { rules, source } = await loadRules(options.config);
      console.log(`Fuente: ${source}`);
      console.log(`Versión: ${rules.version}`);
      console.log("Valores por defecto:");
      console.log(`  mode: ${rules.defaults.mode}`);
      console.log(`  useTrash: ${rules.defaults.useTrash}`);
      console.log(`  maxDepth: ${rules.defaults.maxDepth}`);
      console.log(
        `  largeThresholdMB: ${rules.defaults.largeThresholdMB} (${formatBytes(rules.defaults.largeThresholdMB * 1024 * 1024)})`
      );
      const sections: Array<[string, string[]]> = [
        ["safe (regenerables)", rules.safe],
        ["review (revisión humana)", rules.review],
        ["protected (nunca eliminar)", rules.protected]
      ];
      for (const [label, patterns] of sections) {
        console.log(`\n${label} — ${patterns.length} patrones:`);
        for (const pattern of patterns) console.log(`  ${pattern}`);
      }
      const projectRules = rules.projectRules ?? {};
      for (const [type, local] of Object.entries(projectRules)) {
        console.log(
          `\nReglas condicionadas a proyecto ${formatTypes([type as ProjectType])}:`
        );
        for (const [section, patterns] of Object.entries(local ?? {})) {
          console.log(`  ${section}: ${(patterns ?? []).join(", ") || "—"}`);
        }
      }
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    }
  });

await program.parseAsync();

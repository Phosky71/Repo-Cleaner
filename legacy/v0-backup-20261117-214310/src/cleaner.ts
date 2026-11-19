import { promises as fs } from "node:fs";
import path from "node:path";
import { scanRepository } from "./scanner.js";
import { printReport } from "./report.js";
import { createInterface } from "node:readline/promises";

export interface CleanOptions {
  yes: boolean;
  dryRun: boolean;
}

export async function cleanRepository(
  target: string,
  options: CleanOptions
): Promise<void> {
  const report = await scanRepository(target);
  const candidates = report.entries.filter((entry) => entry.risk === "safe");

  printReport(report, true);

  if (candidates.length === 0) {
    console.log("\nNo se han encontrado artefactos seguros para eliminar.");
    return;
  }

  if (options.dryRun) {
    console.log("\nModo dry-run activo: no se ha eliminado nada.");
    return;
  }

  if (!options.yes) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await rl.question(
      `\n¿Eliminar ${candidates.length} elementos seguros? (yes/no): `
    );

    rl.close();

    if (answer.trim().toLowerCase() !== "yes") {
      console.log("Operación cancelada.");
      return;
    }
  }

  let removed = 0;

  for (const entry of candidates) {
    try {
      await fs.rm(entry.absolutePath, {
        recursive: true,
        force: true
      });

      removed += 1;
      console.log(
        `Eliminado: ${path.relative(report.target, entry.absolutePath)}`
      );
    } catch (error) {
      console.error(
        `No se pudo eliminar ${entry.relativePath}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  console.log(
    `\nLimpieza completada. Elementos eliminados: ${removed}/${candidates.length}.`
  );
}

import type { ScanReport } from "./scanner.js";
import { formatBytes } from "./utils.js";

export function printReport(report: ScanReport, verbose: boolean): void {
  console.log(`\nRepositorio analizado: ${report.target}`);
  console.log(`Fecha: ${report.generatedAt}`);
  console.log(`Candidatos seguros: ${formatBytes(report.totalSafeBytes)}`);
  console.log(`Elementos a revisar: ${formatBytes(report.totalReviewBytes)}`);

  const entries = verbose
    ? report.entries
    : report.entries.filter((entry) => entry.risk !== "review");

  if (entries.length === 0) {
    console.log("\nNo hay elementos que mostrar.");
    return;
  }

  console.log("\nArtefactos detectados:\n");

  for (const entry of entries) {
    const icon = entry.risk === "safe" ? "[SEGURO]" : "[REVISAR]";

    console.log(
      `${icon} ${entry.relativePath} — ${entry.sizeLabel} — ${entry.reason}`
    );
  }
}

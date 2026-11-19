import type {
  CleanerRuleSet,
  ReportPaths,
  ScanReport
} from "../types/index.js";
import { scanProject } from "./scanner.js";
import { saveScanReport } from "./report.js";

export interface InspectOutcome {
  report: ScanReport;
  paths: ReportPaths;
}

/**
 * Análisis profundo de un proyecto: detección de tipo, artefactos,
 * clasificación, tamaños y motivos. 100% de solo lectura.
 * Genera informe JSON + Markdown en `reports/`.
 */
export async function inspectRepository(
  target: string,
  rules: CleanerRuleSet,
  options: { reportsDir?: string } = {}
): Promise<InspectOutcome> {
  const report = await scanProject(target, rules);
  const paths = await saveScanReport(report, options.reportsDir);
  return { report, paths };
}

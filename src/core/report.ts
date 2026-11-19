import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CleanPlan,
  CleanResult,
  ProjectInfo,
  ReportPaths,
  RestorePlan,
  RestoreResult,
  RootScanReport,
  ScanEntry,
  ScanReport,
  TrashPurgeReport,
  TrashSession,
  TrashSessionInfo
} from "../types/index.js";
import { formatBytes, formatDate, formatTypes } from "./format.js";
import { resolveReportsDir } from "./output-paths.js";

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function artifactLine(project: ProjectInfo): string {
  const { safeCount, reviewCount } = project.artifacts;
  if (safeCount + reviewCount === 0) return "—";
  const parts: string[] = [];
  if (safeCount > 0) parts.push(`${safeCount} safe`);
  if (reviewCount > 0) parts.push(`${reviewCount} review`);
  return parts.join(" · ");
}

/** Línea de terminal para un proyecto (usada también como progreso). */
export function formatProjectLine(project: ProjectInfo): string {
  const name =
    project.relativePath.length > 34
      ? `…${project.relativePath.slice(-33)}`
      : project.relativePath;
  return [
    `  ${name.padEnd(36)}`,
    formatTypes(project.types).padEnd(22),
    formatBytes(project.sizeBytes).padStart(10),
    formatDate(project.lastModified).padStart(12),
    `  ${artifactLine(project)}`
  ].join("");
}

export function printRootSummary(report: RootScanReport): void {
  const s = report.summary;
  console.log("");
  console.log(
    `Proyectos detectados: ${s.projectCount} (${s.projectsWithArtifacts} con artefactos)`
  );
  console.log(`Tamaño total aproximado: ${formatBytes(s.totalSizeBytes)}`);
  console.log(
    `Limpiable (safe): ${formatBytes(s.safeBytes)} · Revisar (review): ${formatBytes(s.reviewBytes)} · Artefactos: ${s.artifactCount}`
  );
  if (report.warnings.length > 0) {
    console.log(`Avisos: ${report.warnings.length} (ver informe)`);
  }
}

export function printArtifactDetails(report: RootScanReport): void {
  for (const project of report.projects) {
    if (project.entries.length === 0) continue;
    console.log("");
    console.log(`${project.name} — ${project.path}`);
    for (const entry of project.entries) {
      const tag =
        entry.risk === "safe"
          ? "[SEGURO]  "
          : entry.risk === "review"
            ? "[REVISAR] "
            : "[PROTEGIDO]";
      console.log(
        `  ${tag} ${entry.relativePath} — ${formatBytes(entry.sizeBytes)} — ${entry.reason}`
      );
    }
  }
}

export function printRootScanReport(
  report: RootScanReport,
  verbose: boolean
): void {
  console.log(`Raíz analizada: ${report.root}`);
  console.log(`Fecha: ${report.generatedAt} · ID: ${report.id}`);
  console.log(`Reglas: ${report.rulesSource}`);
  console.log("");
  for (const project of report.projects) {
    console.log(formatProjectLine(project));
  }
  printRootSummary(report);
  if (verbose) printArtifactDetails(report);
}

function entriesTable(entries: ScanEntry[]): string {
  if (entries.length === 0) return "_Sin artefactos detectados._\n";
  const rows = entries.map(
    (e) =>
      `| \`${mdEscape(e.relativePath)}\` | ${e.type === "directory" ? "carpeta" : "archivo"} | ${e.risk} | ${formatBytes(e.sizeBytes)} | ${e.matchedRule ? `\`${mdEscape(e.matchedRule)}\`` : "—"} | ${mdEscape(e.reason)} |`
  );
  return [
    "| Ruta | Tipo | Riesgo | Tamaño | Regla | Motivo |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    ""
  ].join("\n");
}

function rootScanMarkdown(report: RootScanReport): string {
  const s = report.summary;
  const lines: string[] = [
    "# Informe de escaneo de raíz",
    "",
    `- **Raíz:** \`${report.root}\``,
    `- **Fecha:** ${report.generatedAt}`,
    `- **ID:** ${report.id}`,
    `- **Reglas:** ${report.rulesSource}`,
    `- **Proyectos:** ${s.projectCount} (${s.projectsWithArtifacts} con artefactos)`,
    `- **Tamaño total aproximado:** ${formatBytes(s.totalSizeBytes)}`,
    `- **Limpiable (safe):** ${formatBytes(s.safeBytes)}`,
    `- **Revisar (review):** ${formatBytes(s.reviewBytes)}`,
    "",
    "> Escaneo de solo lectura: no se ha modificado ni eliminado ningún archivo.",
    "",
    "## Proyectos",
    "",
    "| Proyecto | Ruta | Tipo | Tamaño | Última modificación | Artefactos |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const p of report.projects) {
    lines.push(
      `| ${mdEscape(p.name)} | \`${mdEscape(p.relativePath)}\` | ${formatTypes(p.types)} | ${formatBytes(p.sizeBytes)} | ${formatDate(p.lastModified)} | ${artifactLine(p)} |`
    );
  }
  lines.push("", "## Artefactos por proyecto", "");
  for (const p of report.projects) {
    lines.push(`### ${p.name} — \`${p.path}\``, "", entriesTable(p.entries));
  }
  if (report.warnings.length > 0) {
    lines.push("## Avisos", "");
    for (const w of report.warnings) lines.push(`- ${mdEscape(w)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function projectScanMarkdown(report: ScanReport): string {
  const s = report.summary;
  return [
    "# Informe de escaneo de proyecto",
    "",
    `- **Proyecto:** \`${report.target}\``,
    `- **Tipos detectados:** ${formatTypes(report.projectTypes)}`,
    `- **Lenguajes:** ${report.meta.languages.join(", ") || "—"}`,
    `- **Gestores de paquetes:** ${report.meta.packageManagers.join(", ") || "—"}`,
    `- **Frameworks:** ${report.meta.frameworks.join(", ") || "—"}`,
    `- **Git:** ${
      report.meta.isGitRepo
        ? report.meta.gitPendingChanges
          ? "repositorio con cambios pendientes"
          : "repositorio sin cambios pendientes"
        : "no es repositorio"
    }`,
    `- **Fecha:** ${report.generatedAt}`,
    `- **ID:** ${report.id}`,
    `- **Archivos:** ${s.totalFiles} · **Carpetas:** ${s.totalDirectories}`,
    `- **Tamaño total aproximado:** ${formatBytes(s.totalSizeBytes)}`,
    `- **Limpiable (safe):** ${formatBytes(s.safeBytes)}`,
    `- **Revisar (review):** ${formatBytes(s.reviewBytes)}`,
    `- **Última modificación relevante:** ${s.lastModified}`,
    "",
    "> Escaneo de solo lectura: no se ha modificado ni eliminado ningún archivo.",
    "",
    ...(report.meta.regenerationCommands.length > 0
      ? [
          "## Regeneración recomendada (no se ejecuta automáticamente)",
          "",
          ...report.meta.regenerationCommands.map((c) => `- \`${c}\``),
          ""
        ]
      : []),
    "## Elementos detectados",
    "",
    entriesTable(report.entries),
    ...(report.warnings.length > 0
      ? ["## Avisos", "", ...report.warnings.map((w) => `- ${mdEscape(w)}`), ""]
      : [])
  ].join("\n");
}

async function writeReports(
  baseName: string,
  json: unknown,
  markdown: string,
  reportsDir?: string
): Promise<ReportPaths> {
  const dir = resolveReportsDir(reportsDir);
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `${baseName}.json`);
  const markdownPath = path.join(dir, `${baseName}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  await fs.writeFile(markdownPath, markdown, "utf8");
  return { json: jsonPath, markdown: markdownPath };
}

/** Guarda el informe de raíz en JSON y Markdown dentro de `reports/`. */
export async function saveRootScanReport(
  report: RootScanReport,
  reportsDir?: string
): Promise<ReportPaths> {
  const baseName = `root-scan-${stamp(report.generatedAt)}-${report.id.slice(0, 8)}`;
  return writeReports(baseName, report, rootScanMarkdown(report), reportsDir);
}

/** Guarda el informe de un proyecto en JSON y Markdown dentro de `reports/`. */
export async function saveScanReport(
  report: ScanReport,
  reportsDir?: string
): Promise<ReportPaths> {
  const baseName = `scan-${stamp(report.generatedAt)}-${report.id.slice(0, 8)}`;
  return writeReports(
    baseName,
    report,
    projectScanMarkdown(report),
    reportsDir
  );
}

function riskTag(risk: ScanEntry["risk"]): string {
  return risk === "safe"
    ? "[SEGURO]   "
    : risk === "review"
      ? "[REVISAR]  "
      : "[PROTEGIDO]";
}

function entryLine(entry: ScanEntry): string {
  const rule = entry.matchedRule ? ` · regla: ${entry.matchedRule}` : "";
  return `  ${riskTag(entry.risk)} ${entry.relativePath} — ${formatBytes(entry.sizeBytes)}${rule} — ${entry.reason}`;
}

/** Análisis de un proyecto para `inspect` (y previo de `clean`). */
export function printProjectAnalysis(
  report: ScanReport,
  verbose: boolean
): void {
  const s = report.summary;
  console.log(`Proyecto: ${report.target}`);
  console.log(
    `Tipo: ${formatTypes(report.projectTypes)} · Tamaño: ${formatBytes(s.totalSizeBytes)} · Última modificación: ${formatDate(s.lastModified)}`
  );
  console.log(`Archivos: ${s.totalFiles} · Carpetas: ${s.totalDirectories}`);
  const meta = report.meta;
  console.log(
    `Lenguajes: ${meta.languages.join(", ") || "—"} · Gestores: ${meta.packageManagers.join(", ") || "—"}`
  );
  if (meta.frameworks.length > 0) {
    console.log(`Frameworks: ${meta.frameworks.join(", ")}`);
  }
  console.log(
    `Git: ${
      meta.isGitRepo
        ? meta.gitPendingChanges
          ? "repositorio con cambios pendientes"
          : "repositorio sin cambios pendientes"
        : "no es repositorio"
    }`
  );
  if (meta.regenerationCommands.length > 0) {
    console.log("Regeneración recomendada (no se ejecuta automáticamente):");
    for (const command of meta.regenerationCommands) {
      console.log(`  $ ${command}`);
    }
  }

  const groups: Array<ScanEntry["risk"]> = verbose
    ? ["safe", "review", "protected"]
    : ["safe", "review"];
  for (const risk of groups) {
    const entries = report.entries.filter((e) => e.risk === risk);
    if (entries.length === 0) continue;
    console.log("");
    for (const entry of entries) console.log(entryLine(entry));
  }
  console.log("");
  console.log(
    `Limpiable (safe): ${formatBytes(s.safeBytes)} · Revisar (review): ${formatBytes(s.reviewBytes)} · Protegido: ${formatBytes(s.protectedBytes)}`
  );
  if (report.warnings.length > 0) {
    console.log(`Avisos: ${report.warnings.length}`);
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
}

/** Plan de limpieza numerado, con acción propuesta y elementos no incluidos. */
export function printCleanPlan(plan: CleanPlan, report: ScanReport): void {
  const actionLabel =
    plan.items[0]?.action === "permanent"
      ? "ELIMINACIÓN PERMANENTE"
      : "papelera local";
  console.log("");
  console.log(
    `Plan de limpieza (${actionLabel}) — ${plan.items.length} elementos · ${formatBytes(plan.totalBytes)} liberables`
  );
  plan.items.forEach((item, index) => {
    const n = String(index + 1).padStart(3);
    console.log(
      `${n}. ${riskTag(item.entry.risk)} ${item.entry.relativePath} — ${formatBytes(item.entry.sizeBytes)} — ${item.entry.reason}`
    );
  });
  const reviewCount = report.entries.filter((e) => e.risk === "review").length;
  const protectedCount = report.entries.filter(
    (e) => e.risk === "protected"
  ).length;
  console.log("");
  console.log(
    `No incluidos: ${reviewCount} review (selección explícita con --include-review o --only) · ${protectedCount} protected (nunca eliminables)`
  );
}

function cleanResultMarkdown(result: CleanResult, scan: ScanReport): string {
  const lines: string[] = [
    "# Informe de limpieza",
    "",
    `- **Proyecto:** \`${result.target}\``,
    `- **Tipos:** ${formatTypes(result.projectTypes)}`,
    `- **Acción:** ${result.action === "trash" ? "papelera local" : "eliminación permanente"}`,
    `- **Inicio:** ${result.startedAt} · **Fin:** ${result.finishedAt}`,
    `- **Plan:** ${result.planId} · **Análisis:** ${result.scanReportId}`,
    `- **Ejecutados:** ${result.executedCount} · **Fallidos:** ${result.failedCount} · **Omitidos:** ${result.skippedCount}`,
    `- **Espacio liberado:** ${formatBytes(result.freedBytes)}`,
    ...(result.trashSessionDir
      ? [`- **Papelera:** \`${result.trashSessionDir}\``]
      : []),
    ...(result.auditPath ? [`- **Auditoría:** \`${result.auditPath}\``] : []),
    "",
    "## Acciones",
    "",
    "| Ruta | Riesgo | Acción | Resultado | Tamaño | Detalle |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const item of result.items) {
    lines.push(
      `| \`${mdEscape(item.entry.relativePath)}\` | ${item.entry.risk} | ${item.action} | ${item.result} | ${formatBytes(item.entry.sizeBytes)} | ${mdEscape(item.error ?? item.storedPath ?? "—")} |`
    );
  }
  lines.push("", "## Verificación Git", "");
  if (result.git?.available) {
    lines.push(
      result.git.deletedTracked.length > 0
        ? `**ATENCIÓN: ${result.git.deletedTracked.length} ficheros versionados eliminados.**`
        : "Sin eliminaciones inesperadas de ficheros versionados.",
      "",
      "```text",
      result.git.output.trim() || "(sin cambios)",
      "```",
      ""
    );
  } else {
    lines.push(result.git?.output ?? "Verificación no disponible.", "");
  }
  lines.push(
    "## Conservados",
    "",
    `- Review no seleccionados: ${scan.entries.filter((e) => e.risk === "review").length}`,
    `- Protegidos (nunca eliminables): ${scan.entries.filter((e) => e.risk === "protected").length}`,
    ""
  );
  if (result.warnings.length > 0) {
    lines.push("## Avisos", "");
    for (const w of result.warnings) lines.push(`- ${mdEscape(w)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Guarda el informe final de limpieza (JSON + Markdown) en `reports/`. */
export async function saveCleanResult(
  result: CleanResult,
  scan: ScanReport,
  reportsDir?: string
): Promise<ReportPaths> {
  const baseName = `clean-${stamp(result.finishedAt)}-${result.id.slice(0, 8)}`;
  return writeReports(
    baseName,
    { clean: result, scan },
    cleanResultMarkdown(result, scan),
    reportsDir
  );
}

/** Resumen final de limpieza en terminal. */
export function printCleanResult(
  result: CleanResult,
  scan: ScanReport,
  paths: ReportPaths
): void {
  console.log("");
  console.log(
    `Limpieza completada: ${result.executedCount} ejecutados · ${result.failedCount} fallidos · ${result.skippedCount} omitidos`
  );
  console.log(`Espacio liberado: ${formatBytes(result.freedBytes)}`);
  const keptReview = scan.entries.filter((e) => e.risk === "review").length;
  const keptProtected = scan.entries.filter(
    (e) => e.risk === "protected"
  ).length;
  console.log(
    `Conservados: ${keptReview} review · ${keptProtected} protected · ${result.skippedCount} no seleccionados`
  );
  if (result.trashSessionDir) {
    console.log(`Papelera: ${result.trashSessionDir}`);
  }
  if (result.auditPath) console.log(`Auditoría: ${result.auditPath}`);
  if (result.git?.available) {
    if (result.git.deletedTracked.length > 0) {
      console.log(
        `⚠ Git detecta ${result.git.deletedTracked.length} ficheros versionados eliminados: revisa el informe.`
      );
    } else {
      console.log(
        "Git: sin eliminaciones inesperadas de ficheros versionados."
      );
    }
  }
  for (const w of result.warnings) console.log(`Aviso: ${w}`);
  console.log(`Informe JSON:     ${paths.json}`);
  console.log(`Informe Markdown: ${paths.markdown}`);
}

/* ---------- Restauración (fase 4) ---------- */

const SESSION_STATUS_LABELS: Record<TrashSessionInfo["status"], string> = {
  restorable: "restaurable",
  partial: "parcialmente restaurable",
  restored: "restaurada",
  unrestorable: "no restaurable"
};

/** Listado numerado de sesiones de papelera. */
export function printRestoreSessions(sessions: TrashSessionInfo[]): void {
  console.log("");
  console.log(`Sesiones de papelera: ${sessions.length}`);
  sessions.forEach((session, index) => {
    console.log(
      `  ${index + 1}. ${session.sessionId} · ${formatDate(session.createdAt)} · ` +
        `${session.itemCount} elementos (${session.pendingCount} pendientes, ` +
        `${session.restorableCount} restaurables) · ${formatBytes(session.totalBytes)} · ` +
        `plan ${session.planHash.slice(0, 12)}… · ${SESSION_STATUS_LABELS[session.status]}`
    );
  });
}

/** Detalle del plan de restauración con estados y conflictos. */
export function printRestorePlan(
  plan: RestorePlan,
  session: TrashSession
): void {
  console.log("");
  console.log(
    `Sesión ${plan.sessionId} · plan original ${session.planId} · ` +
      `hash ${session.planHash.slice(0, 12)}…`
  );
  console.log(
    `Plan de restauración — ${plan.items.length} elementos · ${formatBytes(plan.totalBytes)}`
  );
  plan.items.forEach((item, index) => {
    const n = String(index + 1).padStart(3);
    const flags: string[] = [];
    if (!item.storedExists) flags.push("ALMACÉN INEXISTENTE");
    if (item.conflict)
      flags.push(`CONFLICTO: destino existe → ${item.resolution}`);
    if (item.meta.restored) flags.push("ya restaurado");
    const suffix = flags.length > 0 ? ` [${flags.join(" · ")}]` : "";
    console.log(
      `${n}. ${item.meta.relativePath} — ${formatBytes(item.meta.sizeBytes)} — ${item.meta.risk}${suffix}`
    );
  });
}

function restoreResultMarkdown(result: RestoreResult): string {
  const lines: string[] = [
    "# Informe de restauración",
    "",
    `- **Proyecto:** \`${result.target}\``,
    `- **Sesión:** ${result.sessionId} · **Plan original:** ${result.originalPlanId}`,
    `- **Inicio:** ${result.startedAt} · **Fin:** ${result.finishedAt}`,
    `- **Restaurados:** ${result.restoredCount} · **Fallidos:** ${result.failedCount} · **Omitidos:** ${result.skippedCount} · **Conflictos:** ${result.conflictCount}`,
    `- **Tamaño restaurado:** ${formatBytes(result.restoredBytes)}`,
    ...(result.auditPath ? [`- **Auditoría:** \`${result.auditPath}\``] : []),
    "",
    "## Acciones",
    "",
    "| Ruta | Resultado | Tamaño | Destino / Detalle |",
    "| --- | --- | --- | --- |"
  ];
  for (const item of result.items) {
    lines.push(
      `| \`${mdEscape(item.relativePath)}\` | ${item.result} | ${formatBytes(item.sizeBytes)} | ${mdEscape(item.error ?? item.restoredPath ?? "—")} |`
    );
  }
  if (result.warnings.length > 0) {
    lines.push("", "## Avisos", "");
    for (const w of result.warnings) lines.push(`- ${mdEscape(w)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Guarda el informe final de restauración (JSON + Markdown). */
export async function saveRestoreResult(
  result: RestoreResult,
  reportsDir?: string
): Promise<ReportPaths> {
  const baseName = `restore-${stamp(result.finishedAt)}-${result.id.slice(0, 8)}`;
  return writeReports(
    baseName,
    result,
    restoreResultMarkdown(result),
    reportsDir
  );
}

/** Resumen final de restauración en terminal. */
export function printRestoreResult(
  result: RestoreResult,
  paths: ReportPaths
): void {
  console.log("");
  console.log(
    `Restauración completada: ${result.restoredCount} restaurados · ${result.failedCount} fallidos · ${result.skippedCount} omitidos · ${result.conflictCount} conflictos`
  );
  console.log(`Tamaño restaurado: ${formatBytes(result.restoredBytes)}`);
  if (result.auditPath) console.log(`Auditoría: ${result.auditPath}`);
  for (const w of result.warnings) console.log(`Aviso: ${w}`);
  console.log(`Informe JSON:     ${paths.json}`);
  console.log(`Informe Markdown: ${paths.markdown}`);
}

/* ---------- Gestión de papelera (fase 5) ---------- */

/** Listado completo de sesiones con contadores y estado. */
export function printTrashSessions(sessions: TrashSessionInfo[]): void {
  console.log("");
  console.log(`Sesiones de papelera: ${sessions.length}`);
  sessions.forEach((session, index) => {
    console.log(
      `  ${index + 1}. ${session.sessionId} · ${formatDate(session.createdAt)} · ` +
        `${session.itemCount} elementos (${session.pendingCount} pendientes, ` +
        `${session.restoredCount} restaurados, ${session.restorableCount} restaurables) · ` +
        `${formatBytes(session.totalBytes)} · plan ${session.planHash.slice(0, 12)}… · ` +
        SESSION_STATUS_LABELS[session.status]
    );
  });
}

/** Detalle de una sesión con el estado real de cada elemento. */
export function printTrashSessionDetail(
  session: TrashSession,
  states: Array<{
    meta: {
      relativePath: string;
      sizeBytes: number;
      risk: string;
      restored?: boolean;
    };
    storedExists: boolean;
    conflict: boolean;
  }>
): void {
  console.log("");
  console.log(
    `Sesión ${path.basename(session.sessionDir)} · creada ${session.createdAt} · ` +
      `plan ${session.planId} · hash ${session.planHash.slice(0, 12)}…`
  );
  for (const state of states) {
    const flags: string[] = [];
    if (state.meta.restored) flags.push("restaurado");
    else if (!state.storedExists) flags.push("almacén inexistente");
    else if (state.conflict) flags.push("destino existente");
    else flags.push("restaurable");
    console.log(
      `  ${state.meta.relativePath} — ${formatBytes(state.meta.sizeBytes)} — ${state.meta.risk} [${flags.join(" · ")}]`
    );
  }
}

function trashPurgeMarkdown(report: TrashPurgeReport): string {
  const lines: string[] = [
    "# Informe de gestión de papelera",
    "",
    `- **Proyecto:** \`${report.target}\``,
    `- **Fecha:** ${report.generatedAt}`,
    `- **Sesiones listadas:** ${report.sessions.length}`,
    `- **Elegibles:** ${report.eligible.length}`,
    `- **Eliminadas:** ${report.purged.filter((p) => p.result === "purged").length}`,
    `- **Conservadas:** ${report.kept.length}`,
    `- **Espacio liberado:** ${formatBytes(report.freedBytes)}`,
    "",
    "## Sesiones",
    "",
    "| Sesión | Estado | Elementos | Pendientes | Restaurados | Tamaño |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const s of report.sessions) {
    lines.push(
      `| ${s.sessionId} | ${SESSION_STATUS_LABELS[s.status]} | ${s.itemCount} | ${s.pendingCount} | ${s.restoredCount} | ${formatBytes(s.totalBytes)} |`
    );
  }
  lines.push(
    "",
    "## Acciones",
    "",
    "| Sesión | Resultado | Tamaño | Detalle |",
    "| --- | --- | --- | --- |"
  );
  for (const p of report.purged) {
    lines.push(
      `| ${p.sessionId} | ${p.result} | ${formatBytes(p.sizeBytes)} | ${mdEscape(p.error ?? "—")} |`
    );
  }
  if (report.errors.length > 0) {
    lines.push("", "## Errores", "");
    for (const e of report.errors) lines.push(`- ${mdEscape(e)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Guarda el informe de gestión de papelera (JSON + Markdown). */
export async function saveTrashPurgeReport(
  report: TrashPurgeReport,
  reportsDir?: string
): Promise<ReportPaths> {
  const baseName = `trash-${stamp(report.generatedAt)}-${report.id.slice(0, 8)}`;
  return writeReports(baseName, report, trashPurgeMarkdown(report), reportsDir);
}

/** Resumen final de purga de sesiones en terminal. */
export function printTrashPurgeSummary(
  report: TrashPurgeReport,
  paths: ReportPaths
): void {
  const purged = report.purged.filter((p) => p.result === "purged").length;
  const failed = report.purged.filter((p) => p.result === "failed").length;
  const skipped = report.purged.filter((p) => p.result === "skipped").length;
  console.log("");
  console.log(
    `Papelera: ${purged} sesiones eliminadas · ${failed} fallidas · ${skipped} omitidas · ${report.kept.length} conservadas`
  );
  console.log(`Espacio liberado: ${formatBytes(report.freedBytes)}`);
  for (const e of report.errors) console.log(`Aviso: ${e}`);
  console.log(`Informe JSON:     ${paths.json}`);
  console.log(`Informe Markdown: ${paths.markdown}`);
}

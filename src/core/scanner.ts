import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fg from "fast-glob";
import ignore from "ignore";
import type {
  ArtifactSummary,
  CleanerRuleSet,
  ProjectInfo,
  ProjectMeta,
  ProjectType,
  RootScanReport,
  ScanEntry,
  ScanOptions,
  ScanReport,
  ScanSummary
} from "../types/index.js";
import {
  classifyPath,
  negationUnderDirectory,
  type ClassificationResult
} from "./rule-engine.js";
import {
  detectProjectMeta,
  detectProjectType,
  MARKER_FILES
} from "./project-meta.js";

export { detectProjectType } from "./project-meta.js";
export type { ProjectDetection } from "./project-meta.js";

type GitignoreFilter = ReturnType<typeof ignore>;

/** Patrones de poda: no buscar proyectos dentro de artefactos ni rutas protegidas. */
function buildPrunePatterns(rules: CleanerRuleSet): string[] {
  const names = new Set<string>();
  for (const pattern of [...rules.safe, ...rules.protected, ...rules.review]) {
    if (!/[*?[\]{}]/.test(pattern)) names.add(pattern);
  }
  const prune: string[] = [];
  for (const name of names) {
    prune.push(`${name}/**`, `**/${name}/**`);
  }
  return prune;
}

/**
 * Descubre proyectos bajo la raíz.
 * - Si la propia raíz es un proyecto, se devuelve solo ella.
 * - Si no, se buscan marcadores hasta `maxDepth`, sin entrar en proyectos
 *   ya detectados (un proyecto = una unidad de análisis).
 */
async function discoverProjects(
  absRoot: string,
  rules: CleanerRuleSet,
  warnings: string[]
): Promise<string[]> {
  const rootDetection = await detectProjectType(absRoot);
  if (rootDetection.markers.length > 0) return [absRoot];

  const markerNames = [...Object.keys(MARKER_FILES), ".git"];
  const patterns = markerNames.flatMap((m) => [m, `**/${m}`]);
  patterns.push("*.csproj", "**/*.csproj", "*.fsproj", "**/*.fsproj");
  patterns.push("*.vbproj", "**/*.vbproj", "*.sln", "**/*.sln");

  let found: string[];
  try {
    found = await fg(patterns, {
      cwd: absRoot,
      dot: true,
      onlyFiles: false,
      markDirectories: true,
      followSymbolicLinks: false,
      deep: rules.defaults.maxDepth,
      suppressErrors: true,
      ignore: buildPrunePatterns(rules)
    });
  } catch (error) {
    warnings.push(
      `Error durante la búsqueda de proyectos: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }

  const candidates = [
    ...new Set(
      found.map((p) => {
        const clean = p.replace(/\/+$/, "");
        const dir = path.dirname(clean);
        return dir === "." ? absRoot : path.join(absRoot, dir);
      })
    )
  ];

  const depth = (p: string) =>
    path.relative(absRoot, p).split(path.sep).filter(Boolean).length;
  candidates.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));

  const accepted: string[] = [];
  for (const candidate of candidates) {
    const nested = accepted.some(
      (a) => candidate === a || candidate.startsWith(a + path.sep)
    );
    if (!nested) accepted.push(candidate);
  }
  return accepted;
}

interface Totals {
  size: number;
  maxMtime: number;
  files: number;
  dirs: number;
}

function emptyTotals(): Totals {
  return { size: 0, maxMtime: 0, files: 0, dirs: 0 };
}

function addTotals(base: Totals, extra: Totals, includeMtime: boolean): void {
  base.size += extra.size;
  base.files += extra.files;
  base.dirs += extra.dirs;
  if (includeMtime) base.maxMtime = Math.max(base.maxMtime, extra.maxMtime);
}

async function loadGitignore(
  projectDir: string
): Promise<GitignoreFilter | null> {
  try {
    const content = await fs.readFile(
      path.join(projectDir, ".gitignore"),
      "utf8"
    );
    return ignore().add(content);
  } catch {
    return null;
  }
}

export interface ScanProjectOptions {
  /** Tipos ya detectados (p. ej. por scanRoot); si no, se detectan aquí. */
  projectTypes?: ProjectType[];
  /** Metadatos ya calculados; evita doble detección. */
  meta?: ProjectMeta;
  /** Consultar git status (solo lectura). Por defecto sí. */
  checkGit?: boolean;
}

/**
 * Escanea un proyecto concreto: artefactos, clasificación, tamaños y fecha
 * de última modificación relevante. Es 100% de solo lectura.
 */
export async function scanProject(
  target: string,
  rules: CleanerRuleSet,
  options: ScanProjectOptions = {}
): Promise<ScanReport> {
  const absTarget = path.resolve(target);
  const stat = await fs.stat(absTarget).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`La ruta no existe o no es un directorio: ${absTarget}`);
  }

  const meta =
    options.meta ??
    (await detectProjectMeta(absTarget, { checkGit: options.checkGit }));
  const projectTypes = options.projectTypes ?? meta.types;
  const entries: ScanEntry[] = [];
  const warnings: string[] = [];
  const gitignore = await loadGitignore(absTarget);
  const largeBytes = rules.defaults.largeThresholdMB * 1024 * 1024;
  const maxDepth = rules.defaults.maxDepth;

  const pushEntry = (
    rel: string,
    type: "file" | "directory",
    classification: ClassificationResult,
    sizeBytes: number
  ): void => {
    entries.push({
      absolutePath: path.join(absTarget, rel),
      relativePath: rel,
      type,
      risk: classification.risk,
      reason: classification.reason,
      sizeBytes,
      ...(classification.matchedRule !== undefined
        ? { matchedRule: classification.matchedRule }
        : {})
    });
  };

  /**
   * Un match "safe" que NO está ignorado por .gitignore puede ser contenido
   * versionado: se degrada a review (conservador).
   */
  const applyGitignore = (
    classification: ClassificationResult,
    rel: string,
    type: "file" | "directory"
  ): ClassificationResult => {
    // ignore@7 sigue la semántica de git: los patrones de directorio
    // (con "/" final) solo se aplican a rutas marcadas como directorio.
    const probe = type === "directory" ? `${rel}/` : rel;
    if (
      classification.risk === "safe" &&
      gitignore &&
      !gitignore.ignores(probe)
    ) {
      warnings.push(
        `Posible contenido versionado: ${rel} (patrón safe no ignorado por Git)`
      );
      return {
        risk: "review",
        reason: `Patrón seguro (${classification.matchedRule ?? "?"}) pero no ignorado por .gitignore: posible contenido versionado`,
        ...(classification.matchedRule !== undefined
          ? { matchedRule: classification.matchedRule }
          : {})
      };
    }
    return classification;
  };

  /** Recorrido completo de tamaño/mtime, sin clasificar (para artefactos y rutas protegidas). */
  async function measure(abs: string, riskBase?: string): Promise<Totals> {
    const totals = emptyTotals();
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      warnings.push(
        `No se pudo leer ${abs}: ${error instanceof Error ? error.message : String(error)}`
      );
      return totals;
    }
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue; // nunca seguir enlaces
      const child = path.join(abs, dirent.name);
      // Hijos directos de zonas regenerables: avisar de contenido importante.
      if (riskBase !== undefined) {
        const risk = classifyPath(dirent.name, rules, projectTypes);
        if (risk.risk === "protected" && risk.matchedRule) {
          warnings.push(
            `Archivo potencialmente importante en zona regenerable: ${riskBase}/${dirent.name} (${risk.matchedRule})`
          );
        }
      }
      if (dirent.isDirectory()) {
        totals.dirs += 1;
        addTotals(totals, await measure(child), true);
      } else if (dirent.isFile()) {
        try {
          const s = await fs.stat(child);
          totals.files += 1;
          totals.size += s.size;
          totals.maxMtime = Math.max(totals.maxMtime, s.mtimeMs);
        } catch {
          // archivo ilegible: se ignora en el cómputo
        }
      }
    }
    return totals;
  }

  /** Recorrido principal: clasifica, detecta artefactos y acumula tamaño. */
  async function walk(
    abs: string,
    rel: string,
    depth: number
  ): Promise<Totals> {
    const totals = emptyTotals();
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      warnings.push(
        `No se pudo leer ${abs}: ${error instanceof Error ? error.message : String(error)}`
      );
      return totals;
    }

    for (const dirent of dirents) {
      // Los enlaces simbólicos/junctions nunca se siguen: evitan escapes del target.
      if (dirent.isSymbolicLink()) continue;
      const childAbs = path.join(abs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        totals.dirs += 1;
        const classification = classifyPath(childRel, rules, projectTypes);

        if (classification.risk === "protected") {
          const sub = await measure(childAbs);
          addTotals(totals, sub, true);
          pushEntry(childRel, "directory", classification, sub.size);
          continue;
        }

        // Un directorio safe que contiene negaciones se degrada a review
        // y se recorre para hacer visibles las rutas excluidas.
        const negUnder =
          classification.risk === "safe"
            ? negationUnderDirectory(childRel, rules, projectTypes)
            : undefined;

        if (
          classification.matchedRule &&
          classification.risk === "safe" &&
          !negUnder
        ) {
          const sub = await measure(childAbs, childRel);
          // La actividad dentro de artefactos no es "modificación relevante".
          addTotals(totals, sub, false);
          pushEntry(
            childRel,
            "directory",
            applyGitignore(classification, childRel, "directory"),
            sub.size
          );
          continue;
        }

        let sub: Totals;
        if (depth + 1 >= maxDepth) {
          sub = await measure(childAbs);
        } else {
          sub = await walk(childAbs, childRel, depth + 1);
        }
        addTotals(totals, sub, true);

        if (negUnder) {
          warnings.push(`Exclusión activa en ${childRel}: ${negUnder}`);
          pushEntry(
            childRel,
            "directory",
            {
              risk: "review",
              reason: `Contiene rutas excluidas por negación (${negUnder}): revisar antes de eliminar`,
              ...(classification.matchedRule !== undefined
                ? { matchedRule: classification.matchedRule }
                : {})
            },
            sub.size
          );
        } else if (classification.matchedRule) {
          pushEntry(childRel, "directory", classification, sub.size);
        } else if (sub.size > largeBytes) {
          pushEntry(
            childRel,
            "directory",
            {
              risk: "review",
              reason: `Directorio grande sin regla conocida (${Math.round(sub.size / (1024 * 1024))} MB): revisar`
            },
            sub.size
          );
        }
        continue;
      }

      if (dirent.isFile()) {
        let s;
        try {
          s = await fs.stat(childAbs);
        } catch {
          continue;
        }
        totals.files += 1;
        totals.size += s.size;
        totals.maxMtime = Math.max(totals.maxMtime, s.mtimeMs);

        const classification = classifyPath(childRel, rules, projectTypes);
        if (classification.matchedRule) {
          pushEntry(
            childRel,
            "file",
            applyGitignore(classification, childRel, "file"),
            s.size
          );
        } else if (s.size > largeBytes) {
          pushEntry(
            childRel,
            "file",
            {
              risk: "review",
              reason: `Archivo grande sin regla conocida (${Math.round(s.size / (1024 * 1024))} MB): revisar`
            },
            s.size
          );
        }
      }
    }
    return totals;
  }

  const totals = await walk(absTarget, "", 0);
  if (!gitignore && entries.some((e) => e.risk === "safe")) {
    warnings.push(
      "El proyecto no tiene .gitignore: los artefactos safe podrían estar versionados"
    );
  }
  if (meta.gitPendingChanges) {
    warnings.push(
      "Git tiene cambios pendientes: revisa el estado antes de limpiar"
    );
  }
  const generatedAt = new Date().toISOString();
  const lastModified = new Date(
    totals.maxMtime > 0 ? totals.maxMtime : stat.mtimeMs
  ).toISOString();

  const attributed = attributeEntryBytes(entries);
  const sumBy = (risk: "safe" | "review" | "protected") =>
    entries
      .filter((e) => e.risk === risk)
      .reduce(
        (acc, e) => acc + (attributed.get(e.relativePath) ?? e.sizeBytes),
        0
      );

  const summary: ScanSummary = {
    target: absTarget,
    totalFiles: totals.files,
    totalDirectories: totals.dirs,
    totalSizeBytes: totals.size,
    safeBytes: sumBy("safe"),
    reviewBytes: sumBy("review"),
    protectedBytes: sumBy("protected"),
    lastModified,
    generatedAt
  };

  return {
    id: randomUUID(),
    target: absTarget,
    projectTypes,
    meta,
    generatedAt,
    warnings,
    summary,
    entries
  };
}

/**
 * Atribuye los bytes de cada entrada descontando las subentradas listadas,
 * de modo que los totales por riesgo no solapen bytes (un directorio review
 * que contiene artefactos safe no los cuenta dos veces).
 */
function attributeEntryBytes(entries: ScanEntry[]): Map<string, number> {
  const byPath = new Map(entries.map((e) => [e.relativePath, e]));
  const childSum = new Map<string, number>();
  for (const entry of entries) {
    const segments = entry.relativePath.split("/");
    for (let i = segments.length - 1; i >= 1; i -= 1) {
      const ancestor = segments.slice(0, i).join("/");
      if (byPath.has(ancestor)) {
        childSum.set(ancestor, (childSum.get(ancestor) ?? 0) + entry.sizeBytes);
        break;
      }
    }
  }
  const result = new Map<string, number>();
  for (const entry of entries) {
    result.set(
      entry.relativePath,
      entry.sizeBytes - (childSum.get(entry.relativePath) ?? 0)
    );
  }
  return result;
}

function summarizeArtifacts(entries: ScanEntry[]): ArtifactSummary {
  const attributed = attributeEntryBytes(entries);
  const summary: ArtifactSummary = {
    safeCount: 0,
    reviewCount: 0,
    protectedCount: 0,
    safeBytes: 0,
    reviewBytes: 0,
    protectedBytes: 0
  };
  for (const entry of entries) {
    const bytes = attributed.get(entry.relativePath) ?? entry.sizeBytes;
    if (entry.risk === "safe") {
      summary.safeCount += 1;
      summary.safeBytes += bytes;
    } else if (entry.risk === "review") {
      summary.reviewCount += 1;
      summary.reviewBytes += bytes;
    } else {
      summary.protectedCount += 1;
      summary.protectedBytes += bytes;
    }
  }
  return summary;
}

/**
 * Escanea una ruta raíz (p. ej. C:\Trabajo), detecta proyectos en sus
 * subcarpetas y analiza los artefactos de cada uno. Solo lectura.
 */
export async function scanRoot(
  root: string,
  rules: CleanerRuleSet,
  options: ScanOptions = {}
): Promise<RootScanReport> {
  const absRoot = path.resolve(root);
  const stat = await fs.stat(absRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`La ruta raíz no existe o no es un directorio: ${absRoot}`);
  }

  const warnings: string[] = [];
  const projectDirs = await discoverProjects(absRoot, rules, warnings);
  const projects: ProjectInfo[] = [];

  for (const dir of projectDirs) {
    const meta = await detectProjectMeta(dir, { checkGit: false });
    const report = await scanProject(dir, rules, {
      projectTypes: meta.types,
      meta
    });
    const artifacts = summarizeArtifacts(report.entries);
    const info: ProjectInfo = {
      name: path.basename(dir),
      path: dir,
      relativePath: path.relative(absRoot, dir).replace(/\\/g, "/") || ".",
      types: meta.types,
      markers: meta.markers,
      meta,
      sizeBytes: report.summary.totalSizeBytes,
      lastModified: report.summary.lastModified,
      hasArtifacts: artifacts.safeCount + artifacts.reviewCount > 0,
      artifacts,
      entries: report.entries,
      warnings: report.warnings
    };
    projects.push(info);
    options.onProject?.(info);
  }

  const summary = {
    projectCount: projects.length,
    projectsWithArtifacts: projects.filter((p) => p.hasArtifacts).length,
    totalSizeBytes: projects.reduce((acc, p) => acc + p.sizeBytes, 0),
    safeBytes: projects.reduce((acc, p) => acc + p.artifacts.safeBytes, 0),
    reviewBytes: projects.reduce((acc, p) => acc + p.artifacts.reviewBytes, 0),
    artifactCount: projects.reduce(
      (acc, p) => acc + p.artifacts.safeCount + p.artifacts.reviewCount,
      0
    )
  };

  return {
    id: randomUUID(),
    root: absRoot,
    generatedAt: new Date().toISOString(),
    rulesSource: options.rulesSource ?? "no especificado",
    summary,
    projects,
    warnings
  };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CleanerRuleSet,
  ProjectRuleSet,
  ProjectType,
  RuleDefaults
} from "../types/index.js";
import { DEFAULT_RULES } from "./defaults.js";
import { classifyPath } from "../core/rule-engine.js";

export interface LoadedRules {
  rules: CleanerRuleSet;
  source: string;
}

export const DEFAULT_CONFIG_PATH = path.join("config", "rules.json");

const KNOWN_PROJECT_TYPES: ProjectType[] = [
  "nodejs",
  "typescript",
  "python",
  "rust",
  "go",
  "gradle",
  "maven",
  "dotnet",
  "php",
  "ruby",
  "unknown"
];

/** Patrones que SIEMPRE son review, aunque el usuario intente otra cosa. */
const REVIEW_ALWAYS = [".vs"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(source: string, message: string): never {
  throw new Error(`Reglas inválidas en ${source}: ${message}`);
}

function validatePatternArray(
  value: unknown,
  section: string,
  source: string
): string[] {
  if (!Array.isArray(value)) {
    fail(source, `"${section}" debe ser un array de patrones`);
  }
  const patterns: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      fail(source, `"${section}" contiene un patrón vacío o no textual`);
    }
    const pattern = raw.replace(/\\/g, "/").trim();
    if (pattern.split("/").includes("..")) {
      fail(source, `"${section}" no admite patrones con "..": ${raw}`);
    }
    if (pattern.startsWith("/") || /^[a-zA-Z]:/.test(pattern)) {
      fail(source, `"${section}" no admite rutas absolutas: ${raw}`);
    }
    if (pattern.includes("/")) {
      fail(
        source,
        `"${section}" aplica patrones al nombre final, no a rutas: ${raw}`
      );
    }
    patterns.push(pattern);
  }
  return [...new Set(patterns)];
}

function validateDefaults(
  value: unknown,
  source: string
): Partial<RuleDefaults> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(source, '"defaults" debe ser un objeto');
  const result: Partial<RuleDefaults> = {};
  if (value.mode !== undefined) {
    if (value.mode !== "dry-run" && value.mode !== "clean") {
      fail(source, '"defaults.mode" debe ser "dry-run" o "clean"');
    }
    result.mode = value.mode;
  }
  if (value.useTrash !== undefined) {
    if (typeof value.useTrash !== "boolean") {
      fail(source, '"defaults.useTrash" debe ser booleano');
    }
    result.useTrash = value.useTrash;
  }
  if (value.maxDepth !== undefined) {
    if (
      typeof value.maxDepth !== "number" ||
      !Number.isInteger(value.maxDepth) ||
      value.maxDepth < 1 ||
      value.maxDepth > 64
    ) {
      fail(source, '"defaults.maxDepth" debe ser un entero entre 1 y 64');
    }
    result.maxDepth = value.maxDepth;
  }
  if (value.largeThresholdMB !== undefined) {
    if (
      typeof value.largeThresholdMB !== "number" ||
      !Number.isFinite(value.largeThresholdMB) ||
      value.largeThresholdMB <= 0
    ) {
      fail(source, '"defaults.largeThresholdMB" debe ser un número > 0');
    }
    result.largeThresholdMB = value.largeThresholdMB;
  }
  return result;
}

function validateProjectRules(
  value: unknown,
  source: string
): Partial<Record<ProjectType, ProjectRuleSet>> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(source, '"projectRules" debe ser un objeto');
  const result: Partial<Record<ProjectType, ProjectRuleSet>> = {};
  for (const [key, raw] of Object.entries(value)) {
    const type = (key === "node" ? "nodejs" : key) as ProjectType;
    if (!KNOWN_PROJECT_TYPES.includes(type)) {
      fail(source, `tipo de proyecto desconocido en "projectRules": ${key}`);
    }
    if (!isRecord(raw)) {
      fail(source, `"projectRules.${key}" debe ser un objeto`);
    }
    const local: ProjectRuleSet = {};
    if (raw.safe !== undefined) {
      local.safe = validatePatternArray(
        raw.safe,
        `projectRules.${key}.safe`,
        source
      );
    }
    if (raw.review !== undefined) {
      local.review = validatePatternArray(
        raw.review,
        `projectRules.${key}.review`,
        source
      );
    }
    if (raw.protected !== undefined) {
      local.protected = validatePatternArray(
        raw.protected,
        `projectRules.${key}.protected`,
        source
      );
    }
    if (raw.safeNegations !== undefined) {
      local.safeNegations = validateNegations(raw.safeNegations, source);
    }
    result[type] = local;
  }
  return result;
}

function validateNegations(value: unknown, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(source, '"safeNegations" debe ser un array de rutas con prefijo "!"');
  }
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.startsWith("!")) {
      fail(source, `toda negación debe empezar por "!": ${String(raw)}`);
    }
    const pattern = raw.slice(1).replace(/\\/g, "/").trim();
    if (pattern.length === 0) {
      fail(source, `negación vacía tras "!": ${raw}`);
    }
    if (pattern.split("/").includes("..")) {
      fail(source, `negación con ".." no permitida: ${raw}`);
    }
    if (pattern.startsWith("/") || /^[a-zA-Z]:/.test(pattern)) {
      fail(source, `negación absoluta no permitida: ${raw}`);
    }
    result.push(`!${pattern}`);
  }
  return [...new Set(result)];
}

function mergeProjectRules(
  user: Partial<Record<ProjectType, ProjectRuleSet>>
): Partial<Record<ProjectType, ProjectRuleSet>> {
  const result: Partial<Record<ProjectType, ProjectRuleSet>> = {};
  const types = new Set<ProjectType>([
    ...(Object.keys(DEFAULT_RULES.projectRules ?? {}) as ProjectType[]),
    ...(Object.keys(user) as ProjectType[])
  ]);
  for (const type of types) {
    const base = DEFAULT_RULES.projectRules?.[type] ?? {};
    const local = user[type] ?? {};
    const merged: ProjectRuleSet = {};
    const safe = local.safe ?? base.safe;
    const review = local.review ?? base.review;
    // La protección condicionada tampoco se debilita.
    const protectedPatterns = [
      ...new Set([...(base.protected ?? []), ...(local.protected ?? [])])
    ];
    if (safe && safe.length > 0) merged.safe = safe;
    if (review && review.length > 0) merged.review = review;
    if (protectedPatterns.length > 0) merged.protected = protectedPatterns;
    const negations = local.safeNegations ?? base.safeNegations;
    if (negations !== undefined) merged.safeNegations = negations;
    result[type] = merged;
  }
  return result;
}

function validateAndMerge(data: unknown, source: string): CleanerRuleSet {
  if (!isRecord(data)) fail(source, "el documento debe ser un objeto JSON");
  if (data.version !== undefined && data.version !== 1) {
    fail(
      source,
      `versión no soportada: ${String(data.version)} (se esperaba 1)`
    );
  }

  const defaults: RuleDefaults = {
    ...DEFAULT_RULES.defaults,
    ...validateDefaults(data.defaults, source)
  };
  const safe =
    data.safe === undefined
      ? [...DEFAULT_RULES.safe]
      : validatePatternArray(data.safe, "safe", source);
  const review = [
    ...new Set([
      ...(data.review === undefined
        ? DEFAULT_RULES.review
        : validatePatternArray(data.review, "review", source)),
      // Invariante: `.vs` siempre review, nunca safe.
      ...REVIEW_ALWAYS
    ])
  ];
  const userProtected =
    data.protected === undefined
      ? []
      : validatePatternArray(data.protected, "protected", source);
  const projectRules = mergeProjectRules(
    validateProjectRules(data.projectRules, source)
  );
  const safeNegations =
    data.safeNegations === undefined
      ? [...(DEFAULT_RULES.safeNegations ?? [])]
      : validateNegations(data.safeNegations, source);

  // La protección nunca se debilita: unión con las reglas internas.
  const protectedPatterns = [
    ...new Set([...DEFAULT_RULES.protected, ...userProtected])
  ];

  // Ningún patrón "safe" puede convertir en eliminable algo protegido.
  const protectedRules: CleanerRuleSet = {
    version: 1,
    defaults,
    safe: [],
    review: [],
    protected: protectedPatterns
  };
  for (const pattern of safe) {
    if (classifyPath(pattern, protectedRules).risk === "protected") {
      fail(
        source,
        `el patrón seguro "${pattern}" choca con una ruta protegida (innegociable)`
      );
    }
  }
  for (const [type, local] of Object.entries(projectRules)) {
    const scoped: CleanerRuleSet = {
      ...protectedRules,
      protected: [...protectedPatterns, ...(local?.protected ?? [])]
    };
    for (const pattern of local?.safe ?? []) {
      if (
        classifyPath(pattern, scoped, [type as ProjectType]).risk ===
        "protected"
      ) {
        fail(
          source,
          `el patrón seguro "${pattern}" de projectRules.${type} choca con una ruta protegida`
        );
      }
    }
  }

  return {
    version: 1,
    defaults,
    safe,
    review,
    protected: protectedPatterns,
    projectRules,
    safeNegations
  };
}

/**
 * Carga y valida `config/rules.json`.
 * - Sin archivo por defecto: usa las reglas internas (fallback seguro).
 * - Ruta explícita inexistente: error (no silently fallback).
 * - `protected` siempre se fusiona con las invariantes internas.
 */
export async function loadRules(configPath?: string): Promise<LoadedRules> {
  const requested = configPath ?? DEFAULT_CONFIG_PATH;
  const resolved = path.resolve(requested);
  const isDefault = requested === DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch {
    if (!isDefault) {
      throw new Error(`No existe el archivo de reglas: ${resolved}`);
    }
    return {
      rules: DEFAULT_RULES,
      source: "reglas internas por defecto (no existe config/rules.json)"
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `JSON inválido en ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  return { rules: validateAndMerge(parsed, resolved), source: resolved };
}

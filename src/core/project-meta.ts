import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProjectMeta, ProjectType } from "../types/index.js";
import { verifyGitStatus } from "./git.js";

/** Archivos marcadores que identifican un proyecto y su tipo. */
export const MARKER_FILES: Record<string, ProjectType> = {
  "package.json": "nodejs",
  "tsconfig.json": "typescript",
  "pyproject.toml": "python",
  "setup.py": "python",
  "requirements.txt": "python",
  Pipfile: "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  "settings.gradle": "gradle",
  "settings.gradle.kts": "gradle",
  gradlew: "gradle",
  "pom.xml": "maven",
  "composer.json": "php",
  Gemfile: "ruby"
};

const MARKER_GLOBS: Array<{ pattern: RegExp; type: ProjectType }> = [
  { pattern: /\.(csproj|fsproj|vbproj|sln)$/i, type: "dotnet" }
];

const TYPE_PRIORITY: ProjectType[] = [
  "typescript",
  "nodejs",
  "python",
  "rust",
  "go",
  "gradle",
  "maven",
  "dotnet",
  "php",
  "ruby"
];

export interface ProjectDetection {
  types: ProjectType[];
  markers: string[];
}

/** Detecta el tipo de proyecto a partir de los marcadores de su raíz. */
export async function detectProjectType(
  projectDir: string
): Promise<ProjectDetection> {
  let names: string[];
  try {
    names = await fs.readdir(projectDir);
  } catch {
    return { types: ["unknown"], markers: [] };
  }

  const found = new Set<ProjectType>();
  const markers: string[] = [];

  for (const name of names) {
    const type = MARKER_FILES[name];
    if (type) {
      found.add(type);
      markers.push(name);
      continue;
    }
    for (const glob of MARKER_GLOBS) {
      if (glob.pattern.test(name)) {
        found.add(glob.type);
        markers.push(name);
      }
    }
  }
  // Un repositorio Git sin marcadores de build también es un proyecto.
  if (names.includes(".git")) markers.push(".git");

  const types = TYPE_PRIORITY.filter((t) => found.has(t));
  return { types: types.length > 0 ? types : ["unknown"], markers };
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

async function readTextSafe(file: string): Promise<string> {
  return fs.readFile(file, "utf8").catch(() => "");
}

async function readPackageJson(file: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

export interface ProjectMetaOptions {
  /** Ejecutar `git status --short` (solo lectura). Por defecto sí. */
  checkGit?: boolean;
}

/**
 * Metadatos del proyecto basados SOLO en evidencia (archivos y configuración
 * existentes). Los comandos de regeneración son recomendaciones: este módulo
 * nunca ejecuta nada. Git se consulta en modo exclusivamente lectura.
 */
export async function detectProjectMeta(
  projectDir: string,
  options: ProjectMetaOptions = {}
): Promise<ProjectMeta> {
  const detection = await detectProjectType(projectDir);
  const names = await fs.readdir(projectDir).catch(() => [] as string[]);
  const has = (name: string) => names.includes(name);
  const anyMatch = (re: RegExp) => names.some((name) => re.test(name));

  // Lenguajes: marcadores o extensiones presentes en la raíz.
  const languages = new Set<string>();
  if (has("tsconfig.json") || anyMatch(/\.ts$/)) languages.add("TypeScript");
  if (has("package.json") || anyMatch(/\.(js|mjs|cjs)$/))
    languages.add("JavaScript");
  if (
    has("pyproject.toml") ||
    has("requirements.txt") ||
    has("setup.py") ||
    anyMatch(/\.py$/)
  )
    languages.add("Python");
  if (has("Cargo.toml") || anyMatch(/\.rs$/)) languages.add("Rust");
  if (has("go.mod") || anyMatch(/\.go$/)) languages.add("Go");
  if (anyMatch(/\.(csproj|sln)$/)) languages.add("C#");
  if (anyMatch(/\.fsproj$/)) languages.add("F#");
  if (anyMatch(/\.vbproj$/)) languages.add("VB.NET");
  if (
    has("pom.xml") ||
    has("build.gradle") ||
    has("build.gradle.kts") ||
    anyMatch(/\.java$/)
  )
    languages.add("Java");
  if (anyMatch(/\.kt$/)) languages.add("Kotlin");
  if (has("composer.json") || anyMatch(/\.php$/)) languages.add("PHP");
  if (has("Gemfile") || anyMatch(/\.rb$/)) languages.add("Ruby");

  // Gestores de paquetes: lockfiles y marcadores inequívocos.
  const packageManagers: string[] = [];
  const hasPnpm = has("pnpm-lock.yaml");
  const hasYarn = has("yarn.lock");
  const hasBun = has("bun.lockb") || has("bun.lock");
  if (hasPnpm) packageManagers.push("pnpm");
  if (hasYarn) packageManagers.push("yarn");
  if (hasBun) packageManagers.push("bun");
  if (has("package.json") && !hasPnpm && !hasYarn && !hasBun)
    packageManagers.push("npm");
  if (has("requirements.txt")) packageManagers.push("pip");
  if (has("uv.lock")) packageManagers.push("uv");
  if (has("poetry.lock")) packageManagers.push("poetry");
  if (has("Cargo.lock")) packageManagers.push("cargo");
  if (has("go.sum")) packageManagers.push("go");
  if (anyMatch(/\.(sln|csproj|fsproj|vbproj)$/)) packageManagers.push("dotnet");
  if (has("build.gradle") || has("build.gradle.kts") || has("gradle.lockfile"))
    packageManagers.push("gradle");
  if (has("pom.xml")) packageManagers.push("maven");
  if (has("composer.lock")) packageManagers.push("composer");

  // Frameworks: solo con evidencia clara.
  const frameworks = new Set<string>();
  if (anyMatch(/^next\.config\./)) frameworks.add("Next.js");
  if (anyMatch(/^nuxt\.config\./)) frameworks.add("Nuxt");
  if (has("svelte.config.js")) frameworks.add("SvelteKit");
  if (anyMatch(/^astro\.config\./)) frameworks.add("Astro");
  if (anyMatch(/^vite\.config\./)) frameworks.add("Vite");
  if (has("manage.py")) frameworks.add("Django");
  const tauriConf = path.join(projectDir, "src-tauri", "tauri.conf.json");
  if (await fs.stat(tauriConf).catch(() => null)) frameworks.add("Tauri");

  const pkg = await readPackageJson(path.join(projectDir, "package.json"));
  const deps: Record<string, string> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {})
  };
  if ("react" in deps) frameworks.add("React");
  if ("vue" in deps) frameworks.add("Vue");
  if ("express" in deps) frameworks.add("Express");
  if ("@nestjs/core" in deps) frameworks.add("NestJS");
  if ("electron" in deps) frameworks.add("Electron");
  const requirements = await readTextSafe(
    path.join(projectDir, "requirements.txt")
  );
  const pyproject = await readTextSafe(path.join(projectDir, "pyproject.toml"));
  if (/fastapi/i.test(requirements) || /fastapi/i.test(pyproject))
    frameworks.add("FastAPI");

  // Comandos de regeneración: SOLO recomendaciones, nunca se ejecutan.
  const regenerationCommands: string[] = [];
  const hasBuildScript = typeof pkg?.scripts?.build === "string";
  if (packageManagers.includes("pnpm")) {
    regenerationCommands.push("pnpm install");
    if (hasBuildScript) regenerationCommands.push("pnpm build");
  } else if (packageManagers.includes("yarn")) {
    regenerationCommands.push("yarn install");
    if (hasBuildScript) regenerationCommands.push("yarn build");
  } else if (packageManagers.includes("bun")) {
    regenerationCommands.push("bun install");
    if (hasBuildScript) regenerationCommands.push("bun run build");
  } else if (packageManagers.includes("npm")) {
    regenerationCommands.push("npm install");
    if (hasBuildScript) regenerationCommands.push("npm run build");
  }
  if (packageManagers.includes("pip"))
    regenerationCommands.push("pip install -r requirements.txt");
  if (packageManagers.includes("uv")) regenerationCommands.push("uv sync");
  if (packageManagers.includes("poetry"))
    regenerationCommands.push("poetry install");
  if (packageManagers.includes("cargo"))
    regenerationCommands.push("cargo build");
  if (packageManagers.includes("go"))
    regenerationCommands.push("go build ./...");
  if (packageManagers.includes("dotnet"))
    regenerationCommands.push("dotnet restore", "dotnet build");
  if (packageManagers.includes("gradle"))
    regenerationCommands.push(
      has("gradlew") ? "./gradlew build" : "gradle build"
    );
  if (packageManagers.includes("maven"))
    regenerationCommands.push("mvn clean install");
  if (packageManagers.includes("composer"))
    regenerationCommands.push("composer install");
  if (has("Gemfile")) regenerationCommands.push("bundle install");

  // Git: solo lectura (git status --short), nunca comandos que modifiquen.
  const isGitRepo = has(".git");
  let gitPendingChanges = false;
  let gitStatusOutput: string | undefined;
  if (isGitRepo && options.checkGit !== false) {
    const verification = verifyGitStatus(projectDir);
    if (verification.available) {
      gitPendingChanges = verification.output.trim().length > 0;
      gitStatusOutput = verification.output;
    }
  }

  return {
    types: detection.types,
    markers: detection.markers,
    languages: [...languages],
    packageManagers,
    frameworks: [...frameworks],
    regenerationCommands,
    isGitRepo,
    gitPendingChanges,
    gitStatusOutput
  };
}

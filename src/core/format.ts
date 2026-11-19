import type { ProjectType } from "../types/index.js";

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  nodejs: "Node.js",
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  gradle: "Java/Gradle",
  maven: "Java/Maven",
  dotnet: ".NET",
  php: "PHP",
  ruby: "Ruby",
  unknown: "Desconocido"
};

export function formatTypes(types: ProjectType[]): string {
  return types.map((t) => PROJECT_TYPE_LABELS[t]).join(" · ");
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const label = units[unit] ?? "B";
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${label}`;
}

/** Fecha corta (YYYY-MM-DD) a partir de un ISO string. */
export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyPath, type Risk } from "./rules.js";
import { pathExists, getDirectorySize, formatBytes } from "./utils.js";
import { LARGE_THRESHOLD_MB } from "./config.js";

export interface ScanEntry {
  absolutePath: string;
  relativePath: string;
  type: "file" | "directory";
  risk: Risk;
  reason: string;
  sizeBytes: number;
  sizeLabel: string;
}

export interface ScanReport {
  target: string;
  entries: ScanEntry[];
  totalSafeBytes: number;
  totalReviewBytes: number;
  generatedAt: string;
}

export async function scanRepository(target: string): Promise<ScanReport> {
  const absoluteTarget = path.resolve(target);

  if (!(await pathExists(absoluteTarget))) {
    throw new Error(`La ruta no existe: ${absoluteTarget}`);
  }

  const entries: ScanEntry[] = [];

  async function walk(current: string): Promise<void> {
    const dirEntries = await fs.readdir(current, {
      withFileTypes: true
    });

    for (const entry of dirEntries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(absoluteTarget, absolutePath);
      const classification = classifyPath(relativePath);

      if (classification.risk === "protected") {
        continue;
      }

      if (entry.isDirectory()) {
        const sizeBytes = await getDirectorySize(absolutePath);

        entries.push({
          absolutePath,
          relativePath,
          type: "directory",
          risk:
            sizeBytes > LARGE_THRESHOLD_MB * 1024 * 1024
              ? "review"
              : classification.risk,
          reason:
            sizeBytes > LARGE_THRESHOLD_MB * 1024 * 1024
              ? `Carpeta grande: revisa antes de eliminar`
              : classification.reason,
          sizeBytes,
          sizeLabel: formatBytes(sizeBytes)
        });

        if (classification.risk !== "safe") {
          await walk(absolutePath);
        }

        continue;
      }

      const stats = await fs.stat(absolutePath);

      entries.push({
        absolutePath,
        relativePath,
        type: "file",
        risk: classification.risk,
        reason: classification.reason,
        sizeBytes: stats.size,
        sizeLabel: formatBytes(stats.size)
      });
    }
  }

  await walk(absoluteTarget);

  const totalSafeBytes = entries
    .filter((entry) => entry.risk === "safe")
    .reduce((sum, entry) => sum + entry.sizeBytes, 0);

  const totalReviewBytes = entries
    .filter((entry) => entry.risk === "review")
    .reduce((sum, entry) => sum + entry.sizeBytes, 0);

  return {
    target: absoluteTarget,
    entries,
    totalSafeBytes,
    totalReviewBytes,
    generatedAt: new Date().toISOString()
  };
}

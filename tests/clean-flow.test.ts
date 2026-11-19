import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRepository } from "../src/core/cleaner.js";
import { readAudit } from "../src/core/audit.js";
import { listFiles, makeFixture, testRules } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function setup(): Promise<{
  target: string;
  auditPath: string;
  reportsDir: string;
}> {
  const root = await makeFixture();
  tempDirs.push(root);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-flow-"));
  tempDirs.push(aux);
  return {
    target: path.join(root, "proj-node"),
    auditPath: path.join(aux, "clean-audit.jsonl"),
    reportsDir: path.join(aux, "reports")
  };
}

/** Preguntas inyectadas: selección y confirmación. */
function answers(...responses: string[]): (prompt: string) => Promise<string> {
  let index = 0;
  return async () => {
    const response = responses[index] ?? "";
    index += 1;
    return response;
  };
}

describe("cleanRepository — human-in-the-loop", () => {
  it("dry-run no elimina, no mueve y no audita nada", async () => {
    const { target, auditPath, reportsDir } = await setup();
    const before = await listFiles(target);
    const outcome = await cleanRepository(target, testRules(), {
      dryRun: true,
      auditPath,
      reportsDir
    });
    expect(outcome.result).toBeNull();
    expect(outcome.plan.items.length).toBeGreaterThan(0);
    expect(await listFiles(target)).toEqual(before);
    await expect(fs.stat(auditPath)).rejects.toThrow();
    await expect(
      fs.stat(path.join(target, ".repo-cleaner-trash"))
    ).rejects.toThrow();
  });

  it("confirmación negativa: no se toca nada", async () => {
    const { target, auditPath, reportsDir } = await setup();
    const before = await listFiles(target);
    const outcome = await cleanRepository(target, testRules(), {
      isInteractive: true,
      ask: answers("", "no"),
      auditPath,
      reportsDir
    });
    expect(outcome.result).toBeNull();
    expect(await listFiles(target)).toEqual(before);
    await expect(fs.stat(auditPath)).rejects.toThrow();
  });

  it("selección vacía ('none') cancela sin tocar nada", async () => {
    const { target, auditPath, reportsDir } = await setup();
    const before = await listFiles(target);
    const outcome = await cleanRepository(target, testRules(), {
      isInteractive: true,
      ask: answers("none"),
      auditPath,
      reportsDir
    });
    expect(outcome.result).toBeNull();
    expect(await listFiles(target)).toEqual(before);
  });

  it("confirmación positiva mueve a la papelera y genera informe final", async () => {
    const { target, auditPath, reportsDir } = await setup();
    const outcome = await cleanRepository(target, testRules(), {
      isInteractive: true,
      ask: answers("", "yes"),
      auditPath,
      reportsDir
    });
    expect(outcome.result).not.toBeNull();
    expect(outcome.result?.executedCount).toBeGreaterThan(0);
    expect(outcome.result?.action).toBe("trash");
    await expect(fs.stat(path.join(target, "node_modules"))).rejects.toThrow();
    expect(outcome.paths).toBeDefined();
    expect(await fs.stat(outcome.paths?.json ?? "")).toBeTruthy();
    expect(await fs.stat(outcome.paths?.markdown ?? "")).toBeTruthy();
    const records = await readAudit(auditPath);
    expect(records.length).toBe(outcome.result?.executedCount);
    // Verificación Git posterior incluida (fixture sin repo real -> no disponible).
    expect(outcome.result?.git).toBeDefined();
  });

  it("selección individual por número en el prompt", async () => {
    const { target, auditPath, reportsDir } = await setup();
    const outcome = await cleanRepository(target, testRules(), {
      isInteractive: true,
      ask: answers("1", "sí"),
      auditPath,
      reportsDir
    });
    expect(outcome.result?.executedCount).toBe(1);
    const records = await readAudit(auditPath);
    const trashed = records.filter((r) => r.result === "trashed");
    expect(trashed).toHaveLength(1);
  });

  it("--yes ejecuta sin prompts (automatización consciente)", async () => {
    const { target, auditPath, reportsDir } = await setup();
    const outcome = await cleanRepository(target, testRules(), {
      yes: true,
      isInteractive: false,
      auditPath,
      reportsDir
    });
    expect(outcome.result?.executedCount).toBeGreaterThan(0);
  });

  it("sin TTY y sin --yes se niega a ejecutar", async () => {
    const { target, auditPath, reportsDir } = await setup();
    const before = await listFiles(target);
    await expect(
      cleanRepository(target, testRules(), {
        isInteractive: false,
        auditPath,
        reportsDir
      })
    ).rejects.toThrow(/interactivo/);
    expect(await listFiles(target)).toEqual(before);
  });

  it("--permanent requiere flags explícitos y elimina de verdad", async () => {
    const { target, auditPath, reportsDir } = await setup();
    const outcome = await cleanRepository(target, testRules(), {
      yes: true,
      permanent: true,
      only: ["dist"],
      isInteractive: false,
      auditPath,
      reportsDir
    });
    expect(outcome.result?.action).toBe("permanent");
    await expect(fs.stat(path.join(target, "dist"))).rejects.toThrow();
    await expect(
      fs.stat(path.join(target, ".repo-cleaner-trash"))
    ).rejects.toThrow();
    const records = await readAudit(auditPath);
    expect(records[0]?.result).toBe("deleted");
  });
});

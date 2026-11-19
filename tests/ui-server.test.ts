import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/ui/server.js";
import { makeFixture, testRules } from "./helpers.js";

const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof startServer>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("servidor real (integración)", () => {
  it("escucha solo en 127.0.0.1 y sirve health + UI", async () => {
    const root = await makeFixture();
    tempDirs.push(root);
    const aux = await fs.mkdtemp(path.join(os.tmpdir(), "repo-cleaner-srv-"));
    tempDirs.push(aux);

    const server = startServer(
      {
        allowedRoot: root,
        rules: testRules(),
        reportsDir: path.join(aux, "reports"),
        auditPath: path.join(aux, "audit.jsonl")
      },
      0 // puerto efímero
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));

    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const home = await fetch(base);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Repo Cleaner");

    const scan = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: root })
    });
    expect(scan.status).toBe(200);
    const data = (await scan.json()) as { projects: unknown[] };
    expect(data.projects).toHaveLength(3);
  });
});

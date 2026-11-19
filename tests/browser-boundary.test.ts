import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createServer } from "../src/ui/server.js";
import { DEFAULT_RULES } from "../src/rules/defaults.js";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const hasEdge = fs.existsSync(EDGE);
const DEBUG_PORT = 9333;

const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) {
    await fn().catch(() => {});
  }
});

interface CdpRequest {
  url: string;
  method: string;
}

/**
 * Prueba en NAVEGADOR REAL (Edge headless + CDP, sin dependencias nuevas).
 * Verifica el límite generar/confirmar: generar el plan no ejecuta limpieza;
 * solo una confirmación explícita posterior ejecuta, y una sola vez.
 * Se omite en máquinas sin Edge (p. ej. CI Linux).
 */
describe("límite generar/confirmar en navegador real", () => {
  it.skipIf(!hasEdge)(
    "generar plan no mueve archivos; confirmar ejecuta una vez y muestra resultado",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rc-boundary-"));
      const proj = path.join(root, "proj");
      const aux = path.join(root, "aux");
      await fsp.mkdir(path.join(proj, "node_modules", "pkg"), {
        recursive: true
      });
      await fsp.mkdir(path.join(proj, "dist"), { recursive: true });
      await fsp.mkdir(aux, { recursive: true });
      const files: Record<string, string> = {
        "package.json": '{"name":"boundary"}',
        ".gitignore": "node_modules/\ndist/\n",
        "node_modules/pkg/index.js": "CONTENIDO-CONOCIDO-123",
        "dist/bundle.js": "BUNDLE-XYZ"
      };
      for (const [rel, content] of Object.entries(files)) {
        await fsp.writeFile(path.join(proj, rel), content, "utf8");
      }
      const hashOf = async (rel: string) => {
        try {
          return createHash("sha256")
            .update(await fsp.readFile(path.join(proj, rel)))
            .digest("hex");
        } catch {
          return "AUSENTE";
        }
      };
      const before: Record<string, string> = {};
      for (const rel of Object.keys(files)) before[rel] = await hashOf(rel);

      const app = createServer({
        allowedRoot: root,
        rules: DEFAULT_RULES,
        reportsDir: path.join(aux, "reports"),
        auditPath: path.join(aux, "audit.jsonl")
      });
      // Servidor HTTP real sobre el fetch de Hono
      const { serve } = await import("@hono/node-server");
      const httpServer = serve({
        fetch: app.fetch,
        port: 0,
        hostname: "127.0.0.1"
      });
      await new Promise<void>((r) => httpServer.once("listening", () => r()));
      const base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
      cleanup.push(async () => {
        await new Promise<void>((r) => httpServer.close(() => r()));
      });

      const profile = path.join(root, "edge-profile");
      const browser: ChildProcess = spawn(
        EDGE,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          `--user-data-dir=${profile}`,
          `--remote-debugging-port=${DEBUG_PORT}`,
          "--remote-allow-origins=*",
          "about:blank"
        ],
        { stdio: "ignore" }
      );
      cleanup.push(async () => {
        browser.kill();
        await new Promise((r) => setTimeout(r, 500));
        await fsp.rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 300
        });
      });

      let wsUrl: string | undefined;
      for (let i = 0; i < 80 && !wsUrl; i++) {
        await new Promise((r) => setTimeout(r, 300));
        try {
          const list = (await (
            await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
          ).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
          wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
        } catch {
          /* aún arrancando */
        }
      }
      expect(wsUrl).toBeTruthy();

      const ws = new WebSocket(wsUrl as string);
      ws.addEventListener("error", () => {
        /* errores de socket durante el cierre: no son fallos del test */
      });
      await new Promise<void>((r) => (ws.onopen = () => r()));
      let msgId = 0;
      const pending = new Map<
        number,
        (m: { result?: Record<string, unknown> }) => void
      >();
      const requests: CdpRequest[] = [];
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as {
          id?: number;
          method?: string;
          params?: { request?: { url: string; method: string } };
          result?: Record<string, unknown>;
        };
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)?.(m);
          pending.delete(m.id);
        }
        if (m.method === "Network.requestWillBeSent" && m.params?.request) {
          requests.push({
            url: m.params.request.url,
            method: m.params.request.method
          });
        }
      };
      const send = (method: string, params: Record<string, unknown> = {}) =>
        new Promise<{ result?: Record<string, unknown> }>((resolve) => {
          const id = ++msgId;
          pending.set(id, resolve);
          ws.send(JSON.stringify({ id, method, params }));
        });
      const evaluate = async (expression: string): Promise<unknown> => {
        const r = await send("Runtime.evaluate", {
          expression,
          returnByValue: true
        });
        return (r.result?.result as { value?: unknown } | undefined)?.value;
      };
      const waitFor = async (expression: string, timeout = 25000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          if (await evaluate(expression)) return;
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new Error("timeout esperando: " + expression);
      };
      const click = async (selector: string) => {
        const rect = (await evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
        )) as { x: number; y: number } | null;
        expect(rect).toBeTruthy();
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: rect?.x,
          y: rect?.y,
          button: "left",
          clickCount: 1
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: rect?.x,
          y: rect?.y,
          button: "left",
          clickCount: 1
        });
      };
      const cleanCalls = () =>
        requests.filter(
          (r) => r.url.includes("/api/clean") && r.method === "POST"
        ).length;

      await send("Network.enable");
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Page.navigate", { url: base });
      await waitFor(`document.getElementById('btn-scan') !== null`);
      await evaluate(
        `document.getElementById('root-path').value = ${JSON.stringify(proj)}`
      );
      await click("#btn-scan");
      await waitFor(`!document.getElementById('view-projects').hidden`);
      await click("#projects-list .card .card-actions button");
      await waitFor(
        `document.getElementById('artifacts-body').children.length > 0`
      );
      await click("#btn-select-safe");
      await waitFor(`!document.getElementById('btn-generate-plan').disabled`);

      // UN solo clic en Generar plan; NO confirmar.
      await click("#btn-generate-plan");
      await waitFor(`!document.getElementById('view-plan').hidden`);
      await new Promise((r) => setTimeout(r, 2500));

      // Invariante: nada se ejecutó ni movió.
      expect(cleanCalls()).toBe(0);
      for (const rel of Object.keys(files)) {
        expect(await hashOf(rel)).toBe(before[rel]);
      }
      expect(fs.existsSync(path.join(proj, ".repo-cleaner-trash"))).toBe(false);
      expect(fs.existsSync(path.join(aux, "audit.jsonl"))).toBe(false);

      // Confirmación explícita en una interacción separada.
      await click("#btn-confirm-clean");
      await waitFor(`!document.getElementById('view-result').hidden`);
      await new Promise((r) => setTimeout(r, 800));
      expect(cleanCalls()).toBe(1);
      expect(await hashOf("node_modules/pkg/index.js")).toBe("AUSENTE");
      expect(await hashOf("dist/bundle.js")).toBe("AUSENTE");
      expect(fs.existsSync(path.join(proj, ".repo-cleaner-trash"))).toBe(true);
      const audit = (await fsp.readFile(path.join(aux, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { result: string });
      expect(audit.filter((a) => a.result === "trashed")).toHaveLength(2);
      expect(
        await evaluate(`document.getElementById('error-banner').hidden`)
      ).toBe(true);
      ws.close();
    },
    180000
  );
});

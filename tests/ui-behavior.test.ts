import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const appJs = readFileSync(path.join(repoRoot, "src/ui/public/app.js"), "utf8");
const stylesCss = readFileSync(
  path.join(repoRoot, "src/ui/public/styles.css"),
  "utf8"
);

interface ShimElement {
  id: string;
  hidden: boolean;
  textContent: string;
  disabled: boolean;
  value: string;
  href: string;
  title: string;
  className: string;
  dataset: Record<string, string>;
  children: Array<ShimElement | string>;
  listeners: Record<string, Array<(event?: unknown) => void>>;
  attrs: Record<string, string>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, force?: boolean): void;
    contains(c: string): boolean;
  };
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  append(...kids: Array<ShimElement | string>): void;
  addEventListener(type: string, fn: (event?: unknown) => void): void;
  click(): void;
}

function makeElement(id = ""): ShimElement {
  const el: ShimElement = {
    id,
    hidden: false,
    textContent: "",
    disabled: false,
    value: "",
    href: "",
    title: "",
    className: "",
    dataset: {},
    children: [],
    listeners: {},
    attrs: {},
    classList: {
      add(c) {
        if (!el.className.includes(c)) el.className += ` ${c}`;
      },
      remove(c) {
        el.className = el.className.replace(c, "").trim();
      },
      toggle(c, force) {
        const on = force ?? !el.className.includes(c);
        if (on) el.classList.add(c);
        else el.classList.remove(c);
      },
      contains(c) {
        return el.className.includes(c);
      }
    },
    setAttribute(k, v) {
      el.attrs[k] = v;
    },
    getAttribute(k) {
      return el.attrs[k] ?? null;
    },
    append(...kids) {
      el.children.push(...kids);
    },
    addEventListener(type, fn) {
      (el.listeners[type] ??= []).push(fn);
    },
    click() {
      for (const fn of el.listeners["click"] ?? []) fn({});
    }
  };
  return el;
}

interface ShimResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function jsonResponse(status: number, data: unknown): ShimResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  };
}

const SCAN_OK = {
  reportId: "r1",
  summary: {
    projectCount: 1,
    projectsWithArtifacts: 1,
    totalSizeBytes: 10,
    safeBytes: 5,
    reviewBytes: 0
  },
  projects: [
    {
      name: "demo",
      path: "C:/demo",
      relativePath: "demo",
      types: ["nodejs"],
      sizeBytes: 10,
      lastModified: "2026-01-01T00:00:00Z",
      hasArtifacts: true,
      artifacts: { safeCount: 1, reviewCount: 0 }
    }
  ]
};

interface UiHarness {
  elements: Map<string, ShimElement>;
  main: ShimElement;
  fetchMock: ReturnType<typeof vi.fn>;
  el: (id: string) => ShimElement;
}

function loadUi(fetchImpl: (url: string) => Promise<ShimResponse>): UiHarness {
  const elements = new Map<string, ShimElement>();
  const views = [
    "home",
    "projects",
    "inspect",
    "trash",
    "reports",
    "plan",
    "result"
  ].map((name) => {
    const el = makeElement(`view-${name}`);
    el.className = "view";
    el.hidden = name !== "home";
    elements.set(el.id, el);
    return el;
  });
  const filterButtons = ["all", "safe", "review", "protected"].map((filter) => {
    const el = makeElement();
    el.className = "btn-filter";
    el.dataset.filter = filter;
    return el;
  });
  const main = makeElement("main");
  const docListeners: Record<string, Array<() => void>> = {};

  const documentShim = {
    getElementById(id: string): ShimElement {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id) as ShimElement;
    },
    createElement(): ShimElement {
      return makeElement();
    },
    querySelectorAll(selector: string): ShimElement[] {
      if (selector === ".view") return views;
      if (selector === ".btn-filter") return filterButtons;
      return [];
    },
    querySelector(selector: string): ShimElement | null {
      return selector === "main" ? main : null;
    },
    addEventListener(type: string, fn: () => void): void {
      (docListeners[type] ??= []).push(fn);
    }
  };

  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "/api/health") return jsonResponse(200, { status: "ok" });
    return fetchImpl(u);
  });

  const sandbox = {
    document: documentShim,
    window: { scrollTo: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchMock,
    setTimeout,
    clearTimeout,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox, { filename: "app.js" });
  for (const fn of docListeners["DOMContentLoaded"] ?? []) fn();

  return {
    elements,
    main,
    fetchMock,
    el: (id) => documentShim.getElementById(id)
  };
}

const scanCalls = (h: UiHarness) =>
  h.fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/scan").length;

describe("UI — comportamiento real ante fallos (shim DOM, sin dependencias)", () => {
  it("500 en /api/scan: oculta spinner, quita aria-busy, restaura botón y muestra error", async () => {
    const h = loadUi(async () =>
      jsonResponse(500, { error: "Error interno del servidor" })
    );
    h.el("root-path").value = "C:/demo";
    h.el("btn-scan").click();
    await vi.waitFor(() => {
      expect(h.el("home-loading").hidden).toBe(true);
    });
    expect(h.el("projects-loading").hidden).toBe(true);
    expect(h.main.attrs["aria-busy"]).toBe("false");
    expect(h.el("btn-scan").disabled).toBe(false);
    expect(h.el("error-banner").hidden).toBe(false);
    expect(h.el("error-banner").textContent).toContain(
      "Error interno del servidor"
    );
    expect(scanCalls(h)).toBe(1);
  });

  it("fallo de red: sale del estado de carga con mensaje legible", async () => {
    const h = loadUi(async () => {
      throw new TypeError("fetch failed");
    });
    h.el("root-path").value = "C:/demo";
    h.el("btn-scan").click();
    await vi.waitFor(() => {
      expect(h.el("home-loading").hidden).toBe(true);
    });
    expect(h.main.attrs["aria-busy"]).toBe("false");
    expect(h.el("btn-scan").disabled).toBe(false);
    expect(h.el("error-banner").textContent).toContain("Error de red");
  });

  it("doble clic durante petición pendiente produce una sola petición", async () => {
    let resolveScan: (r: ShimResponse) => void = () => {};
    const h = loadUi(
      () =>
        new Promise<ShimResponse>((resolve) => {
          resolveScan = resolve;
        })
    );
    h.el("root-path").value = "C:/demo";
    h.el("btn-scan").click();
    h.el("btn-scan").click();
    h.el("btn-scan").click();
    expect(scanCalls(h)).toBe(1);
    expect(h.el("home-loading").hidden).toBe(false);
    resolveScan(jsonResponse(200, SCAN_OK));
    await vi.waitFor(() => {
      expect(h.el("view-projects").hidden).toBe(false);
    });
    expect(scanCalls(h)).toBe(1);
    expect(h.main.attrs["aria-busy"]).toBe("false");
  });

  it("tras un error se puede reintentar y el escaneo tiene éxito", async () => {
    let fail = true;
    const h = loadUi(async () => {
      if (fail)
        return jsonResponse(500, { error: "Error interno del servidor" });
      return jsonResponse(200, SCAN_OK);
    });
    h.el("root-path").value = "C:/demo";
    h.el("btn-scan").click();
    await vi.waitFor(() => {
      expect(h.el("error-banner").hidden).toBe(false);
    });
    expect(h.el("btn-scan").disabled).toBe(false);
    fail = false;
    h.el("btn-scan").click();
    await vi.waitFor(() => {
      expect(h.el("view-projects").hidden).toBe(false);
    });
    expect(scanCalls(h)).toBe(2);
    expect(h.el("home-loading").hidden).toBe(true);
    expect(h.el("error-banner").hidden).toBe(true);
    expect(h.el("projects-summary").textContent).toContain("1");
  });

  it("Enter en el input también respeta la guarda anti-duplicados", async () => {
    let resolveScan: (r: ShimResponse) => void = () => {};
    const h = loadUi(
      () =>
        new Promise<ShimResponse>((resolve) => {
          resolveScan = resolve;
        })
    );
    const input = h.el("root-path");
    input.value = "C:/demo";
    input.click(); // no-op: sin listener click
    for (const fn of input.listeners["keydown"] ?? []) fn({ key: "Enter" });
    for (const fn of input.listeners["keydown"] ?? []) fn({ key: "Enter" });
    expect(scanCalls(h)).toBe(1);
    resolveScan(jsonResponse(200, SCAN_OK));
    await vi.waitFor(() => {
      expect(h.el("view-projects").hidden).toBe(false);
    });
  });
});

describe("UI — regresión CSS del indicador persistente", () => {
  it("[hidden] prevalece sobre display:flex/grid de .loading/.cards/.empty-state", () => {
    expect(stylesCss).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    expect(stylesCss).toMatch(/\.loading\s*\{\s*display:\s*flex/);
  });
});

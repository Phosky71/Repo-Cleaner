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
  checked: boolean;
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
  dispatch(type: string): void;
}

function makeElement(id = ""): ShimElement {
  const el: ShimElement = {
    id,
    hidden: false,
    textContent: "",
    disabled: false,
    checked: false,
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
    },
    dispatch(type) {
      for (const fn of el.listeners[type] ?? []) fn({});
    }
  };
  let text = "";
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set: (value: string) => {
      text = value;
      el.children.length = 0;
    }
  });
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

function loadUi(
  fetchImpl: (url: string, options?: unknown) => Promise<ShimResponse>
): UiHarness {
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
  const actionRadios = ["trash", "permanent"].map((value, index) => {
    const el = makeElement();
    el.value = value;
    el.checked = index === 0;
    el.attrs.name = "action";
    return el;
  });
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
      if (selector === "main") return main;
      if (selector === 'input[name="action"]:checked') {
        return actionRadios.find((radio) => radio.checked) ?? null;
      }
      return null;
    },
    addEventListener(type: string, fn: () => void): void {
      (docListeners[type] ??= []).push(fn);
    }
  };

  const fetchMock = vi.fn(
    async (url: string | URL | Request, options?: unknown) => {
      const u = String(url);
      if (u === "/api/health") return jsonResponse(200, { status: "ok" });
      return fetchImpl(u, options);
    }
  );

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

describe("UI — flujo completo seleccionar → plan → confirmar → resultado", () => {
  const ENTRY = {
    absolutePath: "C:/demo/dist",
    relativePath: "dist",
    type: "directory",
    risk: "safe",
    sizeBytes: 10,
    reason: "Regenerable",
    matchedRule: "dist"
  };
  const INSPECT_OK = {
    id: "scan1",
    target: "C:/demo",
    projectTypes: ["nodejs"],
    meta: {
      types: ["nodejs"],
      markers: ["package.json"],
      languages: ["JavaScript"],
      packageManagers: ["npm"],
      frameworks: [],
      regenerationCommands: ["npm install"],
      isGitRepo: false,
      gitPendingChanges: false
    },
    summary: {
      totalFiles: 2,
      totalDirectories: 1,
      totalSizeBytes: 20,
      safeBytes: 10,
      reviewBytes: 0,
      protectedBytes: 0,
      lastModified: "2026-01-01T00:00:00Z"
    },
    entries: [ENTRY],
    warnings: []
  };
  const PLAN_OK = {
    plan: {
      id: "p1",
      items: [{ entry: ENTRY, action: "trash", approved: true }],
      totalBytes: 10
    },
    planHash: "a".repeat(64),
    action: "trash",
    expiresAt: "2026-01-01T01:00:00Z"
  };
  const CLEAN_OK = {
    result: {
      executedCount: 1,
      failedCount: 0,
      skippedCount: 0,
      freedBytes: 10,
      action: "trash",
      items: [
        {
          entry: ENTRY,
          action: "trash",
          result: "trashed",
          sizeBytes: 10
        }
      ],
      git: { available: false, output: "no repo" }
    },
    reportId: "r1"
  };

  function flowFetch(
    cleanHandler: (options?: unknown) => Promise<ShimResponse>
  ) {
    return async (url: string, options?: unknown): Promise<ShimResponse> => {
      if (url === "/api/scan") return jsonResponse(200, SCAN_OK);
      if (url === "/api/inspect") return jsonResponse(200, INSPECT_OK);
      if (url === "/api/plan") return jsonResponse(200, PLAN_OK);
      if (url === "/api/clean") return cleanHandler(options);
      throw new Error(`ruta inesperada: ${url}`);
    };
  }

  async function driveToPlan(h: UiHarness): Promise<void> {
    h.el("root-path").value = "C:/demo";
    h.el("btn-scan").click();
    await vi.waitFor(() => {
      expect(h.el("view-projects").hidden).toBe(false);
    });
    const card = h.el("projects-list").children[0] as ShimElement;
    const actions = card.children[4] as ShimElement;
    (actions.children[0] as ShimElement).click();
    await vi.waitFor(() => {
      expect(h.el("artifacts-body").children.length).toBeGreaterThan(0);
    });
    const row = h.el("artifacts-body").children[0] as ShimElement;
    const checkbox = (row.children[0] as ShimElement)
      .children[0] as ShimElement;
    checkbox.checked = true;
    checkbox.dispatch("change");
    await vi.waitFor(() => {
      expect(h.el("btn-generate-plan").disabled).toBe(false);
    });
    h.el("btn-generate-plan").click();
    await vi.waitFor(() => {
      expect(h.el("view-plan").hidden).toBe(false);
    });
  }

  const cleanCalls = (h: UiHarness) =>
    h.fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/clean");

  it("flujo completo: el planId enviado coincide con el recibido y llega al resultado", async () => {
    const h = loadUi(flowFetch(async () => jsonResponse(200, CLEAN_OK)));
    await driveToPlan(h);
    h.el("btn-confirm-clean").click();
    await vi.waitFor(() => {
      expect(h.el("view-result").hidden).toBe(false);
    });
    const calls = cleanCalls(h);
    expect(calls).toHaveLength(1);
    const options = calls[0]?.[1] as { body: string } | undefined;
    const body = JSON.parse(options?.body ?? "{}") as {
      planId: string;
      confirmed: boolean;
      action: string;
    };
    expect(body.planId).toBe("p1");
    expect(body.confirmed).toBe(true);
    expect(body.action).toBe("trash");
    expect(h.el("result-stats").children.length).toBe(5);
    expect(h.el("result-body").children.length).toBe(1);
  });

  it("doble clic de confirmación pendiente produce exactamente un POST", async () => {
    let resolveClean: (r: ShimResponse) => void = () => {};
    const h = loadUi(
      flowFetch(
        () =>
          new Promise<ShimResponse>((resolve) => {
            resolveClean = resolve;
          })
      )
    );
    await driveToPlan(h);
    h.el("btn-confirm-clean").click();
    h.el("btn-confirm-clean").click();
    expect(cleanCalls(h)).toHaveLength(1);
    resolveClean(jsonResponse(200, CLEAN_OK));
    await vi.waitFor(() => {
      expect(h.el("view-result").hidden).toBe(false);
    });
    expect(cleanCalls(h)).toHaveLength(1);
  });

  it("404 invalida el plan, bloquea confirmaciones y explica el siguiente paso", async () => {
    const h = loadUi(
      flowFetch(async () =>
        jsonResponse(404, { error: "El plan no existe o ya fue ejecutado" })
      )
    );
    await driveToPlan(h);
    h.el("btn-confirm-clean").click();
    await vi.waitFor(() => {
      expect(h.el("plan-invalid").hidden).toBe(false);
    });
    expect(h.el("btn-confirm-clean").disabled).toBe(true);
    expect(h.el("plan-invalid-message").textContent).toContain("papelera");
    expect(h.el("plan-invalid-message").textContent).toContain("inspeccionar");
    h.el("btn-confirm-clean").click();
    expect(cleanCalls(h)).toHaveLength(1);
  });

  it("410 (expirado) invalida el plan sin permitir reconfirmar", async () => {
    const h = loadUi(
      flowFetch(async () => jsonResponse(410, { error: "El plan ha expirado" }))
    );
    await driveToPlan(h);
    h.el("btn-confirm-clean").click();
    await vi.waitFor(() => {
      expect(h.el("plan-invalid").hidden).toBe(false);
    });
    expect(h.el("btn-confirm-clean").disabled).toBe(true);
    h.el("btn-confirm-clean").click();
    expect(cleanCalls(h)).toHaveLength(1);
  });

  it("fallo de red tras enviar: resultado incierto, sin reintento automático", async () => {
    const h = loadUi(
      flowFetch(async () => {
        throw new TypeError("fetch failed");
      })
    );
    await driveToPlan(h);
    h.el("btn-confirm-clean").click();
    await vi.waitFor(() => {
      expect(h.el("plan-invalid").hidden).toBe(false);
    });
    expect(h.el("plan-invalid-message").textContent).toContain(
      "Resultado incierto"
    );
    expect(h.el("plan-invalid-message").textContent).toContain("papelera");
    expect(h.el("btn-confirm-clean").disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cleanCalls(h)).toHaveLength(1);
  });

  it("tras invalidar, reinspeccionar permite generar un plan nuevo y confirmar", async () => {
    let fail = true;
    const h = loadUi(
      flowFetch(async () => {
        if (fail) {
          return jsonResponse(404, { error: "El plan no existe" });
        }
        return jsonResponse(200, CLEAN_OK);
      })
    );
    await driveToPlan(h);
    h.el("btn-confirm-clean").click();
    await vi.waitFor(() => {
      expect(h.el("plan-invalid").hidden).toBe(false);
    });
    fail = false;
    h.el("btn-plan-reinspect").click();
    await vi.waitFor(() => {
      expect(h.el("inspect-loading").hidden).toBe(true);
      expect(h.el("artifacts-body").children.length).toBeGreaterThan(0);
    });
    const row = h.el("artifacts-body").children[0] as ShimElement;
    const checkbox = (row.children[0] as ShimElement)
      .children[0] as ShimElement;
    checkbox.checked = true;
    checkbox.dispatch("change");
    h.el("btn-generate-plan").click();
    await vi.waitFor(() => {
      expect(h.el("view-plan").hidden).toBe(false);
    });
    expect(h.el("plan-invalid").hidden).toBe(true);
    h.el("btn-confirm-clean").click();
    await vi.waitFor(() => {
      expect(h.el("view-result").hidden).toBe(false);
    });
    expect(cleanCalls(h)).toHaveLength(2);
  });
});

describe("UI — invalidación del plan de restauración", () => {
  const TRASH_LIST = {
    sessions: [
      {
        sessionId: "s1",
        sessionDir: "C:/demo/.repo-cleaner-trash/s1",
        createdAt: "2026-01-01T00:00:00Z",
        planId: "p0",
        planHash: "a".repeat(64),
        itemCount: 1,
        pendingCount: 1,
        restoredCount: 0,
        restorableCount: 1,
        totalBytes: 10,
        status: "restorable"
      }
    ]
  };
  const TRASH_DETAIL = {
    session: {
      id: "sess",
      sessionId: "s1",
      target: "C:/demo",
      createdAt: "2026-01-01T00:00:00Z",
      planId: "p0",
      planHash: "a".repeat(64),
      sessionDir: "C:/demo/.repo-cleaner-trash/s1",
      itemsDir: "C:/demo/.repo-cleaner-trash/s1/items",
      items: []
    },
    items: [
      {
        meta: {
          relativePath: "dist",
          sizeBytes: 10,
          risk: "safe",
          restored: false
        },
        storedExists: true,
        originalExists: false,
        conflict: false
      }
    ]
  };
  const RESTORE_PLAN = {
    plan: {
      id: "rp1",
      items: [
        {
          meta: { relativePath: "dist", sizeBytes: 10, risk: "safe" },
          approved: true,
          conflict: false,
          resolution: "cancel",
          storedExists: true,
          originalExists: false
        }
      ],
      totalBytes: 10
    },
    planHash: "b".repeat(64),
    expiresAt: "2026-01-01T01:00:00Z"
  };

  function restoreFetch(executeHandler: () => Promise<ShimResponse>) {
    return async (url: string): Promise<ShimResponse> => {
      if (url === "/api/scan") return jsonResponse(200, SCAN_OK);
      if (url === "/api/inspect") {
        return jsonResponse(200, {
          id: "scan1",
          target: "C:/demo",
          projectTypes: ["nodejs"],
          meta: {
            languages: [],
            packageManagers: [],
            frameworks: [],
            regenerationCommands: [],
            isGitRepo: false,
            gitPendingChanges: false
          },
          summary: {
            totalSizeBytes: 10,
            safeBytes: 10,
            reviewBytes: 0,
            protectedBytes: 0,
            lastModified: "2026-01-01T00:00:00Z"
          },
          entries: [],
          warnings: []
        });
      }
      if (url.startsWith("/api/trash/") && url.endsWith("/s1")) {
        return jsonResponse(200, TRASH_DETAIL);
      }
      if (url.startsWith("/api/trash/")) return jsonResponse(200, TRASH_LIST);
      if (url === "/api/restore/plan") return jsonResponse(200, RESTORE_PLAN);
      if (url === "/api/restore/execute") return executeHandler();
      throw new Error(`ruta inesperada: ${url}`);
    };
  }

  async function driveToRestoreConfirm(h: UiHarness): Promise<void> {
    h.el("root-path").value = "C:/demo";
    h.el("btn-scan").click();
    await vi.waitFor(() => {
      expect(h.el("view-projects").hidden).toBe(false);
    });
    const card = h.el("projects-list").children[0] as ShimElement;
    ((card.children[4] as ShimElement).children[0] as ShimElement).click();
    await vi.waitFor(() => {
      expect(h.el("inspect-loading").hidden).toBe(true);
    });
    h.el("btn-open-trash").click();
    await vi.waitFor(() => {
      expect(h.el("trash-sessions").children.length).toBeGreaterThan(0);
    });
    const sessionCard = h.el("trash-sessions").children[0] as ShimElement;
    (
      (sessionCard.children[4] as ShimElement).children[0] as ShimElement
    ).click();
    await vi.waitFor(() => {
      expect(h.el("trash-items-body").children.length).toBeGreaterThan(0);
    });
    const row = h.el("trash-items-body").children[0] as ShimElement;
    const checkbox = (row.children[0] as ShimElement)
      .children[0] as ShimElement;
    checkbox.checked = true;
    checkbox.dispatch("change");
    h.el("btn-restore-plan").click();
    await vi.waitFor(() => {
      expect(h.el("restore-confirm").hidden).toBe(false);
    });
  }

  const executeCalls = (h: UiHarness) =>
    h.fetchMock.mock.calls.filter(
      (c) => String(c[0]) === "/api/restore/execute"
    );

  it("404 en restauración invalida su plan, oculta la confirmación y bloquea el botón", async () => {
    const h = loadUi(
      restoreFetch(async () =>
        jsonResponse(404, {
          error: "El plan de restauración no existe o ya fue ejecutado"
        })
      )
    );
    await driveToRestoreConfirm(h);
    expect(h.el("btn-restore-execute").disabled).toBe(false);
    h.el("btn-restore-execute").click();
    await vi.waitFor(() => {
      expect(h.el("restore-confirm").hidden).toBe(true);
    });
    expect(h.el("btn-restore-execute").disabled).toBe(true);
    expect(h.el("error-banner").textContent).toContain("papelera");
    expect(h.el("error-banner").textContent).not.toContain(
      "no se ha tocado nada"
    );
    h.el("btn-restore-execute").click();
    expect(executeCalls(h)).toHaveLength(1);
  });

  it("fallo de red en restauración: resultado incierto y sin reintento", async () => {
    const h = loadUi(
      restoreFetch(async () => {
        throw new TypeError("fetch failed");
      })
    );
    await driveToRestoreConfirm(h);
    h.el("btn-restore-execute").click();
    await vi.waitFor(() => {
      expect(h.el("restore-confirm").hidden).toBe(true);
    });
    expect(h.el("error-banner").textContent).toContain("Resultado incierto");
    expect(h.el("btn-restore-execute").disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeCalls(h)).toHaveLength(1);
  });
});

describe("UI — regresión CSS del indicador persistente", () => {
  it("[hidden] prevalece sobre display:flex/grid de .loading/.cards/.empty-state", () => {
    expect(stylesCss).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    expect(stylesCss).toMatch(/\.loading\s*\{\s*display:\s*flex/);
  });
});

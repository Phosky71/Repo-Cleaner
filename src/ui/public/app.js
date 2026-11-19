"use strict";

/** Repo Cleaner UI — vanilla JS. Todo el contenido dinámico usa textContent. */

const state = {
  root: "",
  scan: null,
  inspect: null,
  selection: new Set(),
  filter: "all",
  planResp: null,
  resultResp: null,
  resultKind: "clean",
  lastProjectPath: "",
  reports: [],
  busy: false,
  trash: {
    projectPath: "",
    sessions: [],
    session: null,
    items: [],
    selection: new Set(),
    planResp: null
  }
};

const $ = (id) => document.getElementById(id);

/** Evita envíos duplicados y marca el estado de carga global. */
async function guarded(fn) {
  if (state.busy) return;
  state.busy = true;
  document.querySelector("main").setAttribute("aria-busy", "true");
  try {
    await fn();
  } finally {
    state.busy = false;
    document.querySelector("main").setAttribute("aria-busy", "false");
  }
}

function fmtBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function fmtDate(iso) {
  return (iso || "").slice(0, 10);
}

function showView(name) {
  for (const section of document.querySelectorAll(".view")) {
    section.hidden = section.id !== `view-${name}`;
  }
  clearError();
  window.scrollTo(0, 0);
}

function showError(message) {
  const banner = $("error-banner");
  banner.textContent = message;
  banner.hidden = false;
}

function clearError() {
  $("error-banner").hidden = true;
}

class ApiCallError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, body) {
  const options = { headers: { "Content-Type": "application/json" } };
  if (body !== undefined) {
    options.method = "POST";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiCallError(
      "Error de red: no se pudo contactar con el servidor local. Comprueba que sigue en ejecución y vuelve a intentarlo.",
      0
    );
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message =
      data && typeof data.error === "string"
        ? data.error
        : `Error HTTP ${response.status}`;
    throw new ApiCallError(message, response.status);
  }
  return data;
}

function badge(text, kind) {
  const span = document.createElement("span");
  span.className = `badge badge-${kind}`;
  span.textContent = text;
  return span;
}

function chip(label, value, kind) {
  const span = document.createElement("span");
  span.className = "chip";
  if (kind) span.classList.add(`chip-${kind}`);
  const strong = document.createElement("strong");
  strong.textContent = value;
  span.append(`${label} `, strong);
  return span;
}

function setLoading(id, on) {
  $(id).hidden = !on;
}

/* ---------- 1. Inicio / escaneo ---------- */

async function runScan(rootPath) {
  clearError();
  setLoading("home-loading", true);
  setLoading("projects-loading", true);
  $("btn-scan").disabled = true;
  $("btn-rescan").disabled = true;
  try {
    const data = await api("/api/scan", { rootPath });
    state.scan = data;
    state.root = rootPath;
    renderProjects();
    showView("projects");
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading("home-loading", false);
    setLoading("projects-loading", false);
    $("btn-scan").disabled = false;
    $("btn-rescan").disabled = false;
  }
}

/* ---------- 2. Proyectos ---------- */

function renderProjects() {
  const data = state.scan;
  const summary = data.summary;
  $("projects-summary").textContent =
    `${summary.projectCount} proyectos · ${summary.projectsWithArtifacts} con artefactos · ` +
    `Tamaño total: ${fmtBytes(summary.totalSizeBytes)} · ` +
    `Limpiable: ${fmtBytes(summary.safeBytes)} · Revisar: ${fmtBytes(summary.reviewBytes)}`;

  const list = $("projects-list");
  list.textContent = "";
  const noProjects = data.projects.length === 0;
  $("projects-empty").hidden = !noProjects;
  list.hidden = noProjects;
  for (const project of data.projects) {
    const card = document.createElement("article");
    card.className = "card";

    const title = document.createElement("h3");
    title.textContent = project.name;
    const pathEl = document.createElement("div");
    pathEl.className = "path mono";
    pathEl.textContent = project.relativePath;

    const meta = document.createElement("div");
    meta.className = "card-meta";
    const types = document.createElement("span");
    types.textContent = project.types.join(" · ");
    const size = document.createElement("span");
    size.textContent = fmtBytes(project.sizeBytes);
    const date = document.createElement("span");
    date.textContent = fmtDate(project.lastModified);
    meta.append(types, size, date);

    const artifacts = document.createElement("div");
    artifacts.className = "card-meta";
    if (project.artifacts.safeCount > 0) {
      artifacts.append(badge(`${project.artifacts.safeCount} safe`, "safe"));
    }
    if (project.artifacts.reviewCount > 0) {
      artifacts.append(
        badge(`${project.artifacts.reviewCount} review`, "review")
      );
    }
    if (!project.hasArtifacts) {
      const none = document.createElement("span");
      none.textContent = "Sin artefactos limpiables";
      artifacts.append(none);
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const inspectBtn = document.createElement("button");
    inspectBtn.className = "btn btn-primary";
    inspectBtn.textContent = "Inspeccionar";
    inspectBtn.addEventListener("click", () =>
      guarded(() => inspectProject(project.path))
    );
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn";
    copyBtn.textContent = "Copiar ruta";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(project.path);
        copyBtn.textContent = "Copiado ✓";
        setTimeout(() => (copyBtn.textContent = "Copiar ruta"), 1500);
      } catch {
        showError("No se pudo copiar al portapapeles");
      }
    });
    actions.append(inspectBtn, copyBtn);

    card.append(title, pathEl, meta, artifacts, actions);
    list.append(card);
  }
}

/* ---------- 3. Inspección ---------- */

async function inspectProject(projectPath) {
  clearError();
  state.lastProjectPath = projectPath;
  showView("inspect");
  $("inspect-title").textContent = projectPath;
  setLoading("inspect-loading", true);
  try {
    const report = await api("/api/inspect", { projectPath });
    state.inspect = report;
    state.selection = new Set();
    state.filter = "all";
    renderInspect();
  } catch (error) {
    showError(error.message);
    showView("projects");
  } finally {
    setLoading("inspect-loading", false);
  }
}

function renderInspect() {
  const report = state.inspect;
  const summary = report.summary;
  const counts = {
    all: report.entries.length,
    safe: 0,
    review: 0,
    protected: 0
  };
  for (const entry of report.entries) counts[entry.risk] += 1;

  const chips = $("inspect-summary");
  chips.textContent = "";
  chips.append(
    chip("Tipo:", report.projectTypes.join(" · ")),
    chip("Tamaño:", fmtBytes(summary.totalSizeBytes)),
    chip("Modificado:", fmtDate(summary.lastModified)),
    chip("Limpiable:", fmtBytes(summary.safeBytes)),
    chip("safe:", String(counts.safe)),
    chip("review:", String(counts.review)),
    chip("protected:", String(counts.protected))
  );

  const meta = report.meta;
  const metaChips = $("inspect-meta");
  metaChips.textContent = "";
  metaChips.append(
    chip("Lenguajes:", meta.languages.join(", ") || "—"),
    chip("Gestores:", meta.packageManagers.join(", ") || "—"),
    chip("Frameworks:", meta.frameworks.join(", ") || "—"),
    chip(
      "Git:",
      meta.isGitRepo
        ? meta.gitPendingChanges
          ? "cambios pendientes"
          : "sin cambios"
        : "no repositorio"
    )
  );

  const warningsBox = $("inspect-warnings");
  if (report.warnings.length > 0) {
    warningsBox.hidden = false;
    warningsBox.textContent = report.warnings.join(" · ");
  } else {
    warningsBox.hidden = true;
  }

  const regenPanel = $("inspect-regen");
  const regenList = $("inspect-regen-list");
  regenList.textContent = "";
  if (meta.regenerationCommands.length > 0) {
    regenPanel.hidden = false;
    for (const command of meta.regenerationCommands) {
      const li = document.createElement("li");
      const code = document.createElement("span");
      code.className = "path";
      code.textContent = `$ ${command}`;
      li.append(code);
      regenList.append(li);
    }
  } else {
    regenPanel.hidden = true;
  }

  $("count-all").textContent = String(counts.all);
  $("count-safe").textContent = String(counts.safe);
  $("count-review").textContent = String(counts.review);
  $("count-protected").textContent = String(counts.protected);
  for (const button of document.querySelectorAll(".btn-filter")) {
    button.classList.toggle("active", button.dataset.filter === state.filter);
  }

  const tbody = $("artifacts-body");
  tbody.textContent = "";
  const visible = report.entries.filter(
    (entry) => state.filter === "all" || entry.risk === state.filter
  );
  $("inspect-empty").hidden = report.entries.length > 0;
  $("artifacts-empty").hidden = visible.length > 0;
  for (const entry of visible) {
    const tr = document.createElement("tr");
    if (entry.risk === "protected") tr.className = "row-protected";

    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selection.has(entry.relativePath);
    // Nunca se pueden seleccionar elementos protegidos.
    checkbox.disabled = entry.risk === "protected";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selection.add(entry.relativePath);
      else state.selection.delete(entry.relativePath);
      updateSelectionUi();
    });
    tdCheck.append(checkbox);

    const tdPath = document.createElement("td");
    tdPath.className = "path";
    tdPath.textContent = entry.relativePath;

    const tdType = document.createElement("td");
    tdType.textContent = entry.type === "directory" ? "carpeta" : "archivo";

    const tdRisk = document.createElement("td");
    tdRisk.append(badge(entry.risk, entry.risk));

    const tdSize = document.createElement("td");
    tdSize.className = "size";
    tdSize.textContent = fmtBytes(entry.sizeBytes);

    const tdRule = document.createElement("td");
    tdRule.className = "mono";
    tdRule.textContent = entry.matchedRule || "—";

    const tdReason = document.createElement("td");
    tdReason.className = "reason";
    tdReason.textContent = entry.reason;

    tr.append(tdCheck, tdPath, tdType, tdRisk, tdSize, tdRule, tdReason);
    tbody.append(tr);
  }
  updateSelectionUi();
}

function updateSelectionUi() {
  const count = state.selection.size;
  $("selection-count").textContent =
    count === 0 ? "Nada seleccionado" : `${count} seleccionados`;
  $("btn-generate-plan").disabled = count === 0;
}

/* ---------- 4. Plan ---------- */

async function generatePlan() {
  clearError();
  const action = document.querySelector('input[name="action"]:checked').value;
  setLoading("plan-loading", true);
  $("btn-generate-plan").disabled = true;
  try {
    const data = await api("/api/plan", {
      projectPath: state.inspect.target,
      selectedRelativePaths: [...state.selection],
      action
    });
    state.planResp = data;
    renderPlan();
    showView("plan");
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading("plan-loading", false);
    $("btn-generate-plan").disabled = state.selection.size === 0;
  }
}

function renderPlan() {
  $("plan-invalid").hidden = true;
  const { plan, planHash, action, expiresAt } = state.planResp;
  const chips = $("plan-summary");
  chips.textContent = "";
  chips.append(
    chip("Elementos:", String(plan.items.length)),
    chip("Total:", fmtBytes(plan.totalBytes)),
    chip("Acción:", action === "trash" ? "papelera local" : "PERMANENTE"),
    chip("Hash:", `${planHash.slice(0, 12)}…`),
    chip("Caduca:", new Date(expiresAt).toLocaleTimeString())
  );

  const isPermanent = action === "permanent";
  $("plan-action-note").textContent = isPermanent
    ? "Acción: eliminación permanente e irreversible. No habrá copia en la papelera."
    : `Acción: mover ${plan.items.length} elementos (${fmtBytes(plan.totalBytes)}) a la papelera local. Es reversible: podrás restaurarlos desde la vista Papelera.`;
  $("plan-warning").hidden = !isPermanent;
  $("permanent-confirm-wrap").hidden = !isPermanent;
  $("permanent-confirm").value = "";

  const list = $("plan-items");
  list.textContent = "";
  for (const item of plan.items) {
    const li = document.createElement("li");
    li.append(badge(item.entry.risk, item.entry.risk));
    const pathEl = document.createElement("span");
    pathEl.className = "path";
    pathEl.textContent = item.entry.relativePath;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = fmtBytes(item.entry.sizeBytes);
    li.append(pathEl, size);
    list.append(li);
  }
  updateConfirmButton();
}

function updateConfirmButton() {
  if (!state.planResp) {
    $("btn-confirm-clean").disabled = true;
    return;
  }
  const isPermanent = state.planResp.action === "permanent";
  const typedOk = $("permanent-confirm").value.trim() === "PERMANENTE";
  $("btn-confirm-clean").disabled = isPermanent ? !typedOk : false;
}

function invalidateCleanPlan(message) {
  state.planResp = null;
  $("btn-confirm-clean").disabled = true;
  $("permanent-confirm-wrap").hidden = true;
  $("plan-warning").hidden = true;
  $("plan-invalid-message").textContent = message;
  $("plan-invalid").hidden = false;
}

async function confirmClean() {
  clearError();
  setLoading("clean-loading", true);
  $("btn-confirm-clean").disabled = true;
  $("btn-cancel-plan").disabled = true;
  try {
    const data = await api("/api/clean", {
      planId: state.planResp.plan.id,
      confirmed: true,
      action: state.planResp.action
    });
    state.resultResp = data;
    state.resultKind = "clean";
    renderResult();
    showView("result");
  } catch (error) {
    if (error.status === 404 || error.status === 410 || error.status === 0) {
      invalidateCleanPlan(
        error.status === 0
          ? "Resultado incierto: la petición se envió pero no se recibió respuesta. La limpieza pudo ejecutarse. Consulta la papelera y los informes antes de volver a intentarlo."
          : "El plan ya no es válido (consumido o expirado). Si ya confirmaste, la limpieza pudo ejecutarse: consulta la papelera y los informes. Vuelve a inspeccionar el proyecto para generar un plan nuevo."
      );
    } else {
      showError(error.message);
    }
  } finally {
    setLoading("clean-loading", false);
    $("btn-cancel-plan").disabled = false;
    updateConfirmButton();
  }
}

/* ---------- 5. Resultado (limpieza o restauración) ---------- */

function renderResult() {
  const { result, reportId } = state.resultResp;
  const isRestore = state.resultKind === "restore";
  const stats = $("result-stats");
  stats.textContent = "";
  if (isRestore) {
    stats.append(
      chip("Restaurados:", String(result.restoredCount)),
      chip("Fallidos:", String(result.failedCount)),
      chip("Omitidos:", String(result.skippedCount)),
      chip("Conflictos:", String(result.conflictCount)),
      chip("Tamaño:", fmtBytes(result.restoredBytes))
    );
  } else {
    stats.append(
      chip("Ejecutados:", String(result.executedCount)),
      chip("Fallidos:", String(result.failedCount)),
      chip("Omitidos:", String(result.skippedCount)),
      chip("Liberado:", fmtBytes(result.freedBytes)),
      chip("Acción:", result.action === "trash" ? "papelera" : "permanente")
    );
  }

  const gitNote = $("result-git");
  if (isRestore) {
    gitNote.hidden = true;
  } else if (result.git && result.git.available) {
    gitNote.hidden = false;
    if (result.git.deletedTracked.length > 0) {
      gitNote.className = "git-note alert";
      gitNote.textContent =
        `⚠ Git detecta ${result.git.deletedTracked.length} ficheros versionados eliminados. ` +
        "Revisa el informe antes de continuar.";
    } else {
      gitNote.className = "git-note";
      gitNote.textContent =
        "Git: sin eliminaciones inesperadas de ficheros versionados.";
    }
  } else {
    gitNote.hidden = false;
    gitNote.className = "git-note";
    gitNote.textContent =
      (result.git && result.git.output) || "Verificación Git no disponible.";
  }

  const tbody = $("result-body");
  tbody.textContent = "";
  for (const item of result.items) {
    const tr = document.createElement("tr");
    const tdPath = document.createElement("td");
    tdPath.className = "path";
    tdPath.textContent = isRestore
      ? item.relativePath
      : item.entry.relativePath;
    const tdRisk = document.createElement("td");
    const risk = isRestore ? item.risk : item.entry.risk;
    tdRisk.append(badge(risk, risk));
    const tdAction = document.createElement("td");
    tdAction.textContent = isRestore
      ? "restaurar"
      : item.action === "trash"
        ? "papelera"
        : "permanente";
    const tdResult = document.createElement("td");
    tdResult.append(badge(item.result, item.result));
    const tdSize = document.createElement("td");
    tdSize.className = "size";
    tdSize.textContent = fmtBytes(item.sizeBytes);
    const tdDetail = document.createElement("td");
    tdDetail.className = "reason";
    tdDetail.textContent =
      item.error || item.restoredPath || item.storedPath || "—";
    tr.append(tdPath, tdRisk, tdAction, tdResult, tdSize, tdDetail);
    tbody.append(tr);
  }

  $("download-json").href = `/api/report/${reportId}?download=1`;
  $("download-md").href = `/api/report/${reportId}?format=markdown&download=1`;
}

/* ---------- 3b. Papelera y restauración ---------- */

async function openTrash(projectPath) {
  clearError();
  state.trash.projectPath = projectPath;
  state.trash.session = null;
  state.trash.planResp = null;
  $("trash-detail").hidden = true;
  $("restore-confirm").hidden = true;
  showView("trash");
  setLoading("trash-loading", true);
  try {
    const data = await api(`/api/trash/${encodeURIComponent(projectPath)}`);
    state.trash.sessions = data.sessions;
    renderTrashSessions();
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading("trash-loading", false);
  }
}

function renderTrashSessions() {
  const list = $("trash-sessions");
  list.textContent = "";
  const purgeable = state.trash.sessions.filter(
    (session) => session.restorableCount === 0
  );
  $("btn-trash-purge").hidden = purgeable.length === 0;
  if (state.trash.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No hay sesiones de papelera en este proyecto.";
    list.append(empty);
    return;
  }
  for (const session of state.trash.sessions) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h3");
    title.className = "mono";
    title.textContent = session.sessionId;
    const meta = document.createElement("div");
    meta.className = "card-meta";
    const date = document.createElement("span");
    date.textContent = fmtDate(session.createdAt);
    const items = document.createElement("span");
    items.textContent = `${session.itemCount} elementos · ${session.pendingCount} pendientes`;
    const size = document.createElement("span");
    size.textContent = fmtBytes(session.totalBytes);
    meta.append(date, items, size);
    const hash = document.createElement("div");
    hash.className = "path mono";
    hash.textContent = `plan ${session.planHash.slice(0, 16)}…`;
    const status = document.createElement("div");
    const statusUi = {
      restorable: { kind: "safe", label: "Restaurable" },
      restored: { kind: "skipped", label: "Restaurada" },
      partial: { kind: "review", label: "Parcialmente restaurable" },
      unrestorable: { kind: "protected", label: "No restaurable" }
    }[session.status] ?? { kind: "protected", label: "No restaurable" };
    status.append(badge(statusUi.label, statusUi.kind));
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const openBtn = document.createElement("button");
    openBtn.className = "btn btn-primary";
    openBtn.textContent = "Ver sesión";
    openBtn.disabled = session.restorableCount === 0;
    openBtn.addEventListener("click", () =>
      openTrashSession(session.sessionId)
    );
    actions.append(openBtn);
    card.append(title, meta, hash, status, actions);
    list.append(card);
  }
}

async function openTrashSession(sessionId) {
  clearError();
  setLoading("trash-loading", true);
  try {
    const data = await api(
      `/api/trash/${encodeURIComponent(state.trash.projectPath)}/${encodeURIComponent(sessionId)}`
    );
    state.trash.session = data.session;
    state.trash.items = data.items;
    state.trash.selection = new Set();
    state.trash.planResp = null;
    $("restore-confirm").hidden = true;
    renderTrashDetail();
    $("trash-detail").hidden = false;
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading("trash-loading", false);
  }
}

function itemStateLabel(item) {
  if (item.meta.restored) return "ya restaurado";
  if (!item.storedExists) return "almacén inexistente";
  if (item.conflict) return "conflicto: destino existe";
  return "listo para restaurar";
}

function renderTrashDetail() {
  const session = state.trash.session;
  $("trash-session-title").textContent = `Sesión ${session.sessionId}`;
  const chips = $("trash-session-summary");
  chips.textContent = "";
  chips.append(
    chip("Creada:", fmtDate(session.createdAt)),
    chip("Elementos:", String(session.items.length)),
    chip("Plan original:", session.planId.slice(0, 8) + "…"),
    chip("Hash:", session.planHash.slice(0, 12) + "…")
  );

  const tbody = $("trash-items-body");
  tbody.textContent = "";
  for (const item of state.trash.items) {
    const tr = document.createElement("tr");
    const selectable = item.storedExists && !item.meta.restored;
    if (!selectable) tr.className = "row-protected";

    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = !selectable;
    checkbox.checked = state.trash.selection.has(item.meta.relativePath);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.trash.selection.add(item.meta.relativePath);
      else state.trash.selection.delete(item.meta.relativePath);
      updateTrashSelectionUi();
    });
    tdCheck.append(checkbox);

    const tdPath = document.createElement("td");
    tdPath.className = "path";
    tdPath.textContent = item.meta.relativePath;
    const tdSize = document.createElement("td");
    tdSize.className = "size";
    tdSize.textContent = fmtBytes(item.meta.sizeBytes);
    const tdRisk = document.createElement("td");
    tdRisk.append(badge(item.meta.risk, item.meta.risk));
    const tdState = document.createElement("td");
    tdState.className = "reason";
    tdState.textContent = itemStateLabel(item);

    tr.append(tdCheck, tdPath, tdSize, tdRisk, tdState);
    tbody.append(tr);
  }
  updateTrashSelectionUi();
}

function updateTrashSelectionUi() {
  const count = state.trash.selection.size;
  $("trash-selection-count").textContent =
    count === 0 ? "Nada seleccionado" : `${count} seleccionados`;
  $("btn-restore-plan").disabled = count === 0;
}

async function generateRestorePlan() {
  clearError();
  setLoading("restore-loading", true);
  $("btn-restore-plan").disabled = true;
  try {
    const data = await api("/api/restore/plan", {
      projectPath: state.trash.projectPath,
      sessionId: state.trash.session.sessionId,
      selectedRelativePaths: [...state.trash.selection],
      onConflict: $("trash-conflict-mode").value
    });
    state.trash.planResp = data;
    renderRestoreConfirm();
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading("restore-loading", false);
    updateTrashSelectionUi();
  }
}

function renderRestoreConfirm() {
  const { plan, planHash } = state.trash.planResp;
  const chips = $("restore-plan-summary");
  chips.textContent = "";
  chips.append(
    chip("Elementos:", String(plan.items.length)),
    chip("Tamaño:", fmtBytes(plan.totalBytes)),
    chip("Sesión:", plan.sessionId),
    chip("Hash:", planHash.slice(0, 12) + "…")
  );
  const conflicts = plan.items.filter((item) => item.conflict);
  const overwrites = conflicts.filter(
    (item) => item.resolution === "overwrite"
  );
  const needsOverwrite = overwrites.length > 0;
  $("restore-overwrite-warning").hidden = !needsOverwrite;
  $("restore-overwrite-input").hidden = !needsOverwrite;
  $("restore-overwrite-input").value = "";
  const overwriteList = $("restore-overwrite-list");
  overwriteList.textContent = "";
  overwriteList.hidden = !needsOverwrite;
  for (const item of overwrites) {
    const li = document.createElement("li");
    const pathEl = document.createElement("span");
    pathEl.className = "path";
    pathEl.textContent = `${item.meta.relativePath} → el contenido existente en su ruta original será reemplazado`;
    li.append(pathEl);
    overwriteList.append(li);
  }
  if (conflicts.length > 0 && !needsOverwrite) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = `${conflicts.length} elementos en conflicto se resolverán como "${conflicts[0].resolution}".`;
    chips.append(note);
  }
  $("restore-confirm").hidden = false;
  updateRestoreConfirmButton();
}

function updateRestoreConfirmButton() {
  const plan = state.trash.planResp?.plan;
  if (!plan) {
    $("btn-restore-execute").disabled = true;
    return;
  }
  const needsOverwrite = plan.items.some(
    (item) => item.approved && item.conflict && item.resolution === "overwrite"
  );
  const typedOk = $("restore-overwrite-input").value.trim() === "OVERWRITE";
  $("btn-restore-execute").disabled = needsOverwrite ? !typedOk : false;
}

async function executeRestore() {
  clearError();
  setLoading("restore-loading", true);
  $("btn-restore-execute").disabled = true;
  try {
    const plan = state.trash.planResp.plan;
    const needsOverwrite = plan.items.some(
      (item) =>
        item.approved && item.conflict && item.resolution === "overwrite"
    );
    const data = await api("/api/restore/execute", {
      planId: plan.id,
      confirmed: true,
      ...(needsOverwrite ? { overwriteConfirmed: true } : {})
    });
    state.resultResp = data;
    state.resultKind = "restore";
    renderResult();
    showView("result");
  } catch (error) {
    if (error.status === 404 || error.status === 410 || error.status === 0) {
      state.trash.planResp = null;
      $("restore-confirm").hidden = true;
      showError(
        error.status === 0
          ? "Resultado incierto: la petición se envió pero no se recibió respuesta. La restauración pudo ejecutarse. Consulta la papelera y los informes antes de volver a intentarlo."
          : "El plan de restauración ya no es válido (consumido o expirado). Si ya confirmaste, la restauración pudo ejecutarse: consulta la papelera y los informes. Vuelve a seleccionar elementos para generar otro plan."
      );
    } else {
      showError(error.message);
    }
  } finally {
    setLoading("restore-loading", false);
    updateRestoreConfirmButton();
  }
}

/* ---------- 3c. Informes históricos ---------- */

const REPORT_KIND_BADGES = {
  scan: "skipped",
  inspect: "skipped",
  clean: "review",
  restore: "safe",
  trash: "protected",
  unknown: "skipped"
};

async function openReports() {
  clearError();
  showView("reports");
  $("report-detail").hidden = true;
  setLoading("reports-loading", true);
  try {
    const data = await api("/api/reports");
    state.reports = data.reports;
    renderReports();
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading("reports-loading", false);
  }
}

function renderReports() {
  const body = $("reports-body");
  body.textContent = "";
  $("reports-empty").hidden = state.reports.length > 0;
  $("reports-list").hidden = state.reports.length === 0;
  for (const report of state.reports) {
    const tr = document.createElement("tr");

    const tdDate = document.createElement("td");
    tdDate.textContent = report.generatedAt.slice(0, 16).replace("T", " ");
    const tdKind = document.createElement("td");
    tdKind.append(
      badge(report.kind, REPORT_KIND_BADGES[report.kind] ?? "skipped")
    );
    const tdTarget = document.createElement("td");
    tdTarget.className = "path";
    tdTarget.textContent = report.target;
    const tdSummary = document.createElement("td");
    tdSummary.textContent = report.summary;
    const tdStatus = document.createElement("td");
    tdStatus.textContent = report.status;

    const tdActions = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row";
    const viewJson = document.createElement("button");
    viewJson.className = "btn btn-filter";
    viewJson.textContent = "Ver";
    viewJson.addEventListener("click", () =>
      guarded(() => viewReport(report.id, "json"))
    );
    const viewMd = document.createElement("button");
    viewMd.className = "btn btn-filter";
    viewMd.textContent = "Markdown";
    viewMd.addEventListener("click", () =>
      guarded(() => viewReport(report.id, "md"))
    );
    const dlJson = document.createElement("a");
    dlJson.className = "btn btn-filter";
    dlJson.textContent = "JSON ↓";
    dlJson.href = `/api/reports/${report.id}/download?format=json`;
    dlJson.setAttribute("download", "");
    const dlMd = document.createElement("a");
    dlMd.className = "btn btn-filter";
    dlMd.textContent = "MD ↓";
    dlMd.href = `/api/reports/${report.id}/download?format=md`;
    dlMd.setAttribute("download", "");
    actions.append(viewJson, viewMd, dlJson, dlMd);
    tdActions.append(actions);

    tr.append(tdDate, tdKind, tdTarget, tdSummary, tdStatus, tdActions);
    body.append(tr);
  }
}

async function viewReport(id, format) {
  clearError();
  setLoading("reports-loading", true);
  try {
    let text;
    if (format === "md") {
      const response = await fetch(`/api/reports/${id}/download?format=md`);
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          data && typeof data.error === "string"
            ? data.error
            : `Error HTTP ${response.status}`
        );
      }
      text = await response.text();
    } else {
      const data = await api(`/api/reports/${id}`);
      text = JSON.stringify(data, null, 2);
    }
    $("report-detail-title").textContent =
      `${id} · ${format === "md" ? "Markdown" : "JSON"}`;
    $("report-detail-content").textContent = text;
    $("reports-list").hidden = true;
    $("reports-empty").hidden = true;
    $("report-detail").hidden = false;
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading("reports-loading", false);
  }
}

/* ---------- Purga de sesiones (UX D2) ---------- */

function openPurgeConfirm() {
  clearError();
  const purgeable = state.trash.sessions.filter(
    (session) => session.restorableCount === 0
  );
  if (purgeable.length === 0) return;
  const chips = $("purge-summary");
  chips.textContent = "";
  const totalBytes = purgeable.reduce((acc, s) => acc + s.totalBytes, 0);
  chips.append(
    chip("Sesiones:", String(purgeable.length)),
    chip(
      "Elementos:",
      String(purgeable.reduce((acc, s) => acc + s.itemCount, 0))
    ),
    chip("Tamaño:", fmtBytes(totalBytes))
  );
  $("purge-result").hidden = true;
  $("purge-confirm").hidden = false;
}

async function executePurge() {
  clearError();
  $("btn-purge-execute").disabled = true;
  try {
    const data = await api("/api/trash/purge", {
      projectPath: state.trash.projectPath,
      confirmed: true
    });
    const purgedCount = data.purged.filter(
      (item) => item.result === "purged"
    ).length;
    $("purge-confirm").hidden = true;
    const result = $("purge-result");
    result.hidden = false;
    result.textContent = `Purga completada: ${purgedCount} sesiones eliminadas · ${fmtBytes(data.freedBytes)} liberados · ${data.kept.length} conservadas. El registro de auditoría se conserva.`;
    const refreshed = await api(
      `/api/trash/${encodeURIComponent(state.trash.projectPath)}`
    );
    state.trash.sessions = refreshed.sessions;
    state.trash.session = null;
    $("trash-detail").hidden = true;
    renderTrashSessions();
  } catch (error) {
    showError(error.message);
  } finally {
    $("btn-purge-execute").disabled = false;
  }
}

/* ---------- Wiring ---------- */

function init() {
  const rootInput = $("root-path");
  $("allowed-root").textContent = rootInput.value;

  fetch("/api/health")
    .then((response) => response.json())
    .then((data) => {
      $("health-dot").classList.add(data.status === "ok" ? "ok" : "bad");
      $("health-dot").title =
        data.status === "ok" ? "Servidor operativo" : "Servidor con problemas";
    })
    .catch(() => $("health-dot").classList.add("bad"));

  $("btn-scan").addEventListener("click", () => {
    const value = rootInput.value.trim();
    if (!value) {
      showError(
        "Ruta inválida: introduce una ruta raíz dentro de la raíz autorizada."
      );
      return;
    }
    guarded(() => runScan(value));
  });
  rootInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("btn-scan").click();
  });

  $("btn-rescan").addEventListener("click", () =>
    guarded(() => runScan(state.root))
  );
  $("btn-back-home").addEventListener("click", () => showView("home"));
  $("btn-empty-change-root").addEventListener("click", () => showView("home"));
  $("btn-back-projects").addEventListener("click", () => showView("projects"));

  $("btn-open-trash").addEventListener("click", () =>
    guarded(() => openTrash(state.lastProjectPath))
  );
  $("btn-trash-back").addEventListener("click", () =>
    guarded(() => inspectProject(state.trash.projectPath))
  );
  $("btn-trash-select-all").addEventListener("click", () => {
    for (const item of state.trash.items) {
      if (item.storedExists && !item.meta.restored) {
        state.trash.selection.add(item.meta.relativePath);
      }
    }
    renderTrashDetail();
  });
  $("btn-trash-clear").addEventListener("click", () => {
    state.trash.selection.clear();
    renderTrashDetail();
  });
  $("btn-trash-purge").addEventListener("click", openPurgeConfirm);
  $("btn-purge-cancel").addEventListener("click", () => {
    $("purge-confirm").hidden = true;
  });
  $("btn-purge-execute").addEventListener("click", () => guarded(executePurge));
  $("btn-restore-plan").addEventListener("click", () =>
    guarded(generateRestorePlan)
  );
  $("btn-restore-cancel").addEventListener("click", () => {
    $("restore-confirm").hidden = true;
    state.trash.planResp = null;
  });
  $("restore-overwrite-input").addEventListener(
    "input",
    updateRestoreConfirmButton
  );
  $("btn-restore-execute").addEventListener("click", () =>
    guarded(executeRestore)
  );

  $("btn-open-reports").addEventListener("click", () => guarded(openReports));
  $("btn-reports-refresh").addEventListener("click", () =>
    guarded(openReports)
  );
  $("btn-reports-back").addEventListener("click", () =>
    showView(state.scan ? "projects" : "home")
  );
  $("btn-report-detail-back").addEventListener("click", () => {
    $("report-detail").hidden = true;
    $("reports-list").hidden = state.reports.length === 0;
    $("reports-empty").hidden = state.reports.length > 0;
  });

  for (const button of document.querySelectorAll(".btn-filter")) {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      renderInspect();
    });
  }

  $("btn-select-safe").addEventListener("click", () => {
    for (const entry of state.inspect.entries) {
      if (entry.risk === "safe") state.selection.add(entry.relativePath);
    }
    renderInspect();
  });
  $("btn-clear-selection").addEventListener("click", () => {
    state.selection.clear();
    renderInspect();
  });
  $("btn-generate-plan").addEventListener("click", () => guarded(generatePlan));

  $("btn-cancel-plan").addEventListener("click", () => showView("inspect"));
  $("btn-plan-reinspect").addEventListener("click", () =>
    guarded(() => inspectProject(state.lastProjectPath))
  );
  $("permanent-confirm").addEventListener("input", updateConfirmButton);
  $("btn-confirm-clean").addEventListener("click", () => guarded(confirmClean));

  $("btn-back-to-project").addEventListener("click", () =>
    guarded(() => inspectProject(state.lastProjectPath))
  );
  $("btn-back-to-projects").addEventListener("click", () =>
    showView("projects")
  );
}

document.addEventListener("DOMContentLoaded", init);

"use strict";

const APP = {
  config: null,
  auth: null,
  selectedPatientId: "",
  selectedPatient: null,
  prescriptionPatientId: "",
  prescriptionPatientRecord: null,
  patientPickerTarget: "consultation",
  recentPatients: [],
  inventoryRows: [],
  medicalConfig: null,
  selectedDoctorId: "",
  editingDoctorId: "",
  doctorEditorActive: false,
  folioControl: null,
  prescriptionLines: [],
  prescriptionSearchRows: [],
  prescriptionHistory: [],
  selectedPrescription: null,
  folioEditEnabled: false,
  leftImageDraft: "",
  rightImageDraft: "",
  backupHandle: null,
  toastTimer: null
};

const DEVICE_SESSION_VERSION = 1;
const LAST_EMAIL_KEY = "macroxelCentralViewerLastEmail";
function deviceSessionKey() { return `macroxelCentralViewerDeviceSession:${APP.config?.storeId || "SIN_TIENDA"}`; }
function saveDeviceSession() {
  if (!APP.auth?.refreshToken || !APP.config?.storeId) return;
  const payload = { version: DEVICE_SESSION_VERSION, storeId: APP.config.storeId, firebaseUrl: APP.config.firebaseDatabaseUrl, uid: APP.auth.uid || "", email: APP.auth.email || "", refreshToken: APP.auth.refreshToken, savedAt: Date.now() };
  localStorage.setItem(deviceSessionKey(), JSON.stringify(payload));
  if (payload.email) localStorage.setItem(LAST_EMAIL_KEY, payload.email);
}
function loadDeviceSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(deviceSessionKey()) || "null");
    if (Number(raw?.version) !== DEVICE_SESSION_VERSION || raw?.storeId !== APP.config.storeId || String(raw?.firebaseUrl || "").replace(/\/+$/, "") !== APP.config.firebaseDatabaseUrl || !raw?.refreshToken) return null;
    return { uid: String(raw.uid || ""), email: String(raw.email || ""), idToken: "", refreshToken: String(raw.refreshToken), expiresAt: 0 };
  } catch (_) { return null; }
}
function clearDeviceSession({ keepEmail = true } = {}) {
  try { localStorage.removeItem(deviceSessionKey()); } catch (_) {}
  sessionStorage.removeItem("macroxelClinicalSession");
  if (!keepEmail) try { localStorage.removeItem(LAST_EMAIL_KEY); } catch (_) {}
}
async function fetchTimed(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) { if (error?.name === "AbortError") throw new Error("La validación tardó demasiado. Revisa Internet e inténtalo nuevamente."); throw error; }
  finally { clearTimeout(timer); }
}

const $ = (id) => document.getElementById(id);
const isoNow = () => new Date().toISOString();
const dateKey = (value = new Date()) => new Date(value).toISOString().slice(0, 10);
const text = (value, fallback = "—") => String(value ?? "").trim() || fallback;
const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const digits = (value) => String(value ?? "").replace(/\D+/g, "");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const money = (value) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(value) || 0);
const formatDate = (value, withTime = false) => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return text(value);
  return new Intl.DateTimeFormat("es-MX", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(d);
};
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const safeFile = (value) => normalize(value).replace(/\s+/g, "_").slice(0, 80) || "EXPEDIENTE";
const firebaseKey = (value) => String(value).replace(/[.#$\[\]/]/g, "_");
const jsonQueryValue = (value) => JSON.stringify(value);
const prescriptionQuantity = window.MacroxelPrescriptionQuantity;

if (!prescriptionQuantity?.infer || !prescriptionQuantity?.effective) {
  throw new Error("No se pudo iniciar el cálculo seguro de cantidades para farmacia.");
}

function toast(message, type = "") {
  const el = $("toast");
  clearTimeout(APP.toastTimer);
  el.textContent = message;
  el.className = `toast ${type}`.trim();
  el.hidden = false;
  APP.toastTimer = setTimeout(() => { el.hidden = true; }, 5200);
}

function setMessage(id, message, isError = false) {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function localDateTimeValue(date = new Date()) {
  const shift = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - shift).toISOString().slice(0, 16);
}

function validateConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const modules = Array.isArray(cfg.modules) ? cfg.modules.map(String) : [];
  if (Number(cfg.version) !== 4 || cfg.source !== "Macroxel FarmaControl" || cfg.purpose !== "central-viewers" || !modules.includes("clinical-records")) throw new Error("La configuración no corresponde al paquete central de visores vigente.");
  cfg.firebaseDatabaseUrl = String(cfg.firebaseDatabaseUrl || cfg.firebaseUrl || "");
  if (!/^https:\/\/[a-z0-9.-]+(?:firebaseio\.com|firebasedatabase\.app)\/?$/i.test(cfg.firebaseDatabaseUrl)) throw new Error("La URL operativa en línea no es válida.");
  if (!String(cfg.firebaseApiKey || "").trim()) throw new Error("Falta preparar el acceso seguro del visor desde Configuración.");
  cfg.storeId = String(cfg.storeId || cfg.tiendaId || "").trim();
  if (!cfg.storeId) throw new Error("Falta el identificador de la farmacia.");
  cfg.firebaseDatabaseUrl = String(cfg.firebaseDatabaseUrl).replace(/\/+$/, "");
  cfg.storeId = firebaseKey(cfg.storeId);
  cfg.pharmacyName = text(cfg.pharmacyName, "Farmacia");
  cfg.pharmacyAddress = String(cfg.pharmacyAddress || cfg.direccionFarmacia || "").trim().slice(0, 300);
  cfg.pharmacyPhone = String(cfg.pharmacyPhone || cfg.telefonoFarmacia || "").trim().slice(0, 30);
  return cfg;
}

async function loadConfig() {
  let response = null;
  for (const relative of ["../macroxel-config.json", "macroxel-config.json"]) {
    response = await fetch(`${relative}?v=${Date.now()}`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) break;
  }
  if (!response?.ok) throw new Error("No se pudo cargar la configuración central de visores.");
  APP.config = validateConfig(await response.json());
  $("login-farmacia").textContent = APP.config.pharmacyName;
  $("farmacia-name").textContent = APP.config.pharmacyName;
  document.title = `${APP.config.pharmacyName} · Visor Expediente Clínico y Existencias`;
}

function authError(code = "") {
  const c = String(code || "").toUpperCase();
  if (c.includes("INVALID_LOGIN_CREDENTIALS") || c.includes("INVALID_PASSWORD") || c.includes("EMAIL_NOT_FOUND")) return "Correo o contraseña incorrectos.";
  if (c.includes("USER_DISABLED")) return "Este usuario está deshabilitado en Firebase Auth.";
  if (c.includes("TOO_MANY_ATTEMPTS")) return "Hay demasiados intentos. Espera unos minutos e inténtalo nuevamente.";
  return "No fue posible iniciar sesión. Revisa la conexión e inténtalo nuevamente.";
}

async function identityLogin(email, password) {
  email = String(email || "").trim().toLowerCase();
  if (!email || !password) throw new Error("Escribe el correo y la contraseña.");
  const response = await fetchTimed(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(APP.config.firebaseApiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(authError(body?.error?.message));
  if (!body?.localId || !body?.refreshToken) throw new Error("Firebase no devolvió una sesión válida.");
  return { uid: body.localId, email: body.email || email, idToken: body.idToken, refreshToken: body.refreshToken, expiresAt: Date.now() + (Number(body.expiresIn) || 3600) * 1000 };
}

async function refreshAuth() {
  if (!APP.auth?.refreshToken) throw new Error("La sesión terminó. Inicia sesión nuevamente.");
  const response = await fetchTimed(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(APP.config.firebaseApiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: APP.auth.refreshToken })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("La sesión guardada ya no es válida. Inicia sesión nuevamente.");
  APP.auth = { ...APP.auth, uid: body.user_id || APP.auth.uid, idToken: body.id_token, refreshToken: body.refresh_token || APP.auth.refreshToken, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  sessionStorage.setItem("macroxelClinicalSession", JSON.stringify(APP.auth));
  saveDeviceSession();
}

async function sendPasswordReset() {
  const email = String($("login-email").value || "").trim().toLowerCase();
  if (!email) throw new Error("Escribe primero el correo autorizado.");
  const response = await fetchTimed(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(APP.config.firebaseApiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestType: "PASSWORD_RESET", email }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { if (String(body?.error?.message || "").includes("EMAIL_NOT_FOUND")) throw new Error("Ese correo no está registrado en Firebase Auth."); throw new Error("No fue posible enviar el correo para restablecer la contraseña."); }
  localStorage.setItem(LAST_EMAIL_KEY, email);
}

async function db(path, { method = "GET", body, query = {}, retry = true } = {}) {
  if (!APP.auth?.idToken) throw new Error("Debes iniciar sesión.");
  if (Date.now() > Number(APP.auth.expiresAt || 0) - 60000) await refreshAuth();
  const cleanPath = String(path).split("/").filter(Boolean).map(firebaseKey).join("/");
  const url = new URL(`${APP.config.firebaseDatabaseUrl}/${cleanPath}.json`);
  url.searchParams.set("auth", APP.auth.idToken);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  if (response.status === 401 && retry) { await refreshAuth(); return db(path, { method, body, query, retry: false }); }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || `Firebase respondió ${response.status}.`);
  return result;
}

async function checkRole() {
  const admin = await db(`seguridad/admins/${APP.auth.uid}`).catch(() => false);
  if (admin === true) { APP.auth.role = "ADMIN"; return true; }
  const medic = await db(`seguridad/medicos/${APP.auth.uid}/${APP.config.storeId}`).catch(() => false);
  if (medic === true) { APP.auth.role = "MÉDICO"; return true; }
  throw new Error("Este usuario no tiene autorización para consultar esta farmacia.");
}

function logout(message = "Sesión cerrada en este dispositivo.") {
  APP.auth = null;
  APP.selectedPatientId = "";
  APP.selectedPatient = null;
  clearDeviceSession({ keepEmail: true });
  $("app").hidden = true;
  $("login-screen").hidden = false;
  $("login-password").value = "";
  setMessage("login-message", message, false);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("macroxel-clinical-viewer-v1", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta");
      if (!database.objectStoreNames.contains("snapshots")) database.createObjectStore("snapshots", { keyPath: "patientId" });
      if (!database.objectStoreNames.contains("pending")) database.createObjectStore("pending", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbAction(storeName, mode, action) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}
const idbGet = (store, key) => idbAction(store, "readonly", (s) => s.get(key));
const idbPut = (store, value, key) => idbAction(store, "readwrite", (s) => key === undefined ? s.put(value) : s.put(value, key));
const idbDelete = (store, key) => idbAction(store, "readwrite", (s) => s.delete(key));
const idbAll = (store) => idbAction(store, "readonly", (s) => s.getAll());

async function selectBackupFolder() {
  if (!("showDirectoryPicker" in window)) {
    toast("Este navegador no permite elegir una carpeta. Se mantendrá el respaldo local interno y puedes exportar el expediente a Excel.", "error");
    return;
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "macroxel-clinical-backups" });
  APP.backupHandle = handle;
  await idbPut("meta", handle, "backupDirectory");
  $("backup-badge").textContent = "Respaldo automático activo";
  $("backup-badge").className = "badge ok";
  if (APP.selectedPatientId) await backupPatient(APP.selectedPatientId);
  toast("Carpeta de respaldos vinculada correctamente.", "ok");
}

async function restoreBackupHandle() {
  APP.backupHandle = await idbGet("meta", "backupDirectory").catch(() => null);
  if (!APP.backupHandle) return;
  const permission = await APP.backupHandle.queryPermission({ mode: "readwrite" }).catch(() => "denied");
  $("backup-badge").textContent = permission === "granted" ? "Respaldo automático activo" : "Confirmar carpeta de respaldo";
  $("backup-badge").className = permission === "granted" ? "badge ok" : "badge warn";
}

async function backupPatient(patientId) {
  if (!patientId) return;
  const [patient, consultations, references, prescriptions] = await Promise.all([
    db(`expediente_clinico/${APP.config.storeId}/pacientes/${patientId}`),
    db(`expediente_clinico/${APP.config.storeId}/consultas/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 200 } }),
    db(`expediente_clinico/${APP.config.storeId}/referencias/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 200 } }),
    db(`expediente_clinico/${APP.config.storeId}/recetas/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 200 } }).catch(() => ({}))
  ]);
  const snapshot = { schema: "macroxel-clinical-backup-v2", patientId, generatedAt: isoNow(), pharmacyName: APP.config.pharmacyName, patient: patient || {}, consultations: consultations || {}, references: references || {}, prescriptions: prescriptions || {} };
  await idbPut("snapshots", snapshot);
  if (!APP.backupHandle) return;
  let permission = await APP.backupHandle.queryPermission({ mode: "readwrite" }).catch(() => "denied");
  if (permission !== "granted") return;
  const file = await APP.backupHandle.getFileHandle(`EXPEDIENTE_${safeFile(patientId)}.json`, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(snapshot, null, 2));
  await writable.close();
  $("backup-badge").textContent = "Respaldo automático activo";
  $("backup-badge").className = "badge ok";
}

function eventAtomicPatch(event) {
  const prefix = `expediente_clinico/${APP.config.storeId}/`;
  const patch = {};
  for (const operation of event.operations || []) {
    if (!String(operation.path || "").startsWith(prefix)) throw new Error("El registro contiene una ruta fuera del expediente de esta farmacia.");
    const relative = operation.path.slice(prefix.length);
    if (operation.method === "PATCH" && operation.body && typeof operation.body === "object" && !Array.isArray(operation.body)) {
      Object.entries(operation.body).forEach(([key, value]) => { patch[`${relative}/${firebaseKey(key)}`] = value; });
    } else {
      patch[relative] = operation.body;
    }
  }
  return patch;
}

async function commitEvent(event) {
  await idbPut("pending", event);
  try {
    await db(`expediente_clinico/${APP.config.storeId}`, { method: "PATCH", body: eventAtomicPatch(event) });
    await idbDelete("pending", event.id);
    $("sync-badge").textContent = "● Conectado";
    $("sync-badge").className = "badge ok";
    return true;
  } catch (error) {
    $("sync-badge").textContent = "● Cambios pendientes";
    $("sync-badge").className = "badge warn";
    throw new Error(`El registro quedó resguardado localmente y se reintentará. ${error.message}`);
  }
}

async function flushPending() {
  const pending = await idbAll("pending").catch(() => []);
  for (const event of pending) {
    try {
      await db(`expediente_clinico/${APP.config.storeId}`, { method: "PATCH", body: eventAtomicPatch(event) });
      await idbDelete("pending", event.id);
    } catch (_) { break; }
  }
  const left = await idbAll("pending").catch(() => []);
  $("sync-badge").textContent = left.length ? `● ${left.length} cambio(s) pendiente(s)` : "● Conectado";
  $("sync-badge").className = left.length ? "badge warn" : "badge ok";
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-btn").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  if (name === "inventory" && !APP.inventoryRows.length) loadFeaturedInventory();
  if (name === "records" && !APP.recentPatients.length) loadRecentPatients();
  if (name === "prescriptions") preparePrescriptionModule().catch((error) => toast(error.message, "error"));
  if (name === "clinical-settings") loadMedicalSettings().catch((error) => toast(error.message, "error"));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function indexToArray(value) {
  return Object.entries(value || {}).map(([id, item]) => ({ id, ...(item || {}) })).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

async function loadRecentPatients() {
  const data = await db(`expediente_clinico/${APP.config.storeId}/pacientes_indice`, { query: { orderBy: jsonQueryValue("updatedAt"), limitToLast: 20 } }).catch(() => ({}));
  APP.recentPatients = indexToArray(data).slice(0, 20);
  renderPatientList(APP.recentPatients, $("recent-patients"), true);
  $("kpi-patients").textContent = String(APP.recentPatients.length);
}

function renderPatientList(rows, target, compact = false, picker = false) {
  if (!rows.length) { target.innerHTML = '<div class="empty">Sin pacientes que coincidan.</div>'; return; }
  target.innerHTML = rows.map((row) => `<article class="list-item"><div><b>${esc(row.name)}</b><span>${esc(row.id)} · ${esc(row.phone || "Sin teléfono")}${compact ? "" : ` · Actualizado ${esc(formatDate(row.updatedAt, true))}`}</span></div><button type="button" data-patient-id="${esc(row.id)}" data-picker="${picker ? "1" : "0"}">${picker ? "Elegir" : "Abrir"}</button></article>`).join("");
}

async function searchPatients(term, target, picker = false) {
  const key = normalize(term);
  if (key.length < 3) { target.innerHTML = '<div class="empty">Escribe al menos tres caracteres.</div>'; return; }
  const orderBy = /^\d+$/.test(key.replace(/\s/g, "")) ? "phoneKey" : "searchKey";
  const start = orderBy === "phoneKey" ? digits(term) : key;
  const data = await db(`expediente_clinico/${APP.config.storeId}/pacientes_indice`, { query: { orderBy: jsonQueryValue(orderBy), startAt: jsonQueryValue(start), endAt: jsonQueryValue(`${start}\uf8ff`), limitToFirst: 20 } });
  renderPatientList(indexToArray(data), target, false, picker);
}

async function openPatient(patientId) {
  const [patient, consultations, references, prescriptions] = await Promise.all([
    db(`expediente_clinico/${APP.config.storeId}/pacientes/${patientId}`),
    db(`expediente_clinico/${APP.config.storeId}/consultas/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 50 } }),
    db(`expediente_clinico/${APP.config.storeId}/referencias/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 50 } }),
    db(`expediente_clinico/${APP.config.storeId}/recetas/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 50 } }).catch(() => ({}))
  ]);
  if (!patient) throw new Error("El expediente ya no está disponible.");
  APP.selectedPatientId = patientId;
  APP.selectedPatient = patient;
  $("consult-patient-label").value = `${patient.name} · ${patientId}`;
  $("reference-patient-label").value = `${patient.name} · ${patientId}`;
  fillPrescriptionPatientFromRecord(patientId, patient);
  renderPatientDetail(patientId, patient, consultations || {}, references || {}, prescriptions || {});
  renderPrescriptionPreview();
  showView("records");
}

function renderPatientDetail(id, patient, consultations, references, prescriptions = {}) {
  const notes = Object.entries(consultations).map(([entryId, item]) => ({ entryId, kind: "note", ...item }));
  const refs = Object.entries(references).map(([entryId, item]) => ({ entryId, kind: "reference", ...item }));
  const prescriptionsRows = Object.entries(prescriptions).map(([entryId, item]) => ({ entryId, kind: "prescription", ...item }));
  const timeline = [...notes, ...refs, ...prescriptionsRows].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  $("patient-detail").innerHTML = `<div class="patient-header"><div><span class="patient-id">${esc(id)}</span><h3>${esc(patient.name)}</h3><p>${esc(formatDate(patient.birthDate))} · ${esc(patient.sex)}</p></div><div class="patient-actions"><button class="btn primary" type="button" data-patient-action="consult">Nueva consulta</button><button class="btn primary" type="button" data-patient-action="prescription">Nueva receta</button><button class="btn ghost" type="button" data-patient-action="export">Exportar Excel</button></div></div>
    <div class="patient-grid">
      ${dataCard("Teléfono", patient.phone)}${dataCard("Correo", patient.email)}${dataCard("Domicilio", patient.address)}
      ${dataCard("Grupo sanguíneo", patient.bloodType)}${dataCard("Alergias", patient.allergies)}${dataCard("Padecimientos crónicos", patient.chronicConditions)}
      ${dataCard("Contacto de emergencia", patient.emergencyContact)}${dataCard("Aviso y consentimiento", patient.consentAt ? `Registrado ${formatDate(patient.consentAt, true)}` : "No asentado")}${dataCard("Última actualización", formatDate(patient.updatedAt, true))}
    </div><h3>Historia clínica y referencias</h3><div class="timeline">${timeline.length ? timeline.map(timelineItem).join("") : '<div class="empty">Aún no hay notas médicas ni referencias.</div>'}</div>`;
}

function dataCard(label, value) { return `<div class="data-card"><span>${esc(label)}</span><b>${esc(text(value))}</b></div>`; }
function timelineItem(item) {
  const reference = item.kind === "reference";
  const prescription = item.kind === "prescription";
  const title = reference ? `Referencia ${text(item.priority, "ORDINARIA")}` : prescription ? `Receta ${text(item.folio)}` : `${text(item.noteType, "NOTA MÉDICA")} · ${text(item.folio)}`;
  const detail = reference ? `${text(item.recipient)}\n${text(item.reason)}` : prescription ? `${text(item.type, "ORDINARIA")} · ${(item.items || []).map((line) => line.genericName).filter(Boolean).join(", ")}` : `${text(item.diagnosis)}\nPlan: ${text(item.treatment)}`;
  const professional = reference ? item.referringDoctor : prescription ? `${item.doctor?.name || item.doctorName || "MÉDICO"} · Céd. ${item.doctor?.license || item.doctorLicense || "—"}` : `${item.doctorName} · Céd. ${item.doctorLicense}`;
  return `<article class="timeline-item ${reference ? "reference" : prescription ? "prescription" : ""}"><div class="meta"><span>${esc(formatDate(item.clinicalDate || item.issuedAt || item.createdAt, true))}</span><span>${esc(professional)}</span></div><h4>${esc(title)}</h4><p>${esc(detail)}</p></article>`;
}

function patientPayload() {
  const createdAt = isoNow();
  return {
    name: text($("patient-name").value, ""), birthDate: $("patient-birth").value, sex: $("patient-sex").value,
    phone: $("patient-phone").value.trim(), email: $("patient-email").value.trim(), address: $("patient-address").value.trim(),
    emergencyContact: $("patient-emergency").value.trim(), bloodType: $("patient-blood").value.trim(), allergies: $("patient-allergies").value.trim(),
    chronicConditions: $("patient-chronic").value.trim(), familyHistory: $("patient-family-history").value.trim(), pathologicalHistory: $("patient-pathological").value.trim(),
    nonPathologicalHistory: $("patient-nonpathological").value.trim(), notes: $("patient-notes").value.trim(), consentAt: createdAt, consentRecordedBy: APP.auth.uid,
    createdAt, updatedAt: createdAt, createdBy: APP.auth.uid, createdByEmail: APP.auth.email, schemaVersion: 1
  };
}

async function createPatient(event) {
  event.preventDefault();
  const patient = patientPayload();
  const id = newId("PAC").toUpperCase();
  const index = { name: patient.name, phone: patient.phone, searchKey: normalize(`${patient.name} ${patient.phone}`), phoneKey: digits(patient.phone), updatedAt: patient.updatedAt };
  await commitEvent({ id: newId("evt_patient"), createdAt: patient.createdAt, operations: [
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/pacientes/${id}`, body: patient },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/pacientes_indice/${id}`, body: index },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/auditoria/${newId("audit")}`, body: { action: "PATIENT_CREATED", patientId: id, createdAt: patient.createdAt, uid: APP.auth.uid, email: APP.auth.email } }
  ]});
  $("patient-dialog").close();
  $("patient-form").reset();
  await loadRecentPatients();
  await openPatient(id);
  await backupPatient(id).catch(() => {});
  toast("Expediente creado y resguardado correctamente.", "ok");
}

function consultationPayload() {
  const createdAt = isoNow();
  return {
    folio: $("consult-folio").value, noteType: $("note-type").value, clinicalDate: new Date($("consult-datetime").value).toISOString(),
    doctorName: $("doctor-name").value.trim(), doctorLicense: $("doctor-license").value.trim(), doctorSpecialty: $("doctor-specialty").value.trim(),
    vitals: { systolic: $("vital-sys").value, diastolic: $("vital-dia").value, heartRate: $("vital-hr").value, respiratoryRate: $("vital-rr").value, temperature: $("vital-temp").value, spo2: $("vital-spo2").value, weightKg: $("vital-weight").value, heightCm: $("vital-height").value, bmi: $("vital-bmi").value, glucose: $("vital-glucose").value, pain: $("vital-pain").value.trim() },
    reason: $("consult-reason").value.trim(), subjective: $("consult-subjective").value.trim(), objective: $("consult-objective").value.trim(), results: $("consult-results").value.trim(), diagnosis: $("consult-diagnosis").value.trim(), prognosis: $("consult-prognosis").value.trim(), treatment: $("consult-treatment").value.trim(), followup: $("consult-followup").value.trim(),
    createdAt, confirmedAt: createdAt, authorUid: APP.auth.uid, authorEmail: APP.auth.email, authenticatedAuthor: true, immutable: true, schemaVersion: 1
  };
}

async function saveConsultation(event) {
  event.preventDefault();
  if (!APP.selectedPatientId || !APP.selectedPatient) throw new Error("Selecciona el paciente antes de guardar la nota.");
  const note = consultationPayload();
  const noteId = newId("NOTA").toUpperCase();
  const auditId = newId("audit");
  const daily = { patientId: APP.selectedPatientId, patientName: APP.selectedPatient.name, noteType: note.noteType, clinicalDate: note.clinicalDate, createdAt: note.createdAt, doctorName: note.doctorName };
  await commitEvent({ id: newId("evt_note"), createdAt: note.createdAt, operations: [
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/consultas/${APP.selectedPatientId}/${noteId}`, body: note },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/consultas_dia/${dateKey(note.clinicalDate)}/${noteId}`, body: daily },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/respaldos/${dateKey(note.createdAt)}/${noteId}`, body: { kind: "CONSULTATION", patientId: APP.selectedPatientId, data: note } },
    { method: "PATCH", path: `expediente_clinico/${APP.config.storeId}/pacientes/${APP.selectedPatientId}`, body: { updatedAt: note.createdAt } },
    { method: "PATCH", path: `expediente_clinico/${APP.config.storeId}/pacientes_indice/${APP.selectedPatientId}`, body: { updatedAt: note.createdAt } },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/auditoria/${auditId}`, body: { action: "CLINICAL_NOTE_CREATED", patientId: APP.selectedPatientId, recordId: noteId, createdAt: note.createdAt, uid: APP.auth.uid, email: APP.auth.email } }
  ]});
  await backupPatient(APP.selectedPatientId).catch(() => {});
  $("consultation-form").reset();
  prepareForms();
  await loadDashboard();
  await openPatient(APP.selectedPatientId);
  toast("Nota médica registrada exitosamente.", "ok");
}

async function saveReference(event) {
  event.preventDefault();
  if (!APP.selectedPatientId || !APP.selectedPatient) throw new Error("Selecciona el paciente antes de guardar la referencia.");
  const createdAt = isoNow();
  const reference = { clinicalDate: new Date($("reference-datetime").value).toISOString(), priority: $("reference-priority").value, recipient: $("reference-recipient").value.trim(), reason: $("reference-reason").value.trim(), diagnosis: $("reference-diagnosis").value.trim(), results: $("reference-results").value.trim(), treatment: $("reference-treatment").value.trim(), referringDoctor: $("reference-doctor").value.trim(), createdAt, authorUid: APP.auth.uid, authorEmail: APP.auth.email, immutable: true, schemaVersion: 1 };
  const refId = newId("REF").toUpperCase();
  await commitEvent({ id: newId("evt_ref"), createdAt, operations: [
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/referencias/${APP.selectedPatientId}/${refId}`, body: reference },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/respaldos/${dateKey(createdAt)}/${refId}`, body: { kind: "REFERENCE", patientId: APP.selectedPatientId, data: reference } },
    { method: "PATCH", path: `expediente_clinico/${APP.config.storeId}/pacientes/${APP.selectedPatientId}`, body: { updatedAt: createdAt } },
    { method: "PATCH", path: `expediente_clinico/${APP.config.storeId}/pacientes_indice/${APP.selectedPatientId}`, body: { updatedAt: createdAt } },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/auditoria/${newId("audit")}`, body: { action: "REFERENCE_CREATED", patientId: APP.selectedPatientId, recordId: refId, createdAt, uid: APP.auth.uid, email: APP.auth.email } }
  ]});
  await backupPatient(APP.selectedPatientId).catch(() => {});
  $("reference-form").reset();
  prepareForms();
  await openPatient(APP.selectedPatientId);
  toast("Referencia clínica registrada exitosamente.", "ok");
}

function prepareForms() {
  const now = localDateTimeValue();
  $("consult-datetime").value = now;
  $("reference-datetime").value = now;
  $("consult-folio").value = `NC-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  if (APP.selectedPatient) {
    $("consult-patient-label").value = `${APP.selectedPatient.name} · ${APP.selectedPatientId}`;
    $("reference-patient-label").value = `${APP.selectedPatient.name} · ${APP.selectedPatientId}`;
    fillPrescriptionPatientFromRecord(APP.selectedPatientId, APP.selectedPatient);
  }
}

function calculateBmi() {
  const kg = Number($("vital-weight").value);
  const cm = Number($("vital-height").value);
  $("vital-bmi").value = kg > 0 && cm > 0 ? (kg / ((cm / 100) ** 2)).toFixed(1) : "";
}

function inventoryToArray(value) {
  return Object.entries(value || {}).map(([id, item]) => ({ id, ...(item || {}) })).slice(0, 20);
}

function renderInventory(rows, title) {
  APP.inventoryRows = rows.slice(0, 20);
  $("inventory-title").textContent = title;
  $("inventory-results").innerHTML = rows.length ? rows.map((row) => `<article class="product-card"><span class="product-code">${esc(row.codigo || row.id)}</span><h4>${esc(row.generica || row.nombre || "PRODUCTO")}</h4><p>${esc(row.distintiva || row.presentacion || "")}</p><div class="stock"><div><b>${esc(Number(row.existencia) || 0)}</b><span> existencias</span></div><strong>${esc(money(row.precioVenta))}</strong></div></article>`).join("") : '<div class="empty">No se encontraron productos.</div>';
}

async function loadFeaturedInventory() {
  const [featured, meta] = await Promise.all([
    db(`expediente_clinico/${APP.config.storeId}/inventario/destacados`).catch(() => ({})),
    db(`expediente_clinico/${APP.config.storeId}/inventario/meta`).catch(() => ({}))
  ]);
  const rows = inventoryToArray(featured).sort((a, b) => Number(b.popularidad || 0) - Number(a.popularidad || 0));
  renderInventory(rows, "20 productos más utilizados");
  $("dashboard-products").innerHTML = rows.length ? rows.slice(0, 8).map((row) => `<div class="compact-product"><b>${esc(row.generica || row.nombre)}</b><span>${esc(row.codigo)} · ${esc(Number(row.existencia) || 0)} pz</span></div>`).join("") : '<div class="empty">Sin inventario sincronizado.</div>';
  $("kpi-products").textContent = String(rows.length);
  $("kpi-sync").textContent = meta?.updatedAt ? formatDate(meta.updatedAt, true) : "—";
  $("inventory-meta").textContent = meta?.updatedAt ? `Sincronizado ${formatDate(meta.updatedAt, true)} · ${Number(meta.totalProducts) || 0} productos disponibles para búsqueda bajo demanda.` : "Esperando sincronización del punto de venta.";
}

async function searchInventory() {
  const term = $("inventory-search").value.trim();
  const key = normalize(term);
  if (key.length < 2) { toast("Escribe al menos dos caracteres o escanea un código.", "error"); return; }
  const numeric = /^\d+$/.test(digits(term)) && digits(term).length >= 4;
  const orderBy = numeric ? "codigo" : "searchKey";
  const start = numeric ? digits(term) : key;
  const data = await db(`expediente_clinico/${APP.config.storeId}/inventario/productos`, { query: { orderBy: jsonQueryValue(orderBy), startAt: jsonQueryValue(start), endAt: jsonQueryValue(`${start}\uf8ff`), limitToFirst: 20 } });
  renderInventory(inventoryToArray(data), `Resultados para “${term}”`);
}

async function loadDashboard() {
  const today = await db(`expediente_clinico/${APP.config.storeId}/consultas_dia/${dateKey()}`, { query: { limitToFirst: 200 } }).catch(() => ({}));
  $("kpi-today").textContent = String(Object.keys(today || {}).length);
  await Promise.all([loadRecentPatients(), loadFeaturedInventory()]);
}

function xml(value) { return esc(String(value ?? "")).replace(/\r?\n/g, "&#10;"); }
function columnName(index) { let name = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; }
function worksheetXml(rows) {
  const safeRows = rows.length ? rows : [["SIN DATOS"]];
  const sheet = safeRows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => `<c r="${columnName(c)}${r + 1}" t="inlineStr"${r === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(cell)}</t></is></c>`).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`;
}
function u16(value) { return new Uint8Array([value & 255, (value >>> 8) & 255]); }
function u32(value) { return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]); }
function concatBytes(parts) { const total = parts.reduce((n, part) => n + part.length, 0); const out = new Uint8Array(total); let offset = 0; parts.forEach((part) => { out.set(part, offset); offset += part.length; }); return out; }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function zipStore(files) {
  const encoder = new TextEncoder(); const locals = []; const central = []; let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name); const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data; const crc = crc32(data);
    const local = concatBytes([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    locals.push(local);
    central.push(concatBytes([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const centralData = concatBytes(central); return concatBytes([...locals, centralData, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralData.length), u32(offset), u16(0)]);
}
function xlsxBlob(sheets) {
  const sheetEntries = sheets.map((sheet, i) => `<sheet name="${xml(sheet.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  const overrides = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>` },
    { name: "_rels/.rels", data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", data: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF075C94"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>' },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: worksheetXml(sheet.rows) }))
  ];
  return new Blob([zipStore(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

async function exportPatient() {
  if (!APP.selectedPatientId) throw new Error("Selecciona un expediente.");
  const snapshot = await idbGet("snapshots", APP.selectedPatientId).catch(() => null);
  if (!snapshot) await backupPatient(APP.selectedPatientId);
  const data = snapshot || await idbGet("snapshots", APP.selectedPatientId);
  const patientRows = [["CAMPO", "VALOR"], ...Object.entries(data.patient || {}).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : value])];
  const noteRows = [["ID", "FECHA", "TIPO", "MÉDICO", "CÉDULA", "MOTIVO", "DIAGNÓSTICO", "TRATAMIENTO", "SEGUIMIENTO"], ...Object.entries(data.consultations || {}).map(([id, n]) => [id, n.clinicalDate, n.noteType, n.doctorName, n.doctorLicense, n.reason, n.diagnosis, n.treatment, n.followup])];
  const refRows = [["ID", "FECHA", "PRIORIDAD", "RECEPTOR", "MOTIVO", "DIAGNÓSTICO", "TRATAMIENTO", "MÉDICO REMITENTE"], ...Object.entries(data.references || {}).map(([id, r]) => [id, r.clinicalDate, r.priority, r.recipient, r.reason, r.diagnosis, r.treatment, r.referringDoctor])];
  const prescriptionRows = [["ID", "FOLIO", "FECHA", "TIPO", "MÉDICO", "CÉDULA", "DIAGNÓSTICO", "MEDICAMENTOS"], ...Object.entries(data.prescriptions || {}).map(([id, r]) => [id, r.folio, r.issuedAt, r.type, r.doctor?.name, r.doctor?.license, r.diagnosis, (r.items || []).map((line) => `${line.genericName} ${line.dose} ${line.frequency} ${line.duration}`).join(" | ")])];
  downloadBlob(xlsxBlob([{ name: "PACIENTE", rows: patientRows }, { name: "CONSULTAS", rows: noteRows }, { name: "REFERENCIAS", rows: refRows }, { name: "RECETAS", rows: prescriptionRows }]), `EXPEDIENTE_${safeFile(APP.selectedPatientId)}_${dateKey()}.xlsx`);
  toast("Expediente exportado a Excel.", "ok");
}

function exportInventory() {
  if (!APP.inventoryRows.length) throw new Error("No hay resultados para exportar.");
  const rows = [["CÓDIGO", "DENOMINACIÓN GENÉRICA", "DENOMINACIÓN DISTINTIVA", "PRESENTACIÓN", "EXISTENCIA", "PRECIO VENTA", "ÚLTIMA SINCRONIZACIÓN"], ...APP.inventoryRows.map((p) => [p.codigo, p.generica || p.nombre, p.distintiva, p.presentacion, p.existencia, p.precioVenta, p.updatedAt])];
  downloadBlob(xlsxBlob([{ name: "INVENTARIO", rows }]), `INVENTARIO_CONSULTA_${dateKey()}.xlsx`);
  toast("Resultados de inventario exportados a Excel.", "ok");
}

function ageFromBirth(value) {
  const birth = new Date(`${String(value || "").slice(0, 10)}T12:00:00`);
  if (Number.isNaN(birth.getTime())) return "";
  const today = new Date();
  let years = today.getFullYear() - birth.getFullYear();
  const beforeBirthday = today.getMonth() < birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (beforeBirthday) years -= 1;
  return years >= 0 && years < 130 ? `${years} año(s)` : "";
}

function safeDataImage(value) {
  const raw = String(value || "");
  return /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(raw) && raw.length <= 700000 ? raw : "";
}

function defaultMedicalConfig() {
  return { pharmacyPhone: APP.config?.pharmacyPhone || "", selectedDoctorId: "", profiles: {}, updatedAt: "", updatedBy: "", schemaVersion: 2 };
}

function normalizedDoctorProfile(value, id = "") {
  const raw = value && typeof value === "object" ? value : {};
  const doctorSex = ["MASCULINO", "FEMENINO"].includes(normalize(raw.doctorSex)) ? normalize(raw.doctorSex) : "";
  return {
    id: firebaseKey(raw.id || id || newId("MEDICO")).slice(0, 80), doctorName: text(raw.doctorName, ""),
    doctorLicense: text(raw.doctorLicense, ""), doctorProfession: text(raw.doctorProfession, "MÉDICO CIRUJANO"),
    doctorSpecialty: text(raw.doctorSpecialty, "MEDICINA GENERAL"), doctorUniversity: text(raw.doctorUniversity, ""),
    doctorSex,
    leftHeaderImage: safeDataImage(raw.leftHeaderImage || raw.universityCrest), rightHeaderImage: safeDataImage(raw.rightHeaderImage || raw.doctorSignature),
    updatedAt: raw.updatedAt || "", updatedBy: raw.updatedBy || "", schemaVersion: 1
  };
}

function normalizedMedicalConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  const profiles = {};
  if (raw.profiles && typeof raw.profiles === "object") {
    Object.entries(raw.profiles).slice(0, 4).forEach(([id, profile]) => { const normalized = normalizedDoctorProfile(profile, id); profiles[normalized.id] = normalized; });
  } else if (raw.doctorName) {
    const legacy = normalizedDoctorProfile(raw, "MEDICO_PRINCIPAL"); profiles[legacy.id] = legacy;
  }
  const ids = Object.keys(profiles); const selectedDoctorId = profiles[raw.selectedDoctorId] ? raw.selectedDoctorId : (ids[0] || "");
  return { pharmacyPhone: text(raw.pharmacyPhone, APP.config?.pharmacyPhone || ""), selectedDoctorId, profiles, updatedAt: raw.updatedAt || "", updatedBy: raw.updatedBy || "", schemaVersion: 2 };
}

function selectedDoctor(config = APP.medicalConfig, doctorId = APP.selectedDoctorId) {
  const cfg = normalizedMedicalConfig(config); return cfg.profiles[doctorId] || cfg.profiles[cfg.selectedDoctorId] || Object.values(cfg.profiles)[0] || null;
}

function doctorProfileComplete(profile) {
  return !!(profile?.doctorName && profile?.doctorLicense && profile?.doctorProfession && profile?.doctorUniversity);
}

function titledDoctorName(doctor = {}) {
  const cleanName = text(doctor.name || doctor.doctorName, "NOMBRE DEL MÉDICO").replace(/^(?:DR|DRA)\.?\s+/i, "");
  return `${normalize(doctor.sex || doctor.doctorSex) === "FEMENINO" ? "Dra." : "Dr."} ${cleanName}`;
}

function normalizedFolioControl(value) {
  const raw = value && typeof value === "object" ? value : {};
  const prefix = normalize(raw.prefix || "RX").replace(/\s+/g, "-").slice(0, 12) || "RX";
  const lastIssued = Math.max(0, Math.trunc(Number(raw.lastIssued || 0) || 0));
  const nextNumber = Math.max(lastIssued + 1, Math.trunc(Number(raw.nextNumber || 1) || 1));
  return { prefix, nextNumber, lastIssued, width: Math.min(10, Math.max(3, Math.trunc(Number(raw.width || 6) || 6))), updatedAt: raw.updatedAt || isoNow(), updatedBy: raw.updatedBy || "", schemaVersion: 1 };
}

function formatPrescriptionFolio(control = APP.folioControl, number = null) {
  const cfg = normalizedFolioControl(control);
  const value = number === null ? cfg.nextNumber : Math.max(1, Math.trunc(Number(number) || 1));
  return `${cfg.prefix}-${String(value).padStart(cfg.width, "0")}`;
}

function medicalConfigComplete(config = APP.medicalConfig, doctorId = APP.selectedDoctorId) {
  const cfg = normalizedMedicalConfig(config); return !!(doctorProfileComplete(selectedDoctor(cfg, doctorId)) && cfg.pharmacyPhone && APP.config?.pharmacyAddress);
}

function firebaseUrlForPath(path) {
  const cleanPath = String(path).split("/").filter(Boolean).map(firebaseKey).join("/");
  const url = new URL(`${APP.config.firebaseDatabaseUrl}/${cleanPath}.json`);
  url.searchParams.set("auth", APP.auth.idToken);
  return url;
}

async function updateFolioTransaction(mutator, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (Date.now() > Number(APP.auth?.expiresAt || 0) - 60000) await refreshAuth();
    const path = `expediente_clinico/${APP.config.storeId}/folios_recetas/control`;
    const url = firebaseUrlForPath(path);
    const currentResponse = await fetch(url, { headers: { "X-Firebase-ETag": "true", "Cache-Control": "no-store" }, cache: "no-store" });
    if (!currentResponse.ok) throw new Error(`No fue posible consultar el control de folios (${currentResponse.status}).`);
    const etag = currentResponse.headers.get("etag");
    if (!etag) throw new Error("Firebase no devolvió el control de concurrencia de folios.");
    const current = normalizedFolioControl(await currentResponse.json().catch(() => null));
    const next = normalizedFolioControl(await mutator({ ...current }));
    const saveResponse = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": etag }, body: JSON.stringify(next), cache: "no-store" });
    if (saveResponse.status === 412) continue;
    if (!saveResponse.ok) throw new Error(`No fue posible reservar el folio (${saveResponse.status}).`);
    APP.folioControl = next;
    return { before: current, after: next };
  }
  throw new Error("Otro usuario actualizó los folios al mismo tiempo. Intenta nuevamente.");
}

function setImagePreview(id, value) {
  const image = $(id);
  const safe = safeDataImage(value);
  image.hidden = !safe;
  if (safe) image.src = safe;
  else image.removeAttribute("src");
}

async function optimizeImageFile(file, maxSide = 520) {
  if (!file || !/^image\/(?:png|jpeg|webp)$/i.test(file.type || "")) throw new Error("Selecciona una imagen PNG, JPG o WebP.");
  if (file.size > 5 * 1024 * 1024) throw new Error("La imagen supera 5 MB.");
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer el archivo de imagen."));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("La imagen está dañada o usa un formato no compatible.")); image.src = source; });
  const initialScale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const scale = initialScale * (0.82 ** attempt); const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("El navegador no pudo preparar la imagen.");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL("image/png");
    if (safeDataImage(png)) return png;
    const webp = canvas.toDataURL("image/webp", 0.86);
    if (safeDataImage(webp)) return webp;
  }
  throw new Error("La imagen no pudo optimizarse al tamaño permitido.");
}

function fillDoctorEditor(doctorId = "") {
  const profile = doctorId ? APP.medicalConfig?.profiles?.[doctorId] : null;
  APP.editingDoctorId = profile?.id || ""; $("settings-doctor-id").value = APP.editingDoctorId;
  $("settings-doctor-name").value = profile?.doctorName || "";
  $("settings-doctor-license").value = profile?.doctorLicense || "";
  $("settings-doctor-sex").value = profile?.doctorSex || "";
  $("settings-doctor-profession").value = profile?.doctorProfession || "";
  $("settings-doctor-specialty").value = profile?.doctorSpecialty || "";
  $("settings-doctor-university").value = profile?.doctorUniversity || "";
  APP.leftImageDraft = safeDataImage(profile?.leftHeaderImage); APP.rightImageDraft = safeDataImage(profile?.rightHeaderImage);
  setImagePreview("settings-university-crest-preview", APP.leftImageDraft); setImagePreview("settings-doctor-signature-preview", APP.rightImageDraft);
  $("settings-university-crest").value = ""; $("settings-doctor-signature").value = ""; $("settings-confirm").checked = false;
}

function closeDoctorEditor() {
  fillDoctorEditor("");
  APP.doctorEditorActive = false;
  const section = $("settings-doctor-editor-section");
  if (section) { section.open = false; section.classList.remove("editor-ready"); }
  $("settings-doctor-editor-summary").textContent = "Selecciona + Nuevo médico o Editar";
}

function openDoctorEditor(doctorId = "") {
  fillDoctorEditor(doctorId);
  APP.doctorEditorActive = true;
  const profile = doctorId ? APP.medicalConfig?.profiles?.[doctorId] : null;
  const section = $("settings-doctor-editor-section");
  if (section) { section.classList.add("editor-ready"); section.open = true; }
  $("settings-doctor-editor-summary").textContent = profile ? `Editando: ${profile.doctorName}` : "Nuevo médico";
  setTimeout(() => $("settings-doctor-name")?.focus(), 0);
}

function renderDoctorProfiles() {
  const profiles = Object.values(APP.medicalConfig?.profiles || {}); const selectedId = APP.selectedDoctorId || APP.medicalConfig?.selectedDoctorId || "";
  $("doctor-profiles-list").innerHTML = profiles.length ? profiles.map((profile) => `<article class="doctor-profile-card${profile.id === selectedId ? " selected" : ""}"><div><b>${esc(profile.doctorName)}</b><span>Cédula ${esc(profile.doctorLicense)} · ${esc(profile.doctorSpecialty || profile.doctorProfession)}</span>${profile.id === selectedId ? '<small>SELECCIONADO PARA RECETAR</small>' : ""}</div><div class="doctor-profile-actions"><button class="link-btn" type="button" data-use-doctor="${esc(profile.id)}">Usar</button><button class="link-btn" type="button" data-edit-doctor="${esc(profile.id)}">Editar</button><button class="link-btn danger" type="button" data-remove-doctor="${esc(profile.id)}">Eliminar</button></div></article>`).join("") : '<div class="empty">Sin médicos configurados. Agrega el primero para emitir recetas.</div>';
  const selector = $("prescription-doctor"); const current = APP.selectedDoctorId || selectedId;
  selector.innerHTML = profiles.length ? profiles.map((profile) => `<option value="${esc(profile.id)}"${profile.id === current ? " selected" : ""}>${esc(profile.doctorName)} · CÉD. ${esc(profile.doctorLicense)}</option>`).join("") : '<option value="">Configura y selecciona un médico</option>';
  APP.selectedDoctorId = selector.value || "";
  refreshPrescriptionCompactSections();
}

function fillMedicalSettingsForm() {
  const cfg = normalizedMedicalConfig(APP.medicalConfig);
  APP.medicalConfig = cfg; APP.selectedDoctorId = cfg.profiles[APP.selectedDoctorId] ? APP.selectedDoctorId : cfg.selectedDoctorId;
  $("settings-pharmacy-address").value = APP.config?.pharmacyAddress || "";
  $("settings-pharmacy-phone").value = cfg.pharmacyPhone || APP.config?.pharmacyPhone || "";
  renderDoctorProfiles();
  const folio = normalizedFolioControl(APP.folioControl);
  $("settings-folio-prefix").value = folio.prefix;
  $("settings-folio-next").value = String(folio.nextNumber);
  $("settings-folio-width").value = String(folio.width);
  $("prescription-next-folio").textContent = `Próximo folio: ${formatPrescriptionFolio(folio)}`;
  const complete = medicalConfigComplete(cfg, APP.selectedDoctorId);
  $("prescription-config-badge").textContent = complete ? "Configuración completa" : "Completar configuración";
  $("prescription-config-badge").className = `badge ${complete ? "ok" : "warn"}`;
  const doctor = selectedDoctor(cfg, APP.selectedDoctorId);
  if ($("doctor-name") && !$("doctor-name").value) $("doctor-name").value = doctor?.doctorName || "";
  if ($("doctor-license") && !$("doctor-license").value) $("doctor-license").value = doctor?.doctorLicense || "";
  if ($("doctor-specialty") && !$("doctor-specialty").value) $("doctor-specialty").value = doctor?.doctorSpecialty || "";
}

async function loadMedicalSettings() {
  const [config, folio] = await Promise.all([
    db(`expediente_clinico/${APP.config.storeId}/configuracion_medicos/${APP.auth.uid}`).catch(() => null),
    db(`expediente_clinico/${APP.config.storeId}/folios_recetas/control`).catch(() => null)
  ]);
  APP.medicalConfig = normalizedMedicalConfig(config || defaultMedicalConfig()); APP.selectedDoctorId = APP.medicalConfig.selectedDoctorId;
  APP.folioControl = normalizedFolioControl(folio);
  fillMedicalSettingsForm();
  closeDoctorEditor();
  renderPrescriptionPreview();
  return APP.medicalConfig;
}

function enableFolioEditing(enabled = true) {
  APP.folioEditEnabled = !!enabled;
  ["settings-folio-prefix", "settings-folio-next", "settings-folio-width"].forEach((id) => { $(id).readOnly = !enabled; });
  $("folio-edit-confirmation").hidden = !enabled;
  $("btn-enable-folio-edit").textContent = enabled ? "Edición habilitada" : "Editar control";
  $("btn-enable-folio-edit").disabled = enabled;
}

async function persistMedicalConfig(config, action) {
  const saved = normalizedMedicalConfig({ ...config, updatedAt: isoNow(), updatedBy: APP.auth.uid, schemaVersion: 2 });
  const primary = selectedDoctor(saved, saved.selectedDoctorId);
  if (!doctorProfileComplete(primary)) throw new Error("Guarda al menos un médico completo antes de actualizar esta configuración.");
  const compatiblePayload = { ...saved, doctorName: primary.doctorName, doctorLicense: primary.doctorLicense, doctorSex: primary.doctorSex, doctorProfession: primary.doctorProfession,
    doctorSpecialty: primary.doctorSpecialty, doctorUniversity: primary.doctorUniversity, universityCrest: primary.leftHeaderImage,
    doctorSignature: primary.rightHeaderImage, schemaVersion: 1 };
  await commitEvent({ id: newId("evt_medical_config"), createdAt: saved.updatedAt, operations: [
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/configuracion_medicos/${APP.auth.uid}`, body: compatiblePayload },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/auditoria/${newId("audit")}`, body: { action, createdAt: saved.updatedAt, uid: APP.auth.uid, email: APP.auth.email } }
  ]});
  APP.medicalConfig = saved; APP.selectedDoctorId = saved.selectedDoctorId; return saved;
}

async function saveMedicalSettings(event) {
  event.preventDefault();
  const profiles = { ...(APP.medicalConfig?.profiles || {}) }; let doctorId = APP.editingDoctorId || firebaseKey(newId("MEDICO").toUpperCase()).slice(0, 80);
  if (!profiles[doctorId] && Object.keys(profiles).length >= 4) throw new Error("Ya existen cuatro médicos. Edita o elimina un perfil antes de agregar otro.");
  const profile = normalizedDoctorProfile({
    id: doctorId,
    doctorName: $("settings-doctor-name").value.trim(), doctorLicense: $("settings-doctor-license").value.trim(),
    doctorSex: $("settings-doctor-sex").value,
    doctorProfession: $("settings-doctor-profession").value.trim(), doctorSpecialty: $("settings-doctor-specialty").value.trim(),
    doctorUniversity: $("settings-doctor-university").value.trim(), leftHeaderImage: safeDataImage(APP.leftImageDraft), rightHeaderImage: safeDataImage(APP.rightImageDraft),
    updatedAt: isoNow(), updatedBy: APP.auth.uid, schemaVersion: 1
  }, doctorId);
  if (!doctorProfileComplete(profile) || !profile.doctorSex) throw new Error("Completa nombre, sexo, cédula, profesión y universidad del médico.");
  profiles[doctorId] = profile; await persistMedicalConfig({ ...APP.medicalConfig, profiles, selectedDoctorId: APP.selectedDoctorId || doctorId }, "PRESCRIPTION_DOCTOR_SAVED");
  APP.selectedDoctorId = APP.medicalConfig.selectedDoctorId; fillMedicalSettingsForm(); closeDoctorEditor(); renderPrescriptionPreview();
  toast(`Médico ${profile.doctorName} guardado correctamente.`, "ok");
}

async function saveClinicalContact(event) {
  event.preventDefault(); if (!APP.config.pharmacyAddress) throw new Error("La dirección no llegó desde el sistema principal. Regenera macroxel-config.json desde Configuración.");
  const pharmacyPhone = $("settings-pharmacy-phone").value.trim(); if (!pharmacyPhone) throw new Error("Captura el teléfono de la farmacia.");
  await persistMedicalConfig({ ...APP.medicalConfig, pharmacyPhone }, "PRESCRIPTION_CONTACT_SAVED"); fillMedicalSettingsForm(); renderPrescriptionPreview(); toast("Teléfono de la farmacia guardado.", "ok");
}

async function saveFolioSettings(event) {
  event.preventDefault(); if (!APP.folioEditEnabled) throw new Error("Primero selecciona Editar control.");
  if (!$("settings-folio-confirm").checked || normalize($("settings-folio-phrase").value) !== "CAMBIAR FOLIO") throw new Error("Confirma el cambio y escribe CAMBIAR FOLIO.");
  const prefix = normalize($("settings-folio-prefix").value).replace(/\s+/g, "-").slice(0, 12); const nextNumber = Math.trunc(Number($("settings-folio-next").value)); const width = Math.trunc(Number($("settings-folio-width").value));
  if (!/^[A-Z0-9-]{1,12}$/.test(prefix) || !Number.isInteger(nextNumber) || nextNumber < 1 || width < 3 || width > 10) throw new Error("El control de folios no es válido.");
  await updateFolioTransaction((current) => { if (nextNumber <= current.lastIssued) throw new Error(`El siguiente folio debe ser mayor a ${current.lastIssued}; los folios emitidos no pueden reutilizarse.`); return { ...current, prefix, nextNumber, width, updatedAt: isoNow(), updatedBy: APP.auth.uid }; });
  await commitEvent({ id: newId("evt_folio_settings"), createdAt: isoNow(), operations: [{ method: "PUT", path: `expediente_clinico/${APP.config.storeId}/auditoria/${newId("audit")}`, body: { action: "PRESCRIPTION_FOLIO_SETTINGS_UPDATED", createdAt: isoNow(), uid: APP.auth.uid, email: APP.auth.email } }] });
  enableFolioEditing(false); $("settings-folio-confirm").checked = false; $("settings-folio-phrase").value = ""; fillMedicalSettingsForm(); toast("Control de folios guardado.", "ok");
}

async function chooseDoctor(doctorId) {
  if (!APP.medicalConfig?.profiles?.[doctorId]) return;
  APP.selectedDoctorId = doctorId; await persistMedicalConfig({ ...APP.medicalConfig, selectedDoctorId: doctorId }, "PRESCRIPTION_DOCTOR_SELECTED"); fillMedicalSettingsForm(); renderPrescriptionPreview();
}

async function removeDoctorProfile(doctorId) {
  const profile = APP.medicalConfig?.profiles?.[doctorId]; if (!profile) return;
  if (Object.keys(APP.medicalConfig.profiles || {}).length <= 1) throw new Error("Debe conservarse al menos un médico. Primero registra el reemplazo y después elimina este perfil.");
  if (!window.confirm(`¿Eliminar el perfil de ${profile.doctorName}? Las recetas históricas no se modificarán.`)) return;
  const profiles = { ...APP.medicalConfig.profiles }; delete profiles[doctorId]; const selectedDoctorId = doctorId === APP.selectedDoctorId ? (Object.keys(profiles)[0] || "") : APP.selectedDoctorId;
  await persistMedicalConfig({ ...APP.medicalConfig, profiles, selectedDoctorId }, "PRESCRIPTION_DOCTOR_REMOVED"); fillMedicalSettingsForm(); closeDoctorEditor(); renderPrescriptionPreview(); toast("Perfil médico eliminado.", "ok");
}

function blankPrescriptionLine(product = null) {
  const line = {
    lineId: newId("rxline"), inventoryId: product?.id || "", productCode: product?.codigo || "", genericName: product?.generica || product?.nombre || "",
    brandName: product?.distintiva || "", presentation: product?.presentacion || "", concentration: "", pharmaceuticalForm: "", route: "ORAL",
    dose: "", frequency: "", duration: "", quantityToDispense: "", quantityAuto: true, instructions: "", price: Number(product?.precioVenta || 0) || 0
  };
  if (product) line.quantityToDispense = prescriptionQuantity.infer(line).quantity;
  return line;
}

function pharmacyQuantityDetection(line) {
  return prescriptionQuantity.infer(line);
}

function pharmacyQuantityHelper(line) {
  const detected = pharmacyQuantityDetection(line);
  if (detected.source === "DEFAULT") return "Cantidad inicial: 1 pza. Puedes editarla antes de guardar.";
  return `Detectado en el producto: ${detected.quantity} ${detected.unit}. Editable; solo se envía a farmacia.`;
}

function renderPrescriptionLines() {
  const target = $("prescription-lines");
  if (!APP.prescriptionLines.length) { target.innerHTML = '<div class="empty">Agrega al menos un medicamento.</div>'; renderPrescriptionPreview(); return; }
  const routeOptions = ["ORAL", "TÓPICA", "OFTÁLMICA", "ÓTICA", "INHALADA", "INTRAMUSCULAR", "INTRAVENOSA", "SUBCUTÁNEA", "RECTAL", "VAGINAL", "OTRA"];
  target.innerHTML = APP.prescriptionLines.map((line, index) => `<article class="rx-line" data-rx-line-id="${esc(line.lineId)}"><div class="rx-line-head"><div><b>Medicamento ${index + 1}</b><span>${line.productCode ? `Vinculado al inventario · ${esc(line.productCode)}` : "Captura manual · no se enviará al carrito hasta vincularlo"}</span></div><button class="link-btn" type="button" data-remove-rx-line="${esc(line.lineId)}">Eliminar</button></div><div class="rx-line-grid">
    <label class="span-2">Denominación genérica<input data-rx-field="genericName" value="${esc(line.genericName)}" required maxlength="220"></label><label class="span-2">Denominación distintiva<input data-rx-field="brandName" value="${esc(line.brandName)}" maxlength="220"></label>
    <label>Forma farmacéutica (opcional)<input data-rx-field="pharmaceuticalForm" value="${esc(line.pharmaceuticalForm)}" maxlength="100" placeholder="TABLETA"></label><label>Concentración (opcional)<input data-rx-field="concentration" value="${esc(line.concentration)}" maxlength="100" placeholder="500 MG"></label><label class="span-2">Presentación / contenido (opcional)<input data-rx-field="presentation" value="${esc(line.presentation)}" maxlength="180" placeholder="CAJA CON 20 TABLETAS"></label>
    <label>Vía<select data-rx-field="route">${routeOptions.map((route) => `<option${route === line.route ? " selected" : ""}>${route}</option>`).join("")}</select></label><label>Dosis<input data-rx-field="dose" value="${esc(line.dose)}" required maxlength="120" placeholder="1 TABLETA"></label><label>Frecuencia<input data-rx-field="frequency" value="${esc(line.frequency)}" required maxlength="120" placeholder="CADA 8 HORAS"></label><label>Duración<input data-rx-field="duration" value="${esc(line.duration)}" required maxlength="120" placeholder="7 DÍAS"></label>
    <label>Cantidad para farmacia (pzs; no se imprime)<input data-rx-field="quantityToDispense" type="number" min="1" max="999" step="1" value="${esc(line.quantityToDispense || pharmacyQuantityDetection(line).quantity)}"><small data-rx-quantity-help>${esc(pharmacyQuantityHelper(line))}</small></label><label class="span-3">Indicaciones específicas<textarea data-rx-field="instructions" maxlength="600" placeholder="Tomar con alimentos, precauciones u horario">${esc(line.instructions)}</textarea></label>
  </div></article>`).join("");
  renderPrescriptionPreview();
}

function updatePrescriptionLineFromElement(element) {
  const container = element.closest("[data-rx-line-id]"); if (!container) return;
  const line = APP.prescriptionLines.find((item) => item.lineId === container.dataset.rxLineId); if (!line) return;
  const field = element.dataset.rxField;
  line[field] = element.value;
  if (field === "quantityToDispense") {
    line.quantityAuto = false;
  } else if (["genericName", "brandName", "presentation", "pharmaceuticalForm"].includes(field) && line.quantityAuto !== false) {
    const detected = pharmacyQuantityDetection(line);
    line.quantityToDispense = detected.quantity;
    const quantityInput = container.querySelector('[data-rx-field="quantityToDispense"]');
    if (quantityInput) quantityInput.value = String(detected.quantity);
    const help = container.querySelector("[data-rx-quantity-help]");
    if (help) help.textContent = pharmacyQuantityHelper(line);
  }
  renderPrescriptionPreview();
}

async function searchPrescriptionProducts() {
  const term = $("prescription-product-search").value.trim(); const key = normalize(term);
  if (key.length < 2) throw new Error("Escribe al menos dos caracteres o escanea un código.");
  const numeric = /^\d+$/.test(digits(term)) && digits(term).length >= 4;
  const start = numeric ? digits(term) : key;
  const data = await db(`expediente_clinico/${APP.config.storeId}/inventario/productos`, { query: { orderBy: jsonQueryValue(numeric ? "codigo" : "searchKey"), startAt: jsonQueryValue(start), endAt: jsonQueryValue(`${start}\uf8ff`), limitToFirst: 20 } });
  APP.prescriptionSearchRows = inventoryToArray(data).filter((row) => Number(row.existencia || 0) > 0);
  const target = $("prescription-product-results"); target.hidden = false;
  target.innerHTML = APP.prescriptionSearchRows.length ? APP.prescriptionSearchRows.map((row) => `<button class="rx-search-item" type="button" data-add-rx-product="${esc(row.id)}"><span><b>${esc(row.generica || row.nombre || "PRODUCTO")}</b><small>${esc(row.distintiva || "")} · ${esc(row.presentacion || "")} · ${esc(row.codigo || "")}</small></span><strong>${esc(Number(row.existencia) || 0)} pz</strong></button>`).join("") : '<div class="empty">No hay coincidencias disponibles.</div>';
}

function ageNumber(value) { const match = String(value || "").match(/\d+/); return match ? Number(match[0]) : 0; }

function numericInput(id) {
  const raw = String($(id)?.value ?? "").trim();
  return raw === "" ? null : Number(raw);
}

function calculatePrescriptionBmi() {
  const kg = numericInput("prescription-patient-weight"); const cm = numericInput("prescription-patient-height");
  $("prescription-patient-bmi").value = kg > 0 && cm > 0 ? (kg / ((cm / 100) ** 2)).toFixed(1) : "";
}

function fillPrescriptionPatientFromRecord(patientId, patient) {
  if (!patient) return;
  APP.prescriptionPatientId = patientId || ""; APP.prescriptionPatientRecord = patient;
  $("prescription-patient-label").value = patient.name || "";
  $("prescription-patient-birth").value = patient.birthDate || "";
  $("prescription-patient-age").value = ageNumber(ageFromBirth(patient.birthDate)) || "";
  $("prescription-patient-sex").value = ["MASCULINO", "FEMENINO"].includes(normalize(patient.sex)) ? normalize(patient.sex) : "";
  $("prescription-patient-allergies").value = text(patient.allergies, "") || "NEGADAS";
  refreshPrescriptionCompactSections();
}

function syncPrescriptionPatientInput(element) {
  if (element.id === "prescription-patient-label" && APP.prescriptionPatientRecord && normalize(element.value) !== normalize(APP.prescriptionPatientRecord.name)) {
    APP.prescriptionPatientId = ""; APP.prescriptionPatientRecord = null;
  }
  if (element.id === "prescription-patient-birth") $("prescription-patient-age").value = ageNumber(ageFromBirth(element.value)) || "";
  if (element.id === "prescription-patient-weight" || element.id === "prescription-patient-height") calculatePrescriptionBmi();
}

const PRESCRIPTION_PATIENT_REQUIRED_IDS = [
  "prescription-patient-label", "prescription-patient-age", "prescription-patient-sex", "prescription-patient-weight",
  "prescription-patient-height", "prescription-patient-bmi", "prescription-patient-temperature",
  "prescription-patient-systolic", "prescription-patient-diastolic", "prescription-patient-allergies", "prescription-diagnosis"
];

function prescriptionFieldHasValue(id) {
  return String($(id)?.value ?? "").trim() !== "";
}

function prescriptionPrescriberReady() {
  const doctorId = $("prescription-doctor")?.value || APP.selectedDoctorId;
  return doctorProfileComplete(selectedDoctor(APP.medicalConfig, doctorId))
    && ["prescription-datetime", "prescription-valid-until", "prescription-type"].every(prescriptionFieldHasValue);
}

function prescriptionPatientReady() {
  return PRESCRIPTION_PATIENT_REQUIRED_IDS.every(prescriptionFieldHasValue);
}

function refreshPrescriptionCompactSections({ changedId = "", forceOpen = false } = {}) {
  const prescriberSection = $("prescription-prescriber-section"); const patientSection = $("prescription-patient-section");
  if (!prescriberSection || !patientSection) return;
  const doctorId = $("prescription-doctor")?.value || APP.selectedDoctorId; const doctor = selectedDoctor(APP.medicalConfig, doctorId);
  $("prescription-prescriber-summary").textContent = doctorProfileComplete(doctor) ? `${doctor.doctorName} · CÉD. ${doctor.doctorLicense}` : "Selecciona al médico que prescribe";
  const patientName = $("prescription-patient-label")?.value.trim() || ""; const age = $("prescription-patient-age")?.value.trim() || "";
  $("prescription-patient-summary").textContent = patientName ? `${patientName}${age ? ` · ${age} año(s)` : ""}` : "Captura o selecciona al paciente";
  if (forceOpen) { prescriberSection.open = true; patientSection.open = true; return; }
  if (["prescription-doctor", "prescription-datetime", "prescription-valid-until", "prescription-type"].includes(changedId) && prescriptionPrescriberReady()) prescriberSection.open = false;
  if (PRESCRIPTION_PATIENT_REQUIRED_IDS.includes(changedId) && prescriptionPatientReady()) {
    patientSection.open = false;
    setTimeout(() => $("prescription-product-search")?.focus(), 0);
  }
}

function prescriptionDraft() {
  const issue = $("prescription-datetime")?.value ? new Date($("prescription-datetime").value).toISOString() : isoNow();
  const doctorId = $("prescription-doctor")?.value || APP.selectedDoctorId; const profile = selectedDoctor(APP.medicalConfig, doctorId);
  return {
    id: "", folio: formatPrescriptionFolio(), type: $("prescription-type")?.value || "ORDINARIA", issuedAt: issue,
    validUntil: $("prescription-valid-until")?.value || "", diagnosis: $("prescription-diagnosis")?.value.trim() || "",
    nonPharmacological: $("prescription-nonpharma")?.value.trim() || "", patientId: APP.prescriptionPatientId,
    patient: {
      name: $("prescription-patient-label")?.value.trim() || "", birthDate: $("prescription-patient-birth")?.value || "", age: numericInput("prescription-patient-age"),
      sex: $("prescription-patient-sex")?.value || "", allergies: $("prescription-patient-allergies")?.value.trim() || "",
      heightCm: numericInput("prescription-patient-height"), weightKg: numericInput("prescription-patient-weight"), bmi: numericInput("prescription-patient-bmi"),
      temperatureC: numericInput("prescription-patient-temperature"), bloodPressure: { systolic: numericInput("prescription-patient-systolic"), diastolic: numericInput("prescription-patient-diastolic") },
      phone: APP.prescriptionPatientRecord?.phone || ""
    },
    doctor: profile ? { id: profile.id, name: profile.doctorName, sex: profile.doctorSex, license: profile.doctorLicense, profession: profile.doctorProfession, specialty: profile.doctorSpecialty, university: profile.doctorUniversity, leftImage: profile.leftHeaderImage, rightImage: profile.rightHeaderImage } : {},
    pharmacy: { name: APP.config?.pharmacyName || "Farmacia", address: APP.config?.pharmacyAddress || "", phone: APP.medicalConfig?.pharmacyPhone || APP.config?.pharmacyPhone || "" },
    items: APP.prescriptionLines.map((line) => ({ ...line }))
  };
}

function prescriptionPaperHtml(recipe) {
  const r = recipe || prescriptionDraft(); const leftImage = safeDataImage(r.doctor?.leftImage || r.doctor?.crest); const rightImage = safeDataImage(r.doctor?.rightImage || r.doctor?.signature);
  const doctorName = titledDoctorName(r.doctor);
  const medicineRows = (r.items || []).length ? r.items.map((line, index) => {
    const descriptor = [line.brandName, line.pharmaceuticalForm, line.concentration, line.presentation].filter(Boolean).join(" · ");
    const directions = [`DOSIS ${line.dose || "—"}`, `VÍA ${line.route || "—"}`, `FRECUENCIA ${line.frequency || "—"}`, `DURACIÓN ${line.duration || "—"}`, line.instructions || ""].filter(Boolean).join(" · ");
    return `<tr><td>${index + 1}</td><td><b>${esc(line.genericName || "MEDICAMENTO")}</b>${descriptor ? ` · ${esc(descriptor)}` : ""} — ${esc(directions)}</td></tr>`;
  }).join("") : '<tr><td colspan="2">Sin medicamentos capturados.</td></tr>';
  return `<article class="prescription-paper"><header class="rx-head">${leftImage ? `<img class="rx-logo rx-logo-left" src="${leftImage}" alt="Imagen superior izquierda">` : '<div class="rx-logo rx-logo-left"></div>'}<div class="rx-head-center"><h2>${esc(doctorName)}</h2><div class="rx-doctor-line"><div class="rx-doctor-main"><span>CÉDULA ${esc(r.doctor?.license || "PENDIENTE")}</span><span class="rx-doctor-part">${esc(r.doctor?.profession || "PROFESIÓN")}</span>${r.doctor?.specialty ? `<span class="rx-doctor-part">${esc(r.doctor.specialty)}</span>` : ""}</div><div class="rx-doctor-university">${esc(r.doctor?.university || "INSTITUCIÓN FORMADORA")}</div></div></div>${rightImage ? `<img class="rx-logo rx-logo-right" src="${rightImage}" alt="Imagen superior derecha">` : '<div class="rx-logo rx-logo-right"></div>'}</header>
    <section class="rx-folio-row"><b class="rx-folio">${esc(r.folio || formatPrescriptionFolio())}</b></section>
    <section class="rx-patient"><span class="rx-patient-name"><b>PACIENTE:</b> ${esc(r.patient?.name || "NOMBRE DEL PACIENTE")}</span><span class="rx-patient-date"><b>FECHA:</b> ${esc(formatDate(r.issuedAt, true))}</span><span><b>EDAD:</b> ${esc(r.patient?.age ?? "—")}</span><span><b>SEXO:</b> ${esc(r.patient?.sex || "—")}</span><span><b>PESO:</b> ${esc(r.patient?.weightKg ?? "—")} kg</span><span><b>TALLA:</b> ${esc(r.patient?.heightCm ?? "—")} cm</span><span><b>IMC:</b> ${esc(r.patient?.bmi ?? "—")}</span><span><b>TEMP.:</b> ${esc(r.patient?.temperatureC ?? "—")} °C</span><span><b>TA:</b> ${esc(r.patient?.bloodPressure?.systolic ?? "—")}/${esc(r.patient?.bloodPressure?.diastolic ?? "—")} mmHg</span><span></span><span class="wide"><b>ALERGIAS:</b> ${esc(r.patient?.allergies || "—")}</span><span class="wide"><b>DIAGNÓSTICO:</b> ${esc(r.diagnosis || "—")}</span></section>
    <table class="rx-medications"><thead><tr><th>#</th><th>MEDICAMENTO E INDICACIONES</th></tr></thead><tbody>${medicineRows}</tbody></table>
    <footer class="rx-footer"><div class="rx-signature"><div class="rx-signature-box"><b>${esc(doctorName)}</b><br>FIRMA</div></div><div class="rx-footer-bottom"><div class="rx-notes"><b>INDICACIONES COMPLEMENTARIAS:</b>${r.nonPharmacological ? ` ${esc(r.nonPharmacological)}` : ""}</div><div class="rx-pharmacy-contact"><span>${esc(r.pharmacy?.address || "DIRECCIÓN PENDIENTE DEL SISTEMA PRINCIPAL")}</span><span>${r.pharmacy?.phone ? `TEL. ${esc(r.pharmacy.phone)}` : "TELÉFONO PENDIENTE"}</span></div></div></footer></article>`;
}

function prescriptionSheetHtml(recipe) {
  const copy = prescriptionPaperHtml(recipe); return `<div class="prescription-sheet"><div class="prescription-copy">${copy}</div><div class="prescription-divider"><span>CORTE</span></div><div class="prescription-copy">${copy}</div></div>`;
}

function renderPrescriptionPreview(recipe = APP.selectedPrescription) {
  const target = $("prescription-preview"); if (!target) return;
  target.outerHTML = `<div id="prescription-preview">${prescriptionPaperHtml(recipe || prescriptionDraft())}</div>`;
  $("btn-print-prescription").disabled = !(recipe?.id);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function integrityCodeFor(value) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))));
  return Array.from(hash.slice(0, 10), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function validatePrescriptionLines(lines) {
  if (!lines.length) throw new Error("Agrega al menos un medicamento.");
  return lines.map((line, index) => {
    const rawQuantity = String(line.quantityToDispense ?? "").trim(); const quantityToDispense = rawQuantity ? Math.trunc(Number(rawQuantity)) : null;
    const item = { ...line, genericName: text(line.genericName, ""), pharmaceuticalForm: text(line.pharmaceuticalForm, ""), concentration: text(line.concentration, ""), presentation: text(line.presentation, ""), route: text(line.route, ""), dose: text(line.dose, ""), frequency: text(line.frequency, ""), duration: text(line.duration, ""), quantityToDispense };
    if (!item.genericName || !item.route || !item.dose || !item.frequency || !item.duration) throw new Error(`Completa los datos clínicos obligatorios del medicamento ${index + 1}.`);
    if (quantityToDispense !== null && (!Number.isInteger(quantityToDispense) || quantityToDispense < 1 || quantityToDispense > 999)) throw new Error(`La cantidad opcional del medicamento ${index + 1} no es válida.`);
    delete item.lineId; delete item.quantityAuto; return item;
  });
}

async function allocatePrescriptionFolio() {
  const result = await updateFolioTransaction((current) => ({ ...current, lastIssued: current.nextNumber, nextNumber: current.nextNumber + 1, updatedAt: isoNow(), updatedBy: APP.auth.uid }));
  return { folio: formatPrescriptionFolio(result.before, result.before.nextNumber), number: result.before.nextNumber, control: result.after };
}

async function savePrescription(event) {
  event.preventDefault();
  if (!medicalConfigComplete()) throw new Error("Completa primero Configuración médica, incluida la dirección y el teléfono de la farmacia.");
  const draft = prescriptionDraft(); const items = validatePrescriptionLines(draft.items);
  const bp = draft.patient.bloodPressure || {};
  if (!draft.patient.name || draft.patient.age === null || !draft.patient.sex || !draft.patient.allergies || !draft.patient.heightCm || !draft.patient.weightKg || !draft.patient.bmi || !draft.patient.temperatureC || !bp.systolic || !bp.diastolic || !draft.validUntil || !draft.diagnosis) throw new Error("Completa nombre, edad, sexo, alergias, talla, peso, IMC, temperatura, presión arterial, vigencia y diagnóstico.");
  const issuedAt = draft.issuedAt; const validUntilEnd = new Date(`${draft.validUntil}T23:59:59`);
  if (validUntilEnd < new Date(issuedAt)) throw new Error("La vigencia no puede ser anterior a la fecha de emisión.");
  const reservation = await allocatePrescriptionFolio(); const createdAt = isoNow(); const id = newId("RECETA").toUpperCase();
  const linkedPatient = !!(APP.prescriptionPatientId && APP.prescriptionPatientRecord); const patientId = linkedPatient ? APP.prescriptionPatientId : newId("PAC_MANUAL").toUpperCase();
  const recipe = { ...draft, patientId, patientSource: linkedPatient ? "EXPEDIENTE" : "CAPTURA_MANUAL", id, folio: reservation.folio, folioNumber: reservation.number, items, createdAt, authorUid: APP.auth.uid, authorEmail: APP.auth.email, authenticatedAuthor: true, immutable: true, schemaVersion: 1 };
  recipe.integrityCode = await integrityCodeFor({ ...recipe, integrityCode: undefined });
  const index = { id, folio: recipe.folio, patientId, patientName: recipe.patient.name, type: recipe.type, issuedAt: recipe.issuedAt, validUntil: recipe.validUntil, itemCount: items.length, createdAt, doctorName: recipe.doctor.name, searchKey: normalize(`${recipe.folio} ${recipe.patient.name}`), integrityCode: recipe.integrityCode, schemaVersion: 1 };
  const operations = [
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/recetas/${patientId}/${id}`, body: recipe },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/recetas_historial/${id}`, body: index },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/respaldos/${dateKey(createdAt)}/${id}`, body: { kind: "PRESCRIPTION", patientId, data: recipe } },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/auditoria/${newId("audit")}`, body: { action: "PRESCRIPTION_CREATED", patientId, patientSource: recipe.patientSource, recordId: id, folio: recipe.folio, createdAt, uid: APP.auth.uid, email: APP.auth.email } }
  ];
  if (linkedPatient) operations.splice(3, 0,
    { method: "PATCH", path: `expediente_clinico/${APP.config.storeId}/pacientes/${patientId}`, body: { updatedAt: createdAt } },
    { method: "PATCH", path: `expediente_clinico/${APP.config.storeId}/pacientes_indice/${patientId}`, body: { updatedAt: createdAt } }
  );
  await commitEvent({ id: newId("evt_prescription"), createdAt, operations });
  APP.selectedPrescription = recipe; APP.prescriptionLines = []; $("prescription-confirm").checked = false;
  if (linkedPatient) await backupPatient(patientId).catch(() => {}); await loadPrescriptionHistory(); fillMedicalSettingsForm(); renderPrescriptionLines(); renderPrescriptionPreview(recipe);
  toast(`Receta ${recipe.folio} guardada correctamente.`, "ok");
}

function clearPrescriptionDraft(resetForm = true) {
  APP.selectedPrescription = null; APP.prescriptionLines = []; APP.prescriptionSearchRows = [];
  if (resetForm) $("prescription-form").reset();
  $("prescription-product-results").hidden = true; $("prescription-product-results").innerHTML = "";
  const now = new Date(); $("prescription-datetime").value = localDateTimeValue(now);
  const valid = new Date(now); valid.setDate(valid.getDate() + 30); $("prescription-valid-until").value = dateKey(valid);
  if (APP.selectedPatient) {
    fillPrescriptionPatientFromRecord(APP.selectedPatientId, APP.selectedPatient);
  } else {
    APP.prescriptionPatientId = ""; APP.prescriptionPatientRecord = null;
  }
  calculatePrescriptionBmi();
  refreshPrescriptionCompactSections({ forceOpen:true }); renderPrescriptionLines(); renderPrescriptionPreview();
}

async function loadPrescriptionHistory() {
  const [history, sends] = await Promise.all([
    db(`expediente_clinico/${APP.config.storeId}/recetas_historial`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 50 } }).catch(() => ({})),
    db(`expediente_clinico/${APP.config.storeId}/recetas_envios`).catch(() => ({}))
  ]);
  APP.prescriptionHistory = Object.entries(history || {}).map(([id, item]) => ({ id, ...(item || {}), send: sends?.[id] || null })).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  renderPrescriptionHistory(); return APP.prescriptionHistory;
}

function renderPrescriptionHistory() {
  const term = normalize($("prescription-history-search")?.value || "");
  const rows = APP.prescriptionHistory.filter((item) => !term || normalize(`${item.folio} ${item.patientName}`).includes(term));
  $("prescription-history").innerHTML = rows.length ? rows.map((item) => `<article class="rx-history-item"><div><h4>${esc(item.folio)}</h4><p>${esc(item.patientName)} · ${esc(formatDate(item.issuedAt, true))} · ${esc(item.type)} · ${esc(item.itemCount)} medicamento(s)</p></div><div class="rx-history-actions"><button class="open" type="button" data-open-prescription="${esc(item.id)}" data-patient="${esc(item.patientId)}">Ver / imprimir</button>${item.send ? `<button class="sent" type="button" disabled>Enviada ${esc(formatDate(item.send.sentAt, true))}</button>` : `<button class="send" type="button" data-send-prescription="${esc(item.id)}" data-patient="${esc(item.patientId)}">Enviar a farmacia</button>`}</div></article>`).join("") : '<div class="empty">No hay recetas que coincidan.</div>';
}

async function openPrescription(id, patientId) {
  const recipe = await db(`expediente_clinico/${APP.config.storeId}/recetas/${patientId}/${id}`);
  if (!recipe) throw new Error("La receta no está disponible.");
  APP.selectedPrescription = recipe; renderPrescriptionPreview(recipe); showView("prescriptions");
}

function b64(bytes) { let binary = ""; const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []); for (const byte of arr) binary += String.fromCharCode(byte); return btoa(binary); }

async function encryptPharmacyOrder(payload, channel) {
  const jwk = channel?.publicKey || channel?.clavePublicaPedidos; const keyId = text(channel?.keyId || channel?.clavePedidosId, "");
  if (!jwk?.n || !jwk?.e || !keyId) throw new Error("El canal seguro de recetas todavía no está publicado. En el sistema principal abre Configuración > Conexiones y presiona Sincronizar inventario clínico.");
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]); const raw = await crypto.subtle.exportKey("raw", aesKey); const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(JSON.stringify(payload))); const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, raw);
  return { version: 1, alg: "RSA-OAEP+A256GCM", keyId, key: b64(wrapped), iv: b64(iv), data: b64(data) };
}

async function sendPrescriptionToPharmacy(id, patientId) {
  const existing = await db(`expediente_clinico/${APP.config.storeId}/recetas_envios/${id}`).catch(() => null);
  if (existing) throw new Error(`La receta ya fue enviada a farmacia el ${formatDate(existing.sentAt, true)}.`);
  const recipe = await db(`expediente_clinico/${APP.config.storeId}/recetas/${patientId}/${id}`); if (!recipe) throw new Error("La receta no está disponible.");
  const linked = (recipe.items || []).filter((item) => item.productCode && item.inventoryId);
  if (!linked.length) throw new Error("La receta no contiene medicamentos vinculados al inventario. Agrégalos desde el buscador para enviarlos al carrito.");
  if (linked.length !== (recipe.items || []).length && !window.confirm("Algunos medicamentos fueron capturados manualmente y no pueden vincularse al inventario. ¿Enviar únicamente los productos vinculados?")) return;
  const linkedWithQuantity = linked.map((item) => ({ ...item, quantityToDispense: prescriptionQuantity.effective(item) }));
  let channel = await db(`expediente_clinico/${APP.config.storeId}/canal_farmacia`).catch(() => null);
  if (!channel?.publicKey?.n || !channel?.keyId) channel = await db(`mi_farmacia/tiendas/${APP.config.storeId}`).catch(() => null);
  const orderId = firebaseKey(`RX-${id}`).slice(0, 120); const createdAt = isoNow();
  const items = linkedWithQuantity.map((item) => ({ idProducto: item.inventoryId, codigo: item.productCode, generica: item.genericName, distintiva: item.brandName || "", nombre: [item.genericName, item.brandName].filter(Boolean).join(" "), presentacion: item.presentation, cantidad: Number(item.quantityToDispense), precioUnitario: Number(item.price || 0), importe: Number(item.price || 0) * Number(item.quantityToDispense) }));
  const piezas = items.reduce((sum, item) => sum + item.cantidad, 0); const totalEstimado = items.reduce((sum, item) => sum + item.importe, 0);
  const contenidoCifrado = await encryptPharmacyOrder({ cliente: { nombre: recipe.patient?.name || "PACIENTE", telefono: recipe.patient?.phone || "" }, observaciones: `RECETA ${recipe.folio} · ${recipe.type}`, entrega: { tipo: "RECOGER_SUCURSAL" }, items, piezas, totalEstimado }, channel);
  const order = { version: 1, origen: "RECETARIO_CLINICO", id: orderId, tiendaId: APP.config.storeId, tiendaNombre: APP.config.pharmacyName, estado: "NUEVO", recetaFolio: recipe.folio, prescriptionId: id, creadoEn: createdAt, actualizadoEn: createdAt, contenidoCifrado };
  await db(`mi_farmacia/pedidos/${APP.config.storeId}/${orderId}`, { method: "PUT", body: order });
  await db(`mi_farmacia/pedidos_meta/${APP.config.storeId}`, { method: "PUT", body: { revision: Date.now(), actualizadoEn: createdAt } }).catch(() => null);
  const send = { recipeId: id, folio: recipe.folio, orderId, sentAt: createdAt, sentBy: APP.auth.uid, schemaVersion: 1 };
  await commitEvent({ id: newId("evt_rx_send"), createdAt, operations: [
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/recetas_envios/${id}`, body: send },
    { method: "PUT", path: `expediente_clinico/${APP.config.storeId}/auditoria/${newId("audit")}`, body: { action: "PRESCRIPTION_SENT_TO_PHARMACY", patientId, recordId: id, orderId, createdAt, uid: APP.auth.uid, email: APP.auth.email } }
  ]});
  await loadPrescriptionHistory(); toast(`Receta ${recipe.folio} enviada. La farmacia podrá cargarla en el primer carrito disponible.`, "ok");
}

function printSelectedPrescription() {
  if (!APP.selectedPrescription?.id) throw new Error("Abre o guarda una receta antes de imprimir.");
  $("prescription-print").innerHTML = prescriptionSheetHtml(APP.selectedPrescription); $("prescription-print").setAttribute("aria-hidden", "false");
  window.print(); setTimeout(() => $("prescription-print").setAttribute("aria-hidden", "true"), 300);
}

function exportPrescriptionHistory() {
  if (!APP.prescriptionHistory.length) throw new Error("No hay recetas para exportar.");
  const rows = [["FOLIO", "FECHA", "VIGENCIA", "TIPO", "PACIENTE", "MÉDICO", "MEDICAMENTOS", "ESTADO FARMACIA"], ...APP.prescriptionHistory.map((item) => [item.folio, item.issuedAt, item.validUntil, item.type, item.patientName, item.doctorName, item.itemCount, item.send ? `ENVIADA ${item.send.sentAt}` : "GUARDADA"])];
  downloadBlob(xlsxBlob([{ name: "RECETAS", rows }]), `HISTORIAL_RECETAS_${dateKey()}.xlsx`); toast("Historial de recetas exportado a Excel.", "ok");
}

async function preparePrescriptionModule() {
  if (!APP.medicalConfig) await loadMedicalSettings();
  if (!APP.prescriptionHistory.length) await loadPrescriptionHistory();
  if (!$("prescription-datetime").value) clearPrescriptionDraft(false);
  fillMedicalSettingsForm(); renderPrescriptionPreview();
}

async function startApp() {
  if (!APP.auth?.idToken || Date.now() > Number(APP.auth?.expiresAt || 0) - 60000) await refreshAuth();
  await checkRole();
  sessionStorage.setItem("macroxelClinicalSession", JSON.stringify(APP.auth));
  saveDeviceSession();
  $("login-screen").hidden = true;
  $("app").hidden = false;
  await restoreBackupHandle();
  await flushPending();
  await loadMedicalSettings().catch(() => null);
  prepareForms();
  await loadDashboard();
}

function bindEvents() {
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("login-submit"); const previous = button.textContent; button.disabled = true; button.textContent = "Validando…"; setMessage("login-message", "Validando acceso…");
    try { clearDeviceSession({ keepEmail: true }); APP.auth = await identityLogin($("login-email").value.trim(), $("login-password").value); await startApp(); }
    catch (error) { APP.auth = null; $("app").hidden = true; $("login-screen").hidden = false; setMessage("login-message", error.message, true); }
    finally { button.disabled = false; button.textContent = previous; }
  });
  $("login-reset-password").addEventListener("click", async () => {
    const button = $("login-reset-password"); button.disabled = true; setMessage("login-message", "Enviando correo de recuperación…");
    try { await sendPasswordReset(); setMessage("login-message", "Te enviamos un correo para restablecer la contraseña. Revisa también Spam.", false); }
    catch (error) { setMessage("login-message", error.message, true); }
    finally { button.disabled = false; }
  });
  $("btn-logout").addEventListener("click", () => logout());
  $("btn-backup-folder").addEventListener("click", () => selectBackupFolder().catch((error) => toast(error.message, "error")));
  document.querySelectorAll("[data-view], [data-open-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view || button.dataset.openView)));
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("btn-new-patient").addEventListener("click", () => $("patient-dialog").showModal());
  $("patient-form").addEventListener("submit", (event) => createPatient(event).catch((error) => toast(error.message, "error")));
  $("btn-search-patient").addEventListener("click", () => searchPatients($("patient-search").value, $("patient-results")).catch((error) => toast(error.message, "error")));
  $("patient-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("btn-search-patient").click(); } });
  $("btn-pick-patient").addEventListener("click", () => { APP.patientPickerTarget = "consultation"; $("patient-picker-dialog").showModal(); });
  $("btn-pick-prescription-patient").addEventListener("click", () => { APP.patientPickerTarget = "prescriptions"; $("patient-picker-dialog").showModal(); });
  $("btn-picker-search").addEventListener("click", () => searchPatients($("picker-search").value, $("picker-results"), true).catch((error) => toast(error.message, "error")));
  $("picker-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("btn-picker-search").click(); } });
  document.addEventListener("click", (event) => {
    const patientButton = event.target.closest("[data-patient-id]");
    if (patientButton) {
      const picker = patientButton.dataset.picker === "1";
      openPatient(patientButton.dataset.patientId).then(() => {
        if (picker) {
          $("patient-picker-dialog").close();
          if (APP.patientPickerTarget === "prescriptions") clearPrescriptionDraft();
          showView(APP.patientPickerTarget || "consultation");
        }
      }).catch((error) => toast(error.message, "error"));
    }
    const action = event.target.closest("[data-patient-action]")?.dataset.patientAction;
    if (action === "consult") showView("consultation");
    if (action === "prescription") { clearPrescriptionDraft(); showView("prescriptions"); }
    if (action === "export") exportPatient().catch((error) => toast(error.message, "error"));

    const addProduct = event.target.closest("[data-add-rx-product]");
    if (addProduct) {
      const product = APP.prescriptionSearchRows.find((item) => item.id === addProduct.dataset.addRxProduct);
      if (product) {
        APP.prescriptionLines.push(blankPrescriptionLine(product));
        $("prescription-product-search").value = "";
        $("prescription-product-results").hidden = true;
        renderPrescriptionLines();
        $("prescription-product-search").focus();
      }
    }
    const removeLine = event.target.closest("[data-remove-rx-line]");
    if (removeLine) {
      APP.prescriptionLines = APP.prescriptionLines.filter((item) => item.lineId !== removeLine.dataset.removeRxLine);
      renderPrescriptionLines();
    }
    const openRecipe = event.target.closest("[data-open-prescription]");
    if (openRecipe) openPrescription(openRecipe.dataset.openPrescription, openRecipe.dataset.patient).catch((error) => toast(error.message, "error"));
    const sendRecipe = event.target.closest("[data-send-prescription]");
    if (sendRecipe) sendPrescriptionToPharmacy(sendRecipe.dataset.sendPrescription, sendRecipe.dataset.patient).catch((error) => toast(error.message, "error"));
    const editDoctor = event.target.closest("[data-edit-doctor]");
    if (editDoctor) openDoctorEditor(editDoctor.dataset.editDoctor);
    const useDoctor = event.target.closest("[data-use-doctor]");
    if (useDoctor) chooseDoctor(useDoctor.dataset.useDoctor).catch((error) => toast(error.message, "error"));
    const removeDoctor = event.target.closest("[data-remove-doctor]");
    if (removeDoctor) removeDoctorProfile(removeDoctor.dataset.removeDoctor).catch((error) => toast(error.message, "error"));
  });
  $("consultation-form").addEventListener("submit", (event) => saveConsultation(event).catch((error) => toast(error.message, "error")));
  $("consultation-form").addEventListener("reset", () => setTimeout(prepareForms, 0));
  $("reference-form").addEventListener("submit", (event) => saveReference(event).catch((error) => toast(error.message, "error")));
  $("vital-weight").addEventListener("input", calculateBmi); $("vital-height").addEventListener("input", calculateBmi);
  $("btn-search-inventory").addEventListener("click", () => searchInventory().catch((error) => toast(error.message, "error")));
  $("inventory-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("btn-search-inventory").click(); } });
  $("btn-export-inventory").addEventListener("click", () => { try { exportInventory(); } catch (error) { toast(error.message, "error"); } });
  $("prescription-form").addEventListener("submit", (event) => savePrescription(event).catch((error) => toast(error.message, "error")));
  $("prescription-form").addEventListener("reset", () => setTimeout(() => clearPrescriptionDraft(false), 0));
  $("prescription-form").addEventListener("input", (event) => {
    if (event.target.matches("[data-rx-field]")) updatePrescriptionLineFromElement(event.target);
    else { syncPrescriptionPatientInput(event.target); refreshPrescriptionCompactSections(); renderPrescriptionPreview(); }
  });
  $("prescription-form").addEventListener("change", (event) => {
    if (event.target.matches("[data-rx-field]")) updatePrescriptionLineFromElement(event.target);
    else { if (event.target.id === "prescription-doctor") APP.selectedDoctorId = event.target.value; refreshPrescriptionCompactSections({ changedId:event.target.id }); renderPrescriptionPreview(); }
  });
  $("prescription-form").addEventListener("invalid", (event) => { const section = event.target.closest("details.rx-collapsible-section"); if (section) section.open = true; }, true);
  $("btn-new-prescription").addEventListener("click", () => clearPrescriptionDraft());
  $("btn-print-prescription").addEventListener("click", () => { try { printSelectedPrescription(); } catch (error) { toast(error.message, "error"); } });
  $("btn-add-manual-medicine").addEventListener("click", () => { APP.prescriptionLines.push(blankPrescriptionLine()); renderPrescriptionLines(); });
  $("btn-search-prescription-product").addEventListener("click", () => searchPrescriptionProducts().catch((error) => toast(error.message, "error")));
  $("prescription-product-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("btn-search-prescription-product").click(); } });
  $("btn-search-prescription-history").addEventListener("click", renderPrescriptionHistory);
  $("prescription-history-search").addEventListener("input", renderPrescriptionHistory);
  $("btn-export-prescriptions").addEventListener("click", () => { try { exportPrescriptionHistory(); } catch (error) { toast(error.message, "error"); } });

  $("clinical-settings-form").addEventListener("submit", (event) => saveMedicalSettings(event).catch((error) => toast(error.message, "error")));
  $("settings-doctor-editor-section").addEventListener("toggle", (event) => { if (event.currentTarget.open && !APP.doctorEditorActive) event.currentTarget.open = false; });
  $("clinical-contact-form").addEventListener("submit", (event) => saveClinicalContact(event).catch((error) => toast(error.message, "error")));
  $("folio-settings-form").addEventListener("submit", (event) => saveFolioSettings(event).catch((error) => toast(error.message, "error")));
  $("btn-new-doctor").addEventListener("click", () => { if (Object.keys(APP.medicalConfig?.profiles || {}).length >= 4) return toast("Ya existen cuatro médicos. Edita o elimina un perfil.", "error"); openDoctorEditor(""); });
  $("btn-cancel-doctor-edit").addEventListener("click", closeDoctorEditor);
  $("btn-enable-folio-edit").addEventListener("click", () => enableFolioEditing(true));
  $("settings-university-crest").addEventListener("change", (event) => optimizeImageFile(event.target.files?.[0]).then((data) => { APP.leftImageDraft = data; setImagePreview("settings-university-crest-preview", data); toast("Imagen izquierda cargada. Guarda el médico para conservarla.", "ok"); }).catch((error) => toast(error.message, "error")));
  $("settings-doctor-signature").addEventListener("change", (event) => optimizeImageFile(event.target.files?.[0]).then((data) => { APP.rightImageDraft = data; setImagePreview("settings-doctor-signature-preview", data); toast("Imagen derecha cargada. Guarda el médico para conservarla.", "ok"); }).catch((error) => toast(error.message, "error")));
  $("btn-clear-university-crest").addEventListener("click", () => { APP.leftImageDraft = ""; $("settings-university-crest").value = ""; setImagePreview("settings-university-crest-preview", ""); });
  $("btn-clear-doctor-signature").addEventListener("click", () => { APP.rightImageDraft = ""; $("settings-doctor-signature").value = ""; setImagePreview("settings-doctor-signature-preview", ""); });
  window.addEventListener("online", () => flushPending().catch(() => {}));
}

async function bootstrap() {
  bindEvents();
  const lastEmail = String(localStorage.getItem(LAST_EMAIL_KEY) || "").trim();
  if (lastEmail) $("login-email").value = lastEmail;
  try {
    await loadConfig();
    const cached = loadDeviceSession() || JSON.parse(sessionStorage.getItem("macroxelClinicalSession") || "null");
    if (cached?.email && !$("login-email").value) $("login-email").value = cached.email;
    if (cached?.refreshToken) {
      APP.auth = cached; setMessage("login-message", "Reconociendo este dispositivo…", false);
      try { await startApp(); }
      catch (sessionError) { APP.auth = null; clearDeviceSession({ keepEmail: true }); $("app").hidden = true; $("login-screen").hidden = false; setMessage("login-message", "La sesión guardada venció o fue revocada. Inicia sesión nuevamente.", true); }
    }
  } catch (error) {
    APP.auth = null; clearDeviceSession({ keepEmail: true }); $("app").hidden = true; $("login-screen").hidden = false; setMessage("login-message", error.message, true);
  }
}

bootstrap();

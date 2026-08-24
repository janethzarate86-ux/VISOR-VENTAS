"use strict";

const APP = {
  config: null,
  auth: null,
  selectedPatientId: "",
  selectedPatient: null,
  recentPatients: [],
  inventoryRows: [],
  backupHandle: null,
  toastTimer: null
};

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

async function identityLogin(email, password) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(APP.config.firebaseApiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message === "INVALID_LOGIN_CREDENTIALS" ? "Correo o contraseña incorrectos." : "No fue posible iniciar sesión.");
  return { uid: body.localId, email: body.email, idToken: body.idToken, refreshToken: body.refreshToken, expiresAt: Date.now() + (Number(body.expiresIn) || 3600) * 1000 };
}

async function refreshAuth() {
  if (!APP.auth?.refreshToken) throw new Error("La sesión terminó. Inicia sesión nuevamente.");
  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(APP.config.firebaseApiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: APP.auth.refreshToken })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("La sesión terminó. Inicia sesión nuevamente.");
  APP.auth = { ...APP.auth, uid: body.user_id, idToken: body.id_token, refreshToken: body.refresh_token || APP.auth.refreshToken, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  sessionStorage.setItem("macroxelClinicalSession", JSON.stringify(APP.auth));
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

function logout(message = "Sesión cerrada.") {
  APP.auth = null;
  APP.selectedPatientId = "";
  APP.selectedPatient = null;
  sessionStorage.removeItem("macroxelClinicalSession");
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
  const [patient, consultations, references] = await Promise.all([
    db(`expediente_clinico/${APP.config.storeId}/pacientes/${patientId}`),
    db(`expediente_clinico/${APP.config.storeId}/consultas/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 200 } }),
    db(`expediente_clinico/${APP.config.storeId}/referencias/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 200 } })
  ]);
  const snapshot = { schema: "macroxel-clinical-backup-v1", patientId, generatedAt: isoNow(), pharmacyName: APP.config.pharmacyName, patient: patient || {}, consultations: consultations || {}, references: references || {} };
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
  const [patient, consultations, references] = await Promise.all([
    db(`expediente_clinico/${APP.config.storeId}/pacientes/${patientId}`),
    db(`expediente_clinico/${APP.config.storeId}/consultas/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 50 } }),
    db(`expediente_clinico/${APP.config.storeId}/referencias/${patientId}`, { query: { orderBy: jsonQueryValue("createdAt"), limitToLast: 50 } })
  ]);
  if (!patient) throw new Error("El expediente ya no está disponible.");
  APP.selectedPatientId = patientId;
  APP.selectedPatient = patient;
  $("consult-patient-label").value = `${patient.name} · ${patientId}`;
  $("reference-patient-label").value = `${patient.name} · ${patientId}`;
  renderPatientDetail(patientId, patient, consultations || {}, references || {});
  showView("records");
}

function renderPatientDetail(id, patient, consultations, references) {
  const notes = Object.entries(consultations).map(([entryId, item]) => ({ entryId, kind: "note", ...item }));
  const refs = Object.entries(references).map(([entryId, item]) => ({ entryId, kind: "reference", ...item }));
  const timeline = [...notes, ...refs].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  $("patient-detail").innerHTML = `<div class="patient-header"><div><span class="patient-id">${esc(id)}</span><h3>${esc(patient.name)}</h3><p>${esc(formatDate(patient.birthDate))} · ${esc(patient.sex)}</p></div><div class="patient-actions"><button class="btn primary" type="button" data-patient-action="consult">Nueva consulta</button><button class="btn ghost" type="button" data-patient-action="export">Exportar Excel</button></div></div>
    <div class="patient-grid">
      ${dataCard("Teléfono", patient.phone)}${dataCard("Correo", patient.email)}${dataCard("Domicilio", patient.address)}
      ${dataCard("Grupo sanguíneo", patient.bloodType)}${dataCard("Alergias", patient.allergies)}${dataCard("Padecimientos crónicos", patient.chronicConditions)}
      ${dataCard("Contacto de emergencia", patient.emergencyContact)}${dataCard("Aviso y consentimiento", patient.consentAt ? `Registrado ${formatDate(patient.consentAt, true)}` : "No asentado")}${dataCard("Última actualización", formatDate(patient.updatedAt, true))}
    </div><h3>Historia clínica y referencias</h3><div class="timeline">${timeline.length ? timeline.map(timelineItem).join("") : '<div class="empty">Aún no hay notas médicas ni referencias.</div>'}</div>`;
}

function dataCard(label, value) { return `<div class="data-card"><span>${esc(label)}</span><b>${esc(text(value))}</b></div>`; }
function timelineItem(item) {
  const reference = item.kind === "reference";
  const title = reference ? `Referencia ${text(item.priority, "ORDINARIA")}` : `${text(item.noteType, "NOTA MÉDICA")} · ${text(item.folio)}`;
  const detail = reference ? `${text(item.recipient)}\n${text(item.reason)}` : `${text(item.diagnosis)}\nPlan: ${text(item.treatment)}`;
  return `<article class="timeline-item ${reference ? "reference" : ""}"><div class="meta"><span>${esc(formatDate(item.clinicalDate || item.createdAt, true))}</span><span>${esc(reference ? item.referringDoctor : `${item.doctorName} · Céd. ${item.doctorLicense}`)}</span></div><h4>${esc(title)}</h4><p>${esc(detail)}</p></article>`;
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
  downloadBlob(xlsxBlob([{ name: "PACIENTE", rows: patientRows }, { name: "CONSULTAS", rows: noteRows }, { name: "REFERENCIAS", rows: refRows }]), `EXPEDIENTE_${safeFile(APP.selectedPatientId)}_${dateKey()}.xlsx`);
  toast("Expediente exportado a Excel.", "ok");
}

function exportInventory() {
  if (!APP.inventoryRows.length) throw new Error("No hay resultados para exportar.");
  const rows = [["CÓDIGO", "DENOMINACIÓN GENÉRICA", "DENOMINACIÓN DISTINTIVA", "PRESENTACIÓN", "EXISTENCIA", "PRECIO VENTA", "ÚLTIMA SINCRONIZACIÓN"], ...APP.inventoryRows.map((p) => [p.codigo, p.generica || p.nombre, p.distintiva, p.presentacion, p.existencia, p.precioVenta, p.updatedAt])];
  downloadBlob(xlsxBlob([{ name: "INVENTARIO", rows }]), `INVENTARIO_CONSULTA_${dateKey()}.xlsx`);
  toast("Resultados de inventario exportados a Excel.", "ok");
}

async function startApp() {
  await checkRole();
  sessionStorage.setItem("macroxelClinicalSession", JSON.stringify(APP.auth));
  $("login-screen").hidden = true;
  $("app").hidden = false;
  await restoreBackupHandle();
  await flushPending();
  prepareForms();
  await loadDashboard();
}

function bindEvents() {
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); setMessage("login-message", "Validando acceso…");
    try { APP.auth = await identityLogin($("login-email").value.trim(), $("login-password").value); await startApp(); }
    catch (error) { logout(error.message); setMessage("login-message", error.message, true); }
  });
  $("btn-logout").addEventListener("click", () => logout());
  $("btn-backup-folder").addEventListener("click", () => selectBackupFolder().catch((error) => toast(error.message, "error")));
  document.querySelectorAll("[data-view], [data-open-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view || button.dataset.openView)));
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("btn-new-patient").addEventListener("click", () => $("patient-dialog").showModal());
  $("patient-form").addEventListener("submit", (event) => createPatient(event).catch((error) => toast(error.message, "error")));
  $("btn-search-patient").addEventListener("click", () => searchPatients($("patient-search").value, $("patient-results")).catch((error) => toast(error.message, "error")));
  $("patient-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("btn-search-patient").click(); } });
  $("btn-pick-patient").addEventListener("click", () => $("patient-picker-dialog").showModal());
  $("btn-picker-search").addEventListener("click", () => searchPatients($("picker-search").value, $("picker-results"), true).catch((error) => toast(error.message, "error")));
  $("picker-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("btn-picker-search").click(); } });
  document.addEventListener("click", (event) => {
    const patientButton = event.target.closest("[data-patient-id]");
    if (patientButton) {
      const picker = patientButton.dataset.picker === "1";
      openPatient(patientButton.dataset.patientId).then(() => { if (picker) { $("patient-picker-dialog").close(); showView("consultation"); } }).catch((error) => toast(error.message, "error"));
    }
    const action = event.target.closest("[data-patient-action]")?.dataset.patientAction;
    if (action === "consult") showView("consultation");
    if (action === "export") exportPatient().catch((error) => toast(error.message, "error"));
  });
  $("consultation-form").addEventListener("submit", (event) => saveConsultation(event).catch((error) => toast(error.message, "error")));
  $("consultation-form").addEventListener("reset", () => setTimeout(prepareForms, 0));
  $("reference-form").addEventListener("submit", (event) => saveReference(event).catch((error) => toast(error.message, "error")));
  $("vital-weight").addEventListener("input", calculateBmi); $("vital-height").addEventListener("input", calculateBmi);
  $("btn-search-inventory").addEventListener("click", () => searchInventory().catch((error) => toast(error.message, "error")));
  $("inventory-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("btn-search-inventory").click(); } });
  $("btn-export-inventory").addEventListener("click", () => { try { exportInventory(); } catch (error) { toast(error.message, "error"); } });
  window.addEventListener("online", () => flushPending().catch(() => {}));
}

async function bootstrap() {
  bindEvents();
  try {
    await loadConfig();
    const cached = JSON.parse(sessionStorage.getItem("macroxelClinicalSession") || "null");
    if (cached?.refreshToken) { APP.auth = cached; await startApp(); }
  } catch (error) {
    logout(error.message);
    setMessage("login-message", error.message, true);
  }
}

bootstrap();

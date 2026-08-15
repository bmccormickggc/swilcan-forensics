const CONFIG = window.SWILCAN_SUPABASE || {};
const ALLOWED_EMAILS = new Set([
  "selena@swilcanforensics.com",
  "bill.mccormick14@gmail.com"
]);
const STAGES = [
  ["prospect", "Prospecting"], ["outreach", "Outreach active"],
  ["conversation", "Conversation"], ["qualified", "Qualified"],
  ["proposal", "Proposal"], ["won", "Won"]
];
const CADENCE = [0, 7, 14, 30];
let state = { schemaVersion: 1, revision: 0, prospects: [], candidates: [] };
let localMode = false;
let supabaseClient = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const today = () => new Date().toISOString().slice(0, 10);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const addDays = (date, days) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const firstName = (name) => String(name || "there").trim().split(/\s+/)[0];

function configIsReady() {
  return /^https:\/\/.+\.supabase\.co$/.test(CONFIG.url || "") &&
    CONFIG.anonKey && !CONFIG.anonKey.startsWith("REPLACE_");
}

function showApp() {
  $("#authScreen").hidden = true;
  $("#appShell").hidden = false;
}

function showLogin(message = "", error = false) {
  $("#appShell").hidden = true;
  $("#authScreen").hidden = false;
  $("#authStatus").textContent = message;
  $("#authStatus").classList.toggle("error", error);
}

async function initializeAuth() {
  if (!configIsReady()) {
    if (["localhost", "127.0.0.1"].includes(location.hostname)) {
      localMode = true;
      showApp();
      await loadState();
      toast("Local preview mode: data stays in this browser.");
    } else {
      showLogin("CRM backend setup is still pending.", true);
    }
    return;
  }

  supabaseClient = window.supabase.createClient(CONFIG.url, CONFIG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) showLogin(error.message, true);
  else if (data.session) {
    const email = String(data.session.user?.email || "").trim().toLowerCase();
    if (!ALLOWED_EMAILS.has(email)) {
      await supabaseClient.auth.signOut();
      showLogin("Access denied.", true);
    } else {
      showApp(); await loadState();
    }
  } else showLogin();

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_IN" && session) {
      const email = String(session.user?.email || "").trim().toLowerCase();
      if (!ALLOWED_EMAILS.has(email)) {
        void supabaseClient.auth.signOut();
        return showLogin("Access denied.", true);
      }
      showApp(); await loadState();
    }
    if (event === "SIGNED_OUT") showLogin("Signed out.");
  });
}

async function requestMagicLink(event) {
  event.preventDefault();
  if (!supabaseClient) return showLogin("CRM backend setup is still pending.", true);
  const email = $("#loginEmail").value.trim().toLowerCase();
  if (!ALLOWED_EMAILS.has(email)) {
    return showLogin("Access denied.", true);
  }
  $("#authStatus").textContent = "Sending secure link…";
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}/crm/` }
  });
  const rateLimited = /rate limit/i.test(error?.message || "");
  const message = rateLimited
    ? "Use the most recent sign-in link in your email."
    : error
      ? "Sign-in link unavailable. Try again shortly."
      : "Check your email for the sign-in link.";
  showLogin(message, Boolean(error && !rateLimited));
}

async function loadState() {
  if (localMode) {
    state = JSON.parse(localStorage.getItem("swilcan-crm-preview") || "null") || state;
    render(); return;
  }
  const { data, error } = await supabaseClient
    .from("crm_state")
    .select("revision,payload,updated_at")
    .eq("id", 1)
    .single();
  if (error) return toast(`CRM data could not be loaded: ${error.message}`, true);
  state = { ...data.payload, revision: Number(data.revision), updatedAt: data.updated_at };
  render();
}

async function saveState() {
  if (localMode) {
    state.revision = Number(state.revision || 0) + 1;
    state.updatedAt = new Date().toISOString();
    localStorage.setItem("swilcan-crm-preview", JSON.stringify(state));
    render(); return true;
  }
  const expectedRevision = Number(state.revision || 0);
  const payload = { schemaVersion: 1, prospects: state.prospects, candidates: state.candidates };
  const { data: userData } = await supabaseClient.auth.getUser();
  const { data, error } = await supabaseClient
    .from("crm_state")
    .update({
      payload,
      revision: expectedRevision + 1,
      updated_at: new Date().toISOString(),
      updated_by: userData.user?.id || null
    })
    .eq("id", 1)
    .eq("revision", expectedRevision)
    .select("revision,payload,updated_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    toast("The CRM changed in another session. Reloaded the newer version.", true);
    await loadState(); return false;
  }
  state = { ...data.payload, revision: Number(data.revision), updatedAt: data.updated_at };
  render();
  return true;
}

function render() { renderCounts(); renderMetrics(); renderFilters(); renderKanban(); renderCandidates(); renderActions(); }
function renderCounts() {
  $("#reviewCount").textContent = state.candidates.filter(c => c.reviewStatus === "pending").length;
  $("#actionCount").textContent = dueProspects().length;
}
function renderMetrics() {
  const active = state.prospects.filter(p => !["won", "cold"].includes(p.stage));
  const values = [
    ["Active prospects", active.length],
    ["Replies", state.prospects.filter(p => ["conversation", "qualified", "proposal", "won"].includes(p.stage)).length],
    ["Qualified", state.prospects.filter(p => ["qualified", "proposal", "won"].includes(p.stage)).length],
    ["Proposals", state.prospects.filter(p => ["proposal", "won"].includes(p.stage)).length],
    ["Won", state.prospects.filter(p => p.stage === "won").length],
  ];
  $("#metrics").innerHTML = values.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
}
function renderFilters() {
  const select = $("#locationFilter"); const current = select.value;
  const locations = [...new Set(state.prospects.map(p => p.location).filter(Boolean))].sort();
  select.innerHTML = `<option value="">All locations</option>${locations.map(v => `<option>${escapeHtml(v)}</option>`).join("")}`;
  if (locations.includes(current)) select.value = current;
}
function visibleProspects() {
  const q = $("#searchInput").value.trim().toLowerCase(); const location = $("#locationFilter").value;
  return state.prospects.filter(p => p.stage !== "cold" && (!location || p.location === location) && (!q || [p.name,p.organization,p.role,p.location].join(" ").toLowerCase().includes(q)));
}
function renderKanban() {
  const rows = visibleProspects();
  $("#kanban").innerHTML = STAGES.map(([key, label]) => {
    const cards = rows.filter(p => p.stage === key);
    return `<section class="column"><div class="column-head"><h3>${label}</h3><span class="column-count">${cards.length}</span></div><div class="card-list" data-stage="${key}">${cards.map(cardHtml).join("") || `<div class="empty">No contacts</div>`}</div></section>`;
  }).join("");
  $$(".prospect-card").forEach(el => {
    let suppressClick = false;
    el.addEventListener("click", () => { if (!suppressClick) openDetail(el.dataset.id); });
    el.addEventListener("dragstart", event => {
      suppressClick = true;
      el.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", el.dataset.id);
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      $$(".card-list").forEach(list => list.classList.remove("drag-over"));
      setTimeout(() => { suppressClick = false; }, 0);
    });
  });
  $$(".card-list").forEach(column => {
    column.addEventListener("dragover", event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      $$(".card-list").forEach(list => list.classList.toggle("drag-over", list === column));
    });
    column.addEventListener("dragleave", event => {
      if (!column.contains(event.relatedTarget)) column.classList.remove("drag-over");
    });
    column.addEventListener("drop", async event => {
      event.preventDefault();
      $$(".card-list").forEach(list => list.classList.remove("drag-over"));
      await moveProspect(event.dataTransfer.getData("text/plain"), column.dataset.stage);
    });
  });
  $$(".drag-handle").forEach(handle => installPointerDrag(handle));
}
function cardHtml(p) {
  let due = "";
  if (p.nextActionDate) { const cls = p.nextActionDate < today() ? "late" : p.nextActionDate === today() ? "due" : ""; due = `<span class="pill ${cls}">${p.nextActionDate}</span>`; }
  return `<article class="prospect-card" draggable="true" data-id="${escapeHtml(p.id)}"><div class="card-title"><h4>${escapeHtml(p.name)}</h4><button class="drag-handle" type="button" aria-label="Move ${escapeHtml(p.name)}" title="Drag to another stage">⋮⋮</button></div><div class="org">${escapeHtml(p.organization)}${p.role ? ` · ${escapeHtml(p.role)}` : ""}</div><div class="meta">${p.location ? `<span class="pill">${escapeHtml(p.location)}</span>` : ""}${due}</div></article>`;
}

async function moveProspect(id, targetStage, options = {}) {
  const p = state.prospects.find(x => x.id === id);
  if (!p || !targetStage) return false;
  const previous = { stage: p.stage, nextActionDate: p.nextActionDate, updatedAt: p.updatedAt };
  const requestedNextAction = Object.prototype.hasOwnProperty.call(options, "nextActionDate")
    ? options.nextActionDate
    : p.nextActionDate;
  if (p.stage === targetStage && requestedNextAction === p.nextActionDate) return true;
  p.stage = targetStage;
  p.nextActionDate = requestedNextAction || (targetStage === "outreach" ? today() : "");
  p.updatedAt = new Date().toISOString();
  try {
    if (!await saveState()) return false;
    const label = STAGES.find(([key]) => key === targetStage)?.[1] || targetStage;
    toast(options.message || `Moved to ${label}.`);
    return true;
  } catch (error) {
    Object.assign(p, previous);
    render();
    toast(`Could not move contact: ${error.message}`, true);
    return false;
  }
}

function installPointerDrag(handle) {
  const card = handle.closest(".prospect-card");
  let active = false;
  let target = null;
  const clearTarget = () => {
    $$(".card-list").forEach(list => list.classList.remove("drag-over"));
    target = null;
  };
  handle.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
  handle.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    active = true;
    handle.setPointerCapture(event.pointerId);
    card.classList.add("dragging");
  });
  handle.addEventListener("pointermove", event => {
    if (!active) return;
    event.preventDefault();
    const board = $("#kanban");
    const bounds = board.getBoundingClientRect();
    if (event.clientX > bounds.right - 44) board.scrollLeft += 24;
    if (event.clientX < bounds.left + 44) board.scrollLeft -= 24;
    const next = document.elementFromPoint(event.clientX, event.clientY)?.closest(".card-list") || null;
    if (next === target) return;
    clearTarget();
    target = next;
    target?.classList.add("drag-over");
  });
  const finish = async event => {
    if (!active) return;
    event.preventDefault(); event.stopPropagation();
    active = false;
    card.classList.remove("dragging");
    const destination = target?.dataset.stage;
    clearTarget();
    if (destination) await moveProspect(card.dataset.id, destination);
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", () => {
    active = false;
    card.classList.remove("dragging");
    clearTarget();
  });
}
function renderCandidates() {
  const candidates = state.candidates.filter(c => c.reviewStatus === "pending");
  $("#reviewGrid").innerHTML = candidates.map(c => `<article class="review-card"><h3>${escapeHtml(c.name)}</h3><div class="org">${escapeHtml(c.organization)}${c.role ? ` · ${escapeHtml(c.role)}` : ""}</div>${c.rationale ? `<p>${escapeHtml(c.rationale)}</p>` : ""}<div class="meta">${c.location ? `<span class="pill">${escapeHtml(c.location)}</span>` : ""}</div><div class="review-actions"><button class="btn primary small approve" data-id="${c.id}">Approve</button><button class="btn secondary small edit-candidate" data-id="${c.id}">Edit</button><button class="btn danger small reject" data-id="${c.id}">Reject</button></div></article>`).join("") || `<div class="empty">No candidates waiting for review.</div>`;
  $$(".approve").forEach(b => b.onclick = () => approveCandidate(b.dataset.id));
  $$(".reject").forEach(b => b.onclick = () => rejectCandidate(b.dataset.id));
  $$(".edit-candidate").forEach(b => b.onclick = () => openRecord("candidate", b.dataset.id));
}
function dueProspects() { return state.prospects.filter(p => p.stage === "outreach" && p.nextActionDate && p.nextActionDate <= today()).sort((a,b) => a.nextActionDate.localeCompare(b.nextActionDate)); }
function renderActions() {
  const rows = dueProspects();
  $("#actionList").innerHTML = rows.map(p => `<article class="action-card"><div><h3>${escapeHtml(p.name)} · ${escapeHtml(p.organization)}</h3><div class="org">${p.outreachStep === 0 ? "Initial outreach" : `Follow-up ${p.outreachStep}`} due ${escapeHtml(p.nextActionDate)}</div></div><div class="action-actions"><button class="btn primary small draft-btn" data-id="${p.id}">Review draft</button><button class="btn secondary small replied-btn" data-id="${p.id}">They replied</button></div></article>`).join("") || `<div class="empty">No outreach is due today.</div>`;
  $$(".draft-btn").forEach(b => b.onclick = () => showDraft(b.dataset.id));
  $$(".replied-btn").forEach(b => b.onclick = () => markReplied(b.dataset.id));
}

function switchView(view) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  $$(".view").forEach(v => v.classList.remove("active"));
  $(`#${view}View`).classList.add("active");
}
function openRecord(type, id = "") {
  const source = type === "candidate" ? state.candidates : state.prospects;
  const row = source.find(r => r.id === id) || {};
  $("#recordType").value = type; $("#recordId").value = id;
  $("#dialogEyebrow").textContent = id ? "Edit record" : "New record";
  $("#dialogTitle").textContent = `${id ? "Edit" : "Add"} ${type}`;
  [["name","name"],["organization","organization"],["role","role"],["email","email"],["location","location"],["sourceUrl","sourceUrl"]].forEach(([field,key]) => $(`#${field}`).value = row[key] || "");
  $("#notesLabel").textContent = type === "candidate" ? "Why this candidate fits" : "Notes";
  $("#notes").value = type === "candidate" ? (row.rationale || "") : (row.notes || "");
  $("#recordDialog").showModal();
}
async function submitRecord(event) {
  event.preventDefault();
  const type = $("#recordType").value, id = $("#recordId").value || uid(), now = new Date().toISOString();
  const common = { id, name: $("#name").value.trim(), organization: $("#organization").value.trim(), role: $("#role").value.trim(), email: $("#email").value.trim(), location: $("#location").value.trim(), sourceUrl: $("#sourceUrl").value.trim() };
  if (!common.name || !common.organization) return;
  if (type === "candidate") {
    const existing = state.candidates.find(c => c.id === id);
    const row = { ...existing, ...common, rationale: $("#notes").value.trim(), reviewStatus: existing?.reviewStatus || "pending", createdAt: existing?.createdAt || now };
    state.candidates = existing ? state.candidates.map(c => c.id === id ? row : c) : [...state.candidates, row];
  } else {
    const existing = state.prospects.find(p => p.id === id);
    const row = { ...existing, ...common, notes: $("#notes").value.trim(), stage: existing?.stage || "prospect", outreachStep: existing?.outreachStep || 0, nextActionDate: existing?.nextActionDate || "", lastContactDate: existing?.lastContactDate || "", createdAt: existing?.createdAt || now, updatedAt: now };
    state.prospects = existing ? state.prospects.map(p => p.id === id ? row : p) : [...state.prospects, row];
  }
  await saveState(); $("#recordDialog").close(); toast("Saved.");
}
async function approveCandidate(id) {
  const c = state.candidates.find(x => x.id === id); if (!c) return;
  c.reviewStatus = "approved";
  state.prospects.push({ id: uid(), name:c.name, organization:c.organization, role:c.role, email:c.email, location:c.location, sourceUrl:c.sourceUrl, notes:c.rationale, stage:"prospect", outreachStep:0, nextActionDate:"", lastContactDate:"", createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() });
  await saveState(); toast("Approved and moved to Prospecting.");
}
async function rejectCandidate(id) { const c = state.candidates.find(x => x.id === id); if (!c) return; c.reviewStatus = "rejected"; await saveState(); toast("Candidate rejected."); }

function openDetail(id) {
  const p = state.prospects.find(x => x.id === id); if (!p) return;
  const stageOptions = [...STAGES, ["cold","Cold / archived"]].map(([k,v]) => `<option value="${k}" ${p.stage===k?"selected":""}>${v}</option>`).join("");
  $("#detailContent").innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">Prospect</p><h2>${escapeHtml(p.name)}</h2><div class="org">${escapeHtml(p.organization)}</div></div><button class="icon-btn close-detail">×</button></div><div class="detail-grid"><label class="detail-row"><span>Stage</span><select id="detailStage">${stageOptions}</select></label><label class="detail-row"><span>Next action</span><input id="detailNext" type="date" value="${escapeHtml(p.nextActionDate || "")}"></label><div class="detail-row"><span>Email</span><div class="detail-value">${escapeHtml(p.email || "—")}</div></div><div class="detail-row"><span>Location</span><div class="detail-value">${escapeHtml(p.location || "—")}</div></div><div class="detail-row full"><span>Notes</span><div class="detail-value">${escapeHtml(p.notes || "—")}</div></div></div><div class="dialog-actions"><button class="btn danger" id="deleteProspect">Delete</button><button class="btn secondary" id="editProspect">Edit</button><button class="btn primary" id="saveDetail">Save changes</button></div>`;
  $("#detailDialog").showModal(); $(".close-detail").onclick = () => $("#detailDialog").close();
  $("#editProspect").onclick = () => { $("#detailDialog").close(); openRecord("prospect", id); };
  $("#saveDetail").onclick = async () => {
    const saved = await moveProspect(id, $("#detailStage").value, {
      nextActionDate: $("#detailNext").value,
      message: "Updated."
    });
    if (saved) $("#detailDialog").close();
  };
  $("#deleteProspect").onclick = async () => { if (!confirm(`Delete ${p.name}?`)) return; state.prospects=state.prospects.filter(x=>x.id!==id); await saveState(); $("#detailDialog").close(); toast("Deleted."); };
}
function draftFor(p) {
  if (p.outreachStep === 0) return `Subject: Forensic nursing expertise\n\nHey ${firstName(p.name)} –\n\nQuick question: does your office ever use forensic nursing experts for medical-record review, case consultation, or testimony in sexual assault, strangulation, child maltreatment, or domestic violence matters?\n\nI am a board-certified forensic nurse with prosecution and defense experience. If it would be useful, I would be glad to have a brief introductory call and learn how your office handles these matters.\n\nThanks,\nSelena McCormick\nSwilcan Forensics`;
  if (p.outreachStep === 1) return `Subject: Re: Forensic nursing expertise\n\nHey ${firstName(p.name)} –\n\nJust bringing this back to the top of your inbox. Does your office ever have a need for outside forensic nursing review, consultation, or testimony?\n\nThanks,\nSelena`;
  if (p.outreachStep === 2) return `Subject: Re: Forensic nursing expertise\n\nHey ${firstName(p.name)} –\n\nOne final follow-up in case forensic nursing support is relevant to your office now or later. I would be glad to make myself available for a short introductory call.\n\nThanks,\nSelena`;
  return `Subject: Re: Forensic nursing expertise\n\nHey ${firstName(p.name)} –\n\nI will close the loop after this note. If a future matter calls for independent forensic nursing review or testimony, my information is at swilcanforensics.com.\n\nThanks,\nSelena`;
}
function showDraft(id) {
  const p = state.prospects.find(x => x.id === id); if (!p) return;
  $("#detailContent").innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">Draft only</p><h2>${p.outreachStep===0?"Initial outreach":`Follow-up ${p.outreachStep}`}</h2><div class="org">${escapeHtml(p.name)} · ${escapeHtml(p.organization)}</div></div><button class="icon-btn close-detail">×</button></div><div class="draft" id="draftText">${escapeHtml(draftFor(p))}</div><div class="dialog-actions"><button class="btn secondary" id="copyDraft">Copy draft</button><button class="btn primary" id="markSent">Mark sent manually</button></div>`;
  $("#detailDialog").showModal(); $(".close-detail").onclick=()=>$("#detailDialog").close();
  $("#copyDraft").onclick=async()=>{ await navigator.clipboard.writeText(draftFor(p)); toast("Draft copied."); };
  $("#markSent").onclick=async()=>{ p.lastContactDate=today(); if(p.outreachStep>=3){p.stage="cold";p.nextActionDate="";}else{p.outreachStep+=1;p.nextActionDate=addDays(today(),CADENCE[p.outreachStep]);}p.updatedAt=new Date().toISOString();await saveState();$("#detailDialog").close();toast(p.stage==="cold"?"Closed as cold.":`Next follow-up scheduled for ${p.nextActionDate}.`);};
}
async function markReplied(id) { const p=state.prospects.find(x=>x.id===id);if(!p)return;p.stage="conversation";p.nextActionDate="";p.updatedAt=new Date().toISOString();await saveState();toast("Moved to Conversation."); }
function exportData() { const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`swilcan-crm-backup-${today()}.json`;a.click();URL.revokeObjectURL(a.href); }
async function importData(file) { try { const incoming=JSON.parse(await file.text()); if(!Array.isArray(incoming.prospects)||!Array.isArray(incoming.candidates)) throw new Error(); if(!confirm("Replace current CRM data with this backup?"))return; state={...state,prospects:incoming.prospects,candidates:incoming.candidates};await saveState();toast("Backup imported."); } catch { toast("That file is not a valid CRM backup.",true); } }
function toast(message,error=false){const el=$("#toast");el.textContent=message;el.className=`toast show${error?" error":""}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className="toast",3200);}

$$('.tab').forEach(t=>t.onclick=()=>switchView(t.dataset.view));
$("#addProspectBtn").onclick=()=>openRecord("prospect"); $("#addCandidateBtn").onclick=()=>openRecord("candidate");
$("#recordForm").addEventListener("submit",submitRecord); $("#searchInput").addEventListener("input",renderKanban); $("#locationFilter").addEventListener("change",renderKanban);
$("#closeRecordBtn").onclick=()=>$("#recordDialog").close(); $("#cancelRecordBtn").onclick=()=>$("#recordDialog").close();
$("#exportBtn").onclick=exportData; $("#importBtn").onclick=()=>$("#importFile").click(); $("#importFile").onchange=e=>e.target.files[0]&&importData(e.target.files[0]);
$("#loginForm").addEventListener("submit", requestMagicLink);
$("#signOutBtn").onclick=async()=>{ if(localMode){localStorage.removeItem("swilcan-crm-preview");location.reload();return;}await supabaseClient.auth.signOut(); };
initializeAuth();

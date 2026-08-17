const CONFIG = window.SWILCAN_SUPABASE || {};
const ALLOWED_EMAILS = new Set([
  "selena@swilcanforensics.com",
  "bill.mccormick14@gmail.com"
]);
const STAGES = [
  ["prospect", "Prospecting"], ["conversation", "In conversation"],
  ["proposal", "Proposal"], ["won", "Won"]
];
const CADENCE = [0, 7, 30];
const PROPOSAL_TEMPLATE_VERSION = "2026-02-22-barnes";
let state = { schemaVersion: 2, revision: 0, prospects: [], candidates: [] };
let localMode = false;
let supabaseClient = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const today = () => new Date().toISOString().slice(0, 10);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const addDays = (date, days) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const firstName = (name) => String(name || "there").trim().split(/\s+/)[0];
const activity = (type, summary, details = "") => ({ id: uid(), type, summary, details, at: new Date().toISOString() });
const normalizeState = incoming => ({
  ...incoming,
  schemaVersion: 2,
  prospects: (incoming.prospects || []).map(p => ({
    ...p,
    stage: p.stage === "outreach" ? "prospect" : p.stage === "qualified" ? "conversation" : p.stage
  })),
  candidates: incoming.candidates || []
});

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
    state = normalizeState(JSON.parse(localStorage.getItem("swilcan-crm-preview") || "null") || state);
    render(); return;
  }
  const { data, error } = await supabaseClient
    .from("crm_state")
    .select("revision,payload,updated_at")
    .eq("id", 1)
    .single();
  if (error) return toast(`CRM data could not be loaded: ${error.message}`, true);
  state = normalizeState({ ...data.payload, revision: Number(data.revision), updatedAt: data.updated_at });
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
  const payload = { schemaVersion: 2, prospects: state.prospects, candidates: state.candidates };
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
  state = normalizeState({ ...data.payload, revision: Number(data.revision), updatedAt: data.updated_at });
  render();
  return true;
}

function render() { renderCounts(); renderMetrics(); renderFilters(); renderKanban(); renderCandidates(); renderActions(); }
function renderCounts() {
  $("#reviewCount").textContent = state.candidates.filter(c => c.reviewStatus === "pending").length;
  $("#actionCount").textContent = dueProspects().length;
}
function renderMetrics() {
  const values = [
    ["Prospecting", state.prospects.filter(p => p.stage === "prospect").length],
    ["In conversation", state.prospects.filter(p => p.stage === "conversation").length],
    ["Proposals", state.prospects.filter(p => p.stage === "proposal").length],
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
  const alternate = p.needsAlternateContact ? `<span class="pill late">Alternate contact needed</span>` : "";
  return `<article class="prospect-card" draggable="true" data-id="${escapeHtml(p.id)}"><div class="card-title"><h4>${escapeHtml(p.name)}</h4><button class="drag-handle" type="button" aria-label="Move ${escapeHtml(p.name)}" title="Drag to another stage">⋮⋮</button></div><div class="org">${escapeHtml(p.organization)}${p.role ? ` · ${escapeHtml(p.role)}` : ""}</div><div class="meta">${p.location ? `<span class="pill">${escapeHtml(p.location)}</span>` : ""}${due}${alternate}</div></article>`;
}

async function moveProspect(id, targetStage, options = {}) {
  const p = state.prospects.find(x => x.id === id);
  if (!p || !targetStage) return false;
  if (targetStage === "proposal" && p.stage !== "conversation" && !p.proposal) {
    toast("Move the contact to In conversation before creating a proposal.", true);
    return false;
  }
  if (targetStage === "proposal" && !p.proposal) {
    openProposalGate(id);
    return false;
  }
  const previous = { stage: p.stage, nextActionDate: p.nextActionDate, updatedAt: p.updatedAt };
  const requestedNextAction = Object.prototype.hasOwnProperty.call(options, "nextActionDate")
    ? options.nextActionDate
    : p.nextActionDate;
  if (p.stage === targetStage && requestedNextAction === p.nextActionDate) return true;
  p.stage = targetStage;
  p.nextActionDate = requestedNextAction || (targetStage === "prospect" && !p.needsAlternateContact ? today() : "");
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
  $("#reviewGrid").innerHTML = candidates.map(c => `<article class="review-card">
    <div class="review-card-head"><div><h3>${escapeHtml(c.name)}</h3><div class="org">${escapeHtml(c.organization)}${c.role ? ` · ${escapeHtml(c.role)}` : ""}</div></div>${c.confidence ? `<span class="pill">${escapeHtml(c.confidence)}</span>` : ""}</div>
    ${c.rationale ? `<p><strong>Why this fits:</strong> ${escapeHtml(c.rationale)}</p>` : ""}
    ${c.researchSummary ? `<p><strong>Research:</strong> ${escapeHtml(c.researchSummary)}</p>` : ""}
    ${c.outreachAngle ? `<p><strong>Suggested angle:</strong> ${escapeHtml(c.outreachAngle)}</p>` : ""}
    <div class="meta">${c.location ? `<span class="pill">${escapeHtml(c.location)}</span>` : ""}${c.sourceUrl ? `<a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener">Source</a>` : ""}</div>
    <div class="review-actions"><button type="button" class="btn primary small approve" data-id="${c.id}">Approve campaign</button><button type="button" class="btn secondary small edit-candidate" data-id="${c.id}">Edit</button><button type="button" class="btn danger small reject" data-id="${c.id}">Decline</button></div>
  </article>`).join("") || `<div class="empty">No prospects waiting for review.</div>`;
  $$(".approve").forEach(b => b.onclick = () => approveCandidate(b.dataset.id));
  $$(".reject").forEach(b => b.onclick = () => rejectCandidate(b.dataset.id));
  $$(".edit-candidate").forEach(b => b.onclick = () => openRecord("candidate", b.dataset.id));
}
function dueProspects() { return state.prospects.filter(p => p.stage === "prospect" && p.nextActionDate && p.nextActionDate <= today()).sort((a,b) => a.nextActionDate.localeCompare(b.nextActionDate)); }
function renderActions() {
  const rows = dueProspects();
  $("#actionList").innerHTML = rows.map(p => `<article class="action-card"><div><h3>${escapeHtml(p.name)} · ${escapeHtml(p.organization)}</h3><div class="org">${p.outreachStep === 0 ? "Initial outreach" : `Follow-up ${p.outreachStep}`} due ${escapeHtml(p.nextActionDate)}</div></div><div class="action-actions"><button class="btn primary small draft-btn" data-id="${p.id}">Review draft</button><button class="btn secondary small replied-btn" data-id="${p.id}">Affirmative reply</button></div></article>`).join("") || `<div class="empty">No outreach is due today.</div>`;
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
  $("#researchSummary").value = row.researchSummary || "";
  $("#outreachAngle").value = row.outreachAngle || "";
  $("#notesLabel").textContent = type === "candidate" ? "Why this prospect fits" : "Operator notes";
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
    const row = { ...existing, ...common, rationale: $("#notes").value.trim(), researchSummary: $("#researchSummary").value.trim(), outreachAngle: $("#outreachAngle").value.trim(), reviewStatus: existing?.reviewStatus || "pending", createdAt: existing?.createdAt || now, updatedAt: now };
    state.candidates = existing ? state.candidates.map(c => c.id === id ? row : c) : [...state.candidates, row];
  } else {
    const existing = state.prospects.find(p => p.id === id);
    const row = { ...existing, ...common, notes: $("#notes").value.trim(), researchSummary: $("#researchSummary").value.trim(), outreachAngle: $("#outreachAngle").value.trim(), stage: existing?.stage || "prospect", outreachStep: existing?.outreachStep || 0, entryPointAttempt: existing?.entryPointAttempt || 1, nextActionDate: existing?.nextActionDate || "", lastContactDate: existing?.lastContactDate || "", activity: existing?.activity || [], createdAt: existing?.createdAt || now, updatedAt: now };
    state.prospects = existing ? state.prospects.map(p => p.id === id ? row : p) : [...state.prospects, row];
  }
  await saveState(); $("#recordDialog").close(); toast("Saved.");
}
async function approveCandidate(id) {
  const c = state.candidates.find(x => x.id === id); if (!c) return;
  const now = new Date().toISOString();
  c.reviewStatus = "approved"; c.reviewedAt = now;
  state.prospects.push({
    id: uid(), candidateId: c.id, name:c.name, organization:c.organization, role:c.role,
    email:c.email, location:c.location, sourceUrl:c.sourceUrl, notes:"",
    rationale:c.rationale || "", researchSummary:c.researchSummary || "", outreachAngle:c.outreachAngle || "",
    prospectingBatchId:c.batchId || c.prospectingBatchId || "manual", stage:"prospect", outreachStep:0,
    entryPointAttempt:1, nextActionDate:today(), lastContactDate:"",
    activity:[activity("approved", "Approved for draft-only outreach", c.rationale || "")],
    createdAt:now, updatedAt:now
  });
  await saveState(); toast("Approved. Initial outreach draft is ready.");
}
function rejectCandidate(id) {
  const c = state.candidates.find(x => x.id === id); if (!c) return;
  $("#declineCandidateId").value = id; $("#declineReason").value = ""; $("#declineFeedback").value = "";
  const dialog = $("#declineDialog");
  if (!dialog.open) dialog.showModal();
}
async function submitDecline(event) {
  event.preventDefault();
  const id = $("#declineCandidateId").value;
  const reason = $("#declineReason").value;
  const feedback = $("#declineFeedback").value.trim();
  const c = state.candidates.find(x => x.id === id);
  if (!c || !reason) return;
  const submit = $("#confirmDeclineBtn");
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  try {
    const now = new Date().toISOString();
    if (localMode) {
      c.reviewStatus = "rejected"; c.declineReason = reason; c.declineFeedback = feedback;
      c.reviewedAt = now; c.archivedAt = now; c.updatedAt = now;
      if (!await saveState()) return;
    } else {
      const expectedRevision = Number(state.revision || 0);
      const { data, error } = await supabaseClient.rpc("crm_decline_candidate", {
        p_candidate_id: id,
        p_reason: reason,
        p_feedback: feedback,
        p_expected_revision: expectedRevision
      });
      if (error) {
        if (/revision conflict/i.test(error.message || "")) await loadState();
        throw new Error(error.message);
      }
      if (!data?.payload || Number(data.revision) !== expectedRevision + 1) {
        throw new Error("Decline was not confirmed by the CRM");
      }
      state = normalizeState({ ...data.payload, revision: Number(data.revision), updatedAt: data.updatedAt });
      render();
    }
    $("#declineDialog").close();
    toast("Declined and archived. Feedback saved for future prospecting.");
  } catch (error) {
    toast(`Could not decline prospect: ${error.message}`, true);
  } finally {
    submit.disabled = false;
    submit.removeAttribute("aria-busy");
  }
}

function openProposalGate(id) {
  const p = state.prospects.find(x => x.id === id); if (!p) return;
  const proposal = p.proposal || {};
  $("#proposalProspectId").value = id;
  $("#proposalDate").value = proposal.proposalDate || today();
  $("#proposalEmail").value = proposal.clientEmail || p.email || "";
  $("#proposalAttorney").value = proposal.attorneyName || p.name || "";
  $("#proposalFirm").value = proposal.firmName || p.organization || "";
  $("#proposalAddress").value = proposal.addressLine || "";
  $("#proposalCityState").value = proposal.cityStateZip || p.location || "";
  $("#proposalCase").value = proposal.caseReference || "";
  $("#proposalSalutation").value = proposal.salutation || "";
  $("#proposalCustomScope").value = proposal.customScope || "";
  const selected = new Set(proposal.scope || []);
  $$(".proposal-scope").forEach(box => { box.checked = proposal.scope ? selected.has(box.value) : true; });
  [["proposalReviewRate","reviewRate",375],["proposalTravelRate","travelRate",375],["proposalTestimonyRate","testimonyRate",525],["proposalIncrement","billingIncrement",0.25],["proposalCancelNotice","cancellationNoticeHours",48],["proposalCancelMinimum","cancellationMinimumHours",4],["proposalCardSurcharge","cardSurcharge",3]].forEach(([field,key,fallback]) => { $(`#${field}`).value = proposal[key] ?? fallback; });
  $("#proposalDialog").showModal();
}

function proposalFromForm() {
  return {
    templateVersion: PROPOSAL_TEMPLATE_VERSION,
    proposalDate: $("#proposalDate").value,
    clientEmail: $("#proposalEmail").value.trim(),
    attorneyName: $("#proposalAttorney").value.trim(),
    firmName: $("#proposalFirm").value.trim(),
    addressLine: $("#proposalAddress").value.trim(),
    cityStateZip: $("#proposalCityState").value.trim(),
    caseReference: $("#proposalCase").value.trim(),
    salutation: $("#proposalSalutation").value.trim(),
    scope: $$(".proposal-scope:checked").map(box => box.value),
    customScope: $("#proposalCustomScope").value.trim(),
    reviewRate: Number($("#proposalReviewRate").value),
    travelRate: Number($("#proposalTravelRate").value),
    testimonyRate: Number($("#proposalTestimonyRate").value),
    billingIncrement: Number($("#proposalIncrement").value),
    cancellationNoticeHours: Number($("#proposalCancelNotice").value),
    cancellationMinimumHours: Number($("#proposalCancelMinimum").value),
    cardSurcharge: Number($("#proposalCardSurcharge").value),
    status: "generated",
    generatedAt: new Date().toISOString()
  };
}

async function submitProposal(event) {
  event.preventDefault();
  const p = state.prospects.find(x => x.id === $("#proposalProspectId").value); if (!p) return;
  const previous = { proposal: p.proposal, stage: p.stage, nextActionDate: p.nextActionDate, activity: [...(p.activity || [])] };
  p.proposal = proposalFromForm();
  p.stage = "proposal"; p.nextActionDate = ""; p.activity = p.activity || [];
  p.activity.push(activity("proposal-generated", "Engagement proposal generated", p.proposal.caseReference));
  p.updatedAt = new Date().toISOString();
  try {
    if (!await saveState()) throw new Error("The CRM changed in another session");
    $("#proposalDialog").close(); if ($("#detailDialog").open) $("#detailDialog").close();
    toast("Proposal generated, attached, and moved to Proposal.");
  } catch (error) {
    Object.assign(p, previous); render(); toast(`Could not generate proposal: ${error.message}`, true);
  }
}

function proposalPdf(p) {
  if (!window.jspdf?.jsPDF) throw new Error("PDF generator is unavailable");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const q = p.proposal, margin = 58, width = 496, bottom = 730;
  let y = 54;
  const ensure = height => { if (y + height > bottom) { doc.addPage(); y = 54; } };
  const write = (text, options = {}) => {
    const size = options.size || 10.5, indent = options.indent || 0, gap = options.gap ?? 6;
    doc.setFont("helvetica", options.bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(25, 31, 38);
    const lines = doc.splitTextToSize(String(text || ""), width - indent); const height = lines.length * (size * 1.35);
    ensure(height + gap); doc.text(lines, margin + indent, y); y += height + gap;
  };
  const heading = text => { ensure(28); y += 5; doc.setDrawColor(30, 56, 72); doc.setLineWidth(0.7); doc.line(margin, y, margin + width, y); y += 15; write(text, { size: 11, bold: true, gap: 7 }); };
  const money = value => `$${Number(value || 0).toFixed(2)}`;
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(20, 45, 58); doc.text("SWILCAN FORENSICS LLC", margin, y); y += 17;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.text("Forensic Nursing Consultation & Expert Witness Services", margin, y); y += 30;
  const longDate = new Date(`${q.proposalDate}T12:00:00`).toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" });
  [longDate, q.attorneyName, q.firmName, q.addressLine, q.cityStateZip].filter(Boolean).forEach(line => write(line, { gap: 2 })); y += 8;
  write(`Re: Expert Witness Engagement — ${q.caseReference}`, { bold: true, gap: 14 });
  write(`Dear ${q.salutation}:`, { gap: 12 });
  write("Thank you for retaining Swilcan Forensics LLC to provide forensic nursing consultation and expert witness services in the above-referenced matter. This letter confirms the terms of our engagement.", { gap: 8 });
  heading("Scope of Services");
  write("Swilcan Forensics LLC, through Selena McCormick, BSN, RN, CPN, SANE-P, SANE-A, will provide the following services as requested by retaining counsel:");
  [...q.scope, ...(q.customScope ? q.customScope.split(/\n+/).filter(Boolean) : [])].forEach(item => write(`•  ${item}`, { indent: 10, gap: 3 }));
  heading("Independence & Objectivity");
  write("All opinions provided are objective and independent, based on the evidence and applicable standards of care. Opinions are not influenced by which party retains our services.");
  heading("Fee Schedule");
  write("Services will be billed at the following hourly rates:");
  write(`Record Review & Consultation: ${money(q.reviewRate)} per hour`, { indent: 10, gap: 3 });
  write(`Travel Time: ${money(q.travelRate)} per hour`, { indent: 10, gap: 3 });
  write(`Testimony (Deposition & Trial): ${money(q.testimonyRate)} per hour`, { indent: 10, gap: 3 });
  write("Travel Expenses: Reimbursed at actual cost (mileage, airfare, lodging, meals)", { indent: 10, gap: 6 });
  write(`Time is billed in ${q.billingIncrement}-hour increments. Cancellation of scheduled testimony with less than ${q.cancellationNoticeHours} hours notice will be billed at a minimum of ${q.cancellationMinimumHours} hours at the applicable testimony rate.`);
  heading("Payment Terms");
  write(`Invoices will be issued monthly and are due upon receipt. Payment for services rendered is not contingent upon the outcome of the case. Payment may be made by check, wire transfer, or ACH bank transfer at no additional charge. Payments made by credit card are subject to a ${q.cardSurcharge}% processing surcharge.`);
  heading("Limitation of Liability");
  write("The total liability of Swilcan Forensics LLC arising from or related to this engagement shall not exceed the total fees paid under this agreement.");
  heading("Agreement");
  write("Please sign below or reply to this letter confirming your agreement to the terms outlined above. If you have any questions, please do not hesitate to contact me.", { gap: 16 });
  write("Sincerely,", { gap: 24 });
  write("___________________________________________", { gap: 3 });
  write("Selena McCormick, BSN, RN, CPN, SANE-P, SANE-A", { gap: 3 });
  write("Swilcan Forensics LLC", { gap: 3 });
  write("Date: _______________", { gap: 18 });
  write("ACCEPTED AND AGREED:", { bold: true, gap: 24 });
  write("___________________________________________", { gap: 3 });
  write(q.attorneyName, { gap: 3 }); if (q.firmName) write(q.firmName, { gap: 3 });
  write("Date: _______________", { gap: 3 });
  return doc;
}

function proposalFilename(p) {
  const safe = `${p.organization || p.name} - ${p.proposal.caseReference}`.replace(/[^a-z0-9 _.-]/gi, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return `Swilcan Engagement - ${safe || p.id}.pdf`;
}
function downloadProposal(id) { const p = state.prospects.find(x => x.id === id); if (!p?.proposal) return; proposalPdf(p).save(proposalFilename(p)); }
function viewProposal(id) { const p = state.prospects.find(x => x.id === id); if (!p?.proposal) return; window.open(proposalPdf(p).output("bloburl"), "_blank", "noopener"); }

function openDetail(id) {
  const p = state.prospects.find(x => x.id === id); if (!p) return;
  const stageOptions = [...STAGES, ["cold","Cold / archived"]].map(([k,v]) => `<option value="${k}" ${p.stage===k?"selected":""}>${v}</option>`).join("");
  const timeline = (p.activity || []).slice().reverse().map(item => `<li><strong>${escapeHtml(item.summary)}</strong><span>${escapeHtml(String(item.at || "").slice(0,10))}</span>${item.details ? `<p>${escapeHtml(item.details)}</p>` : ""}</li>`).join("") || `<li>No activity recorded yet.</li>`;
  $("#detailContent").innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">Prospect record</p><h2>${escapeHtml(p.name)}</h2><div class="org">${escapeHtml(p.organization)}${p.role ? ` · ${escapeHtml(p.role)}` : ""}</div></div><button class="icon-btn close-detail">&times;</button></div>
  <div class="detail-grid">
    <label class="detail-row"><span>Stage</span><select id="detailStage">${stageOptions}</select></label>
    <label class="detail-row"><span>Next action</span><input id="detailNext" type="date" value="${escapeHtml(p.nextActionDate || "")}"></label>
    <div class="detail-row"><span>Email</span><div class="detail-value">${escapeHtml(p.email || "—")}</div></div>
    <div class="detail-row"><span>Location</span><div class="detail-value">${escapeHtml(p.location || "—")}</div></div>
    <div class="detail-row"><span>Campaign</span><div class="detail-value">Entry point ${escapeHtml(p.entryPointAttempt || 1)} · message ${escapeHtml((p.outreachStep || 0) + 1)} of 3</div></div>
    <div class="detail-row"><span>Source</span><div class="detail-value">${p.sourceUrl ? `<a href="${escapeHtml(p.sourceUrl)}" target="_blank" rel="noopener">Open research source</a>` : "—"}</div></div>
    <div class="detail-row full"><span>Why this prospect</span><div class="detail-value prewrap">${escapeHtml(p.rationale || "—")}</div></div>
    <div class="detail-row full"><span>Research context</span><div class="detail-value prewrap">${escapeHtml(p.researchSummary || "—")}</div></div>
    <div class="detail-row full"><span>Suggested outreach angle</span><div class="detail-value prewrap">${escapeHtml(p.outreachAngle || "—")}</div></div>
    <div class="detail-row full"><span>Operator notes</span><div class="detail-value prewrap">${escapeHtml(p.notes || "—")}</div></div>
    ${p.proposal ? `<div class="detail-row full"><span>Attached proposal</span><div class="detail-value"><strong>${escapeHtml(p.proposal.caseReference)}</strong><br>Generated ${escapeHtml(String(p.proposal.generatedAt || "").slice(0,10))} · Template ${escapeHtml(p.proposal.templateVersion || "")}</div></div>` : ""}
    <div class="detail-row full"><span>Activity history</span><ol class="activity-list">${timeline}</ol></div>
  </div><div class="dialog-actions"><button class="btn danger" id="deleteProspect">Delete</button><button class="btn secondary" id="editProspect">Edit</button>${p.proposal ? `<button class="btn secondary" id="editProposal">Edit proposal</button><button class="btn secondary" id="viewProposal">View PDF</button><button class="btn secondary" id="downloadProposal">Download PDF</button><button class="btn secondary" disabled title="Selena mailbox credential is not connected">Draft in Selena email</button>` : ""}<button class="btn primary" id="saveDetail">Save changes</button></div>`;
  $("#detailDialog").showModal(); $(".close-detail").onclick = () => $("#detailDialog").close();
  $("#editProspect").onclick = () => { $("#detailDialog").close(); openRecord("prospect", id); };
  if (p.proposal) {
    $("#editProposal").onclick = () => openProposalGate(id);
    $("#viewProposal").onclick = () => viewProposal(id);
    $("#downloadProposal").onclick = () => downloadProposal(id);
  }
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
  if (p.outreachStep === 0) return `Subject: Quick question\n\nHey ${firstName(p.name)} –\n\nDo you ever run into matters where an independent forensic nurse could help with expert review or testimony?\n\nThanks,\nSelena`;
  if (p.outreachStep === 1) return `Subject: Re: Quick question\n\nHey ${firstName(p.name)} –\n\nJust a quick nudge. Is that ever something your office needs, or not really?\n\nThanks,\nSelena`;
  return `Subject: Re: Quick question\n\nHey ${firstName(p.name)} –\n\nShould I close the loop, or is there someone else in your office I should speak with about forensic nursing expertise?\n\nThanks,\nSelena`;
}
function showDraft(id) {
  const p = state.prospects.find(x => x.id === id); if (!p) return;
  $("#detailContent").innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">Draft only</p><h2>${p.outreachStep===0?"Initial outreach":`Follow-up ${p.outreachStep}`}</h2><div class="org">${escapeHtml(p.name)} · ${escapeHtml(p.organization)}</div></div><button class="icon-btn close-detail">×</button></div><div class="draft" id="draftText">${escapeHtml(draftFor(p))}</div><div class="dialog-actions"><button class="btn secondary" id="copyDraft">Copy draft</button><button class="btn primary" id="markSent">Mark sent manually</button></div>`;
  $("#detailDialog").showModal(); $(".close-detail").onclick=()=>$("#detailDialog").close();
  $("#copyDraft").onclick=async()=>{ await navigator.clipboard.writeText(draftFor(p)); toast("Draft copied."); };
  $("#markSent").onclick=async()=>{
    p.lastContactDate=today(); p.activity = p.activity || [];
    p.activity.push(activity("draft-sent", `${p.outreachStep===0?"Initial outreach":`Follow-up ${p.outreachStep}`} marked sent`, draftFor(p)));
    if(p.outreachStep>=2){
      if((p.entryPointAttempt || 1) >= 3){ p.stage="cold"; p.nextActionDate=""; p.needsAlternateContact=false; p.activity.push(activity("campaign-closed","Closed after three entry points without a response")); }
      else { p.stage="prospect"; p.nextActionDate=""; p.needsAlternateContact=true; p.entryPointAttempt=(p.entryPointAttempt || 1)+1; p.outreachStep=0; p.activity.push(activity("alternate-needed","Alternate entry point requested","Research another relevant contact at the same organization.")); }
    } else { p.outreachStep+=1; p.nextActionDate=addDays(today(),CADENCE[p.outreachStep]); }
    p.updatedAt=new Date().toISOString(); await saveState(); $("#detailDialog").close();
    toast(p.stage==="cold"?"Closed as cold.":p.needsAlternateContact?"Queued for an alternate contact.":`Next follow-up scheduled for ${p.nextActionDate}.`);
  };
}
async function markReplied(id) { const p=state.prospects.find(x=>x.id===id);if(!p)return;p.stage="conversation";p.nextActionDate="";p.needsAlternateContact=false;p.activity=p.activity||[];p.activity.push(activity("reply","Affirmative reply recorded; moved to active CRM"));p.updatedAt=new Date().toISOString();await saveState();toast("Moved to In conversation with full prospecting history."); }
function toast(message,error=false){const el=$("#toast");el.textContent=message;el.className=`toast show${error?" error":""}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className="toast",3200);}

$$('.tab').forEach(t=>t.onclick=()=>switchView(t.dataset.view));
$("#addProspectBtn").onclick=()=>openRecord("prospect"); $("#addCandidateBtn").onclick=()=>openRecord("candidate");
$("#recordForm").addEventListener("submit",submitRecord); $("#searchInput").addEventListener("input",renderKanban); $("#locationFilter").addEventListener("change",renderKanban);
$("#closeRecordBtn").onclick=()=>$("#recordDialog").close(); $("#cancelRecordBtn").onclick=()=>$("#recordDialog").close();
$("#declineForm").addEventListener("submit",submitDecline); $("#closeDeclineBtn").onclick=()=>$("#declineDialog").close(); $("#cancelDeclineBtn").onclick=()=>$("#declineDialog").close();
$("#proposalForm").addEventListener("submit",submitProposal); $("#closeProposalBtn").onclick=()=>$("#proposalDialog").close(); $("#cancelProposalBtn").onclick=()=>$("#proposalDialog").close();
$("#loginForm").addEventListener("submit", requestMagicLink);
$("#signOutBtn").onclick=async()=>{ if(localMode){localStorage.removeItem("swilcan-crm-preview");location.reload();return;}await supabaseClient.auth.signOut(); };
initializeAuth();

"""Deploy Swilcan's verified-email gate and authenticated Gmail draft webhook."""
from __future__ import annotations

import copy
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from deploy_verified_email_gate import (
    BASE,
    WORKFLOW_ID,
    credential_fingerprint,
    get_workflow,
    login,
    node,
    patch,
    update_payload,
)

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT.parent / "evidence" / "swilcan_upgrade_20260821"
DRAFT_NAME = "Swilcan CRM Gmail Draft Service DRAFT-ONLY"
GMAIL_CREDENTIAL_ID = "FvcnzdQNfnNErZJ3"
GMAIL_CREDENTIAL_NAME = "Gmail account 2"
SUPABASE_URL = "https://rmmzpjkzhzqojfxdijoo.supabase.co"
SUPABASE_KEY = "sb_publishable_06_0Z1piaBdRUxD9mkEMAQ_etTLZuj-"


def draft_workflow() -> dict:
    auth_header = "={{ $('Receive Draft Request').first().json.headers.authorization }}"
    headers = {"parameters": [
        {"name": "apikey", "value": SUPABASE_KEY},
        {"name": "Authorization", "value": auth_header},
        {"name": "Content-Type", "value": "application/json"},
    ]}
    validate = r"""const request = $('Receive Draft Request').first().json || {};
const body = request.body || {};
const user = $('Verify CRM User').first().json || {};
const allowed = new Set(['selena@swilcanforensics.com', 'bill.mccormick14@gmail.com']);
if (!allowed.has(String(user.email || '').trim().toLowerCase())) throw new Error('CRM account is not authorized');
const row = $input.first().json || {};
const payload = row.payload || (Array.isArray(row) ? row[0]?.payload : null);
if (!payload) throw new Error('CRM state was not found');
const candidateId = String(body.candidateId || '').trim();
const step = Number(body.step);
if (!/^[a-zA-Z0-9-]{8,100}$/.test(candidateId) || ![0,1,2].includes(step)) throw new Error('Valid candidate and cadence step are required');
const candidate = (payload.candidates || []).find(x => x.id === candidateId);
const prospect = (payload.prospects || []).find(x => x.candidateId === candidateId);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!candidate || candidate.reviewStatus !== 'approved' || !prospect) throw new Error('Candidate is not approved in the CRM');
if (!emailPattern.test(String(prospect.email || '').trim()) || !/^https:\/\//i.test(String(candidate.emailSourceUrl || '')) || String(candidate.email || '').toLowerCase() !== String(prospect.email || '').toLowerCase() || String(candidate.emailSourceUrl || '') !== String(prospect.emailSourceUrl || '')) throw new Error('Approved recipient is missing or does not match the sourced email');
if (Number(prospect.outreachStep) !== step || prospect.stage !== 'prospect') throw new Error('Requested cadence step is not current');
const today = new Date().toISOString().slice(0,10);
if (!prospect.nextActionDate || prospect.nextActionDate > today) throw new Error('Requested cadence step is not due');
const threadId = String(body.threadId || prospect.gmailThreadId || '').trim();
if (step > 0 && !threadId) throw new Error('Follow-up draft requires the original Gmail thread ID');
const first = String(prospect.name || 'there').trim().split(/\s+/)[0];
const fallback = [
  `Hey ${first} -\n\nDo you ever run into matters where an independent forensic nurse could help with expert review or testimony?\n\nThanks,\nSelena`,
  `Hey ${first} -\n\nJust a quick nudge. Is that ever something your office needs, or not really?\n\nThanks,\nSelena`,
  `Hey ${first} -\n\nShould I close the loop, or is there someone else in your office I should speak with about forensic nursing expertise?\n\nThanks,\nSelena`
];
const supplied = [prospect.initialDraft, prospect.followupDraft1, prospect.followupDraft2];
return [{json:{candidateId, step, recipient:String(prospect.email).trim().toLowerCase(), subject:step ? 'Re: Quick question' : 'Quick question', message:String(supplied[step] || fallback[step]).trim(), threadId}}];"""
    format_response = """const draft = $input.first().json || {}; const request = $('Validate Approved Prospect').first().json; return [{json:{ok:true,mailbox:'selena@swilcanforensics.com',step:request.step,recipient:request.recipient,subject:request.subject,draftId:draft.id || '',threadId:draft.message?.threadId || request.threadId || ''}}];"""
    nodes = [
        {"id": "sw-draft-webhook", "name": "Receive Draft Request", "type": "n8n-nodes-base.webhook", "typeVersion": 2.1,
         "position": [0, 0], "webhookId": str(uuid.uuid4()), "parameters": {"httpMethod": "POST", "path": "swilcan-crm-draft", "responseMode": "lastNode", "options": {"allowedOrigins": "https://swilcanforensics.com"}}},
        {"id": "sw-draft-user", "name": "Verify CRM User", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [240, 0],
         "parameters": {"url": f"{SUPABASE_URL}/auth/v1/user", "sendHeaders": True, "headerParameters": headers, "options": {}}},
        {"id": "sw-draft-state", "name": "Get CRM State", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [480, 0],
         "parameters": {"url": f"{SUPABASE_URL}/rest/v1/crm_state?id=eq.1&select=payload", "sendHeaders": True, "headerParameters": headers, "options": {}}},
        {"id": "sw-draft-validate", "name": "Validate Approved Prospect", "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [720, 0], "parameters": {"jsCode": validate}},
        {"id": "sw-draft-gmail", "name": "Create Unsent Selena Gmail Draft", "type": "n8n-nodes-base.gmail", "typeVersion": 2.1, "position": [960, 0],
         "parameters": {"authentication": "oAuth2", "resource": "draft", "operation": "create", "subject": "={{ $json.subject }}", "emailType": "text", "message": "={{ $json.message }}", "options": {"sendTo": "={{ $json.recipient }}", "threadId": "={{ $json.threadId || '' }}"}},
         "credentials": {"gmailOAuth2": {"id": GMAIL_CREDENTIAL_ID, "name": GMAIL_CREDENTIAL_NAME}}},
        {"id": "sw-draft-response", "name": "Return Draft Confirmation", "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [1200, 0], "parameters": {"jsCode": format_response}},
    ]
    names = [n["name"] for n in nodes]
    connections = {names[i]: {"main": [[{"node": names[i + 1], "type": "main", "index": 0}]]} for i in range(len(names) - 1)}
    return {"name": DRAFT_NAME, "nodes": nodes, "connections": connections, "settings": {"executionOrder": "v1", "timezone": "America/New_York"}}


def publish_weekly(session) -> dict:
    before = get_workflow(session)
    if not before.get("active") or before.get("activeVersionId") != before.get("versionId"):
        raise RuntimeError("Swilcan weekly baseline is not the active saved version")
    before_fp = credential_fingerprint(before)
    after = patch(before)
    changed = {a["id"] for a, b in zip(before["nodes"], after["nodes"]) if a != b}
    if changed not in ({"sw-agent", "sw-validate"}, set()):
        raise RuntimeError(f"Unexpected weekly node changes: {sorted(changed)}")
    if changed:
        saved = session.patch(f"{BASE}/rest/workflows/{WORKFLOW_ID}", json=update_payload(before, after), timeout=90)
        saved.raise_for_status()
        staged = get_workflow(session)
        if staged.get("activeVersionId") != staged.get("versionId"):
            activated = session.post(f"{BASE}/rest/workflows/{WORKFLOW_ID}/activate", json={"versionId": staged.get("versionId")}, timeout=60)
            activated.raise_for_status()
    final = get_workflow(session)
    checks = {
        "active_version_current": final.get("active") and final.get("activeVersionId") == final.get("versionId"),
        "prompt_requires_sourced_email": "A verified public business email is required" in node(final, "sw-agent")["parameters"]["options"]["systemMessage"],
        "parser_requires_email_source": "missing verified public business email evidence" in node(final, "sw-validate")["parameters"]["jsCode"] and "emailSourceUrl" in node(final, "sw-validate")["parameters"]["jsCode"],
        "credentials_unchanged": credential_fingerprint(final) == before_fp,
        "connections_unchanged": final.get("connections") == before.get("connections"),
        "settings_unchanged": final.get("settings") == before.get("settings"),
    }
    if not all(checks.values()): raise RuntimeError(f"Weekly verification failed: {checks}")
    return {"oldVersionId": before.get("versionId"), "newVersionId": final.get("versionId"), "checks": checks}


def publish_draft_service(session) -> dict:
    desired = draft_workflow()
    listing = session.get(f"{BASE}/rest/workflows?limit=100", timeout=30); listing.raise_for_status()
    rows = listing.json().get("data", [])
    current = next((row for row in rows if row.get("name") == DRAFT_NAME), None)
    if current:
        before = session.get(f"{BASE}/rest/workflows/{current['id']}", timeout=30).json().get("data")
        payload = copy.deepcopy(desired); payload["versionId"] = before.get("versionId")
        response = session.patch(f"{BASE}/rest/workflows/{current['id']}", json=payload, timeout=90)
    else:
        before = None
        response = session.post(f"{BASE}/rest/workflows", json=desired, timeout=90)
    response.raise_for_status()
    saved = response.json().get("data", response.json())
    workflow_id = saved.get("id") or current["id"]
    latest = session.get(f"{BASE}/rest/workflows/{workflow_id}", timeout=30).json().get("data")
    if latest.get("activeVersionId") != latest.get("versionId"):
        activated = session.post(f"{BASE}/rest/workflows/{workflow_id}/activate", json={"versionId": latest.get("versionId")}, timeout=60)
        activated.raise_for_status()
    final = session.get(f"{BASE}/rest/workflows/{workflow_id}", timeout=30).json().get("data")
    gmail_nodes = [n for n in final.get("nodes", []) if n.get("type") == "n8n-nodes-base.gmail"]
    send_nodes = [n for n in final.get("nodes", []) if n.get("type") == "n8n-nodes-base.gmail" and n.get("parameters", {}).get("resource") == "message" and n.get("parameters", {}).get("operation") == "send"]
    checks = {"active": bool(final.get("active")), "active_version_current": final.get("activeVersionId") == final.get("versionId"), "six_nodes": len(final.get("nodes", [])) == 6,
              "one_gmail_draft_node": len(gmail_nodes) == 1 and gmail_nodes[0].get("parameters", {}).get("resource") == "draft", "zero_send_nodes": not send_nodes,
              "selena_credential": gmail_nodes[0].get("credentials", {}).get("gmailOAuth2", {}).get("id") == GMAIL_CREDENTIAL_ID if gmail_nodes else False}
    if not all(checks.values()): raise RuntimeError(f"Draft workflow verification failed: {checks}")
    return {"workflowId": workflow_id, "versionId": final.get("versionId"), "checks": checks, "before": before, "after": final}


def main() -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    session = login()
    draft = publish_draft_service(session)
    weekly = publish_weekly(session)
    if draft["before"]: (EVIDENCE / "draft_service_before.json").write_text(json.dumps(draft["before"], indent=2), encoding="utf-8")
    (EVIDENCE / "draft_service_after.json").write_text(json.dumps(draft["after"], indent=2), encoding="utf-8")
    report = {"ok": True, "timestampUtc": datetime.now(timezone.utc).isoformat(), "weekly": weekly,
              "draftService": {k: v for k, v in draft.items() if k not in ("before", "after")},
              "manualWeeklyExecution": False, "customerEmailSent": False}
    (EVIDENCE / "deployment_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__": main()

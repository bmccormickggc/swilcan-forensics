"""Require sourced public business emails in the live Swilcan prospecting workflow."""
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
WORKFLOW_ID = "OOBP1PAR9TtbOIkq"
BASE = "https://wmccormick0812.app.n8n.cloud"
EVIDENCE = WORKSPACE / "evidence" / "swilcan_verified_email_gate_20260819"


def login() -> requests.Session:
    source = (WORKSPACE / "n8n_list_workflows.py").read_text(encoding="utf-8")
    email = re.search(r"emailOrLdapLoginId': '([^']+)'", source).group(1)
    password = re.search(r"password': '([^']+)'", source).group(1)
    session = requests.Session()
    response = session.post(f"{BASE}/rest/login", json={"emailOrLdapLoginId": email, "password": password}, timeout=30)
    response.raise_for_status()
    return session


def get_workflow(session: requests.Session) -> dict:
    response = session.get(f"{BASE}/rest/workflows/{WORKFLOW_ID}", timeout=30)
    response.raise_for_status()
    payload = response.json()
    return payload.get("data", payload)


def node(workflow: dict, node_id: str) -> dict:
    matches = [item for item in workflow.get("nodes", []) if item.get("id") == node_id]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one workflow node {node_id}, found {len(matches)}")
    return matches[0]


def credential_fingerprint(workflow: dict) -> str:
    refs = [{"id": item.get("id"), "credentials": item.get("credentials")} for item in workflow.get("nodes", []) if item.get("credentials")]
    return hashlib.sha256(json.dumps(refs, sort_keys=True).encode()).hexdigest()


def patch(before: dict) -> dict:
    after = copy.deepcopy(before)
    prompt_node = node(after, "sw-agent")
    parser_node = node(after, "sw-validate")
    prompt = prompt_node["parameters"]["options"]["systemMessage"]
    old = "A public business email is optional; never guess one."
    new = ("A verified public business email is required for every prospect. The exact address and an emailSourceUrl must appear in supplied public evidence. "
           "Never infer an address pattern, guess an email, or use a generic contact form. If five prospects with sourced addresses cannot be supported, fail rather than fabricate.")
    if old not in prompt and "A verified public business email is required" not in prompt:
        raise RuntimeError("Prospecting prompt email rule drift")
    prompt = prompt.replace(old, new)
    prompt = prompt.replace("name, organization, role, location, email, phone", "name, organization, role, location, email, emailSourceUrl, phone")
    prompt_node["parameters"]["options"]["systemMessage"] = prompt

    parser = parser_node["parameters"]["jsCode"]
    if "missing verified public business email" not in parser:
        anchor = "  const sourceUrl = String(p.sourceUrl || '').trim();"
        insertion = anchor + "\n  const email = String(p.email || '').trim().toLowerCase();\n  const emailSourceUrl = String(p.emailSourceUrl || '').trim();"
        if parser.count(anchor) != 1:
            raise RuntimeError("Prospect parser source anchor drift")
        parser = parser.replace(anchor, insertion)
        identity_throw = "  if (!name || !organization || !/^https:\\/\\//i.test(sourceUrl)) throw new Error(`Prospect ${i + 1} is missing verified identity or source URL`);"
        identity_reject = "  if (!name || !organization || !/^https:\\/\\//i.test(sourceUrl)) rejection = 'missing verified identity or HTTPS source URL';"
        email_gate_throw = "  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || !/^https:\\/\\//i.test(emailSourceUrl)) throw new Error(`Prospect ${i + 1} is missing verified public business email evidence`);"
        email_gate_reject = "  else if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || !/^https:\\/\\//i.test(emailSourceUrl)) rejection = 'missing verified public business email evidence';"
        if parser.count(identity_throw) == 1:
            parser = parser.replace(identity_throw, identity_throw + "\n" + email_gate_throw)
        elif parser.count(identity_reject) == 1:
            parser = parser.replace(identity_reject, identity_reject + "\n" + email_gate_reject)
        else:
            raise RuntimeError("Prospect parser identity gate drift")
        output = "    email: String(p.email || '').trim(), phone:"
        if parser.count(output) != 1:
            raise RuntimeError("Prospect parser output drift")
        parser = parser.replace(output, "    email, emailSourceUrl, phone:")
    parser_node["parameters"]["jsCode"] = parser
    return after


def update_payload(before: dict, patched: dict) -> dict:
    payload = {"name": patched["name"], "nodes": patched["nodes"], "connections": patched["connections"],
               "settings": patched.get("settings", {}), "versionId": before["versionId"]}
    for key in ("staticData", "meta", "tagIds"):
        if key in patched:
            payload[key] = patched[key]
    return payload


def main() -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    session = login()
    before = get_workflow(session)
    if not before.get("active") or before.get("activeVersionId") != before.get("versionId"):
        raise RuntimeError("Live workflow baseline is not the active saved version")
    before_fp = credential_fingerprint(before)
    patched = patch(before)
    changed = {a["id"] for a, b in zip(before["nodes"], patched["nodes"]) if a != b}
    if changed != {"sw-agent", "sw-validate"}:
        raise RuntimeError(f"Unexpected node changes: {sorted(changed)}")
    EVIDENCE.joinpath("before_workflow.json").write_text(json.dumps(before, indent=2), encoding="utf-8")
    saved = session.patch(f"{BASE}/rest/workflows/{WORKFLOW_ID}", json=update_payload(before, patched), timeout=90)
    saved.raise_for_status()
    staged = get_workflow(session)
    if staged.get("activeVersionId") != staged.get("versionId"):
        activated = session.post(f"{BASE}/rest/workflows/{WORKFLOW_ID}/activate", json={"versionId": staged.get("versionId")}, timeout=60)
        activated.raise_for_status()
    final = get_workflow(session)
    final_prompt = node(final, "sw-agent")["parameters"]["options"]["systemMessage"]
    final_parser = node(final, "sw-validate")["parameters"]["jsCode"]
    checks = {
        "active_version_current": final.get("active") and final.get("activeVersionId") == final.get("versionId"),
        "new_version": final.get("versionId") != before.get("versionId"),
        "prompt_requires_sourced_email": "A verified public business email is required" in final_prompt and "emailSourceUrl" in final_prompt,
        "parser_rejects_missing_email": "missing verified public business email evidence" in final_parser,
        "credentials_unchanged": credential_fingerprint(final) == before_fp,
        "connections_unchanged": final.get("connections") == before.get("connections"),
        "settings_unchanged": final.get("settings") == before.get("settings"),
    }
    if not all(checks.values()):
        raise RuntimeError(f"Live verification failed: {[key for key, value in checks.items() if not value]}")
    EVIDENCE.joinpath("after_workflow.json").write_text(json.dumps(final, indent=2), encoding="utf-8")
    report = {"ok": True, "timestampUtc": datetime.now(timezone.utc).isoformat(), "workflowId": WORKFLOW_ID,
              "oldVersionId": before.get("versionId"), "newVersionId": final.get("versionId"), "checks": checks,
              "manualExecutionRun": False, "customerEmailSent": False}
    EVIDENCE.joinpath("deployment_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()

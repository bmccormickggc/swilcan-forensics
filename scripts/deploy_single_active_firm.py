"""Publish the one-active-attorney-per-firm prospecting guard."""

from __future__ import annotations

import copy
import json
from datetime import datetime, timezone

from deploy_verified_email_gate import (
    BASE,
    EVIDENCE as _OLD_EVIDENCE,
    WORKFLOW_ID,
    credential_fingerprint,
    get_workflow,
    login,
    node,
    update_payload,
)


EVIDENCE = _OLD_EVIDENCE.parent / "swilcan_single_active_firm_20260821"
PROMPT_RULE = (
    "Firm concurrency rule: never return an attorney whose firm already has a pending candidate or an active CRM "
    "prospect. A new attorney at the same firm is eligible only after the previous attorney completed the full "
    "three-message non-response cadence and the CRM marks that record as needing an alternate contact or cold. "
    "Never place two attorneys from the same firm in one batch."
)


def execution_ids(session) -> list[str]:
    response = session.get(
        f"{BASE}/rest/executions",
        params={"filter": json.dumps({"workflowId": WORKFLOW_ID}), "limit": 5, "includeData": "false"},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json().get("data") or {}
    return [str(row.get("id")) for row in payload.get("results") or []]


def patch_workflow(before: dict) -> dict:
    after = copy.deepcopy(before)
    prompt_node = node(after, "sw-agent")
    parser_node = node(after, "sw-validate")
    prompt = prompt_node["parameters"]["options"]["systemMessage"]
    if PROMPT_RULE not in prompt:
        prompt = prompt.rstrip() + "\n\n" + PROMPT_RULE
    prompt_node["parameters"]["options"]["systemMessage"] = prompt

    parser = parser_node["parameters"]["jsCode"]
    marker = "firm already has an active or pending attorney"
    if marker not in parser:
        rows_anchor = "const rows = Array.isArray(parsed.prospects) ? parsed.prospects.slice(0, 5) : [];"
        context_code = r"""
const crmContext = $('Get Prospecting Context').first().json || {};
const normalizeFirm = value => String(value || '').trim().toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(and|l\s*l\s*p|l\s*l\s*c|p\s*l\s*l\s*c|p\s*c|p\s*a|law firm|law offices|the)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const blockedFirmKeys = new Set();
for (const candidate of crmContext.pendingCandidates || []) {
  if (candidate.reviewStatus === 'pending') blockedFirmKeys.add(normalizeFirm(candidate.organization));
}
for (const prospect of crmContext.existingProspects || []) {
  if (prospect.stage !== 'cold' && !prospect.needsAlternateContact) blockedFirmKeys.add(normalizeFirm(prospect.organization));
}
blockedFirmKeys.delete('');
const batchFirmKeys = new Set();"""
        if parser.count(rows_anchor) != 1:
            raise RuntimeError("Parser rows anchor drift")
        parser = parser.replace(rows_anchor, rows_anchor + context_code)

        org_anchor = "  const organization = String(p.organization || '').trim();"
        if parser.count(org_anchor) != 1:
            raise RuntimeError("Parser organization anchor drift")
        parser = parser.replace(org_anchor, org_anchor + "\n  const organizationKey = normalizeFirm(organization);")

        identity_gate = r"  if (!name || !organization || !/^https:\/\//i.test(sourceUrl)) rejection = 'missing verified identity or HTTPS source URL';"
        if parser.count(identity_gate) != 1:
            raise RuntimeError("Parser identity gate drift")
        concurrency_gates = (
            identity_gate
            + "\n  else if (blockedFirmKeys.has(organizationKey)) rejection = 'firm already has an active or pending attorney';"
            + "\n  else if (batchFirmKeys.has(organizationKey)) rejection = 'duplicates another firm in this batch';"
        )
        parser = parser.replace(identity_gate, concurrency_gates)

        seen_anchor = "  seen.add(key);"
        if parser.count(seen_anchor) != 1:
            raise RuntimeError("Parser accepted-row anchor drift")
        parser = parser.replace(seen_anchor, "  batchFirmKeys.add(organizationKey);\n" + seen_anchor)
    parser = parser.replace(
        "/\\b(and|llp|llc|pllc|pc|pa|law firm|law offices|the)\\b/g",
        "/\\b(and|l\\s*l\\s*p|l\\s*l\\s*c|p\\s*l\\s*l\\s*c|p\\s*c|p\\s*a|law firm|law offices|the)\\b/g",
    )
    parser_node["parameters"]["jsCode"] = parser
    return after


def main() -> None:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    session = login()
    before = get_workflow(session)
    if not before.get("active") or before.get("activeVersionId") != before.get("versionId"):
        raise RuntimeError("Live workflow baseline is not the active saved version")
    before_ids = execution_ids(session)
    before_fingerprint = credential_fingerprint(before)
    after = patch_workflow(before)
    changed = {a["id"] for a, b in zip(before["nodes"], after["nodes"]) if a != b}
    if not changed.issubset({"sw-agent", "sw-validate"}):
        raise RuntimeError(f"Unexpected node changes: {sorted(changed)}")
    (EVIDENCE / "workflow_before.json").write_text(json.dumps(before, indent=2), encoding="utf-8")
    if changed:
        response = session.patch(f"{BASE}/rest/workflows/{WORKFLOW_ID}", json=update_payload(before, after), timeout=90)
        response.raise_for_status()
        staged = get_workflow(session)
        if staged.get("activeVersionId") != staged.get("versionId"):
            activation = session.post(
                f"{BASE}/rest/workflows/{WORKFLOW_ID}/activate",
                json={"versionId": staged.get("versionId")},
                timeout=60,
            )
            activation.raise_for_status()
    final = get_workflow(session)
    after_ids = execution_ids(session)
    prompt = node(final, "sw-agent")["parameters"]["options"]["systemMessage"]
    parser = node(final, "sw-validate")["parameters"]["jsCode"]
    checks = {
        "active_version_current": final.get("active") and final.get("activeVersionId") == final.get("versionId"),
        "prompt_rule_live": PROMPT_RULE in prompt,
        "parser_checks_active_firms": "firm already has an active or pending attorney" in parser,
        "parser_checks_batch_firms": "duplicates another firm in this batch" in parser,
        "parser_normalizes_firm_suffixes": "p\\s*l\\s*l\\s*c" in parser and "l\\s*l\\s*p" in parser,
        "credentials_unchanged": credential_fingerprint(final) == before_fingerprint,
        "connections_unchanged": final.get("connections") == before.get("connections"),
        "settings_unchanged": final.get("settings") == before.get("settings"),
        "no_manual_execution": before_ids == after_ids,
    }
    if not all(checks.values()):
        raise RuntimeError(f"Workflow verification failed: {[key for key, value in checks.items() if not value]}")
    (EVIDENCE / "workflow_after.json").write_text(json.dumps(final, indent=2), encoding="utf-8")
    report = {
        "ok": True,
        "timestampUtc": datetime.now(timezone.utc).isoformat(),
        "workflowId": WORKFLOW_ID,
        "oldVersionId": before.get("versionId"),
        "newVersionId": final.get("versionId"),
        "checks": checks,
        "customerEmailSent": False,
    }
    (EVIDENCE / "deployment_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()

"""Authenticated, audited Swilcan CRM state inspection and bounded maintenance."""

from __future__ import annotations

import argparse
import base64
import html
import json
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
EVIDENCE = WORKSPACE / "evidence" / "swilcan_crm_20260821"
EXPECTED_EMAIL = "bill.mccormick14@gmail.com"
ALLOWED_DECLINE_REASONS = {
    "off-focus", "wrong-role", "wrong-organization", "wrong-geography",
    "duplicate", "weak-evidence", "conflict", "other",
}


def public_config() -> tuple[str, str]:
    text = (ROOT / "crm" / "config.js").read_text(encoding="utf-8")
    url = re.search(r'url:\s*"([^"]+)"', text)
    key = re.search(r'anonKey:\s*"([^"]+)"', text)
    if not url or not key:
        raise RuntimeError("Swilcan Supabase public configuration is incomplete")
    return url.group(1), key.group(1)


def gmail_access_token() -> str:
    credential = json.loads((WORKSPACE / "token_gmail_personal_rw.json").read_text(encoding="utf-8"))
    response = requests.post(
        credential["token_uri"],
        data={
            "client_id": credential["client_id"],
            "client_secret": credential["client_secret"],
            "refresh_token": credential["refresh_token"],
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def decode_part(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", errors="replace")


def message_text(payload: dict) -> str:
    chunks: list[str] = []
    if payload.get("body", {}).get("data"):
        chunks.append(decode_part(payload["body"]["data"]))
    for part in payload.get("parts") or []:
        chunks.append(message_text(part))
    return "\n".join(chunks)


def authenticated_session(supabase_url: str, anon_key: str) -> tuple[str, dict]:
    gmail_token = gmail_access_token()
    gmail_headers = {"Authorization": f"Bearer {gmail_token}"}
    profile = requests.get("https://gmail.googleapis.com/gmail/v1/users/me/profile", headers=gmail_headers, timeout=30)
    profile.raise_for_status()
    if profile.json().get("emailAddress", "").lower() != EXPECTED_EMAIL:
        raise RuntimeError("Personal Gmail credential verification failed")

    requested_after = int(time.time()) - 5
    otp = requests.post(
        f"{supabase_url}/auth/v1/otp",
        headers={"apikey": anon_key, "Authorization": f"Bearer {anon_key}", "Content-Type": "application/json"},
        json={
            "email": EXPECTED_EMAIL,
            "create_user": False,
            "options": {"email_redirect_to": "https://swilcanforensics.com/crm/"},
        },
        timeout=30,
    )
    otp.raise_for_status()

    verification_url = ""
    query = f'after:{requested_after} ("magic link" OR "sign in" OR "log in")'
    for _ in range(10):
        listing = requests.get(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages",
            headers=gmail_headers,
            params={"q": query, "maxResults": 10},
            timeout=30,
        )
        listing.raise_for_status()
        for row in listing.json().get("messages") or []:
            message = requests.get(
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{row['id']}",
                headers=gmail_headers,
                params={"format": "full"},
                timeout=30,
            )
            message.raise_for_status()
            text = html.unescape(message_text(message.json().get("payload") or {}))
            links = re.findall(r'https://[^\s"<>]+/auth/v1/verify\?[^\s"<>]+', text)
            if links:
                verification_url = links[0].replace("&amp;", "&")
                break
        if verification_url:
            break
        time.sleep(3)
    if not verification_url:
        raise RuntimeError("Supabase sign-in email was not found")

    response = requests.get(verification_url, allow_redirects=False, timeout=30)
    if response.status_code not in {301, 302, 303, 307, 308}:
        raise RuntimeError(f"Supabase verification returned {response.status_code}")
    fragment = parse_qs(urlparse(response.headers.get("Location", "")).fragment)
    access_token = (fragment.get("access_token") or [""])[0]
    if not access_token:
        raise RuntimeError("Supabase verification returned no access token")
    user_response = requests.get(
        f"{supabase_url}/auth/v1/user",
        headers={"apikey": anon_key, "Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    user_response.raise_for_status()
    user = user_response.json()
    if user.get("email", "").lower() != EXPECTED_EMAIL:
        raise RuntimeError("Supabase session mailbox verification failed")
    return access_token, user


def headers(anon_key: str, access_token: str) -> dict[str, str]:
    return {"apikey": anon_key, "Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}


def load_state(supabase_url: str, request_headers: dict[str, str]) -> dict:
    response = requests.get(
        f"{supabase_url}/rest/v1/crm_state",
        headers=request_headers,
        params={"id": "eq.1", "select": "revision,payload,updated_at,updated_by"},
        timeout=30,
    )
    response.raise_for_status()
    rows = response.json()
    if len(rows) != 1:
        raise RuntimeError(f"Expected one CRM state row; found {len(rows)}")
    return rows[0]


def safe_rows(payload: dict) -> dict:
    fields = ("id", "candidateId", "name", "organization", "role", "location", "email", "reviewStatus", "stage", "outreachStep", "nextActionDate")
    return {
        "prospects": [{key: row.get(key) for key in fields if key in row} for row in payload.get("prospects") or []],
        "candidates": [{key: row.get(key) for key in fields if key in row} for row in payload.get("candidates") or []],
    }


def snapshot() -> None:
    supabase_url, anon_key = public_config()
    access_token, _ = authenticated_session(supabase_url, anon_key)
    state = load_state(supabase_url, headers(anon_key, access_token))
    result = {"revision": int(state["revision"]), "updatedAt": state["updated_at"], **safe_rows(state["payload"])}
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / "state_snapshot.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


def decline(candidate_name: str, reason: str, feedback: str) -> None:
    if reason not in ALLOWED_DECLINE_REASONS:
        raise RuntimeError("Invalid decline reason")
    supabase_url, anon_key = public_config()
    access_token, _ = authenticated_session(supabase_url, anon_key)
    request_headers = headers(anon_key, access_token)
    before = load_state(supabase_url, request_headers)
    matches = [
        row for row in before["payload"].get("candidates") or []
        if row.get("reviewStatus") == "pending" and candidate_name.lower() in str(row.get("name") or "").lower()
    ]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one pending candidate matching {candidate_name!r}; found {len(matches)}")
    candidate = matches[0]
    response = requests.post(
        f"{supabase_url}/rest/v1/rpc/crm_decline_candidate",
        headers=request_headers,
        json={
            "p_candidate_id": candidate["id"],
            "p_reason": reason,
            "p_feedback": feedback,
            "p_expected_revision": int(before["revision"]),
        },
        timeout=30,
    )
    if not response.ok:
        raise RuntimeError(f"Decline RPC failed ({response.status_code}): {response.text[:500]}")
    after = load_state(supabase_url, request_headers)
    updated = [row for row in after["payload"].get("candidates") or [] if row.get("id") == candidate["id"]]
    if len(updated) != 1 or updated[0].get("reviewStatus") != "rejected" or int(after["revision"]) != int(before["revision"]) + 1:
        raise RuntimeError("Decline after-state verification failed")
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    evidence = {
        "ok": True,
        "candidate": {"id": candidate["id"], "name": candidate.get("name"), "organization": candidate.get("organization")},
        "reason": reason,
        "feedback": feedback,
        "revisionBefore": int(before["revision"]),
        "revisionAfter": int(after["revision"]),
        "reviewStatusAfter": updated[0].get("reviewStatus"),
        "customerEmailSent": False,
    }
    (EVIDENCE / "rebecca_decline.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))


def firm_key(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", str(value or "").lower().replace("&", " and "))
    normalized = re.sub(r"\b(and|l\s*l\s*p|l\s*l\s*c|p\s*l\s*l\s*c|p\s*c|p\s*a|law firm|law offices|the)\b", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def active_firm_keys(payload: dict) -> set[str]:
    keys = {
        firm_key(row.get("organization", ""))
        for row in payload.get("prospects") or []
        if row.get("stage") != "cold" and not row.get("needsAlternateContact")
    }
    keys.update(
        firm_key(row.get("organization", ""))
        for row in payload.get("candidates") or []
        if row.get("reviewStatus") == "pending"
    )
    keys.discard("")
    return keys


def apply_bundle(candidate_file: Path) -> None:
    supplied = json.loads(candidate_file.read_text(encoding="utf-8"))
    if not isinstance(supplied, list) or len(supplied) not in {2, 3}:
        raise RuntimeError("Candidate file must contain two or three records")
    required = {"name", "organization", "role", "location", "email", "emailSourceUrl", "sourceUrl", "rationale", "researchSummary", "outreachAngle", "initialDraft", "followupDraft1", "followupDraft2"}
    for row in supplied:
        missing = sorted(key for key in required if not str(row.get(key) or "").strip())
        if missing:
            raise RuntimeError(f"Candidate {row.get('name')!r} is missing: {', '.join(missing)}")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", row["email"].strip()) or not row["emailSourceUrl"].startswith("https://") or not row["sourceUrl"].startswith("https://"):
            raise RuntimeError(f"Candidate {row['name']!r} has invalid public evidence")

    supabase_url, anon_key = public_config()
    access_token, user = authenticated_session(supabase_url, anon_key)
    request_headers = headers(anon_key, access_token)
    before = load_state(supabase_url, request_headers)
    original_revision = int(before["revision"])
    rebecca = [
        row for row in before["payload"].get("candidates") or []
        if row.get("reviewStatus") == "pending" and "rebecca" in str(row.get("name") or "").lower()
    ]
    decline_rpc = "already_rejected"
    if len(rebecca) == 1:
        response = requests.post(
            f"{supabase_url}/rest/v1/rpc/crm_decline_candidate",
            headers=request_headers,
            json={
                "p_candidate_id": rebecca[0]["id"],
                "p_reason": "duplicate",
                "p_feedback": "Already contacted a different attorney at the same firm. Do not add another attorney from a firm while an earlier attorney remains in an active prospecting workflow; allow a new attorney only after the previous attorney completes the full non-response cadence.",
                "p_expected_revision": original_revision,
            },
            timeout=30,
        )
        decline_rpc = "success" if response.ok else f"fallback_{response.status_code}"
        if not response.ok:
            timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            target = rebecca[0]
            target.update({
                "reviewStatus": "rejected",
                "declineReason": "duplicate",
                "declineFeedback": "Already contacted a different attorney at the same firm. Do not add another attorney from a firm while an earlier attorney remains in an active prospecting workflow; allow a new attorney only after the previous attorney completes the full non-response cadence.",
                "reviewedAt": timestamp,
                "archivedAt": timestamp,
                "updatedAt": timestamp,
            })
            fallback = requests.patch(
                f"{supabase_url}/rest/v1/crm_state",
                headers={**request_headers, "Prefer": "return=representation"},
                params={"id": "eq.1", "revision": f"eq.{original_revision}", "select": "revision"},
                json={"payload": before["payload"], "revision": original_revision + 1, "updated_at": timestamp, "updated_by": user["id"]},
                timeout=30,
            )
            fallback.raise_for_status()
            if len(fallback.json()) != 1:
                raise RuntimeError("Rebecca decline fallback was not confirmed")
    elif len(rebecca) > 1:
        raise RuntimeError(f"Expected at most one pending Rebecca; found {len(rebecca)}")

    current = load_state(supabase_url, request_headers)
    blocked = active_firm_keys(current["payload"])
    incoming_keys = [firm_key(row["organization"]) for row in supplied]
    collisions = sorted(set(incoming_keys) & blocked)
    if collisions or len(set(incoming_keys)) != len(incoming_keys):
        raise RuntimeError(f"Candidate firm collision: {collisions or incoming_keys}")
    existing_emails = {
        str(row.get("email") or "").strip().lower()
        for group in (current["payload"].get("prospects") or [], current["payload"].get("candidates") or [])
        for row in group
    }
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    batch_id = f"manual-signature-test-{datetime.now(timezone.utc).strftime('%Y%m%d')}"
    added = []
    for source in supplied:
        if source["email"].strip().lower() in existing_emails:
            raise RuntimeError(f"Candidate email already exists: {source['email']}")
        row = {
            **source,
            "id": str(uuid.uuid4()),
            "reviewStatus": "pending",
            "source": "manual-evidence-review",
            "batchId": batch_id,
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }
        current["payload"].setdefault("candidates", []).append(row)
        added.append({"id": row["id"], "name": row["name"], "organization": row["organization"], "email": row["email"]})
    revision = int(current["revision"])
    patch_response = requests.patch(
        f"{supabase_url}/rest/v1/crm_state",
        headers={**request_headers, "Prefer": "return=representation"},
        params={"id": "eq.1", "revision": f"eq.{revision}", "select": "revision,payload,updated_at"},
        json={"payload": current["payload"], "revision": revision + 1, "updated_at": timestamp, "updated_by": user["id"]},
        timeout=30,
    )
    patch_response.raise_for_status()
    if len(patch_response.json()) != 1:
        raise RuntimeError("Candidate insertion lost an optimistic revision race")

    after = load_state(supabase_url, request_headers)
    pending_names = {row.get("name") for row in after["payload"].get("candidates") or [] if row.get("reviewStatus") == "pending"}
    rebecca_after = [row for row in after["payload"].get("candidates") or [] if "rebecca" in str(row.get("name") or "").lower()]
    if not set(row["name"] for row in supplied).issubset(pending_names) or any(row.get("reviewStatus") == "pending" for row in rebecca_after):
        raise RuntimeError("CRM bundle after-state verification failed")
    active_keys_after = [
        firm_key(row.get("organization", ""))
        for row in after["payload"].get("prospects") or []
        if row.get("stage") != "cold" and not row.get("needsAlternateContact")
    ] + [
        firm_key(row.get("organization", ""))
        for row in after["payload"].get("candidates") or []
        if row.get("reviewStatus") == "pending"
    ]
    if len(active_keys_after) != len(set(active_keys_after)):
        raise RuntimeError("Same-firm active-workflow invariant failed after update")

    EVIDENCE.mkdir(parents=True, exist_ok=True)
    evidence = {
        "ok": True,
        "declineRpc": decline_rpc,
        "rebeccaStatusAfter": rebecca_after[0].get("reviewStatus") if rebecca_after else "not_found",
        "revisionBefore": original_revision,
        "revisionAfter": int(after["revision"]),
        "added": added,
        "sameFirmInvariant": True,
        "customerEmailSent": False,
        "mailboxDraftCreated": False,
    }
    (EVIDENCE / "bundle_apply.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("snapshot")
    decline_parser = subparsers.add_parser("decline")
    decline_parser.add_argument("name")
    decline_parser.add_argument("reason")
    decline_parser.add_argument("feedback")
    bundle_parser = subparsers.add_parser("apply-bundle")
    bundle_parser.add_argument("candidate_file", type=Path)
    args = parser.parse_args()
    if args.command == "snapshot":
        snapshot()
    elif args.command == "decline":
        decline(args.name, args.reason, args.feedback)
    elif args.command == "apply-bundle":
        apply_bundle(args.candidate_file)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)

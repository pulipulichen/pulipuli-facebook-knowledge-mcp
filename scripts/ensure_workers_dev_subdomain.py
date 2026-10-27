#!/usr/bin/env python3
"""Preflight workers.dev registration for non-interactive GitHub Actions deployments.

Only create an account-wide workers.dev subdomain when WORKERS_DEV_SUBDOMAIN is
explicitly configured. Never rename a previously registered account subdomain.
"""

import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SUBDOMAIN_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
ACCOUNT_RE = re.compile(r"[a-fA-F0-9]{32}\Z")


class SubdomainSetupError(Exception):
    """User-actionable Cloudflare onboarding error."""


def api_request(method, url, token, payload=None):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    request = Request(url, method=method, headers=headers, data=body)
    try:
        with urlopen(request, timeout=20) as response:
            status, data = response.status, response.read()
    except HTTPError as exc:
        status, data = exc.code, exc.read()
    except URLError as exc:
        raise SubdomainSetupError(f"Unable to reach Cloudflare API: {exc.reason}") from exc
    try:
        return status, json.loads(data)
    except (ValueError, TypeError) as exc:
        raise SubdomainSetupError(f"Cloudflare API returned non-JSON response (HTTP {status}).") from exc


def api_failure(response):
    # Avoid printing authorization headers or arbitrary API response bodies.
    errors = response.get("errors") or []
    return "; ".join(
        f"{item.get('code', 'unknown')}: {item.get('message', 'unknown error')}"
        for item in errors if isinstance(item, dict)
    ) or "Cloudflare returned an unsuccessful response"


def ensure_subdomain(account_id, token, requested="", request_fn=api_request):
    if not ACCOUNT_RE.fullmatch(account_id):
        raise SubdomainSetupError("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal Account ID.")
    if not token:
        raise SubdomainSetupError("Missing CLOUDFLARE_API_TOKEN.")
    if requested and not SUBDOMAIN_RE.fullmatch(requested):
        raise SubdomainSetupError(
            "WORKERS_DEV_SUBDOMAIN must be 1-63 lowercase letters, numbers or internal hyphens."
        )

    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/subdomain"
    status, response = request_fn("GET", url, token)
    existing = ""
    if status == 200 and response.get("success"):
        existing = (response.get("result") or {}).get("subdomain") or ""
    elif status != 404:
        raise SubdomainSetupError(
            f"Cannot check account workers.dev subdomain (HTTP {status}): {api_failure(response)}. "
            "Check Cloudflare token Workers Scripts Read/Write permissions."
        )

    if existing:
        if requested and requested != existing:
            raise SubdomainSetupError(
                f"This Cloudflare account already uses '{existing}.workers.dev'. "
                "Remove WORKERS_DEV_SUBDOMAIN or set it to the existing value. "
                "The workflow will not rename the account-wide subdomain."
            )
        print(f"Account workers.dev subdomain exists: {existing}.workers.dev")
        return existing

    if not requested:
        raise SubdomainSetupError(
            "No workers.dev subdomain registered for this Cloudflare account. "
            "Add GitHub Actions repository Variable WORKERS_DEV_SUBDOMAIN "
            "(suggested: pulipuli-facebook) and rerun Deploy Cloudflare Worker; "
            "the workflow will register it once via Cloudflare API. "
            "Alternatively register manually in Cloudflare Workers & Pages."
        )

    # Account-wide setting; creation requires explicit opt-in via repository Variable.
    status, response = request_fn("PUT", url, token, {"subdomain": requested})
    created = (response.get("result") or {}).get("subdomain") if status == 200 and response.get("success") else None
    if not created:
        raise SubdomainSetupError(
            f"Cannot create '{requested}.workers.dev' (HTTP {status}): {api_failure(response)}. "
            "Check name availability and Workers Scripts Write token permission."
        )
    if created != requested:
        raise SubdomainSetupError(f"Cloudflare created unexpected workers.dev subdomain '{created}'.")
    print(f"Registered account workers.dev subdomain: {created}.workers.dev")
    return created


def main():
    try:
        subdomain = ensure_subdomain(
            os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip(),
            os.environ.get("CLOUDFLARE_API_TOKEN", "").strip(),
            os.environ.get("WORKERS_DEV_SUBDOMAIN", "").strip(),
        )
    except SubdomainSetupError as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output:
            output.write(f"subdomain={subdomain}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

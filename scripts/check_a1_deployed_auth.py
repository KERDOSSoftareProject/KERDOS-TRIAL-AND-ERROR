#!/usr/bin/env python3
"""Negative HTTP checks by default; --authenticated requires credentials.

Authenticated mode calls recovery-sweep, which may process pending test work.
Secrets are read from environment only and are never printed.
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

BASE = "https://gwtnaudjfoxjermhvhpx.supabase.co"


def request(name, body, authorization):
    headers = {"Content-Type": "application/json"}
    if authorization:
        headers["Authorization"] = authorization
    req = urllib.request.Request(BASE + "/functions/v1/" + name,
                                 data=json.dumps(body).encode(),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--authenticated", action="store_true")
    args = parser.parse_args()
    if os.environ.get("KERDOS_TEST_URL", BASE).rstrip("/") != BASE:
        parser.error("Only the exact kerdos-test URL is allowed")
    credentials = {}
    if args.authenticated:
        for suffix in ("SERVICE_KEY", "WEBHOOK_USER", "WEBHOOK_PASS", "SWEEP_SECRET"):
            key = "KERDOS_TEST_" + suffix
            if not os.environ.get(key):
                parser.error("Missing environment variable: " + key)
            credentials[suffix] = os.environ[key]
    passed = failed = 0

    def check(label, name, body, expected, authorization=None, validator=None):
        nonlocal passed, failed
        try:
            status, payload = request(name, body, authorization)
            valid = status == expected
            if valid and validator:
                valid = validator(json.loads(payload))
            if valid:
                passed += 1
                print(f"PASS {label}: HTTP {status}")
            else:
                failed += 1
                print(f"FAIL {label}: HTTP {status}; expected {expected} and valid response")
        except (OSError, ValueError, KeyError, TypeError):
            failed += 1
            print(f"FAIL {label}: request or response validation error")

    for name, bad in (("process-attachment", "Bearer invalid-test-token"),
                      ("inbound-email", "Basic aW52YWxpZDppbnZhbGlk"),
                      ("recovery-sweep", "Bearer invalid-test-secret")):
        check(name + " missing auth", name, {}, 401)
        check(name + " invalid auth", name, {}, 401, bad)
    if args.authenticated:
        check("service reaches processor validation", "process-attachment", {}, 400,
              "Bearer " + credentials["SERVICE_KEY"],
              lambda body: body.get("reason") == "attachmentId and organizationId are required")
        basic = base64.b64encode((credentials["WEBHOOK_USER"] + ":" +
                                  credentials["WEBHOOK_PASS"]).encode()).decode()
        check("webhook reaches unknown routing lookup", "inbound-email", {
            "MessageID": "auth-probe-" + str(uuid.uuid4()),
            "OriginalRecipient": "auth-probe-" + str(uuid.uuid4()) + "@inbound.kerdos.com",
            "FromFull": {"Email": "auth-probe@example.invalid"}, "Attachments": []
        }, 200, "Basic " + basic)
        check("sweep returns structured result", "recovery-sweep", {}, 200,
              "Bearer " + credentials["SWEEP_SECRET"],
              lambda body: all(isinstance(body.get(key), list) for key in
                               ("recovered", "replayed", "needsReview", "deferred")))
    else:
        print("NOT RUN: authenticated HTTP checks (use --authenticated after secrets setup)")
    print(f"HTTP checks: {passed} passed, {failed} failed")
    print("NOT COVERED: import/retry, sweep dispatch/scheduling, DB races, browser preview/Save")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

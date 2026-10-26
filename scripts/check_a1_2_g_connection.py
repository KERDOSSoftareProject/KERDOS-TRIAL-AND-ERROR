#!/usr/bin/env python3
"""Read-only check that GitHub Actions can open two kerdos-test DB sessions."""

import os
import sys
from contextlib import closing

import psycopg2
from psycopg2.extensions import parse_dsn


PROJECT_REF = "gwtnaudjfoxjermhvhpx"


def safe_error_reason(exc):
    """Classify connection failures without echoing a DSN or credential."""
    message = str(exc).lower()
    if "password authentication failed" in message or getattr(exc, "pgcode", None) == "28P01":
        return "database rejected the password for this project"
    if "tenant or user not found" in message:
        return "pooler rejected the project username"
    if "could not translate host name" in message or "name or service not known" in message:
        return "pooler hostname could not be resolved"
    if "timeout expired" in message or "timed out" in message:
        return "connection timed out"
    if "connection refused" in message:
        return "pooler refused the network connection"
    if "no pg_hba.conf entry" in message or "not allowed" in message:
        return "database access rule rejected the connection"
    return "database connection failed for an unclassified reason"


def main():
    url = os.environ.get("KERDOS_TEST_DATABASE_URL")
    if not url:
        raise RuntimeError("KERDOS_TEST_DATABASE_URL is not configured")

    try:
        parts = parse_dsn(url)
    except Exception:
        raise RuntimeError("Database URL is invalid (value withheld)") from None

    host = parts.get("host", "").lower()
    user = parts.get("user", "").lower()
    port = str(parts.get("port", "5432"))
    if not (
        host.endswith(".pooler.supabase.com")
        and user == f"postgres.{PROJECT_REF}"
        and port == "5432"
    ):
        raise RuntimeError(
            "Use the kerdos-test Session pooler URL: postgres.<project-ref> "
            "on a Supabase pooler host, port 5432"
        )

    # This probe is read-only. Neither connection runs the A1.2.g race test.
    with closing(psycopg2.connect(url, connect_timeout=10, sslmode="require")) as first:
        with closing(psycopg2.connect(url, connect_timeout=10, sslmode="require")) as second:
            first.autocommit = True
            second.autocommit = True
            pids = []
            for conn in (first, second):
                with conn.cursor() as cursor:
                    cursor.execute("SELECT pg_backend_pid(), current_database()")
                    pid, database = cursor.fetchone()
                    if database != "postgres":
                        raise RuntimeError("Connected to an unexpected database")
                    pids.append(pid)

            if pids[0] == pids[1]:
                raise RuntimeError("Two connections did not get separate database sessions")

            # A session-pooler connection must retain its backend while open.
            for conn, original_pid in zip((first, second), pids):
                with conn.cursor() as cursor:
                    cursor.execute("SELECT pg_backend_pid()")
                    if cursor.fetchone()[0] != original_pid:
                        raise RuntimeError("Backend changed within an open session")

    print("CONNECTION PASSED: kerdos-test accepted two distinct stable sessions.")
    print("No database rows were created or changed. B1/B2 were not run.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # psycopg2 errors can contain the username/host. Never echo a DSN.
        reason = safe_error_reason(exc) if isinstance(exc, psycopg2.OperationalError) else type(exc).__name__
        print(f"CONNECTION FAILED: {reason}.", file=sys.stderr)
        sys.exit(1)

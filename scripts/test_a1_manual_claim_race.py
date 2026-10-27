#!/usr/bin/env python3
"""Two-connection test of migration 037 on kerdos-test. No production target.

Run after migration 037 is applied. Requires KERDOS_TEST_DATABASE_URL and
psycopg2-binary==2.9.9. Every fixture is identified by returned UUID and
deleted after both connections have stopped. The URL is never printed.
"""
import os
import threading
import time
import uuid

import psycopg2
from psycopg2.extensions import parse_dsn

PROJECT = "gwtnaudjfoxjermhvhpx"


def connection(url, *, autocommit=False):
    conn = psycopg2.connect(url, connect_timeout=10, sslmode="require")
    conn.autocommit = autocommit
    return conn


def one(conn, query, params=()):
    with conn.cursor() as cursor:
        cursor.execute(query, params)
        return cursor.fetchone()[0]


def fixture(url):
    conn = connection(url)
    try:
        org, user = None, None
        with conn.cursor() as cursor:
            cursor.execute("SELECT organization_id, user_id FROM public.organization_members WHERE user_id IS NOT NULL LIMIT 1")
            seed = cursor.fetchone()
            if seed is None:
                raise RuntimeError("No test organization member available")
            org, user = seed
            marker = str(uuid.uuid4())
            cursor.execute("""INSERT INTO public.email_routing_addresses
                (organization_id, routing_address, label, is_active)
                VALUES (%s,%s,%s,false) RETURNING id""",
                (org, f"a1-race-{marker}@inbound.kerdos.com", "A1 manual claim race fixture"))
            route = cursor.fetchone()[0]
            cursor.execute("""INSERT INTO public.inbound_messages
                (organization_id, routing_address_id, postmark_message_id, sender_email)
                VALUES (%s,%s,%s,%s) RETURNING id""",
                (org, route, f"a1-race-{marker}", "test@test.invalid"))
            message = cursor.fetchone()[0]
            ids = []
            for index in (0, 1):
                cursor.execute("""INSERT INTO public.inbound_attachments
                    (organization_id, message_id, attachment_index, filename, storage_path)
                    VALUES (%s,%s,%s,%s,%s) RETURNING id""",
                    (org, message, index, f"__a1_manual_race_{index}__", f"a1-race/{marker}/{index}"))
                ids.append(cursor.fetchone()[0])
        conn.commit()
        return {"org": org, "user": user, "route": route, "message": message, "ids": ids}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def cleanup(url, ids):
    conn = connection(url)
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM public.inbound_attachments WHERE id = ANY(%s::uuid[])", (ids["ids"],))
            cursor.execute("DELETE FROM public.inbound_messages WHERE id = %s", (ids["message"],))
            cursor.execute("DELETE FROM public.email_routing_addresses WHERE id = %s", (ids["route"],))
        conn.commit()
        with conn.cursor() as cursor:
            checks = (
                ("inbound_attachments", "id = ANY(%s::uuid[])", (ids["ids"],)),
                ("inbound_messages", "id = %s", (ids["message"],)),
                ("email_routing_addresses", "id = %s", (ids["route"],)),
            )
            for table, predicate, params in checks:
                cursor.execute(f"SELECT count(*) FROM public.{table} WHERE {predicate}", params)
                if cursor.fetchone()[0]:
                    raise AssertionError(f"{table} fixture remained after cleanup")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def overlap(url, ids, *, manual_first, attachment_id):
    first = second = monitor = None
    thread = None
    result = {}
    try:
        first = connection(url)
        second = connection(url)
        monitor = connection(url, autocommit=True)
        pid1 = one(first, "SELECT pg_backend_pid()")
        pid2 = one(second, "SELECT pg_backend_pid()")
        if pid1 == pid2:
            raise AssertionError("Connections did not get distinct PostgreSQL sessions")
        if manual_first:
            one(first, "SELECT set_config('request.jwt.claim.sub', %s, true)", (str(ids["user"]),))
            if one(first, "SELECT public.begin_manual_attachment_review(%s,%s)", (ids["org"], attachment_id)) is not True:
                raise AssertionError("Manual-first claim failed")
        else:
            if one(first, "SELECT public.claim_attachment(%s)", (attachment_id,)) is None:
                raise AssertionError("Worker-first claim failed")

        def contender():
            try:
                one(second, "SELECT set_config('request.jwt.claim.sub', %s, true)", (str(ids["user"]),))
                with second.cursor() as cursor:
                    cursor.execute("SET LOCAL statement_timeout = '15s'")
                if manual_first:
                    result["value"] = one(second, "SELECT public.claim_attachment(%s)", (attachment_id,))
                else:
                    result["value"] = one(second, "SELECT public.begin_manual_attachment_review(%s,%s)",
                        (ids["org"], attachment_id))
                second.commit()
            except Exception as error:
                result["error"] = error
                second.rollback()

        thread = threading.Thread(target=contender, daemon=True)
        thread.start()
        deadline = time.monotonic() + 8
        blocked = False
        while time.monotonic() < deadline:
            blocked = one(monitor, "SELECT %s = ANY(pg_blocking_pids(%s))", (pid1, pid2))
            if blocked:
                break
            if not thread.is_alive():
                break
            time.sleep(0.05)
        if not blocked:
            raise AssertionError("Actual row-lock overlap was not observed")
        first.commit()
        thread.join(timeout=10)
        if thread.is_alive():
            raise TimeoutError("Contender remained blocked after first transaction committed")
        if "error" in result:
            raise result["error"]
        expected = None if manual_first else False
        if result.get("value") != expected:
            raise AssertionError(f"Second claimant returned {result.get('value')!r}; expected {expected!r}")
        status = one(monitor, "SELECT processing_status FROM public.inbound_attachments WHERE id=%s", (attachment_id,))
        if status != ("needs_review" if manual_first else "processing"):
            raise AssertionError(f"Unexpected final status: {status}")
        print(f"{'manual-first' if manual_first else 'worker-first'}: PASS (distinct PIDs, lock wait, result, status)")
    finally:
        if thread is not None and thread.is_alive():
            second.cancel()
            first.rollback()
            thread.join(timeout=5)
        if thread is not None and thread.is_alive():
            # Never delete fixtures while an active worker may hold their lock.
            raise RuntimeError("Contender still active; fixture cleanup skipped")
        for conn in (first, second, monitor):
            if conn is not None:
                conn.close()


def main():
    url = os.environ.get("KERDOS_TEST_DATABASE_URL", "")
    if not url:
        raise RuntimeError("KERDOS_TEST_DATABASE_URL is missing")
    try:
        dsn = parse_dsn(url)
    except Exception:
        raise RuntimeError("Invalid test database URL") from None
    if PROJECT not in dsn.get("host", "") and PROJECT not in dsn.get("user", ""):
        raise RuntimeError("Database URL does not identify kerdos-test")
    ids = fixture(url)
    safe_to_clean = True
    try:
        overlap(url, ids, manual_first=True, attachment_id=ids["ids"][0])
        overlap(url, ids, manual_first=False, attachment_id=ids["ids"][1])
    except RuntimeError as error:
        if "fixture cleanup skipped" in str(error):
            safe_to_clean = False
        raise
    finally:
        if safe_to_clean:
            cleanup(url, ids)
            print("Fixture cleanup: PASS")


if __name__ == "__main__":
    main()

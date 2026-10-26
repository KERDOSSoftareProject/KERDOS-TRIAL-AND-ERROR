#!/usr/bin/env python3
"""
A1.2.g Race Test – B1 and B2
Target: kerdos-test (project gwtnaudjfoxjermhvhpx)

B1 – kerdos_auto_apply_price_quote() runs inside an open transaction that
     holds the attachment row lock. recover_stale_attachment() on a second
     connection tries the same row and blocks. pg_blocking_pids() MUST
     confirm the block or B1 fails. After price-save commits, recovery
     unblocks, sees the committed state, and completes.
     Final assertions:
       price_history has exactly 1 row via the returned vendor_item_id
       processing_status = 'pending'
       processing_lease_token IS NULL

B2 – recover_stale_attachment() holds the lock first. price-save blocks,
     then unblocks and finds the attachment no longer writable; it returns
     NULL and writes nothing. pg_blocking_pids() MUST confirm the block.
     Final assertions:
       kerdos_auto_apply_price_quote returned NULL
       no vendor_items row with the test item_code exists
       processing_status = 'pending'
       processing_lease_token IS NULL

Overlap proof: the monitor connects and confirms it is polling BEFORE the
race threads start. Connection 1 calls its function inside an open
transaction, fires lock_acquired, then sleeps LOCK_HOLD_SECONDS before
committing. Connection 2 starts immediately after lock_acquired and blocks
on the same row. The monitor queries pg_stat_activity and pg_blocking_pids()
every MONITOR_INTERVAL seconds; both must confirm the block. Sequential
execution cannot produce a passing result.

Schema (confirmed on kerdos-test):
  vendor_items.vendor_item_code  -- column confirmed
  vendors                        -- table confirmed
  email_routing_addresses        -- zero rows on kerdos-test; not used as
                                    fixture source; org+vendor borrowed from
                                    vendor_items JOIN vendors instead
"""

import os
import sys
import threading
import time
import uuid

# psycopg2 is required for B1/B2 but not for --test-timeout.
# Import lazily so the self-contained timeout test can run without it.
try:
    import psycopg2
    import psycopg2.extensions
    from psycopg2.extras import RealDictCursor
    _PSYCOPG2_AVAILABLE = True
except ImportError:
    _PSYCOPG2_AVAILABLE = False

# ── constants ─────────────────────────────────────────────────────────────────

REQUIRED_PROJECT  = "gwtnaudjfoxjermhvhpx"
ROUTING_DOMAIN    = "inbound.kerdos.com"
LOCK_HOLD_SECONDS = 2.0    # conn1 sleeps this long before committing;
                            # long enough for the monitor to sample reliably
MONITOR_INTERVAL  = 0.05   # pg_blocking_pids poll frequency (seconds)


# ── connection helpers ────────────────────────────────────────────────────────

def get_url() -> str:
    if not _PSYCOPG2_AVAILABLE:
        sys.exit("ERROR: psycopg2 is not installed. Run: pip install psycopg2-binary==2.9.9")
    url = os.environ.get("KERDOS_TEST_DATABASE_URL", "")
    if not url:
        sys.exit("ERROR: KERDOS_TEST_DATABASE_URL is not set.")

    try:
        params = psycopg2.extensions.parse_dsn(url)
    except Exception as exc:
        sys.exit(f"ERROR: Could not parse KERDOS_TEST_DATABASE_URL: {exc}")

    host = params.get("host", "")
    user = params.get("user", "")
    if REQUIRED_PROJECT not in host and REQUIRED_PROJECT not in user:
        sys.exit(
            f"ERROR: Connection host/user do not identify project "
            f"{REQUIRED_PROJECT}. Refusing to connect."
        )

    return url


def connect(url: str):
    conn = psycopg2.connect(
        url, cursor_factory=RealDictCursor,
        connect_timeout=10, sslmode="require",
    )
    conn.autocommit = False
    return conn


def connect_ac(url: str):
    """Autocommit connection for monitoring and read-only checks."""
    conn = psycopg2.connect(
        url, cursor_factory=RealDictCursor,
        connect_timeout=10, sslmode="require",
    )
    conn.autocommit = True
    return conn


def run_sql(conn, sql: str, params=None) -> list:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        try:
            return cur.fetchall()
        except psycopg2.ProgrammingError:
            return []


def close_quietly(conn):
    try:
        conn.rollback()
    except Exception:
        pass
    try:
        conn.close()
    except Exception:
        pass


def cancel_and_close(conn):
    """
    Send pg_cancel_backend to the server (non-blocking), then close.

    cancel() must come before rollback()/close() when a thread may still be
    blocked inside cur.execute(). Without it, rollback() itself blocks on the
    socket waiting for the current query to finish. cancel() causes the server
    to raise QueryCanceled, which unblocks the thread's execute() call so the
    thread can catch the error and exit cleanly. close() then cleans up the
    local socket regardless of whether the thread already closed the connection.
    """
    try:
        conn.cancel()
    except Exception:
        pass
    close_quietly(conn)


def backend_pid(conn) -> int:
    rows = run_sql(conn, "SELECT pg_backend_pid() AS pid")
    conn.commit()
    return rows[0]["pid"]


# ── fixtures ──────────────────────────────────────────────────────────────────

def create_fixtures(url: str, run_id: str, label: str) -> dict:
    """
    Borrows organization_id and vendor_id together from one existing
    vendor_items row (joined to vendors to confirm the vendor exists).
    kerdos-test has zero email_routing_addresses, so that table is not
    used as a fixture source. Both IDs come from the same row to ensure
    they belong to the same organization.
    """
    conn = connect(url)
    try:
        seed_rows = run_sql(conn, """
            SELECT vi.organization_id, vi.vendor_id
            FROM vendor_items vi
            JOIN vendors v ON v.id = vi.vendor_id
            LIMIT 1
        """)
        if not seed_rows:
            raise RuntimeError(
                "vendor_items (joined to vendors) returned no rows; "
                "cannot borrow organization_id and vendor_id."
            )
        org_id    = str(seed_rows[0]["organization_id"])
        vendor_id = str(seed_rows[0]["vendor_id"])

        routing_id    = str(uuid.uuid4())
        message_id    = str(uuid.uuid4())
        attachment_id = str(uuid.uuid4())
        lease_token   = str(uuid.uuid4())
        item_code     = f"a12g-{run_id}-{label}"

        run_sql(conn, """
            INSERT INTO email_routing_addresses
                (id, organization_id, routing_address, label, is_active)
            VALUES (%s::uuid, %s::uuid, %s, %s, false)
        """, (
            routing_id, org_id,
            f"race-{run_id}-{label}@{ROUTING_DOMAIN}",
            f"A1.2.g race test {run_id} {label}",
        ))

        run_sql(conn, """
            INSERT INTO inbound_messages
                (id, organization_id, routing_address_id,
                 postmark_message_id, sender_email)
            VALUES (%s::uuid, %s::uuid, %s::uuid, %s, %s)
        """, (
            message_id, org_id, routing_id,
            f"race-{run_id}-{label}",
            f"race-test-{run_id}@test.invalid",
        ))

        # processing_started_at and processing_heartbeat_at set 2 hours ago
        # so recover_stale_attachment(id, now()) treats this row as stale.
        run_sql(conn, """
            INSERT INTO inbound_attachments (
                id, organization_id, message_id, attachment_index,
                filename, storage_path,
                processing_status,
                processing_started_at, processing_heartbeat_at,
                processing_lease_token
            )
            VALUES (
                %s::uuid, %s::uuid, %s::uuid, 0,
                %s, %s,
                'processing',
                now() - interval '2 hours',
                now() - interval '2 hours',
                %s::uuid
            )
        """, (
            attachment_id, org_id, message_id,
            f"race-{run_id}-{label}.pdf",
            f"test/race-{run_id}-{label}.pdf",
            lease_token,
        ))

        conn.commit()
    except Exception:
        close_quietly(conn)
        raise
    else:
        conn.close()

    return {
        "org_id":        org_id,
        "vendor_id":     vendor_id,
        "routing_id":    routing_id,
        "message_id":    message_id,
        "attachment_id": attachment_id,
        "lease_token":   lease_token,
        "item_code":     item_code,
    }


# ── function call builders ────────────────────────────────────────────────────

def price_quote_sql(ids: dict) -> tuple:
    """
    Named-argument call matching scenario_b1_session1_quote_runs.sql.
    p_price=1 and p_price_unavailable=false so a price_history row is
    created (required for the B1 assertion). The function creates the
    vendor_items row and returns its id as vendor_item_id.
    """
    sql = """
        SELECT public.kerdos_auto_apply_price_quote(
            p_vendor_item_id     := NULL,
            p_organization_id    := %s::uuid,
            p_vendor_id          := %s::uuid,
            p_vendor_item_code   := %s,
            p_description        := 'A1.2.g race test — safe to delete',
            p_pack_size          := '1 CS',
            p_price              := 1,
            p_price_unavailable  := false,
            p_effective_date     := now(),
            p_quote_valid_until  := current_date + 30,
            p_source_file_path   := 'a12g-test',
            p_source_file_name   := 'a12g-test.csv',
            p_source_line        := '1',
            p_source_document_id := NULL,
            p_lease_token        := %s::uuid,
            p_attachment_id      := %s::uuid
        ) AS vendor_item_id
    """
    params = (
        ids["org_id"],
        ids["vendor_id"],
        ids["item_code"],
        ids["lease_token"],
        ids["attachment_id"],
    )
    return sql, params


def recovery_sql(ids: dict) -> tuple:
    sql    = "SELECT recover_stale_attachment(%s::uuid, now()) AS result"
    params = (ids["attachment_id"],)
    return sql, params


# ── cleanup ───────────────────────────────────────────────────────────────────

def delete_fixtures(url: str, ids: dict, vendor_item_id=None):
    """
    Deletes all records created by this run using exact IDs.
    Cleans price_history and vendor_items by both vendor_item_id (if
    captured from B1) and vendor_item_code (covers B2 where no id was
    returned). Raises on any error so failures are visible.
    """
    conn = connect(url)
    try:
        if vendor_item_id:
            run_sql(conn, """
                DELETE FROM price_history WHERE vendor_item_id = %s::uuid
            """, (vendor_item_id,))
            run_sql(conn, """
                DELETE FROM vendor_items WHERE id = %s::uuid
            """, (vendor_item_id,))

        # Belt-and-suspenders sweep by item_code; no-ops if already deleted.
        run_sql(conn, """
            DELETE FROM price_history
            WHERE vendor_item_id IN (
                SELECT id FROM vendor_items WHERE vendor_item_code = %s
            )
        """, (ids["item_code"],))
        run_sql(conn, """
            DELETE FROM vendor_items WHERE vendor_item_code = %s
        """, (ids["item_code"],))

        run_sql(conn, """
            DELETE FROM inbound_attachments WHERE id = %s::uuid
        """, (ids["attachment_id"],))
        run_sql(conn, """
            DELETE FROM inbound_messages WHERE id = %s::uuid
        """, (ids["message_id"],))
        run_sql(conn, """
            DELETE FROM email_routing_addresses WHERE id = %s::uuid
        """, (ids["routing_id"],))

        conn.commit()
    except Exception:
        close_quietly(conn)
        raise
    else:
        conn.close()


def verify_cleanup(url: str, ids: dict):
    """Raises AssertionError if any test record remains after cleanup."""
    conn = connect_ac(url)
    leftovers = []

    for table, where, val in [
        ("vendor_items",            "vendor_item_code = %s",  ids["item_code"]),
        ("inbound_attachments",     "id = %s::uuid",          ids["attachment_id"]),
        ("inbound_messages",        "id = %s::uuid",          ids["message_id"]),
        ("email_routing_addresses", "id = %s::uuid",          ids["routing_id"]),
    ]:
        rows = run_sql(conn, f"SELECT id FROM {table} WHERE {where}", (val,))
        if rows:
            leftovers.append(f"  {table}: {len(rows)} row(s) remain")

    conn.close()

    if leftovers:
        raise AssertionError(
            "Cleanup incomplete – rows remain:\n" + "\n".join(leftovers)
        )
    print("  Cleanup verified: zero test rows remain.")


# ── monitor ───────────────────────────────────────────────────────────────────

class LockWaitMonitor(threading.Thread):
    """
    Polls pg_stat_activity and pg_blocking_pids() until it confirms that
    holder_pid is blocking racer_pid.

    ready_event fires after the monitor's first successful database poll,
    which lets run_race delay starting the race until the monitor is
    actually connected and sampling.

    Uses self._halt (not self._stop) to avoid conflicting with
    threading.Thread internals.
    """

    def __init__(self, url: str, racer_pid: int, holder_pid: int):
        super().__init__(daemon=True, name="lock-monitor")
        self.url            = url
        self.racer_pid      = racer_pid
        self.holder_pid     = holder_pid
        self.wait_observed  = False
        self.ready_event    = threading.Event()   # fires after first poll
        self.observed_event = threading.Event()
        self._halt          = threading.Event()

    def run(self):
        try:
            conn = connect_ac(self.url)
            with conn.cursor() as cur:
                first_poll = True
                while not self._halt.is_set():
                    # Step 1: is the racer waiting on any lock?
                    cur.execute("""
                        SELECT 1 FROM pg_stat_activity
                        WHERE pid = %s AND wait_event_type = 'Lock'
                    """, (self.racer_pid,))
                    lock_row = cur.fetchone()

                    if first_poll:
                        self.ready_event.set()   # monitor is connected & polling
                        first_poll = False

                    if lock_row:
                        # Step 2: confirm holder is specifically the blocker
                        cur.execute("""
                            SELECT %s = ANY(pg_blocking_pids(%s)) AS confirmed
                        """, (self.holder_pid, self.racer_pid))
                        row = cur.fetchone()
                        if row and row["confirmed"]:
                            self.wait_observed = True
                            self.observed_event.set()
                            print(
                                f"    [monitor] PID {self.holder_pid} blocking "
                                f"PID {self.racer_pid} — confirmed by "
                                f"pg_blocking_pids()"
                            )
                    time.sleep(MONITOR_INTERVAL)
            conn.close()
        except Exception as exc:
            self.ready_event.set()   # unblock run_race even on monitor error
            print(f"    [monitor] error: {exc}")

    def halt(self):
        self._halt.set()


# ── race runner ───────────────────────────────────────────────────────────────

def run_race(
    url: str,
    fn1_sql: str, fn1_params: tuple,
    fn2_sql: str, fn2_params: tuple,
    label: str,
) -> dict:
    """
    Sequence:
      1. Start monitor; wait for ready_event (confirms it is polling).
      2. Start fn1 and fn2 threads.
      3. fn1: calls SQL inside an open transaction (row locks held), fires
         lock_acquired, sleeps LOCK_HOLD_SECONDS, commits.
      4. fn2: waits for lock_acquired, calls SQL — immediately blocks.
      5. Monitor must confirm via pg_blocking_pids() before fn1 commits.
      6. Join both threads; close connections only after both have stopped.
         On timeout, connections are closed first so live transactions do
         not block fixture cleanup.
      7. Raise if overlap was not observed.
    """
    conn1 = connect(url)
    conn2 = connect(url)

    fn1_result: dict = {"rows": [], "error": None}
    fn2_result: dict = {"rows": [], "error": None}
    lock_acquired     = threading.Event()

    conn1_pid = backend_pid(conn1)
    conn2_pid = backend_pid(conn2)

    monitor = LockWaitMonitor(url, racer_pid=conn2_pid, holder_pid=conn1_pid)

    def run_fn1():
        try:
            rows = run_sql(conn1, fn1_sql, fn1_params)
            fn1_result["rows"] = rows
            lock_acquired.set()               # row locks held; fn2 may start
            time.sleep(LOCK_HOLD_SECONDS)     # hold long enough for monitor
            conn1.commit()
        except Exception as exc:
            fn1_result["error"] = exc
            close_quietly(conn1)
            lock_acquired.set()               # unblock fn2 even on failure

    def run_fn2():
        if not lock_acquired.wait(timeout=10):
            fn2_result["error"] = TimeoutError(
                "lock_acquired was never set; fn1 may have crashed before "
                "acquiring the lock."
            )
            return
        try:
            rows = run_sql(conn2, fn2_sql, fn2_params)
            conn2.commit()
            fn2_result["rows"] = rows
        except Exception as exc:
            fn2_result["error"] = exc
            close_quietly(conn2)

    # Start monitor and wait until it has completed its first poll.
    # If it fails to connect, close both worker connections before raising —
    # they are open at this point and must not be leaked.
    monitor.start()
    if not monitor.ready_event.wait(timeout=10):
        monitor.halt()
        close_quietly(conn1)
        close_quietly(conn2)
        raise AssertionError(f"{label}: monitor did not connect within 10 s.")

    t1 = threading.Thread(target=run_fn1, daemon=True, name=f"{label}-fn1")
    t2 = threading.Thread(target=run_fn2, daemon=True, name=f"{label}-fn2")
    t1.start()
    t2.start()

    t1.join(timeout=15)
    t2.join(timeout=15)

    monitor.halt()
    monitor.join(timeout=2)

    if t1.is_alive() or t2.is_alive():
        # One or both threads are still blocked inside a database call.
        # cancel() sends pg_cancel_backend (non-blocking). The server raises
        # QueryCanceled on the blocked backend, which unblocks cur.execute()
        # so the thread's except-handler can run and exit. We must NOT call
        # rollback() or close() before cancel() — those would block on the
        # socket waiting for the in-progress query to complete.
        cancel_and_close(conn1)
        cancel_and_close(conn2)
        # Give threads time to handle the QueryCanceled and exit.
        t1.join(timeout=5)
        t2.join(timeout=5)
        raise AssertionError(
            f"{label}: worker thread(s) did not finish within the join timeout; "
            f"connections were cancelled. "
            f"fn1.alive={t1.is_alive()}, fn2.alive={t2.is_alive()}"
        )

    # Both threads finished normally; safe to close their connections.
    close_quietly(conn1)
    close_quietly(conn2)

    if fn1_result["error"]:
        raise AssertionError(f"{label}: fn1 raised: {fn1_result['error']}")
    if fn2_result["error"]:
        raise AssertionError(f"{label}: fn2 raised: {fn2_result['error']}")

    if not monitor.wait_observed:
        raise AssertionError(
            f"{label} FAIL: pg_blocking_pids() never confirmed conn1 blocking "
            f"conn2. The calls did not truly overlap — this does not prove the "
            "lease stops competing writes."
        )

    return {
        "fn1_rows": fn1_result["rows"],
        "fn2_rows": fn2_result["rows"],
    }


# ── B1 ────────────────────────────────────────────────────────────────────────

def run_b1(url: str, run_id: str) -> bool:
    print("\n── B1: price-save-first ─────────────────────────────────────────")
    ids            = None
    vendor_item_id = None
    try:
        ids = create_fixtures(url, run_id, "b1")
        print(f"  attachment_id : {ids['attachment_id']}")
        print(f"  item_code     : {ids['item_code']}")

        fn1_sql, fn1_params = price_quote_sql(ids)
        fn2_sql, fn2_params = recovery_sql(ids)

        result = run_race(url, fn1_sql, fn1_params, fn2_sql, fn2_params, "B1")

        fn1_rows = result["fn1_rows"]
        assert fn1_rows and fn1_rows[0]["vendor_item_id"] is not None, (
            "B1 FAIL: kerdos_auto_apply_price_quote returned NULL — "
            "no vendor_item was created."
        )
        vendor_item_id = str(fn1_rows[0]["vendor_item_id"])
        print(f"  vendor_item_id: {vendor_item_id}")

        conn_check = connect_ac(url)

        price_rows = run_sql(conn_check, """
            SELECT id FROM price_history WHERE vendor_item_id = %s::uuid
        """, (vendor_item_id,))

        att = run_sql(conn_check, """
            SELECT processing_status, processing_lease_token
            FROM inbound_attachments WHERE id = %s::uuid
        """, (ids["attachment_id"],))[0]

        conn_check.close()

        assert len(price_rows) == 1, (
            f"B1 FAIL: expected 1 price_history row, found {len(price_rows)}"
        )
        assert att["processing_status"] == "pending", (
            f"B1 FAIL: processing_status={att['processing_status']!r}, "
            "expected 'pending'"
        )
        assert att["processing_lease_token"] is None, (
            f"B1 FAIL: processing_lease_token={att['processing_lease_token']!r}, "
            "expected NULL"
        )

        print("  B1 PASSED.")
        return True

    finally:
        if ids:
            delete_fixtures(url, ids, vendor_item_id)
            verify_cleanup(url, ids)


# ── B2 ────────────────────────────────────────────────────────────────────────

def run_b2(url: str, run_id: str) -> bool:
    print("\n── B2: recovery-first ───────────────────────────────────────────")
    ids = None
    try:
        ids = create_fixtures(url, run_id, "b2")
        print(f"  attachment_id: {ids['attachment_id']}")
        print(f"  item_code    : {ids['item_code']}")

        fn1_sql, fn1_params = recovery_sql(ids)
        fn2_sql, fn2_params = price_quote_sql(ids)

        result = run_race(url, fn1_sql, fn1_params, fn2_sql, fn2_params, "B2")

        fn2_rows = result["fn2_rows"]
        fn2_item_id = (
            fn2_rows[0].get("vendor_item_id")
            if fn2_rows else None
        )

        conn_check = connect_ac(url)

        item_rows = run_sql(conn_check, """
            SELECT id FROM vendor_items WHERE vendor_item_code = %s
        """, (ids["item_code"],))

        att = run_sql(conn_check, """
            SELECT processing_status, processing_lease_token
            FROM inbound_attachments WHERE id = %s::uuid
        """, (ids["attachment_id"],))[0]

        conn_check.close()

        assert fn2_item_id is None, (
            f"B2 FAIL: kerdos_auto_apply_price_quote returned vendor_item_id "
            f"{fn2_item_id} — price was written despite recovery holding the lock."
        )
        assert len(item_rows) == 0, (
            f"B2 FAIL: {len(item_rows)} vendor_items row(s) found with "
            f"item_code={ids['item_code']!r} — price function wrote despite "
            "recovery holding the lock."
        )
        assert att["processing_status"] == "pending", (
            f"B2 FAIL: processing_status={att['processing_status']!r}, "
            "expected 'pending'"
        )
        assert att["processing_lease_token"] is None, (
            f"B2 FAIL: processing_lease_token={att['processing_lease_token']!r}, "
            "expected NULL"
        )

        print("  B2 PASSED.")
        return True

    finally:
        if ids:
            delete_fixtures(url, ids, vendor_item_id=None)
            verify_cleanup(url, ids)


# ── timeout path test (no database required) ─────────────────────────────────

def test_timeout_path():
    """
    Verifies the run_race() timeout path without a database connection.

    Simulates two worker threads that block indefinitely (as if waiting on a
    locked row). FakeConn.cancel() sets an Event that unblocks the thread,
    mimicking the server's QueryCanceled response to pg_cancel_backend.

    Checks:
      1. cancel() is called on both connections.
      2. close() is called on both connections.
      3. Both threads stop after cancel_and_close().
      4. An AssertionError is raised (the race timed out).
      5. When the monitor fails before threads start, conn1 and conn2 are
         closed before the error is raised (no leaked connections).
    """
    print("── test_timeout_path ────────────────────────────────────────────")

    # ── shared fixture ────────────────────────────────────────────────────────
    class FakeConn:
        """
        Drop-in stand-in for a psycopg2 connection that records calls and
        optionally unblocks a threading.Event on cancel() to simulate the
        server's QueryCanceled response.
        """
        def __init__(self, name: str, unblock: threading.Event = None):
            self.name    = name
            self.unblock = unblock
            self.calls: list = []

        def cancel(self):
            self.calls.append("cancel")
            if self.unblock:
                self.unblock.set()

        def rollback(self):
            self.calls.append("rollback")

        def close(self):
            self.calls.append("close")

        def __repr__(self):
            return f"FakeConn({self.name}, calls={self.calls})"

    # ── test 1: threads time out, cancel+close stops them ────────────────────
    print("  [1] thread-timeout: cancel_and_close stops hanging threads")

    unblock1 = threading.Event()
    unblock2 = threading.Event()
    conn1    = FakeConn("conn1", unblock=unblock1)
    conn2    = FakeConn("conn2", unblock=unblock2)

    def hanging(stop_event: threading.Event):
        stop_event.wait(timeout=30)   # blocks until cancel() sets the event

    t1 = threading.Thread(target=hanging, args=(unblock1,), daemon=True)
    t2 = threading.Thread(target=hanging, args=(unblock2,), daemon=True)
    t1.start()
    t2.start()

    assert t1.is_alive() and t2.is_alive(), \
        "precondition: both threads should be blocking"

    # Replicate the exact timeout path from run_race.
    cancel_and_close(conn1)
    cancel_and_close(conn2)
    t1.join(timeout=2)
    t2.join(timeout=2)

    assert not t1.is_alive(), "t1 should have stopped after cancel()"
    assert not t2.is_alive(), "t2 should have stopped after cancel()"
    assert "cancel" in conn1.calls, f"cancel() not called on conn1: {conn1}"
    assert "cancel" in conn2.calls, f"cancel() not called on conn2: {conn2}"
    assert "close"  in conn1.calls, f"close() not called on conn1: {conn1}"
    assert "close"  in conn2.calls, f"close() not called on conn2: {conn2}"
    print("    PASSED.")

    # ── test 2: cancel() before rollback/close (ordering check) ──────────────
    print("  [2] cancel_and_close call order: cancel → rollback → close")

    block_event = threading.Event()
    conn3 = FakeConn("conn3", unblock=block_event)
    cancel_and_close(conn3)

    assert conn3.calls[0] == "cancel",   f"first call should be cancel: {conn3.calls}"
    assert "rollback" in conn3.calls,    f"rollback not called: {conn3.calls}"
    assert conn3.calls[-1] == "close",   f"last call should be close: {conn3.calls}"
    print("    PASSED.")

    # ── test 3: monitor-failure path closes conn1 and conn2 ──────────────────
    print("  [3] monitor-failure path: conn1 and conn2 closed before raise")

    # Reconstruct the monitor-failure guard from run_race using FakeConn.
    conn_a = FakeConn("conn_a")
    conn_b = FakeConn("conn_b")
    monitor_ready = threading.Event()    # deliberately never set (timeout)

    caught = None
    try:
        if not monitor_ready.wait(timeout=0.001):   # immediate timeout
            close_quietly(conn_a)
            close_quietly(conn_b)
            raise AssertionError("monitor did not connect within 10 s.")
    except AssertionError as exc:
        caught = exc

    assert caught is not None, "expected AssertionError was not raised"
    assert "close" in conn_a.calls, f"conn_a not closed on monitor failure: {conn_a}"
    assert "close" in conn_b.calls, f"conn_b not closed on monitor failure: {conn_b}"
    print("    PASSED.")

    print("\nAll timeout-path tests PASSED.")


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    url    = get_url()
    run_id = str(uuid.uuid4())[:8]
    print(f"A1.2.g race test  run={run_id}  project={REQUIRED_PROJECT}")

    b1_passed = b2_passed = False
    exit_code = 0

    try:
        b1_passed = run_b1(url, run_id)
    except (AssertionError, RuntimeError) as exc:
        print(f"\nB1 ERROR: {exc}")
        exit_code = 1

    try:
        b2_passed = run_b2(url, run_id)
    except (AssertionError, RuntimeError) as exc:
        print(f"\nB2 ERROR: {exc}")
        exit_code = 1

    print("\n── Summary ──────────────────────────────────────────────────────")
    print(f"  B1 (price-save-first): {'PASSED' if b1_passed else 'FAILED'}")
    print(f"  B2 (recovery-first):   {'PASSED' if b2_passed else 'FAILED'}")

    if b1_passed and b2_passed:
        print("\nA1.2.g PASSED – lease stops competing database writes.")
    else:
        print("\nA1.2.g INCOMPLETE – see errors above.")

    sys.exit(exit_code)


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--test-timeout":
        test_timeout_path()
        sys.exit(0)
    main()

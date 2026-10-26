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


# ── exceptions ────────────────────────────────────────────────────────────────

class WorkerTimeoutError(Exception):
    """
    Raised by run_race() when one or both worker threads are still alive after
    the initial join timeout, cancel() signals have been sent, and the
    secondary cancel-join timeout has also expired.

    Carrying this as a distinct type lets run_b1/run_b2 distinguish a
    thread-timeout (where fixture cleanup must be skipped — the threads may
    still hold open transactions) from any other assertion failure.
    """
    def __init__(self, label: str, fn1_alive: bool, fn2_alive: bool):
        self.label     = label
        self.fn1_alive = fn1_alive
        self.fn2_alive = fn2_alive
        super().__init__(
            f"{label}: worker thread(s) still alive after cancel+join — "
            f"fn1.alive={fn1_alive}, fn2.alive={fn2_alive}. "
            f"Fixture cleanup was skipped; IDs were printed above."
        )


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
        except Exception:
            # psycopg2.ProgrammingError: no results to fetch (e.g. void func).
            # execute() raises for serious errors before fetchall() is reached,
            # so swallowing only at this point is safe.
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

    ready_event fires after the monitor's first successful database poll
    (connected=True), OR immediately on a connection error (connected=False).
    run_race() checks both: if ready_event is set but connected is False, the
    monitor failed to connect and run_race() raises before starting the race.

    Uses self._halt (not self._stop) to avoid conflicting with
    threading.Thread internals.
    """

    def __init__(self, url: str, racer_pid: int, holder_pid: int):
        super().__init__(daemon=True, name="lock-monitor")
        self.url            = url
        self.racer_pid      = racer_pid
        self.holder_pid     = holder_pid
        self.connected      = False           # True only after first successful poll
        self.wait_observed  = False
        self.ready_event    = threading.Event()   # set on first poll OR on error
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
                        self.connected = True     # first poll succeeded
                        self.ready_event.set()    # unblock run_race
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
            # connected remains False; ready_event still fires so run_race()
            # does not wait forever — it will see connected=False and abort.
            self.ready_event.set()
            print(f"    [monitor] connection error: {exc}")

    def halt(self):
        self._halt.set()


# ── race runner ───────────────────────────────────────────────────────────────

def run_race(
    url: str,
    fn1_sql: str, fn1_params: tuple,
    fn2_sql: str, fn2_params: tuple,
    label: str,
    *,
    _test_hooks: dict = None,
) -> dict:
    """
    Sequence:
      1. Open conn1 and conn2 (or use _test_hooks["conns"] for testing).
      2. Start monitor; wait for ready_event + connected=True.
         If the monitor signals ready but connected=False, it hit a connection
         error — close both worker connections and raise AssertionError.
      3. Start fn1 and fn2 threads.
      4. fn1: calls SQL inside an open transaction (row locks held), fires
         lock_acquired, sleeps lock_hold seconds, commits.
      5. fn2: waits for lock_acquired, calls SQL — immediately blocks.
      6. Monitor must confirm via pg_blocking_pids() before fn1 commits.
      7. Join both threads (join_timeout seconds).
      8. If either thread is still alive:
           a. Send cancel() to both connections (non-blocking — signals
              pg_cancel_backend; must NOT call rollback/close here, those
              block on the socket while a query is executing).
           b. Join again (cancel_join_timeout seconds) so threads can handle
              QueryCanceled and exit cleanly.
           c. Only AFTER threads have stopped, call close_quietly() — safe
              because no thread is using the connection any more.
           d. Raise WorkerTimeoutError. Callers (run_b1/run_b2) must NOT
              proceed to fixture cleanup: the threads may still hold open
              transactions on the database.
      9. Both threads finished normally: close connections, check results.

    _test_hooks (dict, for testing only):
      conns              – (conn1, conn2) to use instead of connect(url)
      monitor            – object with .connected, .ready_event, .wait_observed,
                           .start(), .halt(), .join() to use instead of
                           LockWaitMonitor
      join_timeout       – seconds for initial t1/t2 join (default 15)
      cancel_join_timeout – seconds for post-cancel t1/t2 join (default 5)
      monitor_timeout    – seconds to wait for monitor.ready_event (default 10)
      lock_hold          – seconds fn1 sleeps before committing (default
                           LOCK_HOLD_SECONDS)
    """
    hooks               = _test_hooks or {}
    join_timeout        = hooks.get("join_timeout",         15)
    cancel_join_timeout = hooks.get("cancel_join_timeout",   5)
    monitor_timeout     = hooks.get("monitor_timeout",      10)
    lock_hold           = hooks.get("lock_hold",   LOCK_HOLD_SECONDS)

    if "conns" in hooks:
        conn1, conn2 = hooks["conns"]
    else:
        conn1 = connect(url)
        conn2 = connect(url)

    fn1_result: dict = {"rows": [], "error": None}
    fn2_result: dict = {"rows": [], "error": None}
    lock_acquired     = threading.Event()

    conn1_pid = backend_pid(conn1)
    conn2_pid = backend_pid(conn2)

    if "monitor" in hooks:
        monitor = hooks["monitor"]
    else:
        monitor = LockWaitMonitor(url, racer_pid=conn2_pid, holder_pid=conn1_pid)

    def run_fn1():
        try:
            rows = run_sql(conn1, fn1_sql, fn1_params)
            fn1_result["rows"] = rows
            lock_acquired.set()               # row locks held; fn2 may start
            time.sleep(lock_hold)             # hold long enough for monitor
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

    # ── start monitor ─────────────────────────────────────────────────────────
    # Wait for the monitor to complete its first poll before starting the race
    # threads. If it fires ready_event but connected=False it hit a connection
    # error; close both worker connections (open at this point) before raising.
    monitor.start()
    ready = monitor.ready_event.wait(timeout=monitor_timeout)

    if not ready:
        monitor.halt()
        close_quietly(conn1)
        close_quietly(conn2)
        raise AssertionError(
            f"{label}: monitor did not become ready within {monitor_timeout} s."
        )
    if not monitor.connected:
        monitor.halt()
        close_quietly(conn1)
        close_quietly(conn2)
        raise AssertionError(
            f"{label}: monitor failed to connect "
            f"(ready_event fired on error, not on first successful poll)."
        )

    # ── start race threads ────────────────────────────────────────────────────
    t1 = threading.Thread(target=run_fn1, daemon=True, name=f"{label}-fn1")
    t2 = threading.Thread(target=run_fn2, daemon=True, name=f"{label}-fn2")
    t1.start()
    t2.start()

    t1.join(timeout=join_timeout)
    t2.join(timeout=join_timeout)

    monitor.halt()
    monitor.join(timeout=2)

    # ── timeout handling ──────────────────────────────────────────────────────
    if t1.is_alive() or t2.is_alive():
        # One or both threads are still blocked inside a database call.
        #
        # Correct cancel sequence:
        #   1. cancel() – non-blocking; tells the server to raise QueryCanceled
        #      on the backend. Must NOT call rollback() or close() yet —
        #      both block on the socket while a query is still executing.
        #   2. join() – let threads receive QueryCanceled, catch the error in
        #      their except-handler, and exit. This is when rollback happens
        #      (inside close_quietly inside run_fn1/run_fn2's except block).
        #   3. close_quietly() – only AFTER threads have stopped. Safe because
        #      no thread is using the connection. Idempotent if the thread
        #      already closed it.
        for conn in (conn1, conn2):
            try:
                conn.cancel()
            except Exception:
                pass
        t1.join(timeout=cancel_join_timeout)
        t2.join(timeout=cancel_join_timeout)
        # Only close a connection whose thread has actually stopped.
        # If a thread is still alive its socket is still in use — calling
        # rollback() or close() from the main thread blocks on the wire
        # exactly as it did before cancel(). Leave that connection open;
        # the server will clean it up when the process exits or the client
        # disconnects. The fixture IDs are printed for manual cleanup.
        if not t1.is_alive():
            close_quietly(conn1)
        if not t2.is_alive():
            close_quietly(conn2)
        raise WorkerTimeoutError(label, t1.is_alive(), t2.is_alive())

    # ── normal finish ─────────────────────────────────────────────────────────
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
    ids              = None
    vendor_item_id   = None
    worker_timed_out = False
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

    except WorkerTimeoutError:
        worker_timed_out = True
        raise

    finally:
        if ids is None:
            pass   # fixtures were never created; nothing to clean
        elif worker_timed_out:
            # One or more worker threads may still hold open transactions.
            # Attempting cleanup here would block indefinitely or corrupt state.
            # Print all fixture IDs so they can be cleaned up by a targeted
            # DELETE after the stuck connections are cleared.
            print("  Skipping cleanup — worker thread(s) may still hold DB connections.")
            print("  Fixture IDs for manual cleanup:")
            print(f"    attachment_id : {ids['attachment_id']}")
            print(f"    message_id    : {ids['message_id']}")
            print(f"    routing_id    : {ids['routing_id']}")
            print(f"    item_code     : {ids['item_code']}")
        else:
            delete_fixtures(url, ids, vendor_item_id)
            verify_cleanup(url, ids)


# ── B2 ────────────────────────────────────────────────────────────────────────

def run_b2(url: str, run_id: str) -> bool:
    print("\n── B2: recovery-first ───────────────────────────────────────────")
    ids              = None
    worker_timed_out = False
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

    except WorkerTimeoutError:
        worker_timed_out = True
        raise

    finally:
        if ids is None:
            pass
        elif worker_timed_out:
            print("  Skipping cleanup — worker thread(s) may still hold DB connections.")
            print("  Fixture IDs for manual cleanup:")
            print(f"    attachment_id : {ids['attachment_id']}")
            print(f"    message_id    : {ids['message_id']}")
            print(f"    routing_id    : {ids['routing_id']}")
            print(f"    item_code     : {ids['item_code']}")
        else:
            delete_fixtures(url, ids, vendor_item_id=None)
            verify_cleanup(url, ids)


# ── timeout path test (no database required) ─────────────────────────────────

def test_timeout_path():
    """
    Verifies run_race() failure paths without a database connection.

    Uses _test_hooks injection to supply fake connections and a fake monitor,
    then calls run_race() and asserts on the actual exception type, the
    call-ordering of cancel/close, and the correct error message.

    Sub-tests:
      [t1] Worker-timeout path: run_race() times out at initial join_timeout,
           sends cancel() to both connections (non-blocking), joins again,
           then calls close_quietly() AFTER threads have stopped. Verifies
           cancel precedes close on both connections and WorkerTimeoutError
           is raised.

      [t2] Monitor-error path: monitor fires ready_event but connected=False
           (simulating a connection error in LockWaitMonitor.run()). Verifies
           run_race() closes both worker connections before raising
           AssertionError, and the message identifies the monitor as the
           cause.
    """
    print("── test_timeout_path ────────────────────────────────────────────")

    # ── fake connection infrastructure ───────────────────────────────────────

    class _FakeCursor:
        """
        Context-manager cursor. First cursor on a FakeConn returns pid_row;
        subsequent cursors block on block_event until it is set (simulating a
        hung execute()) then return [].
        """
        def __init__(self, result, block_event=None):
            self._result = result
            self._block  = block_event

        def __enter__(self):  return self
        def __exit__(self, *a): return False

        def execute(self, sql, params=None):
            if self._block:
                self._block.wait()   # blocks until FakeConn.cancel() sets it

        def fetchall(self):
            return self._result if self._result is not None else []

        def fetchone(self):
            r = self.fetchall()
            return r[0] if r else None

    class FakeConn:
        """
        Stand-in for a psycopg2 connection.

        pid              – integer returned by the first cursor (backend_pid)
        block_event      – threading.Event; if given, the second+ cursor blocks
                           in execute() until the event is set
        cancel_unblocks  – if True (default), cancel() sets block_event,
                           mimicking pg_cancel_backend unblocking the query;
                           if False, cancel() is recorded but does NOT set
                           block_event, simulating a backend that ignores the
                           cancel signal (used by [t3])
        """
        def __init__(self, name: str, pid: int,
                     block_event: threading.Event = None,
                     cancel_unblocks: bool = True):
            self.name            = name
            self._pid            = pid
            self._block          = block_event
            self._cancel_unblocks = cancel_unblocks
            self._cursor_seq     = 0
            self.calls: list     = []

        def cursor(self):
            self._cursor_seq += 1
            if self._cursor_seq == 1:
                # First cursor: backend_pid query — returns immediately.
                return _FakeCursor([{"pid": self._pid}])
            else:
                # Subsequent cursors: fn SQL — blocks until event is set.
                return _FakeCursor([], block_event=self._block)

        def commit(self):   pass

        def cancel(self):
            self.calls.append("cancel")
            if self._block and self._cancel_unblocks:
                self._block.set()   # unblocks any waiting cursor execute()

        def rollback(self):
            self.calls.append("rollback")

        def close(self):
            self.calls.append("close")

        def __repr__(self):
            return f"FakeConn({self.name!r}, calls={self.calls})"

    class _FakeMonitor:
        """
        Stand-in for LockWaitMonitor. Fires ready_event immediately;
        connected reflects whether the monitor 'connected' successfully.
        wait_observed stays False (no actual DB polling).
        """
        def __init__(self, connected: bool):
            self.connected     = connected
            self.wait_observed = False
            self.ready_event   = threading.Event()
            self.ready_event.set()   # already ready when start() is called

        def start(self): pass
        def halt(self):  pass
        def join(self, timeout=None): pass

    # ── [t1] worker-timeout path ──────────────────────────────────────────────
    print("  [t1] worker-timeout: cancel() before close_quietly(), both in order")

    block1 = threading.Event()
    block2 = threading.Event()
    c1 = FakeConn("conn1", pid=101, block_event=block1)
    c2 = FakeConn("conn2", pid=102, block_event=block2)

    t1_caught = None
    try:
        run_race(
            url="",                          # unused — conns injected
            fn1_sql="SELECT 1", fn1_params=(),
            fn2_sql="SELECT 1", fn2_params=(),
            label="TEST-T1",
            _test_hooks={
                "conns":               (c1, c2),
                "monitor":             _FakeMonitor(connected=True),
                "join_timeout":        0.05,   # time out quickly
                "cancel_join_timeout": 3.0,    # enough for threads to finish
                "monitor_timeout":     1.0,
                "lock_hold":           0.0,    # no sleep after fn1 unblocks
            },
        )
    except WorkerTimeoutError as exc:
        t1_caught = exc

    assert t1_caught is not None, \
        "expected WorkerTimeoutError was not raised"

    assert "cancel" in c1.calls, \
        f"cancel() not called on conn1: {c1}"
    assert "cancel" in c2.calls, \
        f"cancel() not called on conn2: {c2}"
    assert "close" in c1.calls, \
        f"close() not called on conn1: {c1}"
    assert "close" in c2.calls, \
        f"close() not called on conn2: {c2}"

    # cancel must appear before close — the core ordering guarantee
    c1_cancel = c1.calls.index("cancel")
    c1_close  = c1.calls.index("close")
    assert c1_cancel < c1_close, \
        f"conn1: cancel must precede close, got: {c1.calls}"

    c2_cancel = c2.calls.index("cancel")
    c2_close  = c2.calls.index("close")
    assert c2_cancel < c2_close, \
        f"conn2: cancel must precede close, got: {c2.calls}"

    print("    PASSED.")

    # ── [t2] monitor-error path ───────────────────────────────────────────────
    print("  [t2] monitor-error: both connections closed before AssertionError")

    c3 = FakeConn("conn3", pid=201)
    c4 = FakeConn("conn4", pid=202)

    t2_caught = None
    try:
        run_race(
            url="",
            fn1_sql="SELECT 1", fn1_params=(),
            fn2_sql="SELECT 1", fn2_params=(),
            label="TEST-T2",
            _test_hooks={
                "conns":           (c3, c4),
                "monitor":         _FakeMonitor(connected=False),
                "monitor_timeout": 1.0,
            },
        )
    except AssertionError as exc:
        t2_caught = exc
    except WorkerTimeoutError as exc:
        t2_caught = exc

    assert t2_caught is not None, \
        "expected AssertionError was not raised"
    assert not isinstance(t2_caught, WorkerTimeoutError), \
        "monitor failure should raise AssertionError, not WorkerTimeoutError"

    assert "close" in c3.calls, \
        f"conn3 not closed after monitor failure: {c3}"
    assert "close" in c4.calls, \
        f"conn4 not closed after monitor failure: {c4}"

    msg = str(t2_caught).lower()
    assert "monitor" in msg, \
        f"error message should mention 'monitor': {t2_caught}"

    print("    PASSED.")

    # ── [t3] cancel does not stop the worker ──────────────────────────────────
    print("  [t3] cancel ignored: close_quietly NOT called on still-alive thread")

    # block_event is never set — simulates a backend that ignores pg_cancel_backend.
    # cancel_unblocks=False means cancel() records the call but does NOT set the
    # event, so the thread remains blocked through the entire cancel-join window.
    never_unblock = threading.Event()
    c5 = FakeConn("conn5", pid=301, block_event=never_unblock, cancel_unblocks=False)
    c6 = FakeConn("conn6", pid=302)   # no block; fn2 waits for lock_acquired,
                                       # which fn1 never sets → also stays alive

    t3_caught = None
    try:
        run_race(
            url="",
            fn1_sql="SELECT 1", fn1_params=(),
            fn2_sql="SELECT 1", fn2_params=(),
            label="TEST-T3",
            _test_hooks={
                "conns":               (c5, c6),
                "monitor":             _FakeMonitor(connected=True),
                "join_timeout":        0.05,   # both threads still alive
                "cancel_join_timeout": 0.1,    # short; fn1 never unblocks
                "monitor_timeout":     1.0,
                "lock_hold":           0.0,
            },
        )
    except WorkerTimeoutError as exc:
        t3_caught = exc

    assert t3_caught is not None, \
        "expected WorkerTimeoutError was not raised"
    assert t3_caught.fn1_alive, \
        "fn1 should still be alive (cancel did not unblock it)"

    # The critical property: close_quietly must NOT have been called on a
    # connection whose thread is still alive — rollback() would block on the
    # socket exactly as before cancel() was sent.
    assert "close" not in c5.calls, (
        f"close_quietly was called on conn5 while its thread was still alive — "
        f"rollback() would block: {c5.calls}"
    )

    # cancel() must still have been attempted (we send it; the server just
    # didn't respond in time)
    assert "cancel" in c5.calls, \
        f"cancel() was never called on conn5: {c5.calls}"

    print("    PASSED.")

    print("\nAll timeout-path tests PASSED.")


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    url    = get_url()
    run_id = str(uuid.uuid4())[:8]
    print(f"A1.2.g race test  run={run_id}  project={REQUIRED_PROJECT}")

    b1_passed         = False
    b2_passed         = False
    b1_worker_timeout = False
    exit_code         = 0

    try:
        b1_passed = run_b1(url, run_id)
    except WorkerTimeoutError as exc:
        b1_worker_timeout = True
        print(f"\nB1 TIMEOUT: {exc}")
        exit_code = 1
    except (AssertionError, RuntimeError) as exc:
        print(f"\nB1 ERROR: {exc}")
        exit_code = 1

    if b1_worker_timeout:
        # A live worker thread after cancel+join means an open transaction may
        # still exist. Running B2 (which creates new fixtures and starts new
        # connections) against a database with a stuck transaction is unsafe.
        print(
            "\nSkipping B2 — B1 had a live worker thread after cancel+join.\n"
            "Investigate and clear stuck connections before re-running."
        )
        exit_code = 1
    else:
        try:
            b2_passed = run_b2(url, run_id)
        except WorkerTimeoutError as exc:
            print(f"\nB2 TIMEOUT: {exc}")
            exit_code = 1
        except (AssertionError, RuntimeError) as exc:
            print(f"\nB2 ERROR: {exc}")
            exit_code = 1

    print("\n── Summary ──────────────────────────────────────────────────────")
    print(f"  B1 (price-save-first): {'PASSED' if b1_passed else 'FAILED'}")
    if b1_worker_timeout:
        print(f"  B2 (recovery-first):   SKIPPED (B1 worker timeout)")
    else:
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

import assert from "node:assert/strict";
import { createLeaseBindings } from "./lease-bindings.mjs";
import { authorizedServiceRequest } from "./request-auth.mjs";
import { isDispatchable, isTerminal, VALID_OUTCOMES } from "../inbound-email/attachment-state.mjs";
import { processAttachments } from "../inbound-email/attachment-processor.mjs";

let passed = 0;
async function check(name, fn) {
  await fn(); passed++; console.log(`✓ ${name}`);
}

function rpcClient(responses) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve(responses[name] ?? { data: null, error: null });
    },
  };
}

// ── 1. Auth ────────────────────────────────────────────────────────────────

await check("service-role bearer required", () => {
  assert.equal(authorizedServiceRequest("Bearer secret", "secret"), true);
  assert.equal(authorizedServiceRequest("Bearer anon", "secret"), false);
  assert.equal(authorizedServiceRequest("Basic secret", "secret"), false);
  assert.equal(authorizedServiceRequest(null, "secret"), false);
  assert.equal(authorizedServiceRequest("Bearer secret", ""), false);
});

await check("constant-time check: equal-length wrong token rejected", () => {
  assert.equal(authorizedServiceRequest("Bearer abcdefgh", "ABCDEFGH"), false);
});

await check("constant-time check: length mismatch rejected without character comparison", () => {
  // Different lengths return false immediately
  assert.equal(authorizedServiceRequest("Bearer short", "a-much-longer-secret"), false);
  assert.equal(authorizedServiceRequest("Bearer a-much-longer-token-value", "short"), false);
});

// ── 2. attachment-state predicates ────────────────────────────────────────

await check("VALID_OUTCOMES includes the three expected values", () => {
  assert.ok(VALID_OUTCOMES.includes("auto_imported"));
  assert.ok(VALID_OUTCOMES.includes("needs_review"));
  assert.ok(VALID_OUTCOMES.includes("skipped"));
  assert.equal(VALID_OUTCOMES.length, 3);
});

await check("isDispatchable: pending row with storage_path is dispatchable", () => {
  assert.equal(isDispatchable({ processing_status: "pending", ingest_error: null, storage_path: "org/path" }), true);
});

await check("isDispatchable: needs_review row is NOT dispatchable", () => {
  assert.equal(isDispatchable({ processing_status: "needs_review", ingest_error: null, storage_path: "org/path" }), false);
});

await check("isDispatchable: pending row without storage_path is not dispatchable", () => {
  assert.equal(isDispatchable({ processing_status: "pending", ingest_error: null, storage_path: null }), false);
});

await check("isDispatchable: pending row with ingest_error is not dispatchable", () => {
  assert.equal(isDispatchable({ processing_status: "pending", ingest_error: "bad base64", storage_path: "org/path" }), false);
});

await check("isDispatchable: processing row is not dispatchable", () => {
  assert.equal(isDispatchable({ processing_status: "processing", ingest_error: null, storage_path: "org/path" }), false);
});

await check("isDispatchable: auto_imported row is not dispatchable", () => {
  assert.equal(isDispatchable({ processing_status: "auto_imported", ingest_error: null, storage_path: "org/path" }), false);
});

await check("isDispatchable: null row is not dispatchable", () => {
  assert.equal(isDispatchable(null), false);
});

await check("isTerminal: auto_imported is terminal", () => {
  assert.equal(isTerminal("auto_imported"), true);
});

await check("isTerminal: needs_review is terminal", () => {
  assert.equal(isTerminal("needs_review"), true);
});

await check("isTerminal: pending is not terminal", () => {
  assert.equal(isTerminal("pending"), false);
});

await check("isTerminal: processing is not terminal", () => {
  assert.equal(isTerminal("processing"), false);
});

// ── 3. Lease bindings ─────────────────────────────────────────────────────

await check("claimed token reaches price, status and heartbeat RPCs", async () => {
  const client = rpcClient({
    claim_attachment: { data: "lease-1", error: null },
    renew_processing_lease: { data: true, error: null },
    kerdos_auto_apply_price_quote: { data: "item-1", error: null },
    set_attachment_status_fenced: { data: true, error: null },
  });
  const lease = createLeaseBindings(client);
  await assert.rejects(lease.applyPrice({}), /LEASE_LOST/);
  assert.equal(await lease.claim("att-1"), "lease-1");
  assert.equal(await lease.renewLease(), true);
  assert.equal(await lease.applyPrice({ p_description: "test" }), "item-1");
  await lease.setStatus("att-1", "auto_imported", null, "doc-1");
  assert.deepEqual(client.calls.map(x => x.name), [
    "claim_attachment", "renew_processing_lease",
    "kerdos_auto_apply_price_quote", "set_attachment_status_fenced",
  ]);
  for (const call of client.calls.slice(1)) {
    assert.equal(call.args.p_attachment_id, "att-1");
    assert.equal(call.args.p_lease_token, "lease-1");
  }
});

await check("revoked lease blocks subsequent writes", async () => {
  const client = rpcClient({
    claim_attachment: { data: "lease-1", error: null },
    renew_processing_lease: { data: false, error: null },
  });
  const lease = createLeaseBindings(client);
  await lease.claim("att-1");
  await assert.rejects(lease.renewLease(), /LEASE_LOST/);
  await assert.rejects(lease.applyPrice({}), /LEASE_LOST/);
  await assert.rejects(lease.setStatus("att-1", "auto_imported"), /LEASE_LOST/);
  assert.equal(client.calls.length, 2);
});

await check("DB error on renewLease marks lease lost and throws LEASE_LOST", async () => {
  const client = rpcClient({
    claim_attachment: { data: "lease-1", error: null },
    renew_processing_lease: { data: null, error: { message: "connection timeout" } },
  });
  const lease = createLeaseBindings(client);
  await lease.claim("att-1");
  await assert.rejects(lease.renewLease(), /LEASE_LOST/);
  await assert.rejects(lease.applyPrice({}), /LEASE_LOST/);
});

await check("attachment ID mismatch in setStatus throws LEASE_LOST", async () => {
  const client = rpcClient({
    claim_attachment: { data: "lease-1", error: null },
  });
  const lease = createLeaseBindings(client);
  await lease.claim("att-1");
  await assert.rejects(
    lease.setStatus("att-DIFFERENT", "auto_imported"),
    /LEASE_LOST/
  );
});

await check("null returned from applyPrice marks lease lost", async () => {
  const client = rpcClient({
    claim_attachment: { data: "lease-1", error: null },
    kerdos_auto_apply_price_quote: { data: null, error: null },
  });
  const lease = createLeaseBindings(client);
  await lease.claim("att-1");
  await assert.rejects(lease.applyPrice({ p_description: "test" }), /LEASE_LOST/);
  await assert.rejects(lease.renewLease(), /LEASE_LOST/);
});

await check("DB error in applyPrice propagates as non-LEASE_LOST error", async () => {
  const client = rpcClient({
    claim_attachment: { data: "lease-1", error: null },
    kerdos_auto_apply_price_quote: { data: null, error: { message: "DB constraint violation" } },
  });
  const lease = createLeaseBindings(client);
  await lease.claim("att-1");
  await assert.rejects(lease.applyPrice({ p_description: "test" }), /DB constraint violation/);
});

// ── 4. Inbound handoff (awaited invocation) ───────────────────────────────

function inboundBackend({ existing = null, invocation, insertRace = false } = {}) {
  let row = existing;
  let inserts = 0;
  let invocations = 0;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const backend = {
    get invocations() { return invocations; },
    get inserts() { return inserts; },
    release,
    from(table) {
      assert.equal(table, "inbound_attachments");
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
        insert() {
          inserts++;
          if (insertRace) {
            row = { id: "att-1", processing_status: "pending", storage_path: "stored" };
            return { select() { return this; }, single() {
              return Promise.resolve({ data: null, error: { code: "23505" } });
            } };
          }
          row = { id: "att-1", processing_status: "pending", storage_path: "stored" };
          return { select() { return this; }, single() {
            return Promise.resolve({ data: row, error: null });
          } };
        },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { async invoke() { invocations++; await wait; return invocation; } },
  };
  return backend;
}

const attachment = [{ Name: "prices.csv", ContentType: "text/csv", Content: btoa("A"), ContentLength: 1 }];

await check("inbound handoff is awaited before success", async () => {
  const backend = inboundBackend({ invocation: { data: { outcome: "auto_imported" }, error: null } });
  let done = false;
  const work = processAttachments(backend, "org-1", "msg-1", attachment).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(done, false);
  backend.release();
  await work;
  assert.equal(backend.invocations, 1);
});

await check("failed invocation throws; retry of stored pending row invokes again", async () => {
  const backend = inboundBackend({ invocation: { data: null, error: { message: "edge down" } } });
  backend.release();
  await assert.rejects(processAttachments(backend, "org-1", "msg-1", attachment), /edge down/);
  assert.equal(backend.inserts, 1);
  await assert.rejects(processAttachments(backend, "org-1", "msg-1", attachment), /edge down/);
  assert.equal(backend.inserts, 1);
  assert.equal(backend.invocations, 2);
});

await check("HTTP 200 failed outcome still triggers retry", async () => {
  const backend = inboundBackend({ invocation: { data: { outcome: "failed", reason: "DB error" }, error: null } });
  backend.release();
  await assert.rejects(processAttachments(backend, "org-1", "msg-1", attachment), /DB error/);
});

await check("insert race retrieves winner and invokes processing", async () => {
  const backend = inboundBackend({ insertRace: true, invocation: { data: { outcome: "skipped" }, error: null } });
  backend.release();
  await processAttachments(backend, "org-1", "msg-1", attachment);
  assert.equal(backend.invocations, 1);
});

await check("existing needs_review row is NOT re-dispatched (not dispatchable)", async () => {
  // needs_review row: has storage_path, no ingest_error, but status is needs_review
  const existingNeedsReview = {
    id: "att-existing",
    processing_status: "needs_review",
    ingest_error: null,
    storage_path: "org-1/inbound/msg-1/0",
  };
  let invocations = 0;
  const backend = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: existingNeedsReview, error: null }); },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke() { invocations++; return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(backend, "org-1", "msg-1", attachment);
  assert.equal(invocations, 0, "needs_review row must not be re-dispatched");
});

await check("existing ingest_error row is NOT re-dispatched", async () => {
  const existingErrorRow = {
    id: "att-err",
    processing_status: "pending",
    ingest_error: "base64 decode failed: invalid character",
    storage_path: null,
  };
  let invocations = 0;
  const backend = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: existingErrorRow, error: null }); },
      };
    },
    functions: { invoke() { invocations++; return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(backend, "org-1", "msg-1", attachment);
  assert.equal(invocations, 0, "ingest_error row must not be re-dispatched");
});

await check("invoice write carries the current database lease and rejects wrong attachment",async()=>{
  const client=rpcClient({claim_attachment:{data:"lease-token",error:null},kerdos_auto_record_invoice:{data:"invoice-id",error:null}});
  const lease=createLeaseBindings(client);await lease.claim("a1");
  assert.equal(await lease.recordInvoice({attachmentId:"a1",fingerprint:"fp",header:{},lines:[]}),"invoice-id");
  const call=client.calls.at(-1);assert.equal(call.args.p_lease_token,"lease-token");assert.equal(call.args.p_attachment_id,"a1");
  await assert.rejects(()=>lease.recordInvoice({attachmentId:"other",header:{},lines:[]}),/LEASE_LOST/);
});
await check("unconfirmed invoice RPC remains distinguishable from a validation exception",async()=>{
  const client=rpcClient({claim_attachment:{data:"lease-token",error:null},kerdos_auto_record_invoice:{data:null,error:{message:"network interrupted"}}});
  const lease=createLeaseBindings(client);await lease.claim("a1");
  await assert.rejects(()=>lease.recordInvoice({attachmentId:"a1",header:{},lines:[]}),/INVOICE_COMMIT_UNCONFIRMED/);
});

console.log(`\n${passed} lease/handoff tests passed`);

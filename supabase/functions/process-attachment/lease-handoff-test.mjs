import assert from "node:assert/strict";
import { createLeaseBindings } from "./lease-bindings.mjs";
import { authorizedServiceRequest } from "./request-auth.mjs";
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

await check("service-role bearer required", () => {
  assert.equal(authorizedServiceRequest("Bearer secret", "secret"), true);
  assert.equal(authorizedServiceRequest("Bearer anon", "secret"), false);
  assert.equal(authorizedServiceRequest("Basic secret", "secret"), false);
  assert.equal(authorizedServiceRequest(null, "secret"), false);
  assert.equal(authorizedServiceRequest("Bearer secret", ""), false);
});

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

console.log(`${passed} lease/handoff tests passed`);

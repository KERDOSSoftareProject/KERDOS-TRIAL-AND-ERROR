import assert from "node:assert/strict";
import { sweepAttachments } from "./sweep.mjs";
import { authorizedSweep } from "./auth.mjs";

let passed = 0;
async function test(label, fn) { await fn(); passed++; console.log(`✓ ${label}`); }

function mockClient({ stale = [], pending = [], recover = true, lookupError = null,
  fallbackRows = [{ id: "a3" }], fallbackError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, "inbound_attachments");
      let status;
      return {
        select() { return this; },
        update(value) { calls.push({ name: "fallback", value }); return this; },
        eq(column, value) { if (column === "processing_status") status = value; return this; },
        lt() { return this; },
        not() { return this; },
        is() { return this; },
        limit() { return Promise.resolve({ data: status === "processing" ? stale : pending, error: lookupError }); },
        then(resolve) { return Promise.resolve({ data: fallbackRows, error: fallbackError }).then(resolve); },
      };
    },
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({ data: recover, error: null });
    },
  };
}

await test("secret required before sweep", () => {
  assert.equal(authorizedSweep("Bearer secret", "secret"), true);
  assert.equal(authorizedSweep("Bearer wrong", "secret"), false);
  assert.equal(authorizedSweep("Bearer secret", ""), false);
  assert.equal(authorizedSweep(null, "secret"), false);
});

await test("stale candidate recovers and pending row invokes worker", async () => {
  const att = { id: "a1", organization_id: "o1" };
  const client = mockClient({ stale: [att], pending: [att] });
  const calls = [];
  const result = await sweepAttachments(client, {
    now: new Date("2026-10-27T00:15:00Z"),
    invoke: async (name, options) => {
      calls.push({ name, options });
      return { data: { outcome: "auto_imported" }, error: null };
    },
  });
  assert.deepEqual(result, { recovered: ["a1"], replayed: [{ id: "a1", outcome: "auto_imported" }], needsReview: [], deferred: [] });
  assert.equal(client.calls[0].name, "recover_stale_attachment");
  assert.equal(client.calls[0].args.p_stale_before, "2026-10-27T00:05:00.000Z");
  assert.deepEqual(calls[0], {
    name: "process-attachment", options: { body: { attachmentId: "a1", organizationId: "o1" } },
  });
});

await test("recovery CAS loses race and does not claim success", async () => {
  const client = mockClient({ stale: [{ id: "a2", organization_id: "o1" }], recover: false });
  const result = await sweepAttachments(client, { invoke: async () => { throw Error("unexpected"); } });
  assert.deepEqual(result, { recovered: [], replayed: [], needsReview: [], deferred: [] });
});

await test("pending dispatch failure is surfaced for manual review", async () => {
  const client = mockClient({ pending: [{ id: "a3", organization_id: "o1" }] });
  const result = await sweepAttachments(client, {
    invoke: async () => ({ data: null, error: { message: "edge down" } }),
  });
  assert.deepEqual(result.needsReview, ["a3"]);
  assert.equal(client.calls[0].value.processing_status, "needs_review");
});

await test("concurrent claim is not overwritten by fallback", async () => {
  const client = mockClient({ pending: [{ id: "a3", organization_id: "o1" }], fallbackRows: [] });
  const result = await sweepAttachments(client, { invoke: async () => { throw Error("timeout"); } });
  assert.deepEqual(result.needsReview, []);
  assert.deepEqual(result.deferred, ["a3"]);
});

await test("fallback write failure remains visible to scheduler", async () => {
  const client = mockClient({ pending: [{ id: "a3", organization_id: "o1" }],
    fallbackError: { message: "db down" } });
  await assert.rejects(sweepAttachments(client, {
    invoke: async () => ({ data: null, error: { message: "edge down" } }),
  }), /failed to surface/);
});

await test("lookup error fails sweep before any invocation", async () => {
  const client = mockClient({ lookupError: { message: "db down" } });
  await assert.rejects(sweepAttachments(client, {
    invoke: async () => { throw Error("unexpected"); },
  }), /db down/);
});

console.log(`${passed} recovery sweep tests passed`);

/** A1.2.e P/T cases carried forward from the earlier handoff suite.
 * Calls the current awaited production handoff, not the retired fallback module.
 */
import assert from "node:assert/strict";
import { processAttachments } from "./attachment-processor.mjs";

const ATT = { Name: "price.csv", Content: btoa("item,price\nA,1.00"), ContentType: "text/csv", ContentLength: 17 };
const ORG = "org-1", MSG = "msg-1";
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`✓ ${name}`); }

function mock({ lookups = [], lookupError = null, uploadError = null,
  insertError = null, invokeResult = { data: { outcome: "auto_imported" }, error: null },
  invokeThrows = null, decodeInsertErrors = [] } = {}) {
  const calls = { lookup: 0, upload: 0, insert: [], invoke: [] };
  return {
    calls,
    from(table) {
      assert.equal(table, "inbound_attachments");
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() {
          const index = calls.lookup++;
          return { data: lookups[index] ?? null, error: index === 0 ? lookupError : null };
        },
        insert(payload) {
          calls.insert.push(payload);
          if (payload.ingest_error) {
            return Promise.resolve({ error: decodeInsertErrors[calls.insert.length - 1] ?? null });
          }
          return {
            select() { return this; },
            async single() {
              return { data: insertError ? null : { id: "new-att" }, error: insertError };
            },
          };
        },
      };
    },
    storage: { from() { return { async upload() { calls.upload++; return { error: uploadError }; } }; } },
    functions: { async invoke(name, args) {
      calls.invoke.push({ name, args });
      if (invokeThrows) throw invokeThrows;
      return invokeResult;
    } },
  };
}

await check("P1: completed existing row skips upload, insert and dispatch", async () => {
  const b = mock({ lookups: [{ id: "old", processing_status: "auto_imported", storage_path: "stored" }] });
  await processAttachments(b, ORG, MSG, [ATT]);
  assert.equal(b.calls.upload, 0); assert.equal(b.calls.insert.length, 0); assert.equal(b.calls.invoke.length, 0);
});

await check("P2: existence-check error throws before upload", async () => {
  const b = mock({ lookupError: { message: "connection reset" } });
  await assert.rejects(processAttachments(b, ORG, MSG, [ATT]), /existence check failed/);
  assert.equal(b.calls.upload, 0);
});

await check("P3: clean upload inserts and awaits handoff", async () => {
  const b = mock();
  await processAttachments(b, ORG, MSG, [ATT]);
  assert.equal(b.calls.upload, 1); assert.equal(b.calls.insert.length, 1);
  assert.equal(b.calls.invoke[0].args.body.attachmentId, "new-att");
});

await check("P4: Storage 409 with winning DB row dispatches winner", async () => {
  const b = mock({ uploadError: { statusCode: 409, message: "already exists" },
    lookups: [null, { id: "winner" }] });
  await processAttachments(b, ORG, MSG, [ATT]);
  assert.equal(b.calls.insert.length, 0);
  assert.equal(b.calls.invoke[0].args.body.attachmentId, "winner");
});

await check("P5: Storage orphan recovers row and dispatches it", async () => {
  const b = mock({ uploadError: { statusCode: 409, message: "already exists" } });
  await processAttachments(b, ORG, MSG, [ATT]);
  assert.equal(b.calls.insert.length, 1);
  assert.equal(b.calls.insert[0].storage_path, `${ORG}/inbound/${MSG}/0`);
  assert.equal(b.calls.invoke[0].args.body.attachmentId, "new-att");
});

await check("P6: Storage orphan recovery DB error throws for retry", async () => {
  const b = mock({ uploadError: { statusCode: 409, message: "already exists" },
    insertError: { code: "08006", message: "db down" } });
  await assert.rejects(processAttachments(b, ORG, MSG, [ATT]), /recovery insert failed/);
  assert.equal(b.calls.invoke.length, 0);
});

await check("P7: transient Storage failure throws for retry", async () => {
  const b = mock({ uploadError: { statusCode: 503, message: "storage down" } });
  await assert.rejects(processAttachments(b, ORG, MSG, [ATT]), /storage upload failed/);
  assert.equal(b.calls.insert.length, 0);
});

await check("P8: malformed base64 creates a visible error row without dispatch", async () => {
  const b = mock();
  await processAttachments(b, ORG, MSG, [{ ...ATT, Content: "!!!" }]);
  assert.match(b.calls.insert[0].ingest_error, /base64 decode failed/);
  assert.equal(b.calls.insert[0].storage_path, null);
  assert.equal(b.calls.invoke.length, 0);
});

await check("P9: empty list performs no I/O", async () => {
  const b = mock();
  await processAttachments(b, ORG, MSG, []);
  assert.equal(b.calls.lookup, 0); assert.equal(b.calls.upload, 0);
});

await check("P10: orphan recovery 23505 fetches and dispatches winner", async () => {
  const b = mock({ uploadError: { statusCode: 409, message: "already exists" },
    insertError: { code: "23505", message: "duplicate" },
    lookups: [null, null, { id: "winner" }] });
  await processAttachments(b, ORG, MSG, [ATT]);
  assert.equal(b.calls.invoke[0].args.body.attachmentId, "winner");
});

await check("P11: main insert 23505 fetches and dispatches winner", async () => {
  const b = mock({ insertError: { code: "23505", message: "duplicate" },
    lookups: [null, { id: "winner" }] });
  await processAttachments(b, ORG, MSG, [ATT]);
  assert.equal(b.calls.invoke[0].args.body.attachmentId, "winner");
});

await check("T3/T7: failed worker outcome throws for Postmark retry", async () => {
  const b = mock({ invokeResult: { data: { outcome: "failed", reason: "fallback failed" }, error: null } });
  await assert.rejects(processAttachments(b, ORG, MSG, [ATT]), /fallback failed/);
});

await check("T4: invocation network error throws for Postmark retry", async () => {
  const b = mock({ invokeThrows: new Error("network down") });
  await assert.rejects(processAttachments(b, ORG, MSG, [ATT]), /network down/);
});

await check("T6: retry of mixed batch skips completed row and retries pending row", async () => {
  const rows = new Map();
  const invoked = [];
  let secondFailed = false;
  const b = {
    from() {
      let index;
      return {
        select() { return this; },
        eq(column, value) { if (column === "attachment_index") index = value; return this; },
        async maybeSingle() { return { data: rows.get(index) ?? null, error: null }; },
        insert(payload) {
          const row = { id: `att-${payload.attachment_index}`, processing_status: "pending",
            storage_path: payload.storage_path, ingest_error: null };
          rows.set(payload.attachment_index, row);
          return { select() { return this; }, async single() { return { data: row, error: null }; } };
        },
      };
    },
    storage: { from() { return { async upload() { return { error: null }; } }; } },
    functions: { async invoke(_name, { body }) {
      invoked.push(body.attachmentId);
      if (body.attachmentId === "att-1" && !secondFailed) {
        secondFailed = true;
        return { data: { outcome: "failed", reason: "temporary error" }, error: null };
      }
      rows.get(Number(body.attachmentId.slice(-1))).processing_status = "auto_imported";
      return { data: { outcome: "auto_imported" }, error: null };
    } },
  };
  await assert.rejects(processAttachments(b, ORG, MSG, [ATT, ATT]), /temporary error/);
  await processAttachments(b, ORG, MSG, [ATT, ATT]);
  assert.deepEqual(invoked, ["att-0", "att-1", "att-1"]);
  assert.equal(rows.get(0).processing_status, "auto_imported");
  assert.equal(rows.get(1).processing_status, "auto_imported");
});

console.log(`${passed} recovered handoff cases passed`);

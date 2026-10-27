import assert from "node:assert/strict";
import { beginManualAttachmentReview } from "./email-routing.js";

const calls = [];
const backend = {
  rpc(name, params) {
    calls.push({ name, params });
    return Promise.resolve({ data: true, error: null });
  },
};
assert.equal(await beginManualAttachmentReview(backend, "org-1", "att-1"), true);
assert.deepEqual(calls, [{ name: "begin_manual_attachment_review",
  params: { p_organization_id: "org-1", p_attachment_id: "att-1" } }]);

const busy = { rpc() { return Promise.resolve({ data: false, error: null }); } };
assert.equal(await beginManualAttachmentReview(busy, "org-1", "att-1"), false);

const denied = { rpc() { return Promise.resolve({ data: null, error: { message: "permission denied" } }); } };
await assert.rejects(beginManualAttachmentReview(denied, "org-1", "att-1"), /permission denied/);
console.log("3 manual review RPC contract cases passed");

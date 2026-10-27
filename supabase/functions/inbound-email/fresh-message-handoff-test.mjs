import assert from "node:assert/strict";
import { finishFreshMessage } from "./fresh-message-handoff.mjs";

let passed = 0;
const check = async (name, test) => { await test(); passed++; console.log(`✓ ${name}`); };

await check("successful attachment handoff and forwarding both finish", async () => {
  const calls = [];
  await finishFreshMessage(
    async () => { calls.push("process"); },
    async () => { calls.push("forward"); },
  );
  assert.deepEqual(calls, ["process", "forward"]);
});

await check("attachment failure still attempts forward and reaches webhook retry", async () => {
  const failure = new Error("processor unavailable");
  let forwarded = false;
  await assert.rejects(
    finishFreshMessage(
      async () => { throw failure; },
      async () => { forwarded = true; },
    ),
    error => error === failure,
  );
  assert.equal(forwarded, true);
});

await check("forward failure is recorded without retrying an imported attachment", async () => {
  const failure = new Error("outbound send failed");
  let recorded;
  await finishFreshMessage(
    async () => {},
    async () => { throw failure; },
    error => { recorded = error; },
  );
  assert.equal(recorded, failure);
});

await check("webhook does not acknowledge before forwarding attempt settles", async () => {
  let finishForward;
  const pending = new Promise(resolve => { finishForward = resolve; });
  let settled = false;
  const handoff = finishFreshMessage(async () => {}, () => pending).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  finishForward();
  await handoff;
  assert.equal(settled, true);
});

console.log(`${passed} fresh-message handoff cases passed`);

/** RPC calls shared by the processing worker and its production backend. */
export function createLeaseBindings(client) {
  let lease = null;
  let lost = false;

  function assertLease() {
    if (!lease || lost) throw new Error("LEASE_LOST: no active processing lease");
    return lease;
  }

  return {
    assertLease,
    loseLease() { lost = true; },
    async claim(attachmentId) {
      const { data, error } = await client.rpc("claim_attachment", {
        p_attachment_id: attachmentId,
      });
      if (error) throw new Error(`attachments.claim: ${error.message}`);
      if (data) { lease = { attachmentId, token: data }; lost = false; }
      return data;
    },
    async renewLease() {
      const { attachmentId, token } = assertLease();
      const { data, error } = await client.rpc("renew_processing_lease", {
        p_attachment_id: attachmentId, p_lease_token: token,
      });
      if (error || data !== true) {
        lost = true;
        throw new Error(`LEASE_LOST: heartbeat rejected (${error?.message ?? "token expired"})`);
      }
      return true;
    },
    async applyPrice(params) {
      const { attachmentId, token } = assertLease();
      const { data, error } = await client.rpc("kerdos_auto_apply_price_quote", {
        ...params, p_lease_token: token, p_attachment_id: attachmentId,
      });
      if (error) throw new Error(`kerdos_auto_apply_price_quote: ${error.message}`);
      if (data === null) {
        lost = true;
        throw new Error("LEASE_LOST: price write rejected by database fence");
      }
      return data;
    },
    async setStatus(attachmentId, status, reason = null, docId = null) {
      const { token } = assertLease();
      if (lease.attachmentId !== attachmentId) throw new Error("LEASE_LOST: attachment mismatch");
      const { data, error } = await client.rpc("set_attachment_status_fenced", {
        p_attachment_id: attachmentId, p_status: status,
        p_error: reason ?? null, p_import_document_id: docId ?? null,
        p_lease_token: token,
      });
      if (error) throw new Error(`attachments.setStatus: ${error.message}`);
      if (data !== true) {
        lost = true;
        throw new Error("LEASE_LOST: status update rejected by database fence");
      }
    },
  };
}

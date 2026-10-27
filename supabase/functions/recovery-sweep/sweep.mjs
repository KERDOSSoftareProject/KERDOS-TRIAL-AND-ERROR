/** Recover expired processing leases and replay pending attachments.
 *
 * The database RPC does the conditional transition under a row lock. Another
 * worker can win between our candidate query and the RPC; false is a safe skip.
 * The process-attachment worker claims pending rows with its own atomic RPC.
 */
export async function sweepAttachments(client, {
  invoke,
  now = new Date(),
  staleAfterMs = 10 * 60 * 1000,
  limit = 10,
} = {}) {
  if (typeof invoke !== "function") throw new Error("recovery sweep requires an invocation function");
  const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();

  const { data: stale, error: listError } = await client.from("inbound_attachments")
    .select("id, organization_id")
    .eq("processing_status", "processing")
    .lt("processing_heartbeat_at", cutoff)
    .limit(limit);
  if (listError) throw new Error(`stale attachment lookup failed: ${listError.message}`);

  const recovered = [];
  for (const att of stale ?? []) {
    const { data, error } = await client.rpc("recover_stale_attachment", {
      p_attachment_id: att.id, p_stale_before: cutoff,
    });
    if (error) throw new Error(`recover_stale_attachment ${att.id}: ${error.message}`);
    if (data === true) recovered.push(att.id);
  }

  // Includes rows whose original inbound-email handoff failed as well as
  // recovered rows. The claim RPC in process-attachment prevents two workers
  // from importing the same pending row concurrently.
  const { data: pending, error: pendingError } = await client.from("inbound_attachments")
    .select("id, organization_id")
    .eq("processing_status", "pending")
    .not("storage_path", "is", null)
    .is("ingest_error", null)
    .limit(limit);
  if (pendingError) throw new Error(`pending attachment lookup failed: ${pendingError.message}`);

  const replayed = [];
  const needsReview = [];
  const deferred = [];
  for (const att of pending ?? []) {
    let data, error;
    try {
      ({ data, error } = await invoke("process-attachment", {
        body: { attachmentId: att.id, organizationId: att.organization_id },
      }));
    } catch (caught) {
      error = caught;
    }
    if (!error && ["auto_imported", "needs_review", "skipped"].includes(data?.outcome)) {
      replayed.push({ id: att.id, outcome: data.outcome });
      continue;
    }
    // Surface a dispatch failure to the Inbox instead of leaving the same
    // pending row to starve every later sweep. Only transition if still pending;
    // never overwrite a worker that acquired a lease in the meantime.
    const reason = `Automatic retry failed: ${error?.message ?? data?.reason ?? "missing outcome"}`;
    const { data: changed, error: statusError } = await client.from("inbound_attachments")
      .update({ processing_status: "needs_review", processing_error: reason })
      .eq("id", att.id).eq("processing_status", "pending").select("id");
    if (statusError) throw new Error(`failed to surface ${att.id}: ${statusError.message}`);
    if (changed?.length) needsReview.push(att.id);
    else deferred.push(att.id); // another worker claimed it; lease recovery owns it
  }
  return { recovered, replayed, needsReview, deferred };
}

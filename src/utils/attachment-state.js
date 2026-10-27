/** Pure decisions shared by the Inbox row and its Node tests. */
export function attachmentStateFlags(att) {
  const alreadyIngested = !!(att?.import_document_id && att.processing_status !== "needs_review");
  const partialReview = !!(att?.import_document_id && att.processing_status === "needs_review");
  return { alreadyIngested, partialReview };
}

/** The partial document is actionable through A1.7's resume path. */
export function attachmentRenderOutcome(att, localStatus = "idle") {
  if (att?.ingest_error) return "failed";
  const { alreadyIngested, partialReview } = attachmentStateFlags(att);
  if (alreadyIngested || localStatus === "ingested") return "imported";
  if (partialReview) return "partial";
  return "button";
}

export function attachmentActionBlocked(att, localStatus = "idle") {
  if (!att) return true;
  const outcome = attachmentRenderOutcome(att, localStatus);
  return outcome === "failed" || outcome === "imported" || localStatus === "loading";
}

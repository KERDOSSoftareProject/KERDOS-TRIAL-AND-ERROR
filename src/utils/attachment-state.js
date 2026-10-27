/** Pure decisions shared by the Inbox row and its Node tests. */
export function attachmentStateFlags(att) {
  const alreadyIngested = !!(att?.import_document_id &&
    (att.processing_status === "auto_imported" || att.processing_status == null));
  // Recovery can reset a linked partial to pending before its next worker claims it.
  const partialReview = !!(att?.import_document_id &&
    (att.processing_status === "needs_review" || att.processing_status === "pending"));
  return { alreadyIngested, partialReview };
}

/** The partial document is actionable through A1.7's resume path. */
export function attachmentRenderOutcome(att, localStatus = "idle") {
  if (att?.ingest_error) return "failed";
  if (localStatus === "ingested") return "imported";
  if (att?.processing_status === "processing") return "processing";
  const { alreadyIngested, partialReview } = attachmentStateFlags(att);
  if (alreadyIngested) return "imported";
  if (partialReview) return "partial";
  return "button";
}

export function attachmentActionBlocked(att, localStatus = "idle") {
  if (!att) return true;
  const outcome = attachmentRenderOutcome(att, localStatus);
  return outcome === "failed" || outcome === "imported" || outcome === "processing" || localStatus === "loading";
}

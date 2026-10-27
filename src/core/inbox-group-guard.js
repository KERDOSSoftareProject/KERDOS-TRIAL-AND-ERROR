/**
 * inbox-group-guard.js
 * ====================
 * A1.7 — Inbox resume multi-group guard.
 *
 * When PasteModal is opened from the inbox with inboxImportDocumentId set, the
 * background worker always produced exactly ONE group from ONE attachment file.
 * inboxImportDocumentId points to that group's import document.  A second group
 * (extra pasted text or a second file dropped in) would attempt to resume the
 * SAME document, colliding with the saved evidence or writing unrelated rows
 * into it.  The guard must fire before any writes.
 *
 * Exported as a pure function so it can be imported and exercised directly by
 * test suites without instantiating the React component.
 *
 * @param {string|null} inboxImportDocumentId  — null means manual import; guard does not fire.
 * @param {Array}       parsedGroups           — same array used by the ImportModal save loop.
 * @returns {{ blocked: boolean, message: string|null }}
 *   blocked=true  → caller must surface message and abort (setLoading(false); return).
 *   blocked=false → proceed normally.
 */
export function checkInboxGroupGuard(inboxImportDocumentId, parsedGroups) {
  if (!inboxImportDocumentId) return { blocked: false, message: null };

  const activeGroups = parsedGroups.filter(g => g.rows.length);
  if (activeGroups.length > 1) {
    return {
      blocked: true,
      message: `Inbox resume requires a single document — ${activeGroups.length} groups were found. Remove the extra file or pasted content and try again.`,
    };
  }

  return { blocked: false, message: null };
}

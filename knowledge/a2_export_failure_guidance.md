# A.2 export failure guidance — companion 0.2.5

The portable runner now maps known adapter outcomes to fixed client guidance.
Account/list mismatch, wrong list page, absent selection, non-CSV format,
concurrent capture, unavailable capture, unsupported encoding, invalid CSV,
changed/unverifiable page and unavailable execution have distinct next steps.
Unknown outcomes retain the generic failure result. The code never echoes raw
adapter messages, exception text or private diagnostics into persisted status.

After preflight reservation the pairing is consumed, even if capture fails.
Every failure explains that no file was sent and requires a newly prepared and
paired transfer. It does not claim the vendor export never began: a list can
change after Download or a Blob can fail validation after the ordinary download.
There is no automatic retry, delivery, import-success claim or retained CSV.

MOXe strict UTF-8 decode failure now returns unsupported_encoding instead of
page_unavailable. There is no lossy replacement decoder, encoding conversion,
Windows-1252 fallback or downstream parser change. The original download is
preserved; the user can retain it for review. Actual supplier encoding support
remains a separate investigation.

Controlled tests cover all mapped failures plus unknown/private/prototype-name
and non-string outcomes, persisted safe status, consumed pairing, no delivery
and no repeat. A malformed-byte Blob exercises the adapter's explicit encoding
rejection and verifies capture hooks are restored. The existing Unicode bytes
and hash checks remain. Native Chromium additionally exercises a wrong account,
zero supplier-export clicks/receipts and result persistence across popup reopen.

App, database, customer data, purchasing/Order Guide layout, permissions and
successful transfer protocol are unchanged. The complete 0.2.5 package includes
core and must be reloaded for installed testing. Synthetic CI is not installed
supplier acceptance, fresh saved-price proof or private original retrieval.

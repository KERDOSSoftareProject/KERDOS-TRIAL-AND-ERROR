# B2 mixed native/scanned PDF — live verification

Environment: kerdos-test only (`gwtnaudjfoxjermhvhpx`). Frontend PR #30 merged as `3b9b76ab3494b5b712ce5f4b34f3a0909761cc4c`; deployment run 83 / 41100621209 succeeded and public asset is `index-BWewDI9X.js`.

On 2026-10-31 at 09:35 Eastern, Dino imported the retained mixed PDF after opening a cache-busting app URL. The two browser screenshots show exact prices and successful saving, with one item requiring attention. Direct database inspection confirmed:

| Evidence | Result |
| --- | --- |
| Vendor | B2 OCR FRESH LOAD — disposable, `dbe1f5f5-4ccd-47d5-9822-d3bce68ea4af` |
| Document | `569977d4-8e36-489b-957f-cba7db0b6d97`, complete, keys `row:0` / `row:1` |
| Native row | `892b1fb2-3f5d-448c-b4dc-cc323736e3dd`: code 730001, 20 LB, CASE, 46.75, available; page 1 transforms retained |
| Scanned row | `828aab01-efbf-44e9-bd67-8860adcbc2ff`: code 730002, 20LB, CASE, 57.85; page 2 OCR boxes/confidences retained |
| OCR uncertainty | Recognized description `Turkey BreastSm oked DeliS tyke` retained honestly; low-confidence issue, reviewRequired=true, price_unavailable=true |
| Usable quote | Native row only: `eeeaf670-db12-4a79-9330-8db9dddf4b3e` at 46.75; no quote for uncertain scanned row |
| Original | `60db42cc-b828-4b5c-b011-6f10d00eed4e`, filename `B2_Mixed_Scanned_Prices_Test (1).pdf`, storage metadata 78828 bytes |

This proves the browser-to-database mixed-PDF path with uncertainty retained; it does not establish universal OCR accuracy, live replay protection for this fresh vendor, or acceptance of the uncertain row. Original storage presence/metadata was inspected; storage bytes were not downloaded and hashed.

The earlier 09:27 test under B2 OCR VERIFY produced a malformed scanned row and remains historical failure evidence. Its unavailable row created no quote. The fresh-load success is consistent with a stale browser tab, but no earlier bundle capture proves that cause conclusively. Neither failed fixture was repaired, deleted or backfilled. Existing CSV/XLSX/native PDF/invoice acceptance remains intact.

## Separate warning display fix

The live screen displayed `[object Object]` because ImportModal joined structured issue objects directly. Format string issues unchanged, and object issues by message, then kind, then a generic review label. The existing actual-OCR rendered scenario now pauses persistence long enough to assert the readable warning and absence of `[object Object]`, then confirms unchanged values, unavailable/review flags and source evidence after saving.

Local validation: 13/13 rendered B1/B2/B3 checks, lint, production build. This warning display change is not deployed and does not change classification, import persistence, purchasing eligibility, approval actions, schema, workers or scheduling. No new real-email test is implied.

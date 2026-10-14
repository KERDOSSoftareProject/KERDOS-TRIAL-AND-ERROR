KERDOS QUOTED PER — October 3, 2026

DEPLOY
1. Run the entire KERDOS_QUOTED_PER_UPDATE.sql file in Supabase SQL Editor. This adds the saved unit-cost display preference and updates the existing atomic row-save function. No test data is cleared. It includes support for the previously added manual KERDOS association.
2. DOUBLE-CLICK this ZIP on your Mac to extract it. Do not upload the ZIP itself.
3. Open the extracted folder. In GitHub, at the repository root where package.json lives, upload the src, knowledge and scripts FOLDERS, package.json, and KERDOS_DATABASE_UPDATE_CLEAN.sql. Commit. Preserve the src/... paths.
4. Wait for green Actions, then refresh with Shift + Command + R.

WHAT CHANGED
Quoted per in Item Catalog: Case / Each / Weight / Volume.
Weight reveals LB, OZ, KG, G. Volume reveals GAL, QT, PT, FL OZ, L, ML.
Source units are recognized automatically. A pending Weight/Volume choice saves even before its metric is resolved; the quote stays out of comparison until it can convert correctly.
Unit cost: calculated automatically from quotation and physical pack. Restaurant defaults: pounds for weight, gallons for volume, each for counts. The pack's physical dimension governs conversion; a category name cannot supply missing weights or liquid density.
Manual Unit cost dropdown: compatible units plus Each. Changes preview immediately; Apply changes persists the preference through reload and future price updates. Auto removes the override. The vendor's quoted amount and quoted basis remain separate.
Other industries retain nonfood unit support. Existing unusual source units remain inspectable.

PREVIOUS CHANGES INCLUDED
Case/Each Pack with Each count 1; fresh-only Produce; short restaurant unit menus; editable KERDOS associations. This package includes the prior cleanup because the latest verified GitHub commit contained the ZIP rather than the extracted source files.

CHECK
A case containing 4 bags of 5 LB, quoted $40 per Case, gives $2/LB. Selecting OZ gives $0.125/OZ. Selecting Each gives $10 per bag. Select Weight then LB for a $2/LB quotation: the full case calculates to $40 in the background.
Pack and quote uncertainty remain visible; no invented weight-to-volume conversions.
All existing tests, added conversion/partial-save/persistence checks, lint and production build passed. Live upload and Supabase execution are for you to perform.

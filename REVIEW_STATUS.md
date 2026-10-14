# KERDOS automatic import build

See `WORKFLOW_2026_09_25.md` for the agreed behavior, changes, retained features, verification, and deployment boundary.

The current build includes both the saved Item Catalog row editor and its database save operation, not only an import preview. It separates new-item discovery from item-number-based updates and adds oversight against the last accepted source. All defining product fields must agree before vendor listings compete under one KERDOS identity.

The full source includes previous database migrations and adds migration 011 for document deletion. Run that migration before uploading the app; it installs functions and does not clear data. No live database changes, data clearing, repository upload or deployment were performed from this workspace. File selection now starts parsing and opens review without another Parse click; the exact production file that previously failed was unavailable for reproduction.

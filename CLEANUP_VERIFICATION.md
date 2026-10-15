# KERDOS cleanup verification

This package is the consolidated KERDOS application. Do not combine its source files with older numbered builds.

## Final verification

- Clean dependency installation completed with `npm ci`.
- All 78 procurement regression tests passed.
- All 19 ingestion tests passed.
- Ordering, catalog, category, organization, vendor, import, session, backend, offline, and deployment tests passed.
- Production build completed successfully.
- `npm audit --omit=dev` reported zero vulnerabilities.
- The combined database update was regenerated from migrations 003–007.
- UI code contains no direct Supabase queries; Supabase is isolated in `src/backend/supabase.js`.
- The obsolete `src/data.js` compatibility bridge was removed.
- No double-click document handlers remain.

## Deployment

1. Extract the complete ZIP as one project.
2. Run `npm ci`.
3. Configure the environment variables documented in `.env.example`.
4. Review and back up the database before applying `KERDOS_DATABASE_UPDATE_CLEAN.sql`.
5. Run `npm test` and `npm run build`.
6. Run `npm run dev` for development, or deploy the generated `dist` directory.

The large PDF worker emitted during the production build is intentional: PDF parsing and scanned-document OCR run locally instead of sending client documents to an external parsing service.

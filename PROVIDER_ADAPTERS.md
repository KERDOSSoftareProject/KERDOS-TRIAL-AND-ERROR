# KERDOS provider boundary

KERDOS currently runs on GitHub Pages and Supabase. Neither is a business-rule dependency.

## Backend

`src/backend/contract.js` defines the capabilities an adapter must implement:
`session`, `workspace`, `documents`, `realtime`, `pricing`, `invoices`, `team`, and `records`.
`src/backend/supabase.js` is the current implementation. KERDOS services call
`backend.records.query(...)`, implemented in `src/backend/records.js`. This
builder passes a plain operation description to the adapter; it never returns
or exposes a Supabase query object to a service.

A new adapter must provide all capabilities, preserve the result shape of
record operations (`{data,error}`), and implement the database functions
needed by `pricing`, `invoices`, and `team`. It must also provide auth, storage,
and organization-scoped data access. Test it against the contract and service
suite before selection. Replacing a backend requires a data migration and a
security review of access policies; changing the configuration alone does not
migrate data.

A deployment can register a complete adapter as
`globalThis.__KERDOS_CONFIG__.backendAdapter` **before** loading the application.
The adapter is validated by `assertBackendContract`. If no adapter is supplied,
Supabase is selected using `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
External adapters must implement the contract; a provider name alone cannot
connect to an unknown service.

## Hosting

`vite.config.js` takes `VITE_BASE_PATH`; `/` works for a custom domain, and a
repository subpath works for GitHub Pages. `.github/workflows/deploy-pages.yml`
is only the current host's build and upload procedure. Another host should run
`npm ci`, `npm test`, and `npm run build`, set its base path and backend
configuration, then serve `dist/` as static files.

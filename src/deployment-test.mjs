import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const requiredMigrations=[
  "migration_003_vocabulary.sql","migration_004_context_and_price_lifecycle.sql",
  "migration_005_atomic_price_import.sql","migration_006_atomic_invites.sql",
  "migration_007_atomic_invoices.sql","migration_009_price_basis.sql",
  "migration_010_catalog_rows.sql",
  "migration_011_document_deletion.sql",
  "migration_012_vendor_nvim.sql","migration_013_invoice_mapping.sql",
  "migration_014_item_name.sql","migration_015_recoverable_imports.sql","migration_021_comparison_preferences.sql","migration_022_associate_alternatives.sql","migration_023_automatic_alternatives.sql","migration_024_atomic_orders.sql",
];
for(const file of requiredMigrations) assert.ok(fs.statSync(path.join(root,"knowledge",file)).size>100,`${file} missing or empty`);

const adapter=fs.readFileSync(path.join(root,"src/backend/supabase.js"),"utf8");
const app=fs.readFileSync(path.join(root,"src/App.jsx"),"utf8");
const pageSources=fs.readdirSync(path.join(root,"src/pages")).filter(file=>file.endsWith(".jsx"))
  .map(file=>fs.readFileSync(path.join(root,"src/pages",file),"utf8")).join("\n");
const migrationSql=requiredMigrations.map(file=>fs.readFileSync(path.join(root,"knowledge",file),"utf8")).join("\n");
for(const rpc of [...adapter.matchAll(/client\.rpc\("([^"]+)"/g)].map(match=>match[1]))
  assert.match(migrationSql,new RegExp(`function\\s+(?:public\\.)?${rpc}\\b`,`i`),`adapter RPC ${rpc} has no migration`);

// A price-sheet import must never wait on a person: the auto-save may hold
// only for a document that is not a price sheet, or for invoices. Rows with
// issues are saved with the issues attached for Item Catalog.
const importModal=fs.readFileSync(path.join(root,"src/pages/ImportModal.jsx"),"utf8");
assert.match(importModal,/if\(mode==="invoice"&&\(missingInvoiceDates\.length\|\|needsReview\.length\)\) return;/,"price-sheet auto-save must not be gated on row issues");
assert.ok(!/if\(unsafeDocuments\.length\|\|missingInvoiceDates\.length\|\|needsReview\.length\) return;/.test(importModal),"old price-sheet review gate must be gone");
const importPriceRowSrc=fs.readFileSync(path.join(root,"src/core/import-price-row.js"),"utf8");
assert.match(importPriceRowSrc,/preparePriceImport\(row,\s*ex,\s*priorMapping,\s*rowNeedsReview\s*\?\s*rowIssues\s*:\s*\[\],\s*invoiceSources,\s*\{organizationId:\s*orgId,\s*vendorId\}\)/,"document issues and scoped invoice evidence must reach the row review decision");
assert.match(importPriceRowSrc,/reviewRequired:\s*needsBasis\s*\|\|\s*!!row\.requiresReview,\s*reviewFields:\s*prepared\.reviewFields,\s*conflicts:\s*prepared\.reasons/,"row issues and identity/pack warnings must be saved for new catalog rows");
assert.match(importPriceRowSrc,/reviewRequired:\s*true,\s*reviewFields:\s*prepared\.reviewFields,\s*changes:\s*row\.changes\s*\|\|\s*\[\],\s*conflicts:\s*prepared\.reasons/,"repeat row warnings must be saved without replacing the accepted quote");

// Every adapter parameter of the quote RPC must exist in the migrated function signature.
for(const param of [...adapter.matchAll(/\bp_[a-z_]+(?=:)/g)].map(m=>m[0]))
  assert.match(migrationSql,new RegExp(`\\b${param}\\b`),`adapter passes ${param} but no migration declares it`);

assert.match(migrationSql,/security\s+definer[\s\S]*set\s+search_path\s*=\s*pg_catalog[\s\S]*update\s+public\.invite_codes/i,
  "invite acceptance must bypass member-only RLS with a restricted search path");
for(const guard of [
  "KERDOS base schema is missing required columns",
  "Owner or manager access is required for this organization",
  "Vendor is outside the requested organization",
  "Invoice vendor item is outside the requested organization/vendor",
  "Catalog item is outside the requested organization",
]) assert.ok(migrationSql.includes(guard),`database safety guard missing: ${guard}`);

const combined=fs.readFileSync(path.join(root,"KERDOS_DATABASE_UPDATE_CLEAN.sql"),"utf8");
assert.match(combined,/^begin;$/m,"combined database update lacks transaction start");
assert.match(combined,/^commit;$/m,"combined database update lacks transaction commit");
for(const file of requiredMigrations.filter(name=>!name.startsWith("migration_021")&&!name.startsWith("migration_022")&&!name.startsWith("migration_023")))
  assert.ok(combined.includes(fs.readFileSync(path.join(root,"knowledge",file),"utf8").trim()),`${file} differs from combined database update`);

for(const requiredUi of [
  "Price Sheet History","Import Price Sheet","Invoice History","Import Invoice",
  "Click to open","Remove current prices from Order Guide","Remove price from Order Guide",
  "price_refresh_mode===\"automatic\"?\"automatic\":\"manual\"",
]) assert.ok((app+pageSources).includes(requiredUi),`requested import/history behavior missing: ${requiredUi}`);
assert.match(app,/from "\.\/pages\/DocumentPages\.jsx"/,"document workflows were not extracted from App.jsx");
assert.ok(!app.includes("{/* INVOICES TAB */}"),"legacy inline invoice page remains in App.jsx");
assert.ok(app.split("\n").length<2500,"App.jsx grew past the modularity guardrail");

const ocrFiles=["worker.min.js","eng.traineddata.gz"];
for(const file of ocrFiles) assert.ok(fs.statSync(path.join(root,"public/ocr",file)).size>1000,`OCR asset ${file} missing`);
const coreFiles=new Set(fs.readdirSync(path.join(root,"public/ocr/core")));
for(const file of [
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
]) assert.ok(coreFiles.has(file),`OCR core ${file} missing`);

const envExample=fs.readFileSync(path.join(root,".env.example"),"utf8");
for(const key of ["VITE_KERDOS_BACKEND","VITE_SUPABASE_URL","VITE_SUPABASE_ANON_KEY","VITE_BASE_PATH"])
  assert.match(envExample,new RegExp(`^${key}=`,`m`),`.env.example lacks ${key}`);
assert.ok(fs.existsSync(path.join(root,"vite.config.js")),"Vite deployment configuration missing");
assert.ok(fs.existsSync(path.join(root,".github/workflows/deploy-pages.yml")),"GitHub Pages adapter missing");

console.log("KERDOS deployment assets and migration wiring passed");

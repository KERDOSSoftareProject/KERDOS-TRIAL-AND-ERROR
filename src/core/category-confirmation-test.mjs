/**
 * Regression tests for category confirmation sentinel and repeated-token matching.
 *
 * Four cases covered:
 *  1. Repeated-token keyword matching: one description token satisfies at most
 *     one keyword token — "HALF DEEP PAN" does not match "half and half".
 *  2. Engine "review" + no sentinel → catAcc=70, category gate blocks.
 *  3. category_reason:"confirmed" (from confirmCategory) → catAcc ≥90, gate clears.
 *  4. Confirmed sentinel survives reimport: importPriceRow called again after
 *     confirmCategory — sentinel not erased, catAcc stays ≥90.
 *
 * The confirm/manual-selection → save → reimport → reload paths that exercise
 * importPriceRow and the live backend are covered more thoroughly in
 * src/core/import-to-order-guide-test.mjs (TEST 28).  This file adds focused
 * assertions that run independently of that suite's setup.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {classifyCategory, suggestCategory, configureProcurement} from "../procurement.js";
import {orderGuideAssessment, catalogRowEvidence} from "./catalog-fields.js";
import {createCatalogService} from "../services/catalog.js";
import {createCategoryService} from "../services/categories.js";
import {importPriceRow} from "./import-price-row.js";
import {createImportService} from "../services/imports.js";
import {assertBackendContract} from "../backend/contract.js";
import {createRecords} from "../backend/records.js";

// ── In-memory backend (same shape as import-to-order-guide-test.mjs) ──────────
function createBackend() {
  const data = new Map();
  let nextId = 1;
  const rows = name => { if (!data.has(name)) data.set(name, []); return data.get(name); };
  const execute = async spec => {
    const matches = row => spec.filters.every(({operator,column,value}) => {
      const v = row[column];
      if (operator === "eq") return v === value;
      if (operator === "in") return value.includes(v);
      if (operator === "ilike") return String(v||"").toLowerCase() === String(value).toLowerCase();
      if (operator === "lte") return v <= value;
      throw new Error(`Unsupported filter: ${operator}`);
    });
    let result;
    if (spec.action === "insert" || spec.action === "upsert") {
      const values = Array.isArray(spec.value) ? spec.value : [spec.value];
      result = values.map(v => v.id ? {...v} : {id:`m${nextId++}`, ...v});
      rows(spec.table).push(...result);
    } else if (spec.action === "select") {
      result = rows(spec.table).filter(matches);
    } else if (spec.action === "update") {
      result = rows(spec.table).filter(matches);
      result.forEach(r => Object.assign(r, spec.value));
    } else if (spec.action === "delete") {
      result = rows(spec.table).filter(matches);
      data.set(spec.table, rows(spec.table).filter(r => !matches(r)));
    } else throw new Error(`Unsupported action: ${spec.action}`);
    if (spec.orders?.length) result = [...result].sort((a,b) => {
      for (const {column,options} of spec.orders) {
        const o = (a[column]>b[column])-(a[column]<b[column]);
        if (o) return options?.ascending === false ? -o : o;
      }
      return 0;
    });
    if (spec.limit !== undefined) result = result.slice(0, spec.limit);
    if (spec.cardinality === "single") return {data:result[0]||null, error:result.length===1?null:new Error("Expected one record")};
    if (spec.cardinality === "maybeSingle") return {data:result[0]||null, error:result.length>1?new Error("Expected at most one record"):null};
    return {data:result, error:null};
  };
  const fn = async () => null;
  const applyQuote = async quote => {
    const existing = rows("vendor_items").find(r =>
      r.organization_id === quote.organizationId &&
      r.vendor_id === quote.vendorId &&
      r.vendor_item_code === quote.vendorItemCode);
    const fields = {
      organization_id:quote.organizationId, vendor_id:quote.vendorId,
      vendor_item_code:quote.vendorItemCode||null, description:quote.description,
      brand:quote.brand||null, pack_size:quote.packSize||null,
      selling_unit:quote.sellingUnit||null, price:quote.price??null,
      price_unavailable:!!quote.priceUnavailable, price_source:quote.sourceDocumentId?"pricelist":"quote",
      price_basis:quote.priceBasis||null, import_row:quote.importRow||null,
      field_resolutions:quote.fieldResolutions||null,
      gtin:quote.gtin||null, manufacturer_code:quote.manufacturerCode||null,
    };
    if (existing) { Object.assign(existing, fields); return existing.id; }
    const row = {id:`vi${nextId++}`, ...fields, last_updated:new Date().toISOString()};
    rows("vendor_items").push(row);
    return row.id;
  };
  const provider = assertBackendContract({
    kind:"in-memory-test",
    session:{get:fn,subscribe:()=>()=>{},signIn:fn,signUp:fn,signOut:fn},
    workspace:{memberships:fn,snapshot:fn},
    documents:{upload:fn,signedUrl:fn,remove:fn,deletePriceSheet:fn,deleteInvoiceRecord:fn},
    realtime:{subscribeToOrganization:()=>()=>{}},
    pricing:{applyQuote},
    catalog:{saveRow:fn},
    invoices:{record:fn},
    team:{acceptInvite:fn},
    records:createRecords(execute),
  });
  return {
    provider,
    importService: createImportService(provider),
    catalogService: createCatalogService(provider),
    categoryService: createCategoryService(provider),
    rows,
  };
}

const ORG = "org-cat-test";
const VENDOR = "v-cat-test";
const GROUP = {name:"cat-test.txt", quoteValidUntil:null};

// ── Restaurant dictionary (for "review" confidence on CHUNKY BLUE CHS) ────────
const here = path.dirname(fileURLToPath(import.meta.url));
const dictPath = path.resolve(here, "../../knowledge/restaurant_food_dictionary_v1.sql");
const sql = fs.readFileSync(dictPath, "utf8");
const dictRows = [...sql.matchAll(/\('Restaurant','([^']+)','(\[.*?\])'::jsonb,\d+\)/g)];
const DICT_CATS = dictRows.map((r, i) => ({
  id: `dc-${r[1].toLowerCase().replace(/\s+/g,"-")}`,
  name: r[1], keywords: JSON.parse(r[2]),
  is_holding_pen: false, range_start: (i+1)*10000, range_end: (i+1)*10000+9999,
}));
const DAIRY_DICT = DICT_CATS.find(c => c.name === "Dairy");
assert.ok(DAIRY_DICT, "Dairy must be in dictionary");

// Simple two-category set for repeated-token tests (no restaurant profiles)
const SIMPLE_CATS = [
  {id:"sc-dairy", name:"Dairy", keywords:["half and half","milk","cream","butter","cheese","eggs"], is_holding_pen:false, range_start:10000, range_end:19999},
  {id:"sc-general", name:"General", keywords:["pan","deep pan","sheet pan","cookware"], is_holding_pen:false, range_start:20000, range_end:29999},
];

let passed = 0, failed = 0;
const ok = (label, value, detail="") => {
  if (value) { passed++; console.log(`PASS  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}${detail?" — "+detail:""}`); }
};
const t = (label, got, exp) => {
  const ok2 = JSON.stringify(got) === JSON.stringify(exp);
  if (ok2) { passed++; console.log(`PASS  ${label}`); }
  else { failed++; console.log(`FAIL  ${label} — got=${JSON.stringify(got)} exp=${JSON.stringify(exp)}`); }
};

// ── 1. Repeated-token keyword matching ────────────────────────────────────────
console.log("\n-- [1] Repeated-token keyword matching --");
configureProcurement({industry:null});

{
  const r = classifyCategory("HALF DEEP PAN", SIMPLE_CATS);
  ok('"HALF DEEP PAN" does not match Dairy (no false repeated-token match)',
    r?.id !== "sc-dairy", `classified as: ${r?.name ?? "UNCATEGORIZED"}`);
}
{
  const r = classifyCategory("HALF AND HALF", SIMPLE_CATS);
  t('"HALF AND HALF" correctly matches Dairy', r?.id, "sc-dairy");
}
{
  const r = classifyCategory("HALF AND HALF CREAM", SIMPLE_CATS);
  t('"HALF AND HALF CREAM" correctly matches Dairy (extra token)', r?.id, "sc-dairy");
}
{
  const r = suggestCategory("HALF DEEP PAN", SIMPLE_CATS);
  ok('suggestCategory "HALF DEEP PAN" does not confidently place in Dairy',
    !(r?.confidence === "confident" && r?.category?.id === "sc-dairy"),
    `confidence=${r?.confidence}, cat=${r?.category?.name ?? "none"}`);
}

// ── 2. Engine "review" + no sentinel → catAcc=70 ─────────────────────────────
console.log("\n-- [2] Engine review + no sentinel → catAcc=70 --");
configureProcurement({industry:"Restaurant"});

{
  // Verify test precondition: engine must return "review" for CHUNKY BLUE CHS
  const engineResult = suggestCategory("CHUNKY BLUE CHS", DICT_CATS);
  t('precondition: engine returns confidence:"review" for CHUNKY BLUE CHS',
    engineResult?.confidence, "review");

  const item = {id:"ci1", category_id:DAIRY_DICT.id, master_item_number:30001,
    name:"Chunky Blue Cheese Dressing", category_review:false, category_reason:null};
  const vi = {id:"vi1", organization_id:ORG, vendor_id:VENDOR, vendor_item_code:"001",
    description:"CHUNKY BLUE CHS", pack_size:"1 GAL", selling_unit:"GAL", price:5,
    category_review:false, category_reason:null, import_row:null, field_resolutions:{}};
  const ev = catalogRowEvidence({item, vendorItem:vi, mapping:null,
    vendor:{id:VENDOR,name:"Vendor"}, category:DAIRY_DICT, peers:[], categories:DICT_CATS});
  t('no sentinel + engine review → catAcc=70', ev.category.accuracy, 70);
}

// ── 3. confirmed sentinel → catAcc ≥90 (gate clears) ─────────────────────────
console.log("\n-- [3] Confirmed sentinel → catAcc ≥90 --");

{
  const item = {id:"ci1", category_id:DAIRY_DICT.id, master_item_number:30001,
    name:"Chunky Blue Cheese Dressing", category_review:false, category_reason:"confirmed"};
  const vi = {id:"vi1", organization_id:ORG, vendor_id:VENDOR, vendor_item_code:"001",
    description:"CHUNKY BLUE CHS", pack_size:"1 GAL", selling_unit:"GAL", price:5,
    category_review:false, category_reason:"confirmed", import_row:null, field_resolutions:{}};
  const ev = catalogRowEvidence({item, vendorItem:vi, mapping:null,
    vendor:{id:VENDOR,name:"Vendor"}, category:DAIRY_DICT, peers:[], categories:DICT_CATS});
  ok('"confirmed" sentinel keeps catAcc ≥90 (engine review blocked)',
    (ev.category.accuracy ?? 0) >= 90, `catAcc=${ev.category.accuracy}`);
}

// ── 4. Reimport after confirmCategory: sentinel survives importPriceRow ───────
console.log("\n-- [4] Confirmed sentinel survives importPriceRow (save → confirm → reimport → reload) --");

{
  const {provider, importService, catalogService} = createBackend();

  // Seed the dairy category so the engine can place the item
  const dairyCat = {id:"cat-dairy", name:"Dairy", is_holding_pen:false,
    range_start:3000, range_end:3999, keywords:["milk","cream","butter","cheese","yogurt","dairy"]};
  await provider.records.query("catalog_categories").insert(dairyCat).then(()=>{});

  const workingCatalogItems = [], workingCategories = [dairyCat],
    workingVendorItems = [], workingMappings = [];

  const sourceRow = {
    code:"blue-cat-test", description:"CHUNKY BLUE CHS KENS KEN",
    packSize:"4/5 LB", price:12.50, sellingUnit:"LB",
    sellingUnitSource:"price header", priceBasis:"measure",
  };

  // First import: placeInCategory writes category_review=true (engine returns "review")
  const result1 = await importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow, row:{...sourceRow}, ex:null, priorMapping:null,
    rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:ORG, vendorId:VENDOR,
    sourceDocumentId:"doc-cat-1", completedKey:"row:0", importBatchTime:"2026-10-08",
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });
  ok("first import: vendorItemId returned", !!result1.vendorItemId);

  const vi1 = await importService.findVendorItem({organizationId:ORG, vendorId:VENDOR, code:sourceRow.code});
  const map1 = await importService.mapping(ORG, result1.vendorItemId);
  const {data:ci1} = await provider.records.query("catalog_items").select().eq("id", map1?.catalog_item_id).maybeSingle();
  ok("first import: catalog item created", !!ci1);
  t("first import: category_review=true (engine returned review)", ci1?.category_review, true);

  // Client confirms the category: writes category_review=false, category_reason:"confirmed"
  await catalogService.confirmCategory(ci1.id);
  const {data:ciAfterConfirm} = await provider.records.query("catalog_items").select().eq("id", ci1.id).maybeSingle();
  t("confirmCategory: category_review=false (DB write verified by reload)", ciAfterConfirm?.category_review, false);
  t('confirmCategory: category_reason="confirmed" (sentinel written)', ciAfterConfirm?.category_reason, "confirmed");

  // Reimport: same row, new price — exercises the existing-item UPDATE path
  const result2 = await importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow:{...sourceRow, price:13.00}, row:{...sourceRow, price:13.00},
    ex:vi1, priorMapping:map1,
    rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:ORG, vendorId:VENDOR,
    sourceDocumentId:"doc-cat-2", completedKey:"row:reimport", importBatchTime:"2026-10-08",
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });
  ok("reimport: succeeded", !!result2.vendorItemId);
  t("reimport: same vendorItemId (UPDATE path, not CREATE)", result2.vendorItemId, result1.vendorItemId);

  // Reload catalog item and vendor item from backend after reimport
  const {data:ciAfterReimp} = await provider.records.query("catalog_items").select().eq("id", ci1.id).maybeSingle();
  const vi2 = await importService.findVendorItem({organizationId:ORG, vendorId:VENDOR, code:sourceRow.code});
  t('reimport: sentinel survives — category_reason still "confirmed"', ciAfterReimp?.category_reason, "confirmed");
  t("reimport: sentinel survives — category_review still false", ciAfterReimp?.category_review, false);

  // catalogRowEvidence with reloaded records: catAcc must be ≥90
  const {data:catRows} = await provider.records.query("catalog_categories").select().then(r=>r);
  const catForEvidence = catRows?.find(c => c.id === ciAfterReimp?.category_id) || dairyCat;
  const ev = catalogRowEvidence({
    item:ciAfterReimp, vendorItem:vi2, mapping:map1,
    vendor:{id:VENDOR, name:"Vendor"}, category:catForEvidence,
    peers:[], categories:catRows || [dairyCat],
  });
  ok('reimport: catAcc ≥90 (sentinel not erased by importPriceRow)',
    (ev.category.accuracy ?? 0) >= 90, `catAcc=${ev.category.accuracy}`);

  // orderGuideAssessment: category blocker must not fire
  const assess = orderGuideAssessment({
    item:ciAfterReimp, vendorItem:vi2, mapping:map1,
    vendor:{id:VENDOR, name:"Vendor"}, category:catForEvidence,
    peers:[], categories:catRows || [dairyCat], settings:{}, now:new Date(),
  });
  ok("reimport: category gate does not block (sentinel preserved through reimport)",
    !assess.blockers.includes("category"),
    `blockers: ${JSON.stringify(assess.blockers)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Core per-row save sequence for price-sheet import.
// Pure orchestration: no React, no backend SDK, no UI state.
// Services are injected so the same logic runs in tests (in-memory backend)
// and in production (Supabase backend) without any conditional branching.
//
// ImportModal calls importPriceRow() for each row.
// import-to-order-guide-test calls it with createInMemoryBackend() services.
//
// Contract:
//   applyQuote returns a vendor-item ID (scalar string) — same as the
//   kerdos_apply_price_quote RPC. The in-memory provider must match this.
//
// Returns:
//   {vendorItemId, needsBasis, match, savedMapping}
//     vendorItemId — the saved or pre-existing vendor item id
//     needsBasis   — true when the row was held for review (no applyQuote call)
//     match        — result from catalogService.matchOrCreate, or null
//     savedMapping — result from importService.createMapping, or null
//
// Throws on unrecoverable errors; the caller (ImportModal) catches and
// counts failed rows.

import {preparePriceImport} from './price-import-review.js';
import {importResolutions} from './catalog-fields.js';
import {engineVerifiable} from '../services/catalog.js';

/**
 * @param {object} p
 * @param {object} p.backend          - KERDOS backend (pricing.applyQuote)
 * @param {object} p.importService    - createImportService(backend)
 * @param {object} p.catalogService   - createCatalogService(backend)
 * @param {object} p.sourceRow        - the raw parsed row from the sheet
 * @param {object} p.row              - the row after enrichFromInvoices
 * @param {object|null} p.ex          - existing vendor_items record, or null
 * @param {object|null} p.priorMapping - existing item_mappings record, or null
 * @param {string[]} p.rowIssues      - per-row review reasons
 * @param {boolean} p.rowNeedsReview  - true when issues are unaccepted
 * @param {string[]} p.invoiceSources - invoice rows for inference
 * @param {string} p.orgId
 * @param {string} p.vendorId
 * @param {string} p.sourceDocumentId
 * @param {string} p.completedKey
 * @param {string} p.importBatchTime  - ISO date string
 * @param {object} p.group            - {name, quoteValidUntil}
 * @param {string|null} p.sourceFilePath
 * @param {object[]} p.workingCatalogItems  - mutated in place
 * @param {object[]} p.workingCategories
 * @param {object[]} p.workingVendorItems   - mutated in place
 * @param {object[]} p.workingMappings      - mutated in place
 * @param {Function|null} p.applySelectedCategory - async (catalogItemId, categoryId) => void
 */
export async function importPriceRow({
  backend, importService, catalogService,
  sourceRow, row, ex, priorMapping, rowIssues, rowNeedsReview, invoiceSources,
  orgId, vendorId, sourceDocumentId, completedKey, importBatchTime, group, sourceFilePath,
  workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
  applySelectedCategory,
}) {
  if (!rowNeedsReview && !row.priceUnavailable && (!Number.isFinite(Number(row.price)) || Number(row.price) <= 0))
    throw new Error('No confirmed positive unit price');

  const prepared = preparePriceImport(row, ex, priorMapping, rowNeedsReview ? rowIssues : [], invoiceSources, {organizationId: orgId, vendorId});
  row = prepared.row;
  const resolved = prepared.resolved;
  const needsBasis = prepared.requiresReview;
  const basis = resolved?.basis || null;

  // An unresolvable incoming price must not retire a previously confirmed quote.
  // When needsBasis and the item already exists, skip applyQuote entirely and
  // preserve the existing vendor-item id.
  let vendorItemId;
  if (needsBasis && ex) {
    vendorItemId = ex.id;
    // Still write the import_row so Item Catalog shows what needs resolving.
    const {error} = await backend.records.query('vendor_items')
      .update({import_row: {
        row: {...sourceRow, ...(sourceRow.originalFields||{})},
        evidence: row,
        rowKey: completedKey,
        baseline: ex.import_row?.baseline || ex.import_row?.row || {
          description: ex.description, brand: ex.brand, packSize: ex.pack_size,
          sellingUnit: ex.selling_unit, gtin: ex.gtin, manufacturerCode: ex.manufacturer_code,
        },
        sourceDocumentId, sourceFileName: group.name,
        reviewRequired: true,
        reviewFields: prepared.reviewFields,
        changes: row.changes || [],
        conflicts: prepared.reasons,
      }})
      .eq('id', ex.id)
      .eq('organization_id', orgId);
    if (error) throw new Error(`Could not save the incoming quote for review: ${error.message}`);
  } else {
    vendorItemId = await backend.pricing.applyQuote({
      vendorItemId: ex?.id || null, organizationId: orgId, vendorId,
      vendorItemCode: row.code,
      description: row.description,
      sellingUnit: resolved?.sellingUnit || null,
      priceBasis: basis?.basis || null,
      brand: row.brand || null,
      gtin: row.gtin || null,
      manufacturerCode: row.manufacturerCode || null,
      packSize: row.packSize || ex?.pack_size || null,
      price: row.price,
      priceUnavailable: !!row.priceUnavailable || needsBasis,
      effectiveDate: importBatchTime,
      quoteValidUntil: group.quoteValidUntil || null,
      sourceFilePath: sourceFilePath || null,
      sourceFileName: group.name,
      sourceLine: row.sourceLine || null,
      sourceDocumentId,
      importRow: {
        row: {...sourceRow, ...(sourceRow.originalFields||{})},
        evidence: row,
        rowKey: completedKey,
        baseline: ex?.import_row?.baseline || ex?.import_row?.row || {...sourceRow, ...(sourceRow.originalFields||{})},
        sourceDocumentId,
        sourceFileName: group.name,
        reviewRequired: needsBasis || !!row.requiresReview,
        reviewFields: prepared.reviewFields,
        conflicts: prepared.reasons,
        changes: row.changes || [],
      },
      fieldResolutions: importResolutions(sourceRow, ex || {}),
    });
  }

  // Whether new or updated, link to a catalog item.
  let match = null;
  let savedMapping = null;
  if (vendorItemId) {
    const existingMapping = priorMapping || await importService.mapping(orgId, vendorItemId);
    if (!existingMapping) {
      const identity = needsBasis && ex
        ? {description: ex.description, packSize: ex.pack_size, brand: ex.brand, gtin: ex.gtin, manufacturerCode: ex.manufacturer_code}
        : row;
      match = await catalogService.matchOrCreate({
        organizationId: orgId, vendorId,
        description: identity.description,
        packSize: identity.packSize,
        brand: identity.brand,
        gtin: identity.gtin || null,
        manufacturerCode: identity.manufacturerCode || null,
        categoryId: row.categoryId || null,
        catalogItems: workingCatalogItems,
        categories: workingCategories,
        vendorItems: workingVendorItems,
        mappings: workingMappings,
      });
      if (match) {
        savedMapping = await importService.createMapping({
          organization_id: orgId,
          catalog_item_id: match.catalogItemId,
          vendor_item_id: vendorItemId,
          confidence_score: Math.round((match.score ?? 0) * 100),
          match_method: 'rule_based',
          comparison_track: match.track,
        });
        workingVendorItems.push({id: vendorItemId, vendor_id: vendorId, description: identity.description,
          pack_size: identity.packSize || null, brand: identity.brand || null,
          gtin: identity.gtin || null, manufacturer_code: identity.manufacturerCode || null});
        workingMappings.push({id: savedMapping.id, catalog_item_id: match.catalogItemId,
          vendor_item_id: vendorItemId, comparison_track: match.track,
          confidence_score: Math.round((match.score ?? 0) * 100)});
        if (applySelectedCategory && row.categoryId)
          await applySelectedCategory(match.catalogItemId, row.categoryId);
        // Promote to exact when a second vendor confirms identity and pack.
        if (match.track === 'exact') {
          const verified = engineVerifiable({mappings: workingMappings, vendorItems: workingVendorItems, catalogItems: workingCatalogItems})
            .filter(entry => entry.catalogItemId === match.catalogItemId);
          if (verified.length) {
            try {
              await catalogService.confirmMappings(verified);
              const ids = new Set(verified.map(entry => entry.mappingId));
              for (const m of workingMappings) if (ids.has(m.id)) { m.comparison_track = 'exact'; m.confidence_score = 100; }
            } catch {
              // Verification failure is non-fatal; the mapping stays at review.
            }
          }
        }
      }
    } else if (applySelectedCategory && row.categoryId) {
      await applySelectedCategory(existingMapping.catalog_item_id, row.categoryId);
    }
  }

  if (!vendorItemId || !await importService.mapping(orgId, vendorItemId))
    throw new Error('The price was saved, but its catalog link is incomplete. This row can be resumed.');

  return {vendorItemId, needsBasis, match, savedMapping};
}

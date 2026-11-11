// Isolated database. No hosted documents, accounts, or price rows.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {priceQuoteFixture} from './fixtures/price-quote-db.mjs';
import {preparePriceImport} from '../src/core/price-import-review.js';
import {workspaceProcurement} from '../src/core/source-review-recheck.js';

const db = new PGlite();
try {
  const f = await priceQuoteFixture(db);
  await db.exec(`
    create role service_role;
    create table organizations(id uuid primary key, industry text, settings jsonb);
    create table org_vocabulary(
      id uuid primary key, organization_id uuid references organizations(id), kind text, term text, canonical text
    );
    create table item_mappings(id uuid primary key, organization_id uuid, vendor_item_id uuid, catalog_item_id uuid);
    alter table import_documents add column document_kind text default 'pricelist';
    alter table import_documents add column fingerprint text;
    alter table import_documents add column file_name text default 'Same sheet.csv';
    alter table import_documents add column status text default 'complete';
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261111024722_document_quoted_unit_review.sql', import.meta.url), 'utf8'));

  const otherOrg = randomUUID();
  const otherVendor = randomUUID();
  await db.query("insert into organizations values($1,'construction','{}'),($2,'construction','{}')", [f.org, otherOrg]);
  await db.query("insert into organization_members values($1,$2,'owner')", [otherOrg, f.outsider]);
  await db.query('insert into vendors values($1,$2)', [otherVendor, otherOrg]);
  const document = await f.document();
  const secondDocument = await f.document();
  await db.query("update import_documents set fingerprint='scope-fingerprint' where id=any($1::uuid[])", [[document, secondDocument]]);
  const foreignDocument = (await db.query(
    "insert into import_documents(organization_id,vendor_id,fingerprint) values($1,$2,'scope-fingerprint') returning id",
    [otherOrg, otherVendor]
  )).rows[0].id;

  async function seedListing(organization, vendor, documentId, rowKey) {
    const id = randomUUID();
    const source = {
      sourceDocumentId: documentId,
      rowKey,
      row: {sellingUnit: null, price: 41.25, packSize: '2/10 LB'},
      evidence: {notes: ['Keep source evidence']},
      reviewRequired: true,
      reviewFields: ['selling_unit', 'brand'],
      baseline: {brand: null}
    };
    await db.query(`insert into vendor_items
      (id,organization_id,vendor_id,vendor_item_code,description,brand,pack_size,price,last_updated,
        price_source,price_unavailable,price_quote_valid_until,selling_unit,price_basis,import_row,field_resolutions)
      values($1,$2,$3,$4,'Synthetic item','Example','2/10 LB',41.25,'2026-11-10T18:00:00Z',
        'price_list',true,'2099-11-11','CS','case',$5::jsonb,'{"brand":{"value":"Example"}}')`,
    [id, organization, vendor, rowKey, JSON.stringify(source)]);
    await db.query('insert into item_mappings values($1,$2,$3,$4)', [randomUUID(), organization, id, randomUUID()]);
    await db.query("insert into price_history(vendor_item_id,organization_id,price,source,source_document_id) values($1,$2,40,'price_list',$3)",
      [id, organization, documentId]);
    return id;
  }

  const first = await seedListing(f.org, f.vendor, document, 'row:0');
  const second = await seedListing(f.org, f.vendor, secondDocument, 'row:0');
  const foreign = await seedListing(otherOrg, otherVendor, foreignDocument, 'row:0');
  const readListing = async id => (await db.query('select to_jsonb(v) as value from vendor_items v where id=$1', [id])).rows[0].value;
  const readMapping = async id => (await db.query('select to_jsonb(m) as value from item_mappings m where vendor_item_id=$1', [id])).rows[0].value;
  const readHistory = async () => (await db.query('select to_jsonb(h) as value from price_history h order by id')).rows.map(row => row.value);
  const confirmEntry = async id => ({
    listingId: id,
    expectedListing: await readListing(id),
    expectedMapping: await readMapping(id),
    sellingUnit: 'CS',
    priceBasis: 'case',
    priceUnavailable: false,
    rowKey: 'row:0',
    packSize: '2/10 LB'
  });
  const recheckEntry = async id => ({
    listingId: id,
    expectedListing: await readListing(id),
    expectedMapping: await readMapping(id),
    reviewRequired: false,
    reviewFields: [],
    baseline: {description: 'Synthetic item', brand: 'Example', sellingUnit: 'CS', packSize: '2/10 LB', price: 41.25}
  });
  const planFor = (documentId, rows, summary) => ({
    documentId,
    documentFingerprint: 'scope-fingerprint',
    industry: 'construction',
    vocabulary: [],
    settings: {},
    unit: 'CS',
    rows,
    summary
  });
  const write = async (actor, operation, action, plan, organization = f.org) => (await db.query(
    'select kerdos_apply_quote_unit_operation($1,$2,$3,$4,$5::jsonb) as value',
    [organization, actor, operation, action, JSON.stringify(plan)]
  )).rows[0].value;
  const readReceipt = async (actor, operation, action) => (await db.query(
    'select kerdos_read_quote_unit_operation($1,$2,$3,$4) as value', [f.org, actor, operation, action]
  )).rows[0].value;
  const initial = await readListing(first);
  const untouchedForeign = await readListing(foreign);
  const history = await readHistory();
  const confirmPlan = planFor(document, [await confirmEntry(first)], {beforeReady: 0, afterReady: 0, total: 2});
  const secondConfirmPlan = planFor(secondDocument, [await confirmEntry(second)], confirmPlan.summary);
  const foreignConfirmPlan = planFor(foreignDocument, [await confirmEntry(foreign)], confirmPlan.summary);
  const operation = randomUUID();

  await f.actor(db, f.manager);
  await assert.rejects(write(f.manager, operation, 'confirm', confirmPlan), /permission denied/i);
  await db.exec('reset role; set role service_role');
  await assert.rejects(db.query('select * from kerdos_private.quote_unit_operations'), /permission denied/i);
  await assert.rejects(write(f.employee, operation, 'confirm', confirmPlan), /approval authority/i);
  await assert.rejects(write(f.manager, operation, 'confirm', foreignConfirmPlan), /price sheet changed/i);
  assert.equal(await readReceipt(f.manager, operation, 'confirm'), null);
  const receipt = await write(f.manager, operation, 'confirm', confirmPlan);
  await write(f.manager, randomUUID(), 'confirm', secondConfirmPlan);
  assert.equal(receipt.confirmedBy, f.manager);
  assert.equal(receipt.documentId, document);
  assert.ok(Number.isFinite(Date.parse(receipt.confirmedAt)));
  const confirmation = receipt.rows[0].confirmation;
  assert.equal(confirmation.value, 'CS');
  assert.equal(confirmation.confirmedBy, f.manager);
  assert.equal(confirmation.confirmedAt, receipt.confirmedAt);
  assert.equal(confirmation.documentConfirmation.organizationId, f.org);
  assert.equal(confirmation.documentConfirmation.vendorId, f.vendor);
  assert.equal(confirmation.documentConfirmation.documentFingerprint, 'scope-fingerprint');
  assert.equal(confirmation.documentConfirmation.documentId, document);
  assert.equal(confirmation.documentConfirmation.listingId, first);
  assert.equal(confirmation.documentConfirmation.packSize, '2/10 LB');
  assert.equal(confirmation.documentConfirmation.rowKey, 'row:0');
  assert.match(confirmation.documentConfirmation.observationHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await write(f.manager, operation, 'confirm', confirmPlan), receipt);
  assert.deepEqual(await readReceipt(f.manager, operation, 'confirm'), receipt);
  await assert.rejects(readReceipt(f.owner, operation, 'confirm'), /different approval/i);
  await assert.rejects(write(f.manager, operation, 'confirm', {...confirmPlan, unit: 'EA'}), /different preview/i);

  await db.exec('reset role');
  assert.deepEqual(await readListing(first), {
    ...initial, price_unavailable: false, row_revision: initial.row_revision + 1,
    field_resolutions: {...initial.field_resolutions, selling_unit: confirmation}
  });
  assert.deepEqual(await readListing(foreign), untouchedForeign);
  assert.deepEqual(await readHistory(), history);

  // A raw JSON write cannot fabricate an actor/time or attach a receipt to
  // a different listing. The same valid proof can travel with its own listing.
  await f.actor(db, f.manager);
  const forged = {...confirmation, confirmedAt: '2020-01-01T00:00:00Z'};
  await assert.rejects(db.query("update vendor_items set field_resolutions=jsonb_build_object('selling_unit',$2::jsonb) where id=$1",
    [first, JSON.stringify(forged)]), /matching server receipt/i);
  const carried = proof => ({fieldEvidence: {sellingUnit: {confirmation: proof}}});
  await assert.rejects(db.query("update vendor_items set import_row=import_row||jsonb_build_object('evidence',$2::jsonb) where id=$1",
    [second, JSON.stringify(carried(confirmation))]), /matching server receipt/i);
  await assert.rejects(db.query("update vendor_items set import_row=import_row||jsonb_build_object('retainedSource',$2::jsonb) where id=$1",
    [first, JSON.stringify({evidence: carried(forged)})]), /matching server receipt/i);
  await db.query("update vendor_items set import_row=import_row||jsonb_build_object('evidence',$2::jsonb) where id=$1",
    [first, JSON.stringify(carried(confirmation))]);

  await db.exec('reset role');
  const reviewPlan = planFor(null, [await recheckEntry(first), await recheckEntry(second)], {beforeReady: 0, afterReady: 2, total: 2});
  reviewPlan.documents = [document, secondDocument].map(id => ({id, fingerprint: 'scope-fingerprint'}));
  const reviewOperation = randomUUID();
  // Held imports can change the source without advancing row_revision.
  await db.query("update vendor_items set import_row=import_row||'{\"newObservation\":true}'::jsonb where id=$1", [second]);
  await db.exec('set role service_role');
  await assert.rejects(write(f.manager, reviewOperation, 'recheck', reviewPlan), /approval authority/i);
  await assert.rejects(write(f.owner, reviewOperation, 'recheck', reviewPlan), /source observation changed/i);
  assert.equal(await readReceipt(f.owner, reviewOperation, 'recheck'), null);
  await db.exec('reset role');
  assert.equal((await readListing(first)).import_row.reviewRequired, true);
  const refreshed = {...reviewPlan, rows: [await recheckEntry(first), await recheckEntry(second)]};
  await db.query("insert into org_vocabulary values($1,$2,'synonym','fixture','synthetic')", [randomUUID(), f.org]);
  await db.exec('set role service_role');
  await assert.rejects(write(f.owner, reviewOperation, 'recheck', refreshed), /vocabulary changed/i);
  await db.exec('reset role');
  refreshed.vocabulary = (await db.query('select to_jsonb(v) as value from org_vocabulary v')).rows.map(row => row.value);
  await db.query("update import_documents set fingerprint='changed-scope' where id=$1", [secondDocument]);
  await db.exec('set role service_role');
  await assert.rejects(write(f.owner, reviewOperation, 'recheck', refreshed), /price sheet changed/i);
  assert.equal(await readReceipt(f.owner, reviewOperation, 'recheck'), null);
  await db.exec('reset role');
  await db.query("update import_documents set fingerprint='scope-fingerprint' where id=$1", [secondDocument]);
  await db.exec('set role service_role');
  const reviewed = await write(f.owner, reviewOperation, 'recheck', refreshed);
  assert.equal(reviewed.documentId, null);
  assert.deepEqual(reviewed.documents, refreshed.documents);
  assert.deepEqual(reviewed.summary, refreshed.summary);
  assert.deepEqual(await write(f.owner, reviewOperation, 'recheck', refreshed), reviewed);
  await db.exec('reset role');
  for (const entry of refreshed.rows) {
    assert.deepEqual(await readListing(entry.listingId), {
      ...entry.expectedListing,
      import_row: {
        ...entry.expectedListing.import_row,
        reviewFields: entry.reviewFields,
        reviewRequired: entry.reviewRequired,
        baseline: entry.baseline
      }
    });
    assert.deepEqual(await readMapping(entry.listingId), entry.expectedMapping);
  }
  assert.deepEqual(await readListing(foreign), untouchedForeign);
  assert.deepEqual(await readHistory(), history);
  const readyListing = await readListing(first);
  const procurement = workspaceProcurement({organization:{id:f.org,industry:'construction'},vocabulary:refreshed.vocabulary});
  const scope = {organizationId:f.org,vendorId:f.vendor};
  const mapping = await readMapping(first);
  const nextSheet = {code:readyListing.vendor_item_code,description:readyListing.description,brand:readyListing.brand,
    packSize:readyListing.pack_size,sellingUnit:null,price:44};
  const next = preparePriceImport(nextSheet,readyListing,mapping,[],[],scope,procurement);
  assert.equal(next.requiresReview,false);
  assert.equal(next.resolved.sellingUnit,'CS');
  assert.deepEqual(next.resolved.unitRoot.confirmation,confirmation,'the importer reuses the original SQL receipt');
  for (const change of [{packSize:'3/10 LB'},{sellingUnit:'EA',sellingUnitSource:'column'}]) {
    assert.equal(preparePriceImport({...nextSheet,...change},readyListing,mapping,[],[],scope,procurement).requiresReview,true);
  }
  console.log('PASS document quoted-unit SQL: service-only scope, verified actor receipt, protected carried proof, stale and idempotent multi-document recheck, exact write allowlist.');
} finally {
  await db.close();
}

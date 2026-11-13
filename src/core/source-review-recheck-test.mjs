import assert from 'node:assert/strict';
import {planDocumentQuoteConfirmation,planSourceReviewRecheck,workspaceProcurement} from './source-review-recheck.js';

const organization={id:'company',industry:'construction',settings:{}};
const vocabulary=[{organization_id:organization.id,kind:'unit',term:'tuft',canonical:'EA'}];
const document={id:'sheet',organization_id:organization.id,vendor_id:'vendor',fingerprint:'sheet-content',document_kind:'pricelist',status:'complete'};
const now=new Date('2026-11-11T12:00:00Z');
const sample={id:'listing',organization_id:organization.id,vendor_id:'vendor',description:'Steel scrubbers',vendor_item_code:'ITEM',
  pack_size:'4/5 TUFT',selling_unit:'CS',price_basis:'case',price:35,price_unavailable:true,price_source:'price_list',
  row_revision:7,field_resolutions:{},import_row:{sourceDocumentId:document.id,rowKey:'row:0',reviewRequired:true,
    reviewFields:['description','brand','pack_size','selling_unit','price'],conflicts:['Old source reasons'],
    row:{code:'ITEM',description:'Steel scrubbers',packSize:'4/5 TUFT',price:35,sellingUnit:null},
    evidence:{sellingUnitSource:'inferred',sellingUnit:'CS'}}};
const mapping={id:'mapping',organization_id:organization.id,vendor_item_id:sample.id,catalog_item_id:'catalog',
  comparison_track:'exact',confidence_score:100};
const input={organization,vocabulary,document,listings:[sample],mappings:[mapping],unit:'CASE',now};

const confirm=(changes={},options={})=>planDocumentQuoteConfirmation({...input,listings:[{...sample,...changes}],...options});
const confirmation=()=>({value:'CS',confirmedBy:'owner',confirmedAt:now.toISOString(),sourceValue:null,
  documentConfirmation:{operationId:'operation',organizationId:organization.id,vendorId:sample.vendor_id,documentId:document.id,
    documentFingerprint:document.fingerprint,listingId:sample.id,rowKey:'row:0',packSize:sample.pack_size,observationHash:'a'.repeat(64)}});
const confirmed={...sample,price_unavailable:false,field_resolutions:{selling_unit:confirmation()}};
const recheck=(listing,options={})=>planSourceReviewRecheck({...input,documents:[document],listings:[listing],...options});

assert.throws(()=>workspaceProcurement({organization,vocabulary:null}),/industry and vocabulary/);
assert.throws(()=>workspaceProcurement({organization:{...organization,industry:''},vocabulary}),/industry and vocabulary/);
assert.throws(()=>workspaceProcurement({organization,vocabulary:[{...vocabulary[0],organization_id:'another'}]}),/industry and vocabulary/);
const draft=confirm();
assert.equal(draft.rows.length,1,'same taught unit vocabulary recognizes the retained pack');
assert.equal(draft.rows[0].sellingUnit,'CS','the equivalent saved vendor token is preserved');
const statedTerms={...document,original_text:'All prices are per case'};
assert.equal(confirm({}, {document:statedTerms}).rows.length,1,'the client can confirm a blank row against matching stated document terms');
assert.equal(confirm({}, {document:statedTerms,unit:'EACH'}).rows.length,0,'the action cannot contradict stated document terms');
assert.equal(confirm({}, {document:{...statedTerms,original_text:'All prices are per case. All prices are per each.'}}).rows.length,0);
assert.equal(confirm({}, {document:{...statedTerms,original_text:'All prices are per P'}}).rows.length,0);

assert.equal(draft.rows[0].priceUnavailable,false);
assert.equal(draft.rows[0].expectedListing.price_unavailable,true,'preview does not write');
assert.equal(confirm({}, {vocabulary:[]}).rows.length,0,'a different run cannot borrow another vocabulary');
assert.equal(confirm({}, {listingIds:[]}).rows.length,0,'preview honors an exact selection');
assert.equal(confirm({organization_id:'another'}).rows.length,0);
assert.equal(confirm({import_row:{...sample.import_row,sourceDocumentId:'another-doc'}}).rows.length,0);
assert.equal(confirm({selling_unit:null}).rows[0].sellingUnit,'CASE','a blank unit can be confirmed');

const unsupported={...sample.import_row,row:{...sample.import_row.row,sellingUnit:'P'}};
assert.equal(confirm({import_row:unsupported}).rows.length,0,'unrecognized printed units are protected');
const unsupportedBound={...sample.import_row,row:{...sample.import_row.row,fieldIdentification:{bindings:{sellingUnit:{evidence:'stated',rawValue:'P',header:'Price Unit'}}}}};
assert.equal(confirm({import_row:unsupportedBound}).rows.length,0,'retain printed units even when no canonical unit was parsed');
assert.equal(confirm({selling_unit:'LB',price_basis:'measure',import_row:{...sample.import_row,evidence:{sellingUnitSource:'inferred',sellingUnit:'LB'}}}).rows.length,0);
assert.equal(confirm({price_expired_at:now.toISOString()}).rows.length,0);
assert.equal(confirm({price:50}).rows.length,0,'retained quote amount cannot be substituted');
assert.equal(confirm({field_resolutions:confirmed.field_resolutions}).rows.length,0,'prior confirmation is protected');

const orderingSource={...sample.import_row.row,sellingUnit:'CSE',sellingUnitSource:'header: Type:',
  fieldIdentification:{bindings:{sellingUnit:{evidence:'stated',rawValue:'CSE',header:'Type:'}}}};
const orderingObservation={...sample.import_row,row:orderingSource,evidence:orderingSource,
  baseline:{...orderingSource,sellingUnit:'CS'}};
const orderingListing={...sample,selling_unit:'CSE',price_unavailable:false,import_row:orderingObservation};
const orderingPlan=confirm(orderingListing,{unit:'EACH'});
assert.equal(orderingPlan.rows.length,1,'a Type-only row may be confirmed in its original sheet');
assert.equal(orderingPlan.rows[0].sellingUnit,'EACH','the explicit choice can replace a legacy ordering token');
assert.equal(orderingPlan.rows[0].expectedListing.import_row,orderingObservation,'the full stored snapshot stays in the plan');
assert.equal(orderingPlan.rows[0].expectedListing.selling_unit,'CSE');
assert.equal(confirm({...orderingListing,price_unavailable:true,import_row:{...orderingObservation,reviewRequired:false}}).rows.length,0,'a withdrawn quote is excluded');
assert.equal(confirm({...orderingListing,import_row:{...orderingObservation,retainedSource:{row:orderingSource}}}).rows.length,0,'an incoming observation cannot replace a different active quote');
assert.equal(confirm({...orderingListing,import_row:{...orderingObservation,evidence:{sellingUnit:'EACH',sellingUnitSource:'price header'}}}).rows.length,0,'explicit evidence stays protected');
assert.equal(confirm(orderingListing,{document:statedTerms,unit:'EACH'}).rows.length,0,'a Type-only row cannot override explicit sheet terms');
const unrecognizedOrdering={...orderingSource,sellingUnit:'P',
  fieldIdentification:{bindings:{sellingUnit:{evidence:'stated',rawValue:'P',header:'Type:'}}}};
assert.equal(confirm({...orderingListing,selling_unit:'P',price_basis:null,price_unavailable:true,
  import_row:{...orderingObservation,row:unrecognizedOrdering,evidence:unrecognizedOrdering,baseline:unrecognizedOrdering}}).rows.length,1,
  'the same bound Type code can be replaced even if it cannot be interpreted as a price unit');
const orderingConfirmed={...orderingListing,selling_unit:'EACH',price_basis:'each',
  field_resolutions:{selling_unit:{...confirmation(),value:'EACH',sourceValue:'CSE'}}};
assert.equal(recheck(orderingConfirmed).rows.length,1,'recheck can clear a resolved legacy hold without rewriting its original source');

const warnings={...sample.import_row,row:{...sample.import_row.row,cellConflicts:[{field:'pack',note:'Verify'}]}};
assert.equal(confirm({import_row:warnings}).rows.length,0);
assert.equal(recheck({...confirmed,import_row:warnings}).rows.length,0);
assert.equal(recheck(sample).rows.length,0,'approval cannot clear unresolved unit evidence');
assert.equal(recheck({...confirmed,price_unavailable:true}).rows.length,0,'recheck never changes availability');
assert.equal(recheck(confirmed,{documents:[{...document,fingerprint:'different-content'}]}).rows.length,0);
const ready=recheck(confirmed);
assert.equal(ready.rows.length,1);
assert.deepEqual(ready.rows[0].reviewFields,[]);
assert.equal(ready.rows[0].reviewRequired,false);
assert.equal(ready.rows[0].baseline.price,sample.price);
assert.equal(ready.rows[0].baseline.sellingUnit,sample.selling_unit);
assert.deepEqual(Object.keys(ready.rows[0]).sort(),['baseline','expectedListing','expectedMapping','listingId','reviewFields','reviewRequired']);
assert.equal(confirmed.import_row.reviewRequired,true,'a recheck produces only a proposal');

const scopedInvoice={organizationId:organization.id,vendorId:sample.vendor_id,id:'invoice',row:{code:'ITEM',description:'Different product',packSize:sample.pack_size}};
assert.equal(confirm({}, {invoices:[scopedInvoice]}).rows.length,0,'a selected unit cannot mask invoice conflicts');
assert.equal(confirm(orderingListing,{unit:'EACH',invoices:[scopedInvoice]}).rows.length,0,'Type-only rows still require consistent invoices');
assert.equal(recheck(confirmed,{invoices:[scopedInvoice]}).rows.length,0);
assert.equal(recheck(confirmed,{invoices:[{...scopedInvoice,vendorId:'another'}]}).rows.length,1);

console.log('PASS source review planners preserve source, enforce organization context and unit eligibility, and fail closed on outstanding evidence.');

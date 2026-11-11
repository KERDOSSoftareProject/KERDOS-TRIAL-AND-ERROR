import {getProcurementContext} from '../procurement.js';

const own=(value,key)=>Object.hasOwn(value||{},key);
const valueFields=['description','brand','pack_size','selling_unit','price','price_basis','gtin','manufacturer_code','unit_cost_unit'];

// One active source observation, retained once while a newer observation waits
// for review. Pending row/evidence remain untouched in the existing import_row.
// A successfully applied quote replaces import_row and naturally drops this copy.
export function captureRetainedSource(listing){
  const saved=listing.import_row||{};
  if(own(saved,'retainedSource'))return saved.retainedSource||{values:{}};
  return {
    values:Object.fromEntries(valueFields.map(key=>[key,listing[key]??null])),
    row:saved.row||{},evidence:saved.evidence||saved.row||{},
    sourceDocumentId:saved.sourceDocumentId||null,sourceFileName:saved.sourceFileName||null,
  };
}

// Provenance belongs to the field value, not to whichever document arrived last.
// A changed value cannot borrow proof from an older retained observation.
export function listingSourceForField(listing,field){
  const saved=listing.import_row||{};
  if(own(saved,'retainedSource')){
    const source=saved.retainedSource;
    if(source&&own(source.values,field)&&Object.is(source.values[field]??null,listing[field]??null))
      return {row:source.row||{},evidence:source.evidence||source.row||{},sourceDocumentId:source.sourceDocumentId||null,bound:true};
    return {row:{},evidence:{},sourceDocumentId:null,bound:false};
  }
  return {row:saved.row||{},evidence:saved.evidence||saved.row||{},sourceDocumentId:saved.sourceDocumentId||null,bound:null};
}

export function quotedUnitOrigin(listing,procurement=getProcurementContext()){
  const source=listingSourceForField(listing,'selling_unit');
  const basis=procurement.priceBasisFor(listing.selling_unit);
  const sameUnit=value=>{
    const other=procurement.priceBasisFor(value);
    return !!basis&&!!other&&basis.basis===other.basis&&(basis.unit||null)===(other.unit||null);
  };
  const confirmation=listing.field_resolutions?.selling_unit;
  if(confirmation&&sameUnit(confirmation.value))
    return {...source,status:'confirmed',confirmation,source:'client confirmation'};
  if(!basis)return {...source,status:null,confirmation:null,source:null};
  const inference=source.evidence.fieldInference?.sellingUnit;
  const inferredFlag=source.evidence.sellingUnitSource==='inferred'&&
    (!source.evidence.sellingUnit||sameUnit(source.evidence.sellingUnit));
  if(inferredFlag||inference?.kind==='inferred'&&sameUnit(inference.value))
    return {...source,status:'inferred',confirmation:null,source:'inferred'};
  if(sameUnit(source.evidence.sellingUnit))
    return {...source,status:'confirmed',confirmation:null,source:source.evidence.sellingUnitSource||'document'};
  if(sameUnit(source.row.sellingUnit))
    return {...source,status:'confirmed',confirmation:null,source:'document'};
  // Missing proof is not affirmative confirmation. Keep the existing value;
  // do not manufacture a green label or infer who confirmed it.
  return {...source,status:null,confirmation:null,source:null};
}

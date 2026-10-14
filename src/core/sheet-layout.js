// Header-first reading of a vendor sheet.
//
// A sheet is read the way a person reads it: settle what every column
// means from the header row, once, and only then walk the rows. A header
// KERDOS recognises gets its meaning. A header it does not recognise is
// reported once, for the client to answer once ("this column is the
// pack"), and the answer is remembered for that vendor's layout so the
// same sheet next week needs nothing. Every cell is then checked against
// what its column means: a price must be money, a pack must be a pack,
// a unit must be a unit. A failing cell is flagged with its reason; the
// row still saves. Description is the only column that is interpreted.
import {parsePackSize,priceBasisFor,normalizeGtin} from "../procurement.js";

export const COLUMN_ROLE_LABELS={
  description:"Product description",
  code:"Vendor item number",
  brand:"Brand",
  gtin:"Barcode (UPC / GTIN)",
  mfrCode:"Manufacturer item number",
  packSize:"Pack size",
  sellingUnit:"Price is per (unit)",
  price:"Price",
  qty:"Quantity",
  amount:"Line total",
  ignore:"Not needed — ignore this column",
};
export const COLUMN_ROLES_FOR_CHOICE=["description","code","brand","packSize","sellingUnit","price","gtin","mfrCode","qty","amount","ignore"];

const normalizeLabel=label=>String(label||"").toLowerCase().replace(/[^a-z0-9#/&%]+/g," ").trim();

// The header row's identity: its labels, normalised, in order. Two files
// from the same vendor with the same column headings share a fingerprint.
export function headerFingerprint(headerCells=[]){
  return headerCells.map(normalizeLabel).join("|");
}

// What the header row tells us, column by column, and which columns are
// still unknown after the engine's own vocabulary and the remembered
// layout for this vendor have been applied.
export function readHeaderLayout({headerCells=[],columnMap={},remembered={}}){
  const byIndex=new Map(Object.entries(columnMap).map(([role,index])=>[index,role]));
  const headers=headerCells.map((label,index)=>{
    const rememberedRole=remembered[String(index)]||remembered[index];
    const role=rememberedRole||byIndex.get(index)||null;
    const how=rememberedRole?"remembered":byIndex.has(index)?"recognised":"unknown";
    return {index,label:String(label||"").trim(),role,how};
  });
  const unknown=headers.filter(h=>h.how==="unknown"&&h.label);
  return {headers,unknown,fingerprint:headerFingerprint(headerCells)};
}

// Apply the client's answers (and the remembered layout) on top of the
// engine's own header reading. A column marked "ignore" is dropped even if
// the engine had guessed a role for it; a role assigned to a new column
// displaces the engine's guess for that role.
export function applyLayoutAnswers(columnMap={},answers={}){
  const map={...columnMap};
  for(const [indexText,role] of Object.entries(answers||{})){
    const index=Number(indexText);
    if(!Number.isFinite(index))continue;
    for(const [existingRole,existingIndex] of Object.entries(map))if(existingIndex===index)delete map[existingRole];
    if(role&&role!=="ignore")map[role]=index;
  }
  return map;
}

// Each column's meaning implies a test its cells must pass. A cell that
// fails is reported with the reason; nothing about the row is discarded.
export function checkCell(role,value){
  const text=String(value??"").trim();
  if(!text)return {ok:true,empty:true};
  switch(role){
    case "price":
    case "amount":{
      const n=Number(text.replace(/[$,\s]/g,""));
      return Number.isFinite(n)?{ok:true}:{ok:false,reason:`"${text}" is not an amount`};
    }
    case "qty":{
      const n=Number(text.replace(/[,\s]/g,""));
      return Number.isFinite(n)?{ok:true}:{ok:false,reason:`"${text}" is not a quantity`};
    }
    case "packSize":
      return parsePackSize(text)?.parsed?{ok:true}:{ok:false,reason:`"${text}" is not a complete pack (needs a size and a unit)`};
    case "sellingUnit":
      return priceBasisFor(text)?{ok:true}:{ok:false,reason:`"${text}" is not a unit KERDOS recognises`};
    case "gtin":
      return normalizeGtin(text)?{ok:true}:{ok:false,reason:`"${text}" is not a valid barcode`};
    case "code":
      return /[A-Za-z0-9]/.test(text)?{ok:true}:{ok:false,reason:`"${text}" does not look like an item number`};
    default:
      return {ok:true};
  }
}

// Run every mapped column's test over one row's cells.
// Quantity and line totals are invoice arithmetic, checked by the invoice
// reader against each other; they are not cell tests here.
const UNCHECKED_ROLES=new Set(["qty","amount","description","brand","mfrCode"]);
export function checkRowCells(cells=[],columnMap={}){
  const issues={};
  for(const [role,index] of Object.entries(columnMap)){
    if(UNCHECKED_ROLES.has(role))continue;
    const result=checkCell(role,cells[index]);
    if(!result.ok)issues[role]=result.reason;
  }
  return issues;
}

// Remembered layouts live in the organization's settings, keyed by vendor
// and header fingerprint, so nothing is asked twice.
export function rememberedLayout(settings,vendorId,fingerprint){
  return settings?.vendorLayouts?.[vendorId]?.[fingerprint]||{};
}
export function withRememberedLayout(settings,vendorId,fingerprint,answers){
  const layouts={...(settings?.vendorLayouts||{})};
  layouts[vendorId]={...(layouts[vendorId]||{}),[fingerprint]:{...answers}};
  return {...(settings||{}),vendorLayouts:layouts};
}

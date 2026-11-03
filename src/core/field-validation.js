// B5 admission checks consume assigned fields. They never select source
// cells, substitute another field, decide a product group or write records.
import {checkCell} from './sheet-layout.js';

const UNCHECKED_ROLES=new Set(['qty','amount','description','brand','mfrCode']);

export function assessBoundFields(identification){
 const bindings=identification?.bindings||{};
 const owners=new Map();
 for(const [role,binding] of Object.entries(bindings)){
  if(!Number.isInteger(binding?.columnIndex))continue;
  const roles=owners.get(binding.columnIndex)||[];
  roles.push(role);owners.set(binding.columnIndex,roles);
 }
 const fields={},cellIssues={};
 for(const [role,binding] of Object.entries(bindings)){
  const raw=binding.rawValue;
  const empty=raw==null||!String(raw).trim();
  const checked=!UNCHECKED_ROLES.has(role);
  const result=checked?checkCell(role,raw):{ok:true};
  const competing=owners.get(binding.columnIndex)?.filter(other=>other!==role)||[];
  const status=competing.length?'conflict':empty?'missing':!result.ok?'invalid':binding.evidence==='inferred'?'inferred':'present';
  // Confidence describes the field assignment and readable value, not product identity.
  // A guessed layout has no independent corroboration, so it cannot earn 90.
  const accuracy=empty?0:competing.length||!result.ok?null:
   binding.evidence==='stated-header'||binding.evidence==='remembered-client'?100:
   binding.evidence==='inferred'?70:null;
  fields[role]={status,columnIndex:binding.columnIndex,evidence:binding.evidence,
   accuracy,
   ...(competing.length?{conflictsWith:competing}:{}),...(!result.ok?{reason:result.reason}:{})};
  // Preserve the existing cell warning contract for the import preview.
  if(checked&&!result.ok)cellIssues[role]=result.reason;
 }
 return {fields,cellIssues};
}

export function requireItemDescription(row){
 if(String(row?.description||'').trim().length<2)throw new Error('Identify the product description before saving this listing. The original source row is retained for review.');
}

// Assess assigned cells without changing their placement. The caller decides
// whether a source observation can be admitted as a listing.
export function validateAssignedFields(fields,{price,amount,priceUnavailable=false}={}){
 const raw=fields?.values?.price;
 const text=raw==null?null:String(raw).trim();
 const numericLike=text===''||(text!=null&&/^[$€£¥\d]/.test(text));
 const unreadable=price==null&&amount==null&&!priceUnavailable&&raw!=null&&numericLike;
 const anchorStatus=fields?.anchor?.status||'missing';
 const issues=[...(fields?.issues||[])];
 if(unreadable){
  const hint=text?` ("${text}")`:'';
  issues.push({kind:'missing-price',message:`Price missing or could not be read${hint}`});
 }
 return {version:1,anchorStatus,priceStatus:priceUnavailable?'unavailable':unreadable?'missing-or-unreadable':price!=null||amount!=null?'parsed':'absent',
  retain:price!=null||amount!=null||priceUnavailable||unreadable,
  requiresReview:anchorStatus==='missing'||anchorStatus==='ambiguous'||unreadable,
  issues};
}

// Collect existing arithmetic and quoted-unit findings after row interpretation.
// Legacy review flags remain available to consumers during the transition.
export function withRowValidation(row){
 if(!row?.fieldValidation)return row;
 const fields={...row.fieldValidation.fields};
 const conflicts=(row.cellConflicts||[]).map(({field,note})=>({field,note}));
 for(const {field} of conflicts)if(fields[field])fields[field]={...fields[field],status:'conflict',accuracy:null};
 const unitClues=row.quoteUnitEvidence||[];
 const unitConflict=unitClues.length>1&&new Set(unitClues.map(clue=>clue.unit)).size>1;
 if(unitConflict&&fields.sellingUnit)fields.sellingUnit={...fields.sellingUnit,status:'conflict',accuracy:null};
 return {...row,fieldValidation:{...row.fieldValidation,fields,conflicts,
  unresolved:(row.cellUnresolved||[]).map(({field,reason})=>({field,reason})),
  quotedUnit:unitConflict?'conflict':unitClues.length?'evidenced':'missing'}};
}

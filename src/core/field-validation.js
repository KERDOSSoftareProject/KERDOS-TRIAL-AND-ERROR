// B5 admission checks consume assigned fields. They never select source
// cells, substitute another field, decide a product group or write records.
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

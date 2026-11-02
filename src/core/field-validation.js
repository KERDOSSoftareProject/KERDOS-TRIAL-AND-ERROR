// B5 admission checks consume assigned fields. They never select source
// cells, substitute another field, decide a product group or write records.
export function requireItemDescription(row){
 if(String(row?.description||'').trim().length<2)throw new Error('Identify the product description before saving this listing. The original source row is retained for review.');
}

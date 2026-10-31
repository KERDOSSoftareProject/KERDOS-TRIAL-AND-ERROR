import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {configureProcurement,suggestCategory,contextualCategorySuggestion} from '../src/procurement.js';

const categories=['Produce','Dairy','Meat','Seafood','Dry Goods','Canned Goods','Frozen Foods','Prepared Foods','General'].map((name,i)=>({id:String(i),name,keywords:[name.toLowerCase()]}));
const names=['Fresh cilantro','Mint leaves','Tomato powder','Canned tomatoes','Frozen spinach','Prepared potato salad','Whole milk','Chicken breast','Ground black pepper','Paper napkins','Dried onion','Fresh apples'];
const catalog=Array.from({length:751},(_,i)=>({id:`c${i}`,name:`${names[i%names.length]} ${i}`,category_id:'0'}));
const corrections=lookup=>catalog.flatMap(item=>{
  const suggested=lookup(item);
  return suggested?.category?.id&&suggested.category.id!==item.category_id&&suggested.reason?.includes('Prepared product form')?[[item.id,suggested]]:[];
});
for(const industry of ['Restaurant',null]){
  configureProcurement({industry});
  const start=performance.now();
  const previous=corrections(item=>suggestCategory(item.name,categories,catalog));
  const middle=performance.now();
  const next=corrections(item=>contextualCategorySuggestion(item.name,categories));
  const end=performance.now();
  assert.deepEqual(next,previous,'category review must retain identical suggestions and reasons');
  if(industry)assert.ok(next.length>0,'fixture must exercise prepared-product corrections');
  console.log(JSON.stringify({industry,items:catalog.length,corrections:next.length,previousMs:Math.round(middle-start),optimizedMs:Math.round(end-middle)}));
}
console.log('PASS category review parity, including missing industry profile; timings are local synthetic evidence.');

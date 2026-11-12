import {compareItems,itemMatchesSearch} from './catalog-browse.js';
import {orderable} from './ordering.js';
const alphabetic=new Intl.Collator(undefined,{sensitivity:'base',ignorePunctuation:true,numeric:true});
const alphabeticName=name=>String(name||'').replace(/^[^\p{L}]+/u,'');

// Visibility follows the saved product identity; purchasing still follows each
// offer's eligibility. A group does not disappear because all offers are held.
export function orderGuideGroups(products,{search='',category='',vendor='',sort='alphabetical',regularIds=null}={}){
 const items=products.filter(item=>item.hasProductIdentity!==false&&item.options.length>0&&
  (!regularIds||regularIds.has(item.catalogItemId))&&
  (!category||item.category===category)&&(!vendor||item.options.some(o=>o.vendorId===vendor))&&itemMatchesSearch(item,search))
  .map(item=>({...item,linkedOptions:item.options,options:item.options.filter(orderable)}))
  .sort((a,b)=>['alpha','alphabetical'].includes(sort)?alphabetic.compare(alphabeticName(a.name),alphabeticName(b.name))||Number(a.masterItemNumber)-Number(b.masterItemNumber):compareItems(a,b,sort));
 return items.length?[{category:'all',items}]:[];
}
export function orderGuideCategories(products){
 return [...new Set(products.filter(item=>item.hasProductIdentity!==false&&item.options.length>0).map(item=>item.category))].sort((a,b)=>a.localeCompare(b));
}

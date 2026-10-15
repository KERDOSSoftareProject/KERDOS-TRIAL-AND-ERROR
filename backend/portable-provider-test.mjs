import assert from "node:assert/strict";
import {createRecords} from "./records.js";
import {assertBackendContract} from "./contract.js";
import {createCatalogService} from "../services/catalog.js";
import {createVendorService} from "../services/vendors.js";
import {createCategoryService} from "../services/categories.js";

// An independent in-memory adapter: no Supabase SDK, HTTP or GitHub API.
const data=new Map();
let nextId=1;
const rows=name=>{if(!data.has(name)) data.set(name,[]);return data.get(name);};
const execute=async spec=>{
  const matches=row=>spec.filters.every(({operator,column,value})=>{
    const actual=row[column];
    if(operator==="eq")return actual===value;
    if(operator==="in")return value.includes(actual);
    if(operator==="ilike")return String(actual||"").toLowerCase()===String(value).toLowerCase();
    if(operator==="lte")return actual<=value;
    throw new Error(`Unsupported filter: ${operator}`);
  });
  let result;
  if(spec.action==="insert"||spec.action==="upsert"){
    const values=Array.isArray(spec.value)?spec.value:[spec.value];
    result=values.map(value=>({id:`fake-${nextId++}`,...value}));
    rows(spec.table).push(...result);
  }else if(spec.action==="select") result=rows(spec.table).filter(matches);
  else if(spec.action==="update"){
    result=rows(spec.table).filter(matches);
    result.forEach(row=>Object.assign(row,spec.value));
  }else if(spec.action==="delete"){
    result=rows(spec.table).filter(matches);
    data.set(spec.table,rows(spec.table).filter(row=>!matches(row)));
  }else throw new Error(`Unsupported action: ${spec.action}`);
  if(spec.orders.length)result=[...result].sort((a,b)=>{
    for(const {column,options} of spec.orders){
      const order=(a[column]>b[column])-(a[column]<b[column]);
      if(order)return options?.ascending===false?-order:order;
    }
    return 0;
  });
  if(spec.range)result=result.slice(spec.range.from,spec.range.to+1);
  if(spec.limit!==undefined)result=result.slice(0,spec.limit);
  if(spec.cardinality==="single")return {data:result[0]||null,error:result.length===1?null:new Error("Expected one record")};
  if(spec.cardinality==="maybeSingle")return {data:result[0]||null,error:result.length>1?new Error("Expected at most one record"):null};
  return {data:result,error:null};
};
const fn=async()=>null;
const provider=assertBackendContract({
  kind:"in-memory-test",
  session:{get:fn,subscribe:()=>()=>{},signIn:fn,signUp:fn,signOut:fn},
  workspace:{memberships:fn,snapshot:fn},
  documents:{upload:fn,signedUrl:fn,remove:fn,deletePriceSheet:fn,deleteInvoiceRecord:fn},
  realtime:{subscribeToOrganization:()=>()=>{}},
  pricing:{applyQuote:fn},catalog:{saveRow:fn},invoices:{record:fn},team:{acceptInvite:fn},
  records:createRecords(execute),
});
const categories=createCategoryService(provider);
const category=await categories.addCategory({organizationId:"org",name:"Supplies",keywords:["paper"],categories:[]});
assert.equal(rows("catalog_categories")[0].name,"Supplies");
const catalog=createCatalogService(provider);
const item=await catalog.createItem({organizationId:"org",name:"Copy Paper",categoryId:category[0].id,catalogItems:[],categories:rows("catalog_categories")});
assert.equal(item.name,"Copy Paper");
await catalog.renameItem(item.id,"Office Paper");
assert.equal(rows("catalog_items")[0].name,"Office Paper");
const vendors=createVendorService(provider);
await vendors.add({organizationId:"org",name:" Supplier ",email:"",minimumDollar:"50",minimumUnits:"2"});
assert.equal(rows("vendors")[0].name,"Supplier");
assert.equal(rows("vendors")[0].delivery_minimum_units,2);
console.log("KERDOS services work with an independent in-memory adapter");

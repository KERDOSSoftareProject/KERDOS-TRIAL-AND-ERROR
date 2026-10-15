// Industry-neutral category and vocabulary operations. Industry knowledge is
// stored as data; this service only copies and maintains that data for an org.
import {suggestCategory,nextCategoryRange} from "../procurement.js";

async function run(promise,operation){
  const {data,error}=await promise;
  if(error)throw new Error(`${operation}: ${error.message}`);
  return data;
}

export function holdingPen(categories){
  return categories.find(category=>category.is_holding_pen)||null;
}

export function createCategoryService(backend){
  const table=backend.records.query;
  return {
    async loadStarterPack({organizationId,industry,categories}){
      const name=String(industry||"").trim();
      if(!name)return {added:0,addedVocabulary:0,found:false};
      const [templates,vocabulary]=await Promise.all([
        run(table("industry_templates").select("*").ilike("industry",name).order("sort_order"),"Could not read industry categories"),
        run(table("industry_vocabulary").select("kind,term,canonical").ilike("industry",name),"Could not read industry vocabulary"),
      ]);
      if(!(templates||[]).length&&!(vocabulary||[]).length)return {added:0,addedVocabulary:0,found:false};

      const existingNames=new Set(categories.map(category=>category.name.toLowerCase()));
      const working=[...categories];
      const categoryRows=(templates||[]).filter(row=>!existingNames.has(row.category_name.toLowerCase())).map(row=>{
        const range=nextCategoryRange(working);
        working.push(range);
        return {organization_id:organizationId,name:row.category_name,keywords:row.keywords,...range};
      });
      if(categoryRows.length)await run(table("catalog_categories").insert(categoryRows),"Could not add starter categories");

      const existing=await run(table("org_vocabulary").select("kind,term").eq("organization_id",organizationId),"Could not read vocabulary");
      const have=new Set((existing||[]).map(row=>`${row.kind}:${String(row.term).toLowerCase()}`));
      const vocabularyRows=(vocabulary||[]).filter(row=>!have.has(`${row.kind}:${String(row.term).toLowerCase()}`)).map(row=>({
        organization_id:organizationId,kind:row.kind,term:String(row.term).toLowerCase(),canonical:row.canonical||null,
      }));
      if(vocabularyRows.length)await run(table("org_vocabulary").insert(vocabularyRows),"Could not add starter vocabulary");
      return {added:categoryRows.length,addedVocabulary:vocabularyRows.length,found:true};
    },
    addCategory({organizationId,name,keywords,categories}){
      const range=nextCategoryRange(categories);
      return run(table("catalog_categories").insert({organization_id:organizationId,name:name.trim(),keywords,...range}),"Could not add the category");
    },
    updateKeywords(categoryId,keywords){
      return run(table("catalog_categories").update({keywords}).eq("id",categoryId),"Could not save keywords");
    },
    deleteCategory(categoryId){
      return run(table("catalog_categories").delete().eq("id",categoryId),"Could not delete the category");
    },
    addVocabulary({organizationId,kind,term,canonical}){
      return run(table("org_vocabulary").insert({organization_id:organizationId,kind,term:term.toLowerCase(),canonical:canonical||null}),"Could not add the term");
    },
    removeVocabulary(vocabularyId){
      return run(table("org_vocabulary").delete().eq("id",vocabularyId),"Could not remove the term");
    },
    async assignItem({catalogItemId,categoryId,catalogItems,categories}){
      const target=categories.find(category=>category.id===categoryId);
      if(!target)return null;
      if(target.range_start==null||Number(target.range_start)<=0)throw new Error("This category needs an item-number range.");
      const current=catalogItems.find(item=>item.id===catalogItemId);
      const existingNumber=current?.master_item_number;
      const members=catalogItems.filter(item=>Number(item.master_item_number)>=Number(target.range_start)&&Number(item.master_item_number)<=Number(target.range_end||Number.MAX_SAFE_INTEGER));
      const masterItemNumber=current?.category_id===target.id&&existingNumber!=null?existingNumber:(members.length?Math.max(...members.map(item=>Number(item.master_item_number)||0))+1:(target.range_start));
      if(target.range_end!=null&&masterItemNumber>target.range_end)throw new Error("This category item-number range is full.");
      // category_reason:"confirmed" marks explicit client action so that an
      // unresolved engine result cannot silently downgrade an intentional placement.
      const update={category_id:target.id,master_item_number:masterItemNumber,category_review:false,category_reason:"confirmed"};
      const saved=await run(table("catalog_items").update(update).eq("id",catalogItemId).select("master_item_number"),"Could not move the item");
      return saved?.[0]?.master_item_number??masterItemNumber;
    },
    async reclassifyUncategorized({catalogItems,categories}){
      const holding=holdingPen(categories);
      if(!holding)return {moved:0,checked:0,matchedButFailed:0,firstWriteError:null};
      const stuck=catalogItems.filter(item=>item.category_id===holding.id);
      const choices=categories.filter(category=>category.id!==holding.id);
      const working=[...catalogItems];
      const assignments=[];
      for(const item of stuck){
        const suggested=suggestCategory(item.name,choices,working);
        const target=suggested?.category;
        if(!target)continue;
        if(target.range_start==null||Number(target.range_start)<=0)throw new Error("This category needs an item-number range.");
        const review=suggested.confidence!=="confident";
        const members=working.filter(candidate=>Number(candidate.master_item_number)>=Number(target.range_start)&&Number(candidate.master_item_number)<=Number(target.range_end||Number.MAX_SAFE_INTEGER));
        const number=(members.length?Math.max(...members.map(candidate=>candidate.master_item_number||0))+1:(target.range_start));
        const index=working.findIndex(candidate=>candidate.id===item.id);
        if(index>=0)working[index]={...working[index],category_id:target.id,master_item_number:number};
        assignments.push({itemId:item.id,categoryId:target.id,masterItemNumber:number,review,reason:review?suggested.reason:null});
      }
      const results=await Promise.all(assignments.map(row=>table("catalog_items").update({category_id:row.categoryId,...(row.masterItemNumber==null?{}:{master_item_number:row.masterItemNumber}),category_review:row.review,category_reason:row.reason}).eq("id",row.itemId)));
      const moved=results.filter(result=>!result.error).length;
      return {moved,checked:stuck.length,matchedButFailed:assignments.length-moved,firstWriteError:results.find(result=>result.error)?.error?.message||null};
    },
  };
}

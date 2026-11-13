// Catalog writes expressed in KERDOS business language. The service depends
// only on the provider's generic table capability; UI code never names or
// imports a database vendor.
import {prepareCatalogCorrection} from "./catalog-rows.js";
import {PRODUCT_LABEL_METHOD,productLabelLinked} from "../core/label-association.js";
import {MATCH_POLICY,nextCategoryRange,abbreviationPairs,getProcurementContext} from "../procurement.js";

// An association is a customer's assertion about identity. Ordering eligibility
// additionally requires agreement with the existing vendor product's pack and
// description. Never turn an unverified manual association into an exact quote.
export function mappingVerification(vendorItem,catalogItem,linkedVendorItems=[], procurement=getProcurementContext()){
  if(!vendorItem||!catalogItem)throw new Error("Choose a vendor product and a catalog item.");
  const peers=linkedVendorItems.filter(peer=>peer.id!==vendorItem.id);
  const descriptions=peers.length?peers.map(peer=>peer.description):[catalogItem.name];
  const identity=descriptions.map(description=>procurement.compareProductIdentity(vendorItem.description,description));
  const packs=peers.map(peer=>procurement.comparePurchasingPack(vendorItem.pack_size,peer.pack_size));
  const _brandsAgree=peers.every(peer=>!vendorItem.brand&&!peer.brand||procurement.brandsMatch(vendorItem.brand,peer.brand));
  const identifiersAgree=peers.every(peer=>(!vendorItem.gtin||!peer.gtin||vendorItem.gtin===peer.gtin)&&
    (!vendorItem.manufacturer_code||!peer.manufacturer_code||vendorItem.manufacturer_code===peer.manufacturer_code));
  // When every peer shares a GTIN (or mfr code + brand), the identifier resolves
  // abbreviation uncertainty — "CHIC BRST" and "Chicken Breast Boneless" are the
  // same trade item when their barcodes match. But identifier agreement does not
  // override an explicit product conflict: when descriptions name demonstrably
  // different products (no shared core terms, or explicitly different attributes),
  // the GTIN data is suspect (mis-scan, data error) and must not be trusted.
  // The gap code "wording" with "No shared defining product terms" is the reliable
  // signal — compareProductIdentity alone sometimes returns "review" for
  // zero-overlap descriptions when unresolved abbreviations prevent the "different"
  // path, so we use mappingGap with peers as the conflict detector.
  const allPeersHaveIdentifier=peers.length>0&&peers.every(peer=>
    (vendorItem.gtin&&peer.gtin&&vendorItem.gtin===peer.gtin)||
    (vendorItem.manufacturer_code&&peer.manufacturer_code&&vendorItem.manufacturer_code===peer.manufacturer_code&&
      vendorItem.brand&&peer.brand&&procurement.brandsMatch(vendorItem.brand,peer.brand)));
  // Two signals for an explicit conflict. mappingGap catches zero-overlap descriptions
  // even when unresolved abbreviations prevent compareProductIdentity from reaching
  // "different". compareProductIdentity "different" catches confirmed conflicts
  // (boneless vs bone-in, ground beef vs whole muscle) where terms fully resolve.
  // Either signal means the GTIN data is suspect; don't grant exact.
  const noProductConflict=allPeersHaveIdentifier&&!peers.some((peer,i)=>{
    if(identity[i]?.status==="different")return true;
    const g=mappingGap(vendorItem,catalogItem,[peer], procurement);
    return g.code==="wording"&&g.detail==="No shared defining product terms";
  });
  const identityOk=(allPeersHaveIdentifier&&noProductConflict)||identity.every(result=>result.status==="same");
  // When the catalog item has a locked brand, the vendor item's own brand must match
  // the locked brand directly — peer brand agreement is irrelevant here (a peer with a
  // different brand is already blocked separately by orderGuideAssessment's brand blocker
  // and must not prevent verification for a vendor item whose brand IS correct).
  // When not brand-locked, brand is not a gating criterion for exact verification.
  const brandOk=!catalogItem.brand_locked||procurement.brandsMatch(vendorItem.brand,catalogItem.locked_brand);
  const exact=!!procurement.parsePackSize(vendorItem.pack_size)?.parsed&&brandOk&&identifiersAgree&&identityOk&&packs.every(result=>result.status==="same");
  return {comparison_track:exact?"exact":"review",confidence_score:exact?100:null,match_method:"manual"};
}
async function run(promise,operation){
  const {data,error}=await promise;
  if(error)throw Object.assign(new Error(`${operation}: ${error.message}`),{code:error.code});
  return data;
}

// Why an association is not at 100%, as one fixed code per mapping. The
// codes are what makes the Not mapped list workable: grouped by code, one
// parser fix or one bulk confirm clears a whole group instead of one row.
export const GAP_LABELS={
  "pack-missing":"Pack size missing",
  "pack-unreadable":"Pack size can't be read",
  "single-vendor-ready":"Single vendor — fields still to complete",
  "single-vendor-detail":"Single vendor — wording differs from catalog item",
  "brand-conflict":"Brand differs from linked vendor",
  "pack-conflict":"Pack differs from linked vendor",
  "wording":"Wording differs from linked vendor",
};
export function mappingGap(vendorItem,catalogItem,peers=[], procurement=getProcurementContext()){
  if(!vendorItem||!catalogItem)return {code:"wording",label:GAP_LABELS.wording,detail:"Vendor product or catalog item is missing"};
  if(!vendorItem.pack_size)return {code:"pack-missing",label:GAP_LABELS["pack-missing"],detail:"No pack on the vendor listing"};
  if(!procurement.parsePackSize(vendorItem.pack_size)?.parsed)return {code:"pack-unreadable",label:GAP_LABELS["pack-unreadable"],detail:`"${vendorItem.pack_size}" is not a complete pack KERDOS can read`};
  const others=peers.filter(peer=>peer.id!==vendorItem.id);
  if(!others.length){
    const identity=procurement.compareProductIdentity(vendorItem.description,catalogItem.name);
    return identity.status==="same"
      ?{code:"single-vendor-ready",label:GAP_LABELS["single-vendor-ready"],detail:"Only one vendor lists this product; confirm to make it orderable"}
      :{code:"single-vendor-detail",label:GAP_LABELS["single-vendor-detail"],detail:identity.reason};
  }
  // Brand difference only blocks when the client has set "Require this brand" (brand_locked).
  // When brand sensitivity is off, different brands are acceptable alternatives.
  const brandClash=catalogItem.brand_locked&&others.find(peer=>vendorItem.brand&&peer.brand&&!procurement.brandsMatch(vendorItem.brand,peer.brand));
  if(brandClash)return {code:"brand-conflict",label:GAP_LABELS["brand-conflict"],detail:`${vendorItem.brand} vs ${brandClash.brand} (brand required)`};
  const packClash=others.map(peer=>({peer,result:procurement.comparePurchasingPack(vendorItem.pack_size,peer.pack_size)})).find(entry=>entry.result.status!=="same");
  if(packClash)return {code:"pack-conflict",label:GAP_LABELS["pack-conflict"],detail:`${vendorItem.pack_size} vs ${packClash.peer.pack_size||"none"}`};
  const wordClash=others.map(peer=>procurement.compareProductIdentity(vendorItem.description,peer.description)).find(result=>result.status!=="same");
  return {code:"wording",label:GAP_LABELS.wording,detail:wordClash?.reason||"Defining details need confirmation"};
}

// A barcode or a manufacturer code proves identity the way wording never
// can: the same GTIN from two vendors is the same trade item by
// definition, and the same manufacturer code under the same brand is the
// same part. Identity still says nothing about the pack, so the pack is
// checked separately: same pack → exact; different or unreadable pack →
// review, with the reason spelled out.
export function identifierMatch({gtin=null,manufacturerCode=null,brand=null,packSize=null,vendorId=null},candidates=[], procurement=getProcurementContext()){
  for(const candidate of candidates){
    const peers=(candidate.linkedVendorItems||[]).filter(vi=>!vendorId||vi.vendor_id!==vendorId);
    const byGtin=gtin?peers.find(vi=>vi.gtin&&vi.gtin===gtin):null;
    const byMfr=!byGtin&&manufacturerCode?peers.find(vi=>vi.manufacturer_code&&vi.manufacturer_code===manufacturerCode&&vi.brand&&brand&&procurement.brandsMatch(vi.brand,brand)):null;
    const witness=byGtin||byMfr;
    if(!witness)continue;
    const via=byGtin?"barcode":"manufacturer code";
    const pack=procurement.comparePurchasingPack(packSize,witness.pack_size);
    const allAgree=candidate.linkedVendorItems.every(peer=>procurement.comparePurchasingPack(packSize,peer.pack_size).status==="same"&&
      (!brand||!peer.brand||procurement.brandsMatch(brand,peer.brand))&&
      (!gtin||!peer.gtin||peer.gtin===gtin)&&
      (!manufacturerCode||!peer.manufacturer_code||!brand||!peer.brand||
        !procurement.brandsMatch(brand,peer.brand)||peer.manufacturer_code===manufacturerCode));
    if(pack.status==="same"&&allAgree)return {catalogItem:candidate,track:"exact",score:1,method:"identifier",reason:`Same ${via} as an existing vendor listing in the same pack`};
    return {catalogItem:candidate,track:"similar",score:0.9,method:"identifier",reason:`Same ${via} as an existing vendor listing, but the pack differs or is unreadable (${packSize||"none"} vs ${witness.pack_size||"none"})`};
  }
  return null;
}

// Record the evidence used for an automatic association. A match to the
// catalog label alone cannot override a conflicting linked vendor listing.
export function associationEvidence({description,packSize,brand,gtin,manufacturerCode},candidate, procurement=getProcurementContext()){
  const peers=candidate.linkedVendorItems||[];
  const brandLocked=candidate.brand_locked??false;
  const checks=peers.map(peer=>({
    identity:procurement.compareProductIdentity(description,peer.description).status,
    pack:procurement.comparePurchasingPack(packSize,peer.pack_size).status,
    // When brand_locked=false, different brands are acceptable alternatives —
    // the same product sold under different brand names should share one KERDOS entry.
    // When brand_locked=true, brands must agree.
    brand:!brandLocked||!brand||!peer.brand||procurement.brandsMatch(brand,peer.brand),
    identifier:(!gtin||!peer.gtin||gtin===peer.gtin)&&
      (!manufacturerCode||!peer.manufacturer_code||!brand||!peer.brand||
        !procurement.brandsMatch(brand,peer.brand)||manufacturerCode===peer.manufacturer_code),
  }));
  return {peers:checks.length,checks,exact:checks.length>0&&checks.every((c,i)=>
    (c.identity==="same"||!!gtin&&peers[i].gtin===gtin||
      !!manufacturerCode&&!!brand&&procurement.brandsMatch(brand,peers[i].brand)&&peers[i].manufacturer_code===manufacturerCode)&&
    c.pack==="same"&&c.brand&&c.identifier)};
}

// Mappings the engine is allowed to verify on its own under the agreed
// rule: a second vendor already carries the same exact product in the
// same pack, brands agree, and the pack is readable. These typically
// appear after the vocabulary learns a spelling or a pack is corrected,
// when an earlier "review" decision would now come out "exact".
export function engineVerifiable({mappings=[],vendorItems=[],catalogItems=[]}, procurement=getProcurementContext()){
  const viById=new Map(vendorItems.map(vi=>[vi.id,vi]));
  const ciById=new Map(catalogItems.map(ci=>[ci.id,ci]));
  const byCatalog=new Map();
  for(const m of mappings){const list=byCatalog.get(m.catalog_item_id)||[];list.push(m);byCatalog.set(m.catalog_item_id,list);}
  const ready=[];
  for(const m of mappings){
    if(productLabelLinked(m)||m.comparison_track==="exact"&&m.confidence_score===100)continue;
    const vendorItem=viById.get(m.vendor_item_id),catalogItem=ciById.get(m.catalog_item_id);
    if(!vendorItem||!catalogItem)continue;
    const peers=(byCatalog.get(m.catalog_item_id)||[]).filter(other=>other.id!==m.id).map(other=>viById.get(other.vendor_item_id)).filter(Boolean);
    const witnesses=peers.filter(peer=>peer.vendor_id&&peer.vendor_id!==vendorItem.vendor_id&&peer.pack_size);
    if(!witnesses.length)continue;
    const verification=mappingVerification(vendorItem,catalogItem,peers, procurement);
    if(verification.comparison_track!=="exact")continue;
    ready.push({mappingId:m.id,vendorItemId:vendorItem.id,catalogItemId:catalogItem.id,description:vendorItem.description,packSize:vendorItem.pack_size,
      verification:{...verification,match_method:"rule_based"}});
  }
  return ready;
}

function descriptionFallback({label,eligible,vendorItems,mappings,procurement}){
  const listings=new Map(vendorItems.map(row=>[row.id,row]));
  const peers=new Map();
  for(const mapping of mappings){
    const row=listings.get(mapping.vendor_item_id);
    if(!row)continue;
    const linked=peers.get(mapping.catalog_item_id)||[];
    linked.push(row);
    peers.set(mapping.catalog_item_id,linked);
  }
  const matches=[];
  for(const item of eligible){
    const descriptions=peers.get(item.id)||[];
    const reads=[procurement.readProductLabel({description:item.name}),...descriptions.map(row=>procurement.readProductLabel(row))];
    // Saved product keys and recognized peer forms can veto a wording match.
    const recognized=[item.concept_key,...reads.filter(read=>read.status==="recognized").map(read=>read.key)]
      .filter(key=>key?.startsWith("product:"));
    if(label.status==="recognized"&&recognized.some(key=>key!==label.key))continue;
    if(reads.some(read=>read.key&&(read.formKey||label.formKey)&&read.formKey!==label.formKey))continue;
    if(item.concept_key&&item.concept_key!==label.key)continue;
    const wording=reads.filter(read=>read.comparisonText).map(read=>({
      comparison:procurement.compareProductIdentity(label.comparisonText,read.comparisonText),
      score:procurement.safeProductScore(label.comparisonText,read.comparisonText),
    }));
    if(!wording.some(({comparison,score})=>comparison.status!=="different"&&score>=0.35))continue;
    const clear=wording.some(({comparison,score})=>comparison.status==="same"&&score>=MATCH_POLICY.autoLink)
      ||label.status==="recognized"&&reads.some(read=>read.key===label.key);
    matches.push({item,clear});
  }
  const clear=matches.filter(candidate=>candidate.clear);
  if(clear.length===1)return {item:clear[0].item,created:false};
  return {reason:matches.length?"Description could match more than one reading; confirm the product":null};
}

export function createCatalogService(backend,importProcurement){
  const table=backend.records.query;
  // Writes a confirmation to one mapping, refusing if the catalog item has
  // changed since the operator loaded the page (stale-mapping guard).
  async function confirmOne(mappingId,verification,expectedCatalogItemId){
    if(!expectedCatalogItemId)throw new Error("The current catalog item ID is required to confirm a match.");
    const updated=await run(
      table("item_mappings").update(verification).eq("id",mappingId).eq("catalog_item_id",expectedCatalogItemId).select("id"),
      "Could not confirm the match"
    );
    if(!updated?.length)throw new Error("The association changed since you loaded this page; refresh and try again.");
  }
  return {
    async matchOrCreate({organizationId,description,packSize,brand=null,vendorListingId=null,categoryId=null,catalogItems,categories,vendorItems=[],mappings=[]}){
      const procurement=importProcurement??getProcurementContext();
      const candidate=procurement.readProductLabel({description,packSize,brand});
      const label=candidate.key&&new TextEncoder().encode(candidate.key).length>1024
        ?{...candidate,key:null,reason:"Product label is too long to identify safely"}:candidate;
      const name=(label.label||String(description).trim()).slice(0,120);
      const rejectedItems=new Set(mappings.filter(mapping=>mapping.match_method==="rejected").map(mapping=>mapping.catalog_item_id));
      const eligible=catalogItems.filter(item=>!item.merged_into_id&&!item.retired_at
        &&(!item.lifecycle_state||item.lifecycle_state==='active')
        &&!item.concept_split_from_id&&!item.concept_review_required&&!rejectedItems.has(item.id)
        &&(!item.organization_id||item.organization_id===organizationId));
      const find=async placement=>{
        const params={
          p_organization_id:organizationId,p_concept_key:label.key,p_name:name,
          p_category_id:placement?.category.id??null,p_category_review:placement?.review??false,
          p_category_reason:placement?.reason??null,
        };
        if(backend.catalog?.findOrCreateProductItem)return backend.catalog.findOrCreateProductItem(params);
        if(backend.rpc)return run(backend.rpc("kerdos_find_or_create_product_item",params),"Could not resolve the product label");
        // Portable providers can supply the atomic operation through catalog.
        // A records-only provider supports exact lookups but cannot create a keyed item.
        const normalize=value=>String(value||'').trim().replace(/\s+/g,' ').toLowerCase();
        const matches=eligible.filter(item=>item.concept_key===label.key)
          .sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||''))||String(a.id).localeCompare(String(b.id)));
        const item=matches[0]||eligible.find(row=>!row.concept_key&&normalize(row.name)===normalize(name));
        if(item||!placement)return {item,created:false,sameLabelCount:matches.length};
        throw new Error("This catalog provider does not support atomic product assignment.");
      };
      const placed=({item,created=false,sameLabelCount=0},reason)=>{
        if(!catalogItems.some(current=>current.id===item.id))catalogItems.push(item);
        const splitNotice=sameLabelCount>1?" More than one saved item has this label. The original or oldest eligible item was used.":"";
        return {catalogItemId:item.id,track:"exact",score:0.9,method:PRODUCT_LABEL_METHOD,created,sameLabelCount,
          reason:(reason||(created?"Created from the product label":"Matched the saved product label"))+splitNotice};
      };
      let reviewReason=label.reason;
      if(label.key){
        const saved=await find();
        if(saved?.item)return placed(saved);
        const fallback=descriptionFallback({label,eligible,vendorItems,mappings,procurement});
        if(fallback.item)return placed(fallback,"Matched a compatible product description");
        reviewReason=fallback.reason;
      }

      const placement=await this.placeInCategory({organizationId,description,categoryId,categories,catalogItems});
      if(!reviewReason&&label.key){
        const result=await find(placement);
        if(!result?.item)throw new Error("The catalog did not return a product assignment.");
        return placed(result);
      }
      // Keep ambiguous source evidence on its own provisional catalog entry.
      // No automatic link is made to any of the competing products.
      const reference=vendorListingId? ` [${vendorListingId}]` : "";
      const reason=reviewReason||"Product identity needs review";
      const item=await this.createItem({organizationId,name:name.slice(0,120-reference.length)+reference,categoryId:placement.category.id,
        categoryReview:placement.review,categoryReason:placement.reason,catalogItems,categories,identityReview:reason});
      catalogItems.push(item);
      return {catalogItemId:item.id,track:"review",score:0.7,method:"rule_based",created:true,
        identityReview:true,reason};
    },
    // Most likely category first, holding pen last. A guessed placement is
    // flagged for review so the client confirms or moves it, instead of
    // filing every new product from scratch.
    async placeInCategory({organizationId,description,categoryId=null,categories,catalogItems}){
      if(categoryId){
        const selected=categories.find(category=>category.id===categoryId&&!category.is_holding_pen);
        if(!selected)throw new Error("Choose an available category for this organization.");
        return {category:selected,review:false,reason:null};
      }
      const suggested=(importProcurement??getProcurementContext()).suggestCategory(description,categories,catalogItems);
      if(suggested)return {category:suggested.category,review:suggested.confidence!=="confident",reason:suggested.confidence==="confident"?null:suggested.reason};
      return {category:await this.ensureHoldingCategory(organizationId,categories),review:true,reason:"Category unknown; select a category to move this entire item and its vendor listings"};
    },
    async ensureHoldingCategory(organizationId,categories){
      const existing=categories.find(category=>category.is_holding_pen)||null;
      if(existing)return existing;
      const {range_start,range_end}=nextCategoryRange(categories);
      let created;
      try{
        created=await run(table("catalog_categories").insert({organization_id:organizationId,name:"Uncategorized",is_holding_pen:true,range_start,range_end,keywords:[]}).select().single(),"Could not create the holding category");
      }catch(error){
        if(error.code!=="23505")throw error;
        created=await run(table("catalog_categories").select("*").eq("organization_id",organizationId)
          .eq("is_holding_pen",true).maybeSingle(),"Could not load the holding category");
        if(!created)throw error;
      }
      categories.push(created);
      return created;
    },
    async createItem({organizationId,name,categoryId,categoryReview=false,categoryReason=null,catalogItems,categories,conceptKey=null,splitFromId=null,identityReview=false}){
      const category=categories.find(candidate=>candidate.id===categoryId)||null;
      if(!category||!Number.isFinite(Number(category.range_start))||category.range_start==null||Number(category.range_start)<=0)throw new Error("This category needs an item-number range before creating an item.");
      // Include numbers from items later moved to another category. Their
      // KERDOS numbers remain theirs and must never be recycled here.
      const itemsInCategory=catalogItems.filter(item=>item.master_item_number>=Number(category.range_start)&&
        item.master_item_number<=Number(category?.range_end||Number.MAX_SAFE_INTEGER));
      const masterItemNumber=itemsInCategory.length?Math.max(...itemsInCategory.map(item=>item.master_item_number||0))+1:(category.range_start);
      if(category.range_end!=null&&masterItemNumber>Number(category.range_end))throw new Error("This category item-number range is full.");
      const productFields=identityReview?{concept_review_required:true,concept_review_reason:identityReview}:{};
      if(splitFromId){
        productFields.concept_split_from_id=splitFromId;
        if(conceptKey){
          productFields.concept_key=conceptKey;
          productFields.concept_key_set_at=new Date().toISOString();
        }
      }
      return run(table("catalog_items").insert({organization_id:organizationId,category_id:categoryId||null,master_item_number:masterItemNumber,name:name.slice(0,120),matching_behavior:"flexible",canonical_unit:null,brand_locked:false,category_review:!!categoryReview,category_reason:categoryReason||null,...productFields}).select().single(),"Could not create the item");
    },
    // The client's word on a guessed placement: keep it where it is.
    confirmCategory(catalogItemId){
      // Write category_reason:"confirmed" so that a current engine "review"
      // result cannot silently downgrade an explicitly accepted placement.
      // category_reason non-null → catAcc=DERIVED (90) regardless of engine.
      return run(table("catalog_items").update({category_review:false,category_reason:"confirmed"}).eq("id",catalogItemId),"Could not confirm the category");
    },
    async confirmCategories(catalogItemIds){
      let confirmed=0;
      for(const id of catalogItemIds){await this.confirmCategory(id);confirmed++;}
      return confirmed;
    },
    async splitMapping({organizationId,mappingId,description,catalogItems,categories,expectedCatalogItemId}){
      if(!expectedCatalogItemId)throw new Error("The current catalog item ID is required to create a separate item.");
      // Read vendor_item_id AND catalog_item_id before creating anything so
      // we can detect a stale page without leaving an orphan.
      const mapping=await run(table("item_mappings").select("vendor_item_id,catalog_item_id").eq("id",mappingId).single(),"Could not read the current association");
      // Stale-before-call guard: if the mapping already moved on before this
      // call started, refuse now before creating the new catalog item.
      if(mapping.catalog_item_id!==expectedCatalogItemId)
        throw new Error("The association changed since you loaded this page; refresh and try again.");
      const placement=await this.placeInCategory({organizationId,description,categories,catalogItems});
      const original=catalogItems.find(item=>item.id===expectedCatalogItemId);
      const created=await this.createItem({organizationId,name:description,categoryId:placement.category?.id||null,categoryReview:placement.review,categoryReason:placement.reason,catalogItems,categories,conceptKey:original?.concept_key,splitFromId:original?.concept_split_from_id||expectedCatalogItemId});
      const vendorItem=await run(table("vendor_items").select("*").eq("id",mapping.vendor_item_id).single(),"Could not read the vendor product");
      const verification=mappingVerification(vendorItem,created);
      // Concurrent-change guard: refuse if another session remapped this
      // mapping between the read above and this write.  Clean up the newly
      // created catalog item first so it does not become an orphan.
      const updated=await run(
        table("item_mappings").update({catalog_item_id:created.id,...verification})
          .eq("id",mappingId).eq("catalog_item_id",mapping.catalog_item_id).select("id"),
        "Could not point the vendor item at it"
      );
      if(!updated?.length){
        try{await run(table("catalog_items").delete().eq("id",created.id),"cleanup");}catch{}
        throw new Error("The association changed since you loaded this page; refresh and try again.");
      }
      return created;
    },
    // Reject the current catalog match and give the vendor item its own
    // standalone catalog item.  The actual DB work (create item, update
    // mapping, append rejected_catalog_item_ids) runs inside the
    // kerdos_reject_mapping RPC so everything is atomic and authorized
    // at the DB level.  Returns {catalogItemId, masterItemNumber,
    // rejectedCatalogItemId} from the RPC.
    async rejectMapping(mappingId,vendorItemRevision,{organizationId,expectedCatalogItemId}={}){
      if(vendorItemRevision==null)throw new Error("Reload this product before rejecting it.");
      if(expectedCatalogItemId==null)throw new Error("The current catalog item ID is required to reject a match.");
      return run(
        backend.rpc("kerdos_reject_mapping",{
          p_organization_id:organizationId,
          p_mapping_id:mappingId,
          p_expected_revision:vendorItemRevision,
          p_expected_catalog_item_id:expectedCatalogItemId,
        }),
        "Could not reject the match"
      );
    },
    confirmMapping(mappingId,verification,expectedCatalogItemId){
      if(!verification)throw new Error("Check this product against the catalog and its vendor packs before confirming.");
      return confirmOne(mappingId,verification,expectedCatalogItemId);
    },
    async correctVendorFields({organizationId,vendorItem,mappingId,description,brand,packSize}){
      const patch={description,brand,pack_size:packSize};
      const request=prepareCatalogCorrection({organizationId,vendorItem,mapping:{id:mappingId,vendor_item_id:vendorItem?.id,organization_id:organizationId},patch});
      await backend.catalog.saveRow(request);
      return true;
    },
    async confirmMappings(entries){
      let confirmed=0;
      for(const entry of entries){
        if(!entry?.verification||entry.verification.comparison_track!=="exact")throw new Error("Only fully verified associations can be confirmed in bulk.");
        await confirmOne(entry.mappingId,entry.verification,entry.catalogItemId);
        confirmed++;
      }
      return confirmed;
    },
    // Save the abbreviations a confirmation revealed, so the same wording
    // never needs a second confirmation. Only spelling pairs are saved
    // (see abbreviationPairs); existing terms are left alone.
    async learnAbbreviations({organizationId,description,references=[],vocabulary=[]}){
      const known=new Set(vocabulary.filter(row=>row.kind==="synonym").map(row=>String(row.term).toLowerCase()));
      const pairs=abbreviationPairs(description,references).filter(pair=>!known.has(pair.term));
      if(!pairs.length)return [];
      await run(table("org_vocabulary").insert(pairs.map(pair=>({organization_id:organizationId,kind:"synonym",term:pair.term,canonical:pair.canonical}))),"Could not save the learned wording");
      return pairs;
    },
    // Remap the vendor item to a different (or previously rejected) catalog item.
    // When the operator deliberately maps back to an item that was previously
    // rejected, remove only that UUID from rejected_catalog_item_ids so the
    // deliberate choice is recorded without wiping other rejections.
    // Remap the vendor item to a different (or previously rejected) catalog item.
    // When the destination is in rejected_catalog_item_ids, uses an atomic RPC
    // (kerdos_remap_to_rejected) that clears the rejection, updates the mapping,
    // and bumps row_revision in one transaction, with stale-mapping and
    // stale-revision checks.
    // For any other remap, a plain mapping update is safe (no rejection to clear).
    async remapToExisting(mappingId,catalogItemId,verification,{vendorItemId,currentFieldResolutions,vendorItemRevision,expectedCatalogItemId,organizationId}={}){
      if(!verification)throw new Error("Check this product against the destination and its vendor packs before moving it.");
      if(vendorItemId&&currentFieldResolutions){
        const rejected=currentFieldResolutions.rejected_catalog_item_ids||[];
        if(rejected.includes(catalogItemId)){
          // Atomic path: one RPC handles the rejection-clear, mapping update, and revision bump.
          return run(
            backend.rpc("kerdos_remap_to_rejected",{
              p_organization_id:organizationId,
              p_mapping_id:mappingId,
              p_new_catalog_item_id:catalogItemId,
              p_expected_revision:vendorItemRevision??null,
              p_expected_catalog_item_id:expectedCatalogItemId??null,
              p_comparison_track:verification.comparison_track,
              p_confidence_score:verification.confidence_score,
              p_match_method:verification.match_method,
            }),
            "Could not remap to the previously-rejected item"
          );
        }
      }
      // Plain path: apply the same stale-mapping guard used in confirmOne
      // and kerdos_reject_mapping — refuse if the catalog item the
      // operator loaded is no longer the current one.
      if(!expectedCatalogItemId)throw new Error("The current catalog item ID is required to remap.");
      const updated=await run(
        table("item_mappings").update({catalog_item_id:catalogItemId,...verification})
          .eq("id",mappingId).eq("catalog_item_id",expectedCatalogItemId).select("id"),
        "Could not remap the item"
      );
      if(!updated?.length)throw new Error("The association changed since you loaded this page; refresh and try again.");
    },
    renameItem(catalogItemId,name){
      return run(table("catalog_items").update({name:name.slice(0,120)}).eq("id",catalogItemId),"Could not rename the item");
    },
    updateItemSettings(catalogItemId,patch){
      return run(table("catalog_items").update(patch).eq("id",catalogItemId),"Could not save that setting");
    },
    assignVendorItem({organizationId,vendorItemId,catalogItemId,mappingId=null,verification}){
      if(!verification)throw new Error("Check the vendor product and catalog pack before assigning it.");
      if(mappingId){
        return run(table("item_mappings").update({catalog_item_id:catalogItemId,...verification}).eq("id",mappingId),"Could not update the link");
      }
      return run(table("item_mappings").insert({organization_id:organizationId,catalog_item_id:catalogItemId,vendor_item_id:vendorItemId,...verification}),"Could not create the link");
    },
  };
}

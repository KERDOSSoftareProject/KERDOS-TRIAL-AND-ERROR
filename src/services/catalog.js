// Catalog writes expressed in KERDOS business language. The service depends
// only on the provider's generic table capability; UI code never names or
// imports a database vendor.
import {prepareCatalogCorrection} from "./catalog-rows.js";
import {bestPurchasingMatch,bestPurchasingSuggestion,suggestCategory,nextCategoryRange,compareProductIdentity,comparePurchasingPack,commonPurchasingPack,brandsMatch,parsePackSize,abbreviationPairs} from "../procurement.js";

// An association is a customer's assertion about identity. Ordering eligibility
// additionally requires agreement with the existing vendor product's pack and
// description. Never turn an unverified manual association into an exact quote.
export function mappingVerification(vendorItem,catalogItem,linkedVendorItems=[]){
  if(!vendorItem||!catalogItem)throw new Error("Choose a vendor product and a catalog item.");
  const peers=linkedVendorItems.filter(peer=>peer.id!==vendorItem.id);
  const descriptions=peers.length?peers.map(peer=>peer.description):[catalogItem.name];
  const identity=descriptions.map(description=>compareProductIdentity(vendorItem.description,description));
  const packs=peers.map(peer=>comparePurchasingPack(vendorItem.pack_size,peer.pack_size));
  const brandsAgree=peers.every(peer=>!vendorItem.brand&&!peer.brand||brandsMatch(vendorItem.brand,peer.brand));
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
      vendorItem.brand&&peer.brand&&brandsMatch(vendorItem.brand,peer.brand)));
  // Two signals for an explicit conflict. mappingGap catches zero-overlap descriptions
  // even when unresolved abbreviations prevent compareProductIdentity from reaching
  // "different". compareProductIdentity "different" catches confirmed conflicts
  // (boneless vs bone-in, ground beef vs whole muscle) where terms fully resolve.
  // Either signal means the GTIN data is suspect; don't grant exact.
  const noProductConflict=allPeersHaveIdentifier&&!peers.some((peer,i)=>{
    if(identity[i]?.status==="different")return true;
    const g=mappingGap(vendorItem,catalogItem,[peer]);
    return g.code==="wording"&&g.detail==="No shared defining product terms";
  });
  const identityOk=(allPeersHaveIdentifier&&noProductConflict)||identity.every(result=>result.status==="same");
  const brandOk=!catalogItem.brand_locked||brandsAgree;
  const exact=!!parsePackSize(vendorItem.pack_size)?.parsed&&brandOk&&identifiersAgree&&identityOk&&packs.every(result=>result.status==="same");
  return {comparison_track:exact?"exact":"review",confidence_score:exact?100:null,match_method:"manual"};
}
async function run(promise,operation){
  const {data,error}=await promise;
  if(error)throw new Error(`${operation}: ${error.message}`);
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
export function mappingGap(vendorItem,catalogItem,peers=[]){
  if(!vendorItem||!catalogItem)return {code:"wording",label:GAP_LABELS.wording,detail:"Vendor product or catalog item is missing"};
  if(!vendorItem.pack_size)return {code:"pack-missing",label:GAP_LABELS["pack-missing"],detail:"No pack on the vendor listing"};
  if(!parsePackSize(vendorItem.pack_size)?.parsed)return {code:"pack-unreadable",label:GAP_LABELS["pack-unreadable"],detail:`"${vendorItem.pack_size}" is not a complete pack KERDOS can read`};
  const others=peers.filter(peer=>peer.id!==vendorItem.id);
  if(!others.length){
    const identity=compareProductIdentity(vendorItem.description,catalogItem.name);
    return identity.status==="same"
      ?{code:"single-vendor-ready",label:GAP_LABELS["single-vendor-ready"],detail:"Only one vendor lists this product; confirm to make it orderable"}
      :{code:"single-vendor-detail",label:GAP_LABELS["single-vendor-detail"],detail:identity.reason};
  }
  // Brand difference only blocks when the client has set "Require this brand" (brand_locked).
  // When brand sensitivity is off, different brands are acceptable alternatives.
  const brandClash=catalogItem.brand_locked&&others.find(peer=>vendorItem.brand&&peer.brand&&!brandsMatch(vendorItem.brand,peer.brand));
  if(brandClash)return {code:"brand-conflict",label:GAP_LABELS["brand-conflict"],detail:`${vendorItem.brand} vs ${brandClash.brand} (brand required)`};
  const packClash=others.map(peer=>({peer,result:comparePurchasingPack(vendorItem.pack_size,peer.pack_size)})).find(entry=>entry.result.status!=="same");
  if(packClash)return {code:"pack-conflict",label:GAP_LABELS["pack-conflict"],detail:`${vendorItem.pack_size} vs ${packClash.peer.pack_size||"none"}`};
  const wordClash=others.map(peer=>compareProductIdentity(vendorItem.description,peer.description)).find(result=>result.status!=="same");
  return {code:"wording",label:GAP_LABELS.wording,detail:wordClash?.reason||"Defining details need confirmation"};
}

// A barcode or a manufacturer code proves identity the way wording never
// can: the same GTIN from two vendors is the same trade item by
// definition, and the same manufacturer code under the same brand is the
// same part. Identity still says nothing about the pack, so the pack is
// checked separately: same pack → exact; different or unreadable pack →
// review, with the reason spelled out.
export function identifierMatch({gtin=null,manufacturerCode=null,brand=null,packSize=null,vendorId=null},candidates=[]){
  for(const candidate of candidates){
    const peers=(candidate.linkedVendorItems||[]).filter(vi=>!vendorId||vi.vendor_id!==vendorId);
    const byGtin=gtin?peers.find(vi=>vi.gtin&&vi.gtin===gtin):null;
    const byMfr=!byGtin&&manufacturerCode?peers.find(vi=>vi.manufacturer_code&&vi.manufacturer_code===manufacturerCode&&vi.brand&&brand&&brandsMatch(vi.brand,brand)):null;
    const witness=byGtin||byMfr;
    if(!witness)continue;
    const via=byGtin?"barcode":"manufacturer code";
    const pack=comparePurchasingPack(packSize,witness.pack_size);
    const allAgree=candidate.linkedVendorItems.every(peer=>comparePurchasingPack(packSize,peer.pack_size).status==="same"&&
      (!brand||!peer.brand||brandsMatch(brand,peer.brand))&&
      (!gtin||!peer.gtin||peer.gtin===gtin)&&
      (!manufacturerCode||!peer.manufacturer_code||!brand||!peer.brand||
        !brandsMatch(brand,peer.brand)||peer.manufacturer_code===manufacturerCode));
    if(pack.status==="same"&&allAgree)return {catalogItem:candidate,track:"exact",score:1,method:"identifier",reason:`Same ${via} as an existing vendor listing in the same pack`};
    return {catalogItem:candidate,track:"similar",score:0.9,method:"identifier",reason:`Same ${via} as an existing vendor listing, but the pack differs or is unreadable (${packSize||"none"} vs ${witness.pack_size||"none"})`};
  }
  return null;
}

// Record the evidence used for an automatic association. A match to the
// catalog label alone cannot override a conflicting linked vendor listing.
export function associationEvidence({description,packSize,brand,gtin,manufacturerCode},candidate){
  const peers=candidate.linkedVendorItems||[];
  const brandLocked=candidate.brand_locked??false;
  const checks=peers.map(peer=>({
    identity:compareProductIdentity(description,peer.description).status,
    pack:comparePurchasingPack(packSize,peer.pack_size).status,
    // When brand_locked=false, different brands are acceptable alternatives —
    // the same product sold under different brand names should share one KERDOS entry.
    // When brand_locked=true, brands must agree.
    brand:!brandLocked||!brand||!peer.brand||brandsMatch(brand,peer.brand),
    identifier:(!gtin||!peer.gtin||gtin===peer.gtin)&&
      (!manufacturerCode||!peer.manufacturer_code||!brand||!peer.brand||
        !brandsMatch(brand,peer.brand)||manufacturerCode===peer.manufacturer_code),
  }));
  return {peers:checks.length,checks,exact:checks.length>0&&checks.every((c,i)=>
    (c.identity==="same"||!!gtin&&peers[i].gtin===gtin||
      !!manufacturerCode&&!!brand&&brandsMatch(brand,peers[i].brand)&&peers[i].manufacturer_code===manufacturerCode)&&
    c.pack==="same"&&c.brand&&c.identifier)};
}

// Mappings the engine is allowed to verify on its own under the agreed
// rule: a second vendor already carries the same exact product in the
// same pack, brands agree, and the pack is readable. These typically
// appear after the vocabulary learns a spelling or a pack is corrected,
// when an earlier "review" decision would now come out "exact".
export function engineVerifiable({mappings=[],vendorItems=[],catalogItems=[]}){
  const viById=new Map(vendorItems.map(vi=>[vi.id,vi]));
  const ciById=new Map(catalogItems.map(ci=>[ci.id,ci]));
  const byCatalog=new Map();
  for(const m of mappings){const list=byCatalog.get(m.catalog_item_id)||[];list.push(m);byCatalog.set(m.catalog_item_id,list);}
  const ready=[];
  for(const m of mappings){
    if(m.comparison_track==="exact"&&m.confidence_score===100)continue;
    const vendorItem=viById.get(m.vendor_item_id),catalogItem=ciById.get(m.catalog_item_id);
    if(!vendorItem||!catalogItem)continue;
    const peers=(byCatalog.get(m.catalog_item_id)||[]).filter(other=>other.id!==m.id).map(other=>viById.get(other.vendor_item_id)).filter(Boolean);
    const witnesses=peers.filter(peer=>peer.vendor_id&&peer.vendor_id!==vendorItem.vendor_id&&peer.pack_size);
    if(!witnesses.length)continue;
    const verification=mappingVerification(vendorItem,catalogItem,peers);
    if(verification.comparison_track!=="exact")continue;
    ready.push({mappingId:m.id,vendorItemId:vendorItem.id,catalogItemId:catalogItem.id,description:vendorItem.description,packSize:vendorItem.pack_size,
      verification:{...verification,match_method:"rule_based"}});
  }
  return ready;
}

export function createCatalogService(backend){
  const table=backend.records.query;
  return {
    async matchOrCreate({organizationId,vendorId,description,packSize,brand=null,gtin=null,manufacturerCode=null,categoryId=null,catalogItems,categories,vendorItems=[],mappings=[]}){
      const byId=new Map(vendorItems.map(vi=>[vi.id,vi]));
      const candidates=catalogItems.map(ci=>{
        const linked=mappings.map(m=>m.catalog_item_id===ci.id?byId.get(m.vendor_item_id):null).filter(Boolean);
        const knownPack=commonPurchasingPack(linked.map(vi=>vi.pack_size));
        const knownBrands=[...new Set(linked.map(vi=>vi.brand).filter(Boolean))];
        return {...ci,pack_size:knownPack,knownBrand:knownBrands.length===1?knownBrands[0]:null,
          linkedVendorItems:linked,
          otherVendorPresent:!!vendorId&&linked.some(vi=>vi.vendor_id&&vi.vendor_id!==vendorId)};
      });
      // Identifiers come first: they settle identity without wording.
      // Same GTIN or manufacturer code + same pack = same item, same KERDOS number.
      // Multiple vendors on the same entry is the goal.
      const proven=identifierMatch({gtin,manufacturerCode,brand,packSize,vendorId},candidates);
      if(proven?.track==="exact"){
        const evidence=associationEvidence({description,packSize,brand,gtin,manufacturerCode},proven.catalogItem);
        if(evidence.exact)return {catalogItemId:proven.catalogItem.id,track:"exact",score:1,method:"identifier",reason:proven.reason};
      }
      const match=proven||bestPurchasingMatch(description,packSize,candidates);
      // Same description + same pack = same item = same KERDOS number.
      // Link the incoming vendor item to the existing entry directly.
      // Multiple vendors under one KERDOS number is exactly the goal.
      // brand_locked=true: brands must agree for auto-exact.
      // brand_locked=false (default): different brands are acceptable — unlocked items
      // are generic; multiple competing brands share the same entry.
      const brandLocked=match?.catalogItem?.brand_locked??false;
      const brandVerified=match&&(!brandLocked||!brand||!match.catalogItem.knownBrand||brandsMatch(brand,match.catalogItem.knownBrand));
      if(match?.track==="exact"&&brandVerified){
        const evidence=associationEvidence({description,packSize,brand,gtin,manufacturerCode},match.catalogItem);
        if(evidence.exact)return {catalogItemId:match.catalogItem.id,track:"exact",score:1,method:"description_pack",reason:"Same description and pack as an existing item"};
      }
      // Different purchasing packs are separate catalog items even when the product
      // description is the same. 3/12 LB and 1/12 LB of CHEESE PROVOLONE SLICING are
      // distinct purchasing units — sharing one catalog entry hides the distinction and
      // makes price-per-unit comparison ambiguous. A human can always link two separate
      // entries; a false shared entry is harder to undo.
      // When a similar match exists (identity uncertain or pack doesn't match), fall through
      // to create a new entry. Mixed or unknown packs do NOT trigger automatic attachment —
      // without confirmed identity, pack, and brand-lock agreement a link is unsafe.
      if(match?.track==="similar"){
        // No automatic attachment for any similar match — fall through to new entry.
        // If a suggestion exists with confirmed identity ("same"), it is offered below.
      }

      // Fix 2: only suggest when description identity is confirmed same, not just plausible.
      // "Chicken thigh" must never be suggested as the same item as "chicken breast".
      // "CANDY SKITTLES" must never be linked to "CANDY M&M" even as a review suggestion —
      // unresolved terms on either side may mean genuinely different products.
      // Only allow suggestions when identity is "same"; "review" now falls through to new entry.
      const rawSuggestion=bestPurchasingSuggestion(description,packSize,candidates);
      const suggestionIdentity=rawSuggestion?compareProductIdentity(description,rawSuggestion.catalogItem.name):null;
      // When the candidate is brand-locked and the incoming brand disagrees with the known brand,
      // don't suggest linking — a brand-locked item must not absorb a different brand at review.
      const suggestionBrandOk=!rawSuggestion||(()=>{
        const ci=rawSuggestion.catalogItem;
        if(!ci.brand_locked)return true;
        return !brand||!ci.knownBrand||brandsMatch(brand,ci.knownBrand);
      })();
      // Only suggest when description identity is confirmed "same".
      // Vocabulary gaps (unresolved abbreviations, unknown modifiers like "DIET") return "review"
      // and must not drive a suggestion — unresolved terms may mean genuinely different products.
      // CANDY SKITTLES ≠ CANDY M&M; SODA BIRCH WHITE ≠ SODA BIRCH WHITE DIET.
      // Abbreviation variants ("AMER" for "AMERICAN") without vocabulary confirmation also fall
      // through to a new entry; the client can merge manually if the products are the same.
      const suggestionSafe=rawSuggestion&&suggestionIdentity?.status==="same"&&suggestionBrandOk;
      const suggestion=suggestionSafe?rawSuggestion:null;
      // If a plausible, identity-confirmed match exists, link to that item at review track
      // so the client can confirm pack agreement. Only link when product identity is confirmed.
      if(suggestion?.catalogItem?.id){
        const suggestionScore=Math.round((suggestion.score??0.5)*100)/100;
        return {catalogItemId:suggestion.catalogItem.id,track:"review",score:suggestionScore,
          method:"suggestion",reason:suggestion.reason||"Possible match — confirm before including in price comparisons"};
      }
      // No match at all: create a new catalog entry.
      const placement=await this.placeInCategory({organizationId,description,categoryId,categories,catalogItems});
      const created=await this.createItem({organizationId,name:description,categoryId:placement.category?.id||null,categoryReview:placement.review,categoryReason:placement.reason,catalogItems,categories});
      catalogItems.push(created);
      return {catalogItemId:created.id,track:"new",score:null,reason:"No existing item matched this description and pack"};
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
      const suggested=suggestCategory(description,categories,catalogItems);
      if(suggested)return {category:suggested.category,review:suggested.confidence!=="confident",reason:suggested.confidence==="confident"?null:suggested.reason};
      return {category:await this.ensureHoldingCategory(organizationId,categories),review:true,reason:"Category unknown; select a category to move this entire item and its vendor listings"};
    },
    async ensureHoldingCategory(organizationId,categories){
      const existing=categories.find(category=>category.is_holding_pen)||null;
      if(existing)return existing;
      const {range_start,range_end}=nextCategoryRange(categories);
      const created=await run(table("catalog_categories").insert({organization_id:organizationId,name:"Uncategorized",is_holding_pen:true,range_start,range_end,keywords:[]}).select().single(),"Could not create the holding category");
      categories.push(created);
      return created;
    },
    async createItem({organizationId,name,categoryId,categoryReview=false,categoryReason=null,catalogItems,categories}){
      const category=categories.find(candidate=>candidate.id===categoryId)||null;
      if(!category||!Number.isFinite(Number(category.range_start))||category.range_start==null||Number(category.range_start)<=0)throw new Error("This category needs an item-number range before creating an item.");
      // Include numbers from items later moved to another category. Their
      // KERDOS numbers remain theirs and must never be recycled here.
      const itemsInCategory=catalogItems.filter(item=>item.master_item_number>=Number(category.range_start)&&
        item.master_item_number<=Number(category?.range_end||Number.MAX_SAFE_INTEGER));
      const masterItemNumber=itemsInCategory.length?Math.max(...itemsInCategory.map(item=>item.master_item_number||0))+1:(category.range_start);
      if(category.range_end!=null&&masterItemNumber>Number(category.range_end))throw new Error("This category item-number range is full.");
      return run(table("catalog_items").insert({organization_id:organizationId,category_id:categoryId||null,master_item_number:masterItemNumber,name:name.slice(0,120),matching_behavior:"flexible",canonical_unit:null,brand_locked:false,category_review:!!categoryReview,category_reason:categoryReason||null}).select().single(),"Could not create the item");
    },
    // Rows whose sheet never said what the price is for. One decision for
    // the lot: the quoted amount is for one full pack. Rows with a readable
    // pack become priced; rows without one stay unavailable until the pack
    // is set. Rows that already state a unit are left alone.
    async setCaseBasisWhereUnstated({organizationId,vendorItems=[]}){
      const targets=vendorItems.filter(vi=>vi.organization_id===organizationId&&!vi.price_basis&&!vi.selling_unit&&Number(vi.price)>0&&vi.price_source!=="invoice");
      let done=0;
      for(const vi of targets){
        await run(table("vendor_items").update({price_basis:"case",selling_unit:"CS",price_unavailable:!parsePackSize(vi.pack_size)?.parsed}).eq("id",vi.id).eq("organization_id",organizationId),"Could not set the quoted unit");
        done++;
      }
      return done;
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
    async splitMapping({organizationId,mappingId,description,catalogItems,categories}){
      const placement=await this.placeInCategory({organizationId,description,categories,catalogItems});
      const created=await this.createItem({organizationId,name:description,categoryId:placement.category?.id||null,categoryReview:placement.review,categoryReason:placement.reason,catalogItems,categories});
      const mapping=await run(table("item_mappings").select("vendor_item_id").eq("id",mappingId).single(),"Could not read the current association");
      const vendorItem=await run(table("vendor_items").select("*").eq("id",mapping.vendor_item_id).single(),"Could not read the vendor product");
      const verification=mappingVerification(vendorItem,created);
      await run(table("item_mappings").update({catalog_item_id:created.id,...verification}).eq("id",mappingId),"Could not point the vendor item at it");
      return created;
    },
    confirmMapping(mappingId,verification){
      if(!verification)throw new Error("Check this product against the catalog and its vendor packs before confirming.");
      return run(table("item_mappings").update(verification).eq("id",mappingId),"Could not confirm the match");
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
        await run(table("item_mappings").update(entry.verification).eq("id",entry.mappingId),"Could not confirm the match");
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
    remapToExisting(mappingId,catalogItemId,verification){
      if(!verification)throw new Error("Check this product against the destination and its vendor packs before moving it.");
      return run(table("item_mappings").update({catalog_item_id:catalogItemId,...verification}).eq("id",mappingId),"Could not remap the item");
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

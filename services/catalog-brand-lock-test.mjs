/**
 * catalog-brand-lock-test.mjs
 *
 * Tests the brand_locked exemption in mappingVerification.
 * When catalogItem.brand_locked is false (or absent), brand differences among
 * peers do not block exact — consistent with mappingGap's brand-conflict logic.
 *
 * Run: node src/services/catalog-brand-lock-test.mjs
 * from the project root directory
 */

import {mappingVerification} from "./catalog.js";
import {configureProcurement} from "../procurement.js";

configureProcurement({industry:"restaurant",vocabulary:[]});
// configureProcurement is synchronous but resolves async; give it a tick.
await new Promise(r=>setTimeout(r,10));

let passed=0,failed=0;
function t(label,actual,expected){
  if(actual===expected){
    console.log(`  PASS  ${label}`);
    passed++;
  }else{
    console.error(`  FAIL  ${label}`);
    console.error(`        expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
    failed++;
  }
}

// Helpers — shared product/pack strings that compareProductIdentity and
// comparePurchasingPack will resolve cleanly.
const SAME_PRODUCT="CHICKEN BREAST BNLS SKNLS";
const SAME_PACK="4/10 LB";
const DIFF_PACK="2/10 LB";
const DIFF_PRODUCT="CHICKEN THIGH BNLS SKNLS";

// ── Case 1: same product, same pack, different brands, brand_locked=false ─────
// Expect: exact  (brand difference is acceptable when brand_locked is off)
{
  const vi  ={id:"v2",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC"};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:false};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"LAUBSC"};
  const result=mappingVerification(vi,ci,[peer]);
  t("1. same product, same pack, different brands, brand_locked=false → exact",
    result.comparison_track,"exact");
}

// ── Case 2: same product, same pack, different brands, brand_locked=true ──────
// Expect: review  (brand_locked enforces brand agreement)
{
  const vi  ={id:"v2",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC"};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:true};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"LAUBSC"};
  const result=mappingVerification(vi,ci,[peer]);
  t("2. same product, same pack, different brands, brand_locked=true → review",
    result.comparison_track,"review");
}

// ── Case 3: same product, same pack, same brands, brand_locked=false ──────────
// Expect: exact  (brands agree, so brandOk regardless of brand_locked)
{
  const vi  ={id:"v2",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC"};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:false};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC"};
  const result=mappingVerification(vi,ci,[peer]);
  t("3. same product, same pack, same brands, brand_locked=false → exact",
    result.comparison_track,"exact");
}

// ── Case 4: same product, same pack, same brands, brand_locked=true ───────────
// Expect: exact  (brands agree so brandsAgree=true, brand_locked=true is satisfied)
{
  const vi  ={id:"v2",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC"};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:true};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC"};
  const result=mappingVerification(vi,ci,[peer]);
  t("4. same product, same pack, same brands, brand_locked=true → exact",
    result.comparison_track,"exact");
}

// ── Case 5: same product, same pack, no brands on either, brand_locked=false ──
// Expect: exact  (no brands → brandsAgree=true, brandOk=true)
{
  const vi  ={id:"v2",description:SAME_PRODUCT,pack_size:SAME_PACK};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:false};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK};
  const result=mappingVerification(vi,ci,[peer]);
  t("5. same product, same pack, no brands, brand_locked=false → exact",
    result.comparison_track,"exact");
}

// ── Case 6: different product, same pack, brand_locked=false ──────────────────
// Expect: review  (identity check still blocks)
{
  const vi  ={id:"v2",description:DIFF_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC"};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:false};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"LAUBSC"};
  const result=mappingVerification(vi,ci,[peer]);
  t("6. different product, same pack, brand_locked=false → review",
    result.comparison_track,"review");
}

// ── Case 7: same product, different pack, brand_locked=false ──────────────────
// Expect: review  (pack check still blocks)
{
  const vi  ={id:"v2",description:SAME_PRODUCT,pack_size:DIFF_PACK,brand:"PRWISC"};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:false};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"LAUBSC"};
  const result=mappingVerification(vi,ci,[peer]);
  t("7. same product, different pack, brand_locked=false → review",
    result.comparison_track,"review");
}

// ── Case 8: manufacturer code match, same brand, same pack, brand_locked=false ─
// allPeersHaveIdentifier path — expect: exact
// When both vendor items share a manufacturer_code+brand, the identifier resolves
// wording uncertainty; pack agrees → exact.
{
  const vi  ={id:"v2",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC",manufacturer_code:"MC123"};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:false};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC",manufacturer_code:"MC123"};
  const result=mappingVerification(vi,ci,[peer]);
  t("8. mfr code match, same brand, same pack, brand_locked=false → exact",
    result.comparison_track,"exact");
}

// ── Case 9: manufacturer code match, same brand, DIFFERENT pack, brand_locked=false ─
// Identifier agreement does not override pack check → review
{
  const vi  ={id:"v2",description:SAME_PRODUCT,pack_size:DIFF_PACK,brand:"PRWISC",manufacturer_code:"MC123"};
  const ci  ={id:"c1",name:SAME_PRODUCT,brand_locked:false};
  const peer={id:"v1",description:SAME_PRODUCT,pack_size:SAME_PACK,brand:"PRWISC",manufacturer_code:"MC123"};
  const result=mappingVerification(vi,ci,[peer]);
  t("9. mfr code match, same brand, different pack, brand_locked=false → review",
    result.comparison_track,"review");
}

// ─────────────────────────────────────────────────────────────────────────────
// Provolone replay — rows 26752, 26753, 26754, 26755 from horn audit
// Isolated backend: Dairy category seeded. brand_locked defaults to false.
//
// Scenario after import:
//   - 26752 (PRWISC 3/12 LB) and 26754 (LAUBSC 3/12 LB) share one catalog item
//   - 26753 (PRWISC 1/12 LB) and 26755 (LAUBSC 1/12 LB) share a second catalog item
//   (Different packs → separate entries, per the KERDOS rule)
//
// The association blocker was the blocker under investigation. Pricing blockers
// (sellingUnit, quote) will still fire because these rows carry no selling_unit
// or quote in this isolated replay — that is expected and correct.
// ─────────────────────────────────────────────────────────────────────────────
import {orderGuideAssessment} from "../core/catalog-fields.js";

const dairyCategory={
  id:"cat-dairy",name:"Dairy",
  keywords:["cheese","provolone","milk"],
  range_start:5000,range_end:6999,
  is_holding_pen:false,organization_id:"org-test",
};

// Two catalog items (one per pack size). brand_locked=false is the default.
const ciProv3lb={id:"ci-prov-3lb",name:"CHEESE PROVOLONE SLICING",
  category_id:"cat-dairy",category_review:false,brand_locked:false,master_item_number:5001};
const ciProv1lb={id:"ci-prov-1lb",name:"CHEESE PROVOLONE SLICING",
  category_id:"cat-dairy",category_review:false,brand_locked:false,master_item_number:5002};

// Four vendor items matching horn.txt
const vi26752={id:"vi-26752",vendor_item_code:"26752",organization_id:"org-test",
  vendor_id:"vendor-wisc",description:"CHEESE PROVOLONE SLICING",
  pack_size:"3/12 LB",brand:"PRWISC",price:2.25,price_source:"sheet",selling_unit:"CS"};
const vi26753={id:"vi-26753",vendor_item_code:"26753",organization_id:"org-test",
  vendor_id:"vendor-wisc",description:"CHEESE PROVOLONE SLICING",
  pack_size:"1/12 LB",brand:"PRWISC",price:2.47,price_source:"sheet",selling_unit:"CS"};
const vi26754={id:"vi-26754",vendor_item_code:"26754",organization_id:"org-test",
  vendor_id:"vendor-laub",description:"CHEESE PROVOLONE SLICING",
  pack_size:"3/12 LB",brand:"LAUBSC",price:2.49,price_source:"sheet",selling_unit:"CS"};
const vi26755={id:"vi-26755",vendor_item_code:"26755",organization_id:"org-test",
  vendor_id:"vendor-laub",description:"CHEESE PROVOLONE SLICING",
  pack_size:"1/12 LB",brand:"LAUBSC",price:2.71,price_source:"sheet",selling_unit:"CS"};

// Pairs: each catalog item has both vendors linked
const provoloneCases=[
  {code:"26752",vendorItem:vi26752,catalogItem:ciProv3lb,peers:[vi26754]},
  {code:"26753",vendorItem:vi26753,catalogItem:ciProv1lb,peers:[vi26755]},
  {code:"26754",vendorItem:vi26754,catalogItem:ciProv3lb,peers:[vi26752]},
  {code:"26755",vendorItem:vi26755,catalogItem:ciProv1lb,peers:[vi26753]},
];

console.log("\n── Provolone replay (rows 26752–26755) ──");
{
  for(const entry of provoloneCases){
    const {code,vendorItem,catalogItem,peers}=entry;

    // Run mappingVerification (the fixed version) to get the current track
    const verification=mappingVerification(vendorItem,catalogItem,peers);

    // Build the mapping as it would exist after import
    const mapping={
      id:`m-${code}`,
      organization_id:"org-test",
      catalog_item_id:catalogItem.id,
      vendor_item_id:vendorItem.id,
      comparison_track:verification.comparison_track,
      confidence_score:verification.confidence_score,
      match_method:verification.match_method,
    };

    // Run orderGuideAssessment with the verified mapping
    const assessment=orderGuideAssessment({
      item:catalogItem,
      vendorItem,
      mapping,
      vendor:{id:vendorItem.vendor_id,name:vendorItem.vendor_id},
      category:dairyCategory,
      peers,
      categories:[dairyCategory],
      settings:{},
      now:new Date(),
    });

    const hasAssociation=assessment.blockers.includes("association");
    const blockerList=assessment.blockers.join(", ")||"none";
    const label=hasAssociation?"ASSOCIATION STILL BLOCKED":"association blocker CLEARED";
    console.log(`  ${code} (${vendorItem.brand} ${vendorItem.pack_size}): track=${verification.comparison_track} | blockers=[${blockerList}] → ${label}`);

    t(`provolone ${code} (${vendorItem.brand} ${vendorItem.pack_size}): association blocker cleared`,
      hasAssociation,false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed?1:0);

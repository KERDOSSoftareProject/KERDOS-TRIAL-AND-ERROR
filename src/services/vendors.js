// Vendor maintenance and manual quote corrections, independent of provider.
import {quotedUnitOrigin} from '../core/listing-provenance.js';
import {casePriceFromQuote,parsePackSize,priceBasisFor} from '../procurement.js';

async function run(promise,operation){
  const {data,error}=await promise;
  if(error)throw new Error(`${operation}: ${error.message}`);
  return data;
}

export function createVendorService(backend){
  const table=backend.records.query;
  return {
    add({organizationId,name,email,minimumDollar,minimumUnits}){
      return run(table("vendors").insert({organization_id:organizationId,name:name.trim(),email:email.trim()||null,delivery_minimum_dollar:minimumDollar?parseFloat(minimumDollar):null,delivery_minimum_units:minimumUnits?parseInt(minimumUnits,10):null,is_active:true}),"Could not add the vendor");
    },
    update(vendorId,patch){return run(table("vendors").update(patch).eq("id",vendorId),"Could not update the vendor");},
    deactivate(vendorId){return run(table("vendors").update({is_active:false}).eq("id",vendorId),"Could not remove the vendor");},
    async recordManualPrice({organizationId,item,mapping,price}){
      if(!item?.id||item.organization_id!==organizationId||
        mapping&&(mapping.organization_id!==organizationId||mapping.vendor_item_id!==item.id))
        throw new Error("Choose a vendor item from this organization.");
      if(!Number.isFinite(price)||price<=0)throw new Error("Enter a positive quoted price.");
      const basis=priceBasisFor(item.selling_unit);
      const convertible=!!mapping&&basis&&basis.basis===item.price_basis&&quotedUnitOrigin(item).status==='confirmed'&&
        parsePackSize(item.pack_size)?.parsed&&casePriceFromQuote(price,basis.basis,basis.unit||item.selling_unit,item.pack_size)!=null;
      return backend.catalog.saveRow({organizationId,vendorItemId:item.id,mappingId:mapping?.id||null,
        expectedRevision:item.row_revision||0,patch:{price,vendor_price_edit:true},priceBasis:item.price_basis||null,
        priceAvailable:!!convertible});
    },
    expireQuotes({organizationId,vendorId,vendorItemIds},expiredAt=new Date().toISOString()){
      return run(table("vendor_items").update({price_expired_at:expiredAt}).eq("organization_id",organizationId).eq("vendor_id",vendorId).in("id",vendorItemIds),"Could not expire prices");
    },
    expireQuote(vendorItemId,expiredAt=new Date().toISOString()){
      return run(table("vendor_items").update({price_expired_at:expiredAt}).eq("id",vendorItemId),"Could not expire the price");
    },
  };
}

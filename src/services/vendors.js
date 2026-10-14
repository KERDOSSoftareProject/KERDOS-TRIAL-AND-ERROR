// Vendor maintenance and manual quote corrections, independent of provider.
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
    async recordManualPrice({organizationId,item,price}){
      const now=new Date().toISOString();
      await run(table("price_history").insert({vendor_item_id:item.id,organization_id:organizationId,price,source:"manual_edit",effective_date:now,source_description:item.description,source_line:`Manual price confirmation: ${item.description} — ${price}`}),"Could not record the price change");
      return run(table("vendor_items").update({price,last_updated:now,price_source:"manual_edit",price_expired_at:null,price_quote_valid_until:null,price_unavailable:!item.pack_size}).eq("id",item.id),"Could not save the price");
    },
    expireQuotes({organizationId,vendorId,vendorItemIds},expiredAt=new Date().toISOString()){
      return run(table("vendor_items").update({price_expired_at:expiredAt}).eq("organization_id",organizationId).eq("vendor_id",vendorId).in("id",vendorItemIds),"Could not expire prices");
    },
    expireQuote(vendorItemId,expiredAt=new Date().toISOString()){
      return run(table("vendor_items").update({price_expired_at:expiredAt}).eq("id",vendorItemId),"Could not expire the price");
    },
  };
}

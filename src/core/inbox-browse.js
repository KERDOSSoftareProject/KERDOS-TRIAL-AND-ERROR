export function inboxVendorId(message){
  return message.vendor_snapshot_at?message.receipt_vendor_id||null:null;
}

export function browseInbox(messages,{vendors=[],vendorId="",search="",sort="newest"}={}){
  const names=new Map(vendors.map(vendor=>[vendor.id,vendor.name]));
  const vendorName=message=>inboxVendorId(message)?names.get(inboxVendorId(message))||"Vendor unavailable":"Vendor not recorded";
  const query=search.trim().toLocaleLowerCase();
  const date=message=>Number.isFinite(Date.parse(message.received_at))?Date.parse(message.received_at):0;
  return messages.filter(message=>{
    if(vendorId&&(vendorId==="__unassigned__"?inboxVendorId(message)!==null:inboxVendorId(message)!==vendorId))return false;
    return !query||[vendorName(message),message.subject,message.sender_name,message.sender_email,message.received_at].some(value=>String(value||"").toLocaleLowerCase().includes(query));
  }).sort((a,b)=>{
    const secondary=date(b)-date(a)||String(a.id).localeCompare(String(b.id));
    if(sort==="oldest")return date(a)-date(b)||String(a.id).localeCompare(String(b.id));
    if(sort==="vendor")return vendorName(a).localeCompare(vendorName(b))||secondary;
    if(sort==="sender")return String(a.sender_name||a.sender_email||"").localeCompare(String(b.sender_name||b.sender_email||""))||secondary;
    if(sort==="subject")return String(a.subject||"").localeCompare(String(b.subject||""))||secondary;
    return secondary;
  });
}

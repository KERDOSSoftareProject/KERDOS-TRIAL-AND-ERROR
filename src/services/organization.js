// Organization lifecycle and team administration in KERDOS language.
// Screens do not know which database provider implements these operations.
async function run(promise,operation){
  const {data,error}=await promise;
  if(error)throw new Error(`${operation}: ${error.message}`);
  return data;
}

export function createOrganizationService(backend){
  const table=backend.records.query;
  async function industryChoices(){
    const [templates,vocabulary]=await Promise.all([
      run(table("industry_templates").select("industry"),"Could not read industry choices"),
      run(table("industry_vocabulary").select("industry"),"Could not read industry vocabulary"),
    ]);
    const prepared=new Set((vocabulary||[]).map(row=>String(row.industry||"").trim().toLowerCase()));
    const choices=new Map();
    for(const row of templates||[]){
      const name=String(row.industry||"").trim();
      if(name&&prepared.has(name.toLowerCase()))choices.set(name.toLowerCase(),name);
    }
    return [...choices.values()].sort((a,b)=>a.localeCompare(b));
  }
  async function selectedIndustry(value){
    const name=String(value||"").trim();
    if(!name)throw new Error("Choose an industry.");
    const choices=await industryChoices();
    const selected=choices.find(choice=>choice.toLowerCase()===name.toLowerCase());
    if(!selected)throw new Error("Choose an industry from the list.");
    return selected;
  }
  return {
    async create({name,industry,vendors=[]}){
      if(!backend.organization?.create)throw new Error("Company setup is unavailable for this backend.");
      const rows=vendors.filter(vendor=>vendor.name.trim()).map(vendor=>({
        name:vendor.name.trim(),
        delivery_minimum_dollar:vendor.minDollar!==""&&vendor.minDollar!=null?Number(vendor.minDollar):null,
        delivery_minimum_units:vendor.minUnits!==""&&vendor.minUnits!=null?Number(vendor.minUnits):null,
      }));
      if(rows.some(row=>
        (row.delivery_minimum_dollar!==null&&(!Number.isFinite(row.delivery_minimum_dollar)||row.delivery_minimum_dollar<0))||
        (row.delivery_minimum_units!==null&&(!Number.isSafeInteger(row.delivery_minimum_units)||row.delivery_minimum_units<0))
      ))throw new Error("Enter a nonnegative minimum order and a whole number of items.");
      return backend.organization.create({name:name.trim(),industry:await selectedIndustry(industry),vendors:rows});
    },
    async update(organizationId,patch){
      const values=Object.hasOwn(patch,"industry")?{...patch,industry:await selectedIndustry(patch.industry)}:patch;
      return run(table("organizations").update(values).eq("id",organizationId),"Could not update the organization");
    },
    rememberVendorLayout(organizationId,vendorId,fingerprint,answers){
      if(!backend.organization?.rememberVendorLayout)throw new Error("Column choices cannot be remembered by this backend.");
      return backend.organization.rememberVendorLayout(organizationId,vendorId,fingerprint,answers);
    },
    syncProfile(user){
      return run(table("profiles").upsert({id:user.id,email:user.email,updated_at:new Date().toISOString()}),"Could not sync the profile");
    },
    templatedIndustries:industryChoices,
    async team(organizationId){
      const [members,codes,industries]=await Promise.all([
        run(table("organization_members").select("*").eq("organization_id",organizationId),"Could not read team members"),
        run(table("invite_codes").select("*").eq("organization_id",organizationId).order("created_at",{ascending:false}),"Could not read invite codes"),
        this.templatedIndustries(),
      ]);
      const ids=(members||[]).map(member=>member.user_id);
      const profiles=ids.length?await run(table("profiles").select("id,email").in("id",ids),"Could not read team profiles"):[];
      const emails=new Map((profiles||[]).map(profile=>[profile.id,profile.email]));
      return {members:(members||[]).map(member=>({...member,email:emails.get(member.user_id)||null})),codes:codes||[],industries};
    },
    createInvite({organizationId,code,role,createdBy}){
      return run(table("invite_codes").insert({organization_id:organizationId,code,role,created_by:createdBy}),"Could not create the invite code");
    },
    revokeInvite(inviteId){return run(table("invite_codes").delete().eq("id",inviteId),"Could not revoke the code");},
    changeRole({organizationId,userId,role}){
      return run(table("organization_members").update({role}).eq("organization_id",organizationId).eq("user_id",userId),"Could not change the role");
    },
    removeMember({organizationId,userId}){
      return run(table("organization_members").delete().eq("organization_id",organizationId).eq("user_id",userId),"Could not remove the member");
    },
  };
}

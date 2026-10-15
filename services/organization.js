// Organization lifecycle and team administration in KERDOS language.
// Screens do not know which database provider implements these operations.
async function run(promise,operation){
  const {data,error}=await promise;
  if(error)throw new Error(`${operation}: ${error.message}`);
  return data;
}

export function createOrganizationService(backend){
  const table=backend.records.query;
  return {
    async create({name,industry,userId,vendors=[]}){
      const slug=name.toLowerCase().replace(/[^a-z0-9]/g,"-").replace(/-+/g,"-");
      const organization=await run(table("organizations").insert({name,slug,industry}).select().single(),"Could not create the organization");
      await run(table("organization_members").insert({organization_id:organization.id,user_id:userId,role:"owner"}),"Could not add you as owner");
      const rows=vendors.filter(vendor=>vendor.name.trim()).map(vendor=>({
        organization_id:organization.id,name:vendor.name.trim(),
        delivery_minimum_dollar:vendor.minDollar?parseFloat(vendor.minDollar):null,
        delivery_minimum_units:vendor.minUnits?parseInt(vendor.minUnits,10):null,
      }));
      if(rows.length)await run(table("vendors").insert(rows),"Could not save vendors");
      return organization;
    },
    update(organizationId,patch){
      return run(table("organizations").update(patch).eq("id",organizationId),"Could not update the organization");
    },
    syncProfile(user){
      return run(table("profiles").upsert({id:user.id,email:user.email,updated_at:new Date().toISOString()}),"Could not sync the profile");
    },
    async templatedIndustries(){
      const rows=await run(table("industry_templates").select("industry"),"Could not read industry templates");
      return [...new Set((rows||[]).map(row=>row.industry).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    },
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

import {assertBackendContract,BackendError,providerResult} from "./backend/contract.js";

const fn=()=>{};
const valid={
  session:{get:fn,subscribe:fn,signIn:fn,signUp:fn,signOut:fn},
  workspace:{memberships:fn,snapshot:fn},
  documents:{upload:fn,signedUrl:fn,remove:fn,deletePriceSheet:fn,deleteInvoiceRecord:fn},
  realtime:{subscribeToOrganization:fn},
  pricing:{applyQuote:fn},catalog:{saveRow:fn},
  invoices:{record:fn},
  team:{acceptInvite:fn},
  records:{query:fn},
};
let passed=0;
function ok(condition,label){if(!condition)throw new Error(`FAIL ${label}`);passed++;console.log("PASS",label);}
ok(assertBackendContract(valid)===valid,"complete provider satisfies KERDOS contract");
try{assertBackendContract({...valid,documents:{upload:fn}});ok(false,"incomplete provider rejected");}
catch(error){ok(/documents\.signedUrl/.test(error.message),"incomplete provider rejected");}
ok(await providerResult(Promise.resolve({data:{id:1},error:null}),"Read").then(x=>x.id===1),"provider result is unwrapped");
try{await providerResult(Promise.resolve({data:null,error:new Error("offline")}),"Load catalog");ok(false,"provider error translated");}
catch(error){ok(error instanceof BackendError&&error.operation==="Load catalog","provider error translated");}
console.log(`${passed} backend contract tests passed`);

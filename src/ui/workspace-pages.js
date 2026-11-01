// Client page names are shared by Welcome tiles and workspace navigation.
export const workspacePages=[
  {id:"home",name:"Welcome",hint:"Your KERDOS home page",icon:"⌂"},
  {id:"order",name:"Order Guide",hint:"Build orders from current vendor prices",icon:"▤"},
  {id:"catalog",name:"Item Catalog",hint:"Your products and vendor listings",icon:"◇"},
  {id:"priceSheets",name:"Price Sheets",hint:"View current and past price sheets",icon:"▦"},
  {id:"invoices",name:"Invoices",hint:"Review invoices and purchase history",icon:"▤"},
  {id:"inbox",name:"Inbox",hint:"Review incoming documents",icon:"✉",restricted:true},
  {id:"vendorConnect",name:"Vendor Connect",hint:"Connect vendor accounts for automatic pricing",icon:"⇄",restricted:true},
  {id:"team",name:"Admin",hint:"Manage your team and account",icon:"⚙",restricted:true},
  {id:"vendorDetail",name:"Vendor Details",contextual:true},
];
export function pageName(id){return workspacePages.find(page=>page.id===id)?.name||"Workspace";}
export function navigationPages(role){return workspacePages.filter(page=>page.id!=="home"&&!page.contextual&&(!page.restricted||["owner","manager"].includes(role)));}

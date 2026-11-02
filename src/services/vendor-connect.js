// I · A · Task 2. Setup requests contain no credentials or vendor session data.
import {BackendError} from '../backend/contract.js';
const missingCodes=new Set(['42P01','PGRST205','PGRST202','42883']);
export class VendorConnectUnavailable extends Error {
  constructor(){super('Vendor account setup is not available in this environment yet.');this.name='VendorConnectUnavailable';}
}
async function run(promise){
  const {data,error}=await promise;
  if(error){if(missingCodes.has(error.code))throw new VendorConnectUnavailable();throw new Error('Could not load or save vendor account setup. Please try again.');}
  return data;
}
export function createVendorConnectService(backend){
  return {
    async list(organizationId){
      if(!organizationId)throw new Error('Select a client first.');
      const [adapters,requests]=await Promise.all([
        run(backend.records.query('vendor_connection_adapters').select('adapter_key,display_name,retrieval_kind,execution_model,setup_available,portal_origin').order('display_name')),
        run(backend.records.query('vendor_connection_requests').select('id,organization_id,vendor_id,adapter_key,state,created_at,portal_account_label,portal_list_label').eq('organization_id',organizationId).order('created_at',{ascending:false})),
      ]);
      return {adapters:adapters||[],requests:requests||[]};
    },
    async request({organizationId,vendorId,adapterKey}){
      if(!organizationId||!vendorId||!adapterKey)throw new Error('Select a client, vendor and connection provider.');
      if(!backend.vendorConnect?.request)throw new VendorConnectUnavailable();
      try{return await backend.vendorConnect.request({organizationId,vendorId,adapterKey});}
      catch(error){if(error instanceof BackendError&&missingCodes.has(error.cause?.code))throw new VendorConnectUnavailable();throw new Error('Could not prepare this vendor connection. Please try again.');}
    },
    async saveSelection({organizationId,vendorId,adapterKey,requestId,account,list}){
      if(!organizationId||!vendorId||!adapterKey||!requestId)throw new Error('Select a saved vendor connection first.');
      if(typeof account!=='string'||typeof list!=='string'||!account.trim()||!list.trim()||account.trim().length>200||list.trim().length>200)
        throw new Error('Enter an account name and pricing list name, up to 200 characters each.');
      const expected={portal_account_label:account.trim(),portal_list_label:list.trim()};
      const rows=await run(backend.records.query('vendor_connection_requests').update(expected)
        .eq('organization_id',organizationId).eq('vendor_id',vendorId).eq('adapter_key',adapterKey)
        .eq('id',requestId).eq('state','setup_requested')
        .select('id,organization_id,vendor_id,adapter_key,state,portal_account_label,portal_list_label'));
      const row=rows?.length===1?rows[0]:null;
      if(!row||row.id!==requestId||row.organization_id!==organizationId||row.vendor_id!==vendorId||row.adapter_key!==adapterKey||row.state!=='setup_requested'||
        row.portal_account_label!==expected.portal_account_label||row.portal_list_label!==expected.portal_list_label)
        throw new Error('This vendor connection is no longer available. Refresh the page.');
      return row;
    },
    async cancel({organizationId,requestId}){
      if(!organizationId||!requestId)throw new Error('Select a connection setup request.');
      const rows=await run(backend.records.query('vendor_connection_requests').update({state:'cancelled'}).eq('organization_id',organizationId).eq('id',requestId).eq('state','setup_requested').select('id'));
      if(!rows?.length)throw new Error('This setup request is no longer available. Refresh the page.');
    },
  };
}

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
        run(backend.records.query('vendor_connection_requests').select('id,organization_id,vendor_id,adapter_key,state,created_at').eq('organization_id',organizationId).order('created_at',{ascending:false})),
      ]);
      return {adapters:adapters||[],requests:requests||[]};
    },
    async request({organizationId,vendorId,adapterKey}){
      if(!organizationId||!vendorId||!adapterKey)throw new Error('Select a client, vendor and connection provider.');
      if(!backend.vendorConnect?.request)throw new VendorConnectUnavailable();
      try{return await backend.vendorConnect.request({organizationId,vendorId,adapterKey});}
      catch(error){if(error instanceof BackendError&&missingCodes.has(error.cause?.code))throw new VendorConnectUnavailable();throw new Error('Could not prepare this vendor connection. Please try again.');}
    },
    async cancel({organizationId,requestId}){
      if(!organizationId||!requestId)throw new Error('Select a connection setup request.');
      const rows=await run(backend.records.query('vendor_connection_requests').update({state:'cancelled'}).eq('organization_id',organizationId).eq('id',requestId).eq('state','setup_requested').select('id'));
      if(!rows?.length)throw new Error('This setup request is no longer available. Refresh the page.');
    },
  };
}

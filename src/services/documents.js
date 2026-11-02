import {assertOriginalEvidence,verifyOriginalBytes} from '../core/retained-original.js';
// Provider-neutral document operations used by KERDOS screens.
// Paths are KERDOS conventions; storage mechanics belong to the adapter.
export function createDocumentService(backend){
  const table=backend.records.query;
  async function run(promise,operation){const {data,error}=await promise;if(error)throw new Error(`${operation}: ${error.message}`);return data;}
  return {
    async uploadOriginal(organizationId,vendorId,file){
      const path=`${organizationId}/${vendorId}/${Date.now()}_${file.name}`;
      try{await backend.documents.upload(path,file);return {path,name:file.name,error:null};}
      catch(error){return {path:null,name:null,error};}
    },
    async uploadLogo(organizationId,file){
      const path=`${organizationId}/logo/${Date.now()}_${file.name}`;
      try{await backend.documents.upload(path,file,{upsert:true});return {path,error:null};}
      catch(error){return {path:null,error};}
    },
    async verifyCompanionOriginal({organizationId,vendorId,document,assertActive=()=>{}}){
      assertActive();
      if(document?.organization_id!==organizationId||document?.vendor_id!==vendorId)
        throw new Error('The retained original belongs to a different organization or vendor.');
      const path=document.file_path;
      if(typeof path!=='string'||!path.startsWith(`${organizationId}/${vendorId}/`)||path.split('/').some(part=>!part||part==='.'||part==='..'))
        throw new Error('The retained original path does not match this organization and vendor.');
      assertOriginalEvidence(document.retrieval_evidence);
      if(typeof backend.documents?.download!=='function')throw new Error('Original-file verification is unavailable from this storage provider.');
      const data=await backend.documents.download(path);assertActive();
      return verifyOriginalBytes(data,document.retrieval_evidence,{assertActive});
    },
    async signedUrl(path,seconds=3600){
      if(!path)return null;
      return (await backend.documents.signedUrl(path,seconds)).signedUrl;
    },
    remove(paths){return backend.documents.remove(paths);},
    source(documentId){return run(table("import_documents").select("original_text,file_path,file_name").eq("id",documentId).single(),"Cannot load original document");},
    olderPriceDocuments(organizationId,offset,limit=500){
      return run(table("import_documents").select("*").eq("organization_id",organizationId).eq("document_kind","pricelist")
        .order("created_at",{ascending:false}).order("id",{ascending:false}).range(offset,offset+limit-1),"Could not load earlier imported documents");
    },
  };
}

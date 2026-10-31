// A retained source observation is not a confirmed vendor/catalog identity.
// Read the immutable proof rather than copying it into another mutable queue.
export function retainedUnlinkedRows(documents){
  const pending=[];
  for(const document of documents){
    if(document.document_kind!=="pricelist"||document.status!=="partial"||
      document.source_rows?.version!==1||!Array.isArray(document.source_rows.rows))continue;
    const completed=new Set(document.completed_keys||[]);
    document.source_rows.rows.forEach((proof,index)=>{
      if(proof.key!==`row:${index}`||completed.has(proof.key)||!Array.isArray(proof.values))return;
      const [code,description,brand,packSize,,price,,sellingUnit]=proof.values;
      pending.push({id:`${document.id}:${proof.key}`,documentId:document.id,vendorId:document.vendor_id,
        fileName:document.file_name,key:proof.key,code,description,brand,packSize,price,sellingUnit,
        sourceLine:proof.sourceLine,position:proof.position});
    });
  }
  return pending;
}

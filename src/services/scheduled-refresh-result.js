// A one-use handoff only queues ingestion. The server marks the schedule
// finished after the importer supplies an actual document and its byte hash.
export async function settleScheduledImport(backend,evidence,importDocumentId,{required=false}={}){
 if(!evidence?.attempt_token)return null;
 if(!importDocumentId){if(required)throw new Error('Missing scheduled import receipt');return null;}
 if(!/^[0-9a-f]{64}$/.test(evidence.sha256||''))throw new Error('Invalid scheduled import hash');
 return backend.vendorConnect.completeSchedule(evidence.attempt_token,importDocumentId,evidence.sha256);
}

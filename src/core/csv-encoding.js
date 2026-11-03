// Decode vendor CSVs without changing the retained original bytes.
export function decodeCsvBytes(bytes){
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch{return new TextDecoder('windows-1252',{fatal:true}).decode(bytes);}
}

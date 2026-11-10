// Decode the view of the file used by the reader. Original storage and the
// companion digest continue to use the received bytes.
export function decodeCsvBytes(bytes){
  if((bytes[0]===0xff&&bytes[1]===0xfe)||(bytes[0]===0xfe&&bytes[1]===0xff))
    throw new Error('Unsupported CSV encoding');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch{text=new TextDecoder('windows-1252',{fatal:true}).decode(bytes);}
  if(/^\s*(?:<!doctype|<html|<body|<script|<\?xml|%PDF-)/i.test(text))
    throw new Error('File does not contain CSV text');
  for(const character of text){
    const code=character.charCodeAt(0);
    if((code<32&&code!==9&&code!==10&&code!==13)||(code>=127&&code<=159)||code===0xfffd)
      throw new Error('CSV contains unsupported text or binary data');
  }
  return text;
}

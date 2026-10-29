// Worker-free Tesseract core. Bounded bands keep OCR CPU per request small.
export const BAND_HEIGHT=200;
const PADDING=72;
export class ImageInputError extends Error {}
export function imageSize(bytes){
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=24&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return {width:view.getUint32(16),height:view.getUint32(20),mime:'image/png'};
  if(bytes[0]===255&&bytes[1]===216){
    let i=2;
    while(i+4<=bytes.length){
      if(bytes[i++]!==255)throw new ImageInputError('Invalid JPEG marker');
      while(bytes[i]===255)i++;
      const marker=bytes[i++];
      if(marker===217||marker===218)break;
      if(marker===1||(marker>=208&&marker<=215))continue;
      const length=view.getUint16(i);
      if(length<2||i+length>bytes.length)throw new ImageInputError('Invalid JPEG segment');
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
        if(length<8)throw new ImageInputError('Invalid JPEG dimensions');
        return {height:view.getUint16(i+3),width:view.getUint16(i+5),mime:'image/jpeg'};
      }
      i+=length;
    }
  }
  throw new ImageInputError('Only valid PNG and JPEG images can be recognized');
}
export function validateImage(bytes,part){
  if(!Number.isInteger(part)||part<0)throw new ImageInputError('Invalid OCR band');
  if(bytes.length>5*1024*1024)throw new ImageInputError('Image exceeds the 5 MB OCR limit');
  const size=imageSize(bytes);
  if(!size.width||!size.height||size.width>2400||size.height>4000||size.width*size.height>4000000)throw new ImageInputError('Image exceeds bounded OCR dimensions');
  const parts=Math.ceil(size.height/BAND_HEIGHT);
  if(part>=parts)throw new ImageInputError('OCR band is outside the image');
  return {...size,parts};
}
export function textLines(tsv,start,end){
  const groups=new Map();
  for(const line of tsv.trim().split('\n').slice(1)){
    const cells=line.split('\t');if(cells[0]!=='5'||cells.length<12)continue;
    const word={left:Number(cells[6]),top:Number(cells[7]),width:Number(cells[8]),height:Number(cells[9]),confidence:Number(cells[10]),text:cells.slice(11).join('\t').trim()};
    if(!word.text)continue;
    const key=cells.slice(1,5).join(':');
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(word);
  }
  return [...groups.values()].flatMap(words=>{
    words.sort((a,b)=>a.left-b.left);
    const top=Math.min(...words.map(w=>w.top)),bottom=Math.max(...words.map(w=>w.top+w.height)),center=(top+bottom)/2;
    if(center<start||center>=end)return [];
    let text='';for(let i=0;i<words.length;i++){const w=words[i],prior=words[i-1];text+=(prior?(w.left-prior.left-prior.width>Math.max(w.height,prior.height)*1.5?'\t':' '):'')+w.text;}
    return [{text,confidence:Math.min(...words.map(w=>w.confidence)),top,bottom}];
  }).sort((a,b)=>a.top-b.top);
}
// OCR may return no word at all for a blurred line. Preserve visible, uncovered
// ink as an explicit source exception instead of silently declaring completion.
export function unreadImageRegions(pixels,width,start,end,recognized){
  const regions=[];let begin=null;
  for(let y=start;y<=end;y++){
    let ink=0;
    if(y<end&&!recognized.some(line=>y>=line.top-5&&y<=line.bottom+5)){
      for(let x=0;x<width;x++){const i=(y*width+x)*4;if(pixels[i+3]>128&&(pixels[i]+pixels[i+1]+pixels[i+2])/3<220)ink++;}
    }
    const present=ink>=12&&ink<width*0.8;
    if(present&&begin==null)begin=y;
    if(!present&&begin!=null){if(y-begin>=4)regions.push({text:'[Unrecognized image content]',confidence:0,top:begin,bottom:y});begin=null;}
  }
  return regions;
}
export function createImageRecognizer(loadCore,loadLanguage,decodeImage,encodeBand){
  let engine,tail=Promise.resolve();
  async function recognize(bytes,part){
    const size=validateImage(bytes,part);
    if(!engine)engine=Promise.all([loadCore(),loadLanguage()]).then(([m,language])=>{m.FS.writeFile('/eng.traineddata',language);const api=new m.TessBaseAPI();if(api.Init(null,'eng',1)!==0)throw new Error('OCR language initialization failed');api.SetPageSegMode(6);return {m,api};}).catch(error=>{engine=null;throw error;});
    const {m,api}=await engine;
    let pixels;
    try{pixels=await decodeImage(bytes,size);}catch{throw new ImageInputError('Image decoder rejected the attachment');}
    if(pixels.length!==size.width*size.height*4)throw new ImageInputError('Image dimensions do not match decoded pixels');
    try{
      const start=part*BAND_HEIGHT,end=Math.min(size.height,start+BAND_HEIGHT),top=Math.max(0,start-PADDING),bottom=Math.min(size.height,end+PADDING);
      const band=pixels.slice(top*size.width*4,bottom*size.width*4);
      m.FS.writeFile('/input',await encodeBand(band,size.width,bottom-top));
      if(api.SetImageFile(1,0)!==0)throw new ImageInputError('Image decoder rejected the attachment');
      api.Recognize(null);
      const all=textLines(api.GetTSVText(0),-Infinity,Infinity);
      const lines=[...all.filter(line=>(line.top+line.bottom)/2>=start-top&&(line.top+line.bottom)/2<end-top),...unreadImageRegions(band,size.width,start-top,end-top,all)].map(line=>({...line,top:line.top+top,bottom:line.bottom+top})).sort((a,b)=>a.top-b.top);
      return {...size,part,lines,engine:'tesseract-core-7.0.0'};
    }finally{api.Clear();try{m.FS.unlink('/input');}catch{/* input may not exist after encoder failure */}}
  }
  return (bytes,part)=>{const job=tail.then(()=>recognize(bytes,part));tail=job.catch(()=>{});return job;};
}

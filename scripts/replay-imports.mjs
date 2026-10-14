// Read-only replay. No database connection or writes. For a real document,
// this is a fresh catalog with no vendor history; it is not a live count.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as XLSX from "xlsx";
import {parseDocument} from "../src/ingestion.js";
import {configureVocabulary,parsePackSize} from "../src/procurement.js";
import {configureCategoryProfile} from "../src/knowledge/category-profiles.js";
import {explainImportRow} from "../src/core/import-evidence.js";
import {automaticImports,categories as fixtureCategories} from "../src/fixtures/automatic-imports.js";
const root=fileURLToPath(new URL("../",import.meta.url));
const source=process.argv[2];
configureCategoryProfile("Restaurant");
let categories=fixtureCategories,entries;
if(source){
  const dictionary=fs.readFileSync(path.join(root,"knowledge/restaurant_food_dictionary_v1.sql"),"utf8");
  const vocabulary=fs.readFileSync(path.join(root,"knowledge/vocabulary_v1.sql"),"utf8")+dictionary;
  configureVocabulary([...vocabulary.matchAll(/\('Restaurant','(synonym|unit|packaging)','([^']+)'(?:,'([^']+)')?/g)]
    .map(match=>({kind:match[1],term:match[2],canonical:match[3]})));
  categories=[...dictionary.matchAll(/\('Restaurant','([^']+)','(\[.*?\])'::jsonb/g)]
    .map(match=>({id:match[1],name:match[1],keywords:JSON.parse(match[2])}));
  const isWorkbook=/\.(xlsx?|ods)$/i.test(source);
  let text;
  if(isWorkbook){
    const book=XLSX.read(fs.readFileSync(source),{type:"buffer"});
    text=book.SheetNames.map(name=>XLSX.utils.sheet_to_csv(book.Sheets[name])).filter(csv=>csv.replace(/[\s,]/g,"").length).join("\n");
  }else text=fs.readFileSync(source,"utf8");
  entries=parseDocument(text).rows.map((row,index)=>({name:`row ${index+1}`,row}));
}else entries=automaticImports.flatMap(fixture=>parseDocument(fixture.text).rows.map(row=>({...fixture,row})));
const blockers={};
let ready=0,incorrect=0;
for(const entry of entries){
  const evidence=explainImportRow(entry.row,{categories,vendor:{id:"replay",name:"Replay vendor"}});
  if(evidence.qualification.ready)ready++;
  if(entry.ready!=null&&entry.ready!==evidence.qualification.ready)incorrect++;
  for(const code of evidence.qualification.blockers)blockers[code]=(blockers[code]||0)+1;
}
console.log(JSON.stringify({source:source?path.basename(source):"synthetic regression fixtures",scope:"Fresh catalog replay; no saved vendor history",
  totalRows:entries.length,readablePacks:entries.filter(entry=>parsePackSize(entry.row.packSize)?.parsed).length,
  statedQuoteUnits:entries.filter(entry=>entry.row.sellingUnit).length,readyWithoutEdits:ready,blockedRows:entries.length-ready,
  incorrectOutcomes:source?null:incorrect,blockers},null,2));
if(!source&&incorrect)process.exitCode=1;

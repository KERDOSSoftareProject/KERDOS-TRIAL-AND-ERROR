import {getProcurementContext} from "../procurement.js";

// Spreadsheets turn a pack like "12/10" or "6/10" into a date before the
// file ever reaches KERDOS ("2025-12-10", "12/10/2025", "10-Dec"). When the
// pack column holds a date, the vendor almost certainly wrote outer/inner
// counts. The month and day are read back as that pack; the year is the
// spreadsheet's invention and is dropped. Anything that is not a date is
// returned untouched.
export function unmangleExcelDatePack(value){
  const text=String(value||"").trim();
  if(!text) return text;
  let m=text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/);           // 2025-12-10 00:00:00
  if(m) return `${Number(m[2])}/${Number(m[3])}`;
  m=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);                                        // 12/10/2025
  if(m) return `${Number(m[1])}/${Number(m[2])}`;
  const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  m=text.match(/^(\d{1,2})-([A-Za-z]{3})(?:-\d{2,4})?$/);                                        // 10-Dec, 10-Dec-25
  if(m&&months[m[2].toLowerCase()]) return `${months[m[2].toLowerCase()]}/${Number(m[1])}`;
  m=text.match(/^([A-Za-z]{3})-(\d{1,2})(?:-\d{2,4})?$/);                                        // Dec-10
  if(m&&months[m[1].toLowerCase()]) return `${months[m[1].toLowerCase()]}/${Number(m[2])}`;
  return text;
}

// Two things a pack column often holds that are packs in the vendor's
// mind but not in KERDOS's grammar. A packaging word alone ("CASE",
// "BOX", "BAG") means one of that packaging with the contents unstated,
// which is exactly how produce and bulk goods are sold: it becomes
// "1 CASE". A bare whole number ("1000", "2500") in a pack column is a
// count of units: it becomes "1000 CT". Anything else is left as written.
const PACKAGING_ONLY=/^(case|cs|cse|box|bx|bag|bg|tub|pail|bucket|bkt|crate|crt|carton|ctn|flat|sack|drum|pallet|tray|sleeve|bundle|bdl|roll|rl|jug|can|jar|bottle|btl|piece|pc|pce|each|ea)\.?$/i;
export function normalizeColumnPack(value, procurement=getProcurementContext()){
  const text=String(value||"").trim();
  if(!text) return text;
  if(PACKAGING_ONLY.test(text)) return `1 ${text.replace(/\.$/,"").toUpperCase()}`;
  if(/^\d{2,}$/.test(text)) return `${Number(text)} CT`;
  // Normalize mixed fractions: 1-1/9 BU → 1.111111 BU
  return procurement.normalizeMixedFraction(text);
}

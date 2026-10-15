// One organization-level formatting policy used by screens, messages and exports.
export const DEFAULT_LOCALE=(typeof navigator!=="undefined"&&navigator.language)||"en-US";
let active={locale:DEFAULT_LOCALE,currency:"USD"};
let money,date;

export function configureLocale(settings){
  const locale=String(settings?.locale||DEFAULT_LOCALE);
  const currency=String(settings?.currency||"USD").toUpperCase();
  try{money=new Intl.NumberFormat(locale,{style:"currency",currency});}
  catch{money=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"});}
  try{date=new Intl.DateTimeFormat(locale,{year:"numeric",month:"numeric",day:"numeric"});}
  catch{date=new Intl.DateTimeFormat("en-US",{year:"numeric",month:"numeric",day:"numeric"});}
  active={locale,currency};
}
configureLocale();

export function localeSettings(){return {...active};}
export function currencyCode(){return active.currency;}
export function formatMoney(value){return money.format(parseFloat(value||0));}
export function formatDate(value){
  if(!value)return "";
  const source=String(value);
  const parsed=/^\d{4}-\d{2}-\d{2}$/.test(source)?new Date(`${source}T00:00:00`):new Date(source);
  return Number.isNaN(parsed.getTime())?source:date.format(parsed);
}

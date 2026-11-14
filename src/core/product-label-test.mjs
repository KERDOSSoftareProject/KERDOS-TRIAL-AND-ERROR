import assert from 'node:assert/strict';
import {createProcurementContext} from '../procurement.js';
import {createProductLabelReader} from './product-label.js';

const reader = createProcurementContext({industry: 'restaurant'}).readProductLabel;
const same = [
  ['SAUSAGE LINK', 'SAUSAGE LINKS 2OZ', 'SAUSAGE LINK PORK', 'SAUSAGE LINKS PORK'],
  ['OLIVE OIL EXTRA VIRGIN', 'OLIVE OIL PURE', 'POMACE OIL 100%'],
  ['BCON LAYOUT 15LB', "BACON LAYOUT WRIGHT'S 10LB"],
  ['BALSAMIC VINEGAR', 'VINEGAR BALSAMIC 4/1 GAL'],
  ['CHIX BRST BNLS SKNLS 4OZ', 'CHICKEN BREAST BONE IN SKIN ON', 'CHICKEN BNLS BRST'],
  ['CHIX THIGH BNLS', 'CHICKEN THIGH SKINLESS'],
  ['GREEN PEPPER JUMBO', 'PEPPER GREEN LG 4/5 LB'],
  ['BALSAMIC VINGRE', 'BALSAMIC VINAIGRETTE', 'DRESS VINAIGR BALSAMIC'],
  ['SAGE 1LB (COL)', 'SAGE'],
  ['GARLIC LOOSE (ARG)', 'GARLIC WHOLE'],
  ['FRESH ARTICHOKE HEARTS', 'ARTICHOKE HEARTS'],
  ['KENS KETCHUP UNKNOWNX', 'HEINZ KETCHUP UNKNOWNY'],
  ['MILK', 'MILK 1%', 'MILK 2%', 'MILK WHOLE', 'SKIM MILK', 'FAT FREE MILK', 'LOW FAT MILK'],
  ['WHOLE MILK POWDER', 'SKIM MILK POWDER', 'DRIED MILK'],
  ['CREAM', 'LIGHT CREAM', 'CREAM HEAVY 36%', 'HEAVY WHIPPING CREAM'],
  ['COFFEE', 'DARK ROAST COFFEE', 'MEDIUM ROASTED COFFEE'],
  ['TOFU SOFT', 'TOFU EXTRA FIRM'],
  ['MUSHROOM', 'MUSHROOM WHOLE'],
  ['WHEAT WRAP', 'WHOLE WHEAT TORTILLA'],
  ['BEEF BASE SELECT', 'BASE BEEF ROYAL'],
  ['CHICKEN BASE SELECT', 'BASE CHICKEN ROYAL'],
  ['GARLIC POWDER', 'POWDER GARLIC'],
  ['HAMBURGER', 'HAMBURGER PATTY', 'BEEF PATTY'],
  ['SLICED BACON', 'BACON SLICED', 'BACON'],
  ['LETTUCE ROM', 'ROMAINE LETTUCE'],
  ['CHICKEN BREAST', 'CHIX BRST BNLS', 'B/S BNLS SKINLESS CHIX BRST'],
  ['SPINACH', 'BABY SPINACH', 'ORGANIC SPINACH', 'SPINACH FRZN'],
  ['BUTTER', 'SALTED BUTTER', 'BUTTER UNSLT', 'BUTTER NSA'],
  ['AMERICAN CHEESE', 'WHITE AMERICAN CHEESE', 'AMERICAN CHEESE YEL'],
  ['ARTICHOKE HEARTS', 'HEARTS ARTICHOKE'],
  ['SHRIMP', 'P&D SHRMP'],
  ['HOT DOG', 'FRANKFURTER'],
  ['CHICKEN', 'WOG'],
  ['COD', 'COD S/O SKIN ON', 'PBO COD'],
  ['SHRIMP', 'PDTO SHRIMP'],
  ['DICED PEACHES IN SYRUP', 'DICED PEACHES IN JUICE'],
  ['GROUND BEEF', 'GROUND BEEF GRD'],
  ['RED DELICIOUS APPLE', 'APPLE RED DEL'],
];
const distinct = [
  ['SAUSAGE LINKS 2OZ', 'SAUSAGE PATTIES 2OZ'],
  ['CHIX BRST BNLS SKNLS 4OZ', 'CHIX THIGH BNLS'],
  ['BALSAMIC VINEGAR', 'BALSAMIC VINAIGRETTE'],
  ['FRESH ARTICHOKE HEARTS', 'CANNED ARTICHOKE HEARTS', 'JARRED ARTICHOKE HEARTS', 'DRIED ARTICHOKE HEARTS'],
  ['BLACK BEAN SMALL CAN', 'BLACK BEAN DRY', 'BLACK BEAN FRESH'],
  ['SAGE 1LB (COL)', 'SAUSAGE LINKS 2OZ'],
  ['BACON LAYOUT 15LB', 'TURKEY BACON', 'BACON PRECOOKED'],
  ['GRATED PARMESAN', 'PARM PEPPERCORN DRESSING'],
  ['GREEN CABBAGE', 'RED CABBAGE'],
  ['SPINACH', 'SPINACH WRAP'],
  ['GRAPE', 'GRAPE JELLY', 'GRAPE LEAVES'],
  ['MUSHROOM SLICED', 'MUSHROOM WHOLE'],
  ['CELERY', 'DICED CELERY'],
  ['BEEF BASE SELECT', 'GROUND BEEF'],
  ['CHICKEN STRIPS', 'CHICKEN'],
  ['SAGE POWDER', 'SAGE'],
  ['HAMBURGER', 'HAMBURGER MEAT', 'HAMBURGER BUN'],
  ['MILK', 'BUTTERMILK', 'DRIED MILK'],
  ['CREAM', 'SOUR CREAM', 'WHIPPED CREAM', 'HALF AND HALF CREAM'],
  ['WHOLE CHICKEN', 'CHICKEN BREAST', 'CHICKEN THIGH'],
  ['RED PEPPER', 'ROASTED RED PEPPER'],
  ['COD', 'COD H&G'],
  ['CORN', 'WHOLE KERNEL CORN', 'CREAM STYLE CORN'],
  ['GRAPE LEAVES', 'STUFFED GRAPE LEAVES'],
];
for (const list of [...same, ...distinct]) {
  const outcomes = list.map(description => reader({description}));
  assert.deepEqual([...list].reverse().map(description => reader({description})), [...outcomes].reverse(), list.join(' / '));
  assert.ok(outcomes.every(result => result.status === 'recognized'), JSON.stringify({list, outcomes}));
  assert.equal(new Set(outcomes.map(result => result.key)).size, same.includes(list) ? 1 : list.length, list.join(' / '));
}

const expansions = {
  CHS:'cheese', BRWN:'brown', BRST:'breast', PRK:'pork',
  CHOC:'chocolate', TORT:'tortilla', AMER:'american', HAMB:'hamburger', VINAIGR:'vinaigrette',
  BCON:'bacon',
};
for (const [description, expected] of Object.entries(expansions)) {
  assert.equal(reader({description}).evidence.find(entry => entry.spelling === description.toLowerCase())?.result, expected, description);
}
for (const description of ['DELI TRIM CRN BEEF', 'BREAD WH GRN SL GLUTEN FREE', 'BLACK LABEL BNLS BRST',
  'FF HASHBROWNS', 'CANNED JARRED ARTICHOKE HEARTS', 'GRN', 'CRN', 'RST', 'B/S CHICKEN BREAST',
  'BREAD WH', 'CHEESE BL PHILADELPHIA', '1 PC CHICKEN', 'POT DETERGENT', 'COD S/O', 'GRD BEEF']) {
  const result = reader({description});
  assert.equal(result.status, 'review', description);
  assert.equal(result.key, null, description);
}
const toy = createProductLabelReader({
  profile: {
    concepts: [{label:'Cable',terms:[]}, {label:'Box',terms:[]},
      {label:'Premium Cable', terms:['cable premium'], levelOf:'Cable', broader:['cable']}],
    modifiers: [{label:'Coiled',terms:[],role:'defining'}, {label:'Large',terms:[],role:'informational'},
      {label:'Whole',terms:[],role:'defining',concepts:['cable']}],
    standalone: ['green','grain'],
  },
  vocabulary: [{kind:'synonym',term:'CBL',canonical:'cable'}],
  unitWords: ['ft'],
});
assert.equal(toy({description:'CBL LARGE 25 FT'}).key, toy({description:'CABLE'}).key);
assert.equal(toy({description:'PREMIUM CABLE'}).key, toy({description:'CABLE'}).key);
assert.equal(toy({description:'CABLE PREMIUM COILED'}).key, toy({description:'CABLE COILED'}).key);
assert.notEqual(toy({description:'CBL COILED'}).key, toy({description:'CABLE'}).key);
assert.notEqual(toy({description:'WHOLE CABLE'}).key, toy({description:'CABLE'}).key);
assert.equal(toy({description:'WHOLE BOX'}).key, toy({description:'BOX'}).key);
assert.equal(toy({description:'GREEN GRAIN GRN'}).status, 'review');
assert.equal(toy({description:'GRN'}).key, null);
assert.equal(toy({description:'CABLE BOX'}).status, 'review');

const other = createProcurementContext({industry:'construction',vocabulary:[{kind:'synonym',term:'PLYWD',canonical:'plywood'}]}).readProductLabel;
assert.equal(other({description:'PLYWD PANEL 6 FT'}).key, other({description:'PANEL PLYWOOD'}).key);
assert.equal(other({description:'BCON'}).key, 'literal:bcon');
const unlisted = other({description:'UNLISTED SEALANT'}).key;
for (const description of ['UNLISTED SEALANT GRADE A', 'UNLISTED SEALANT GRADE B',
  'UNLISTED SEALANT LEVEL 2', 'UNLISTED SEALANT 5%', 'UNLISTED SEALANT 10%',
  'PREMIUM GRADE UNLISTED SEALANT', 'WHOLE UNLISTED SEALANT']) {
  assert.equal(other({description}).key, unlisted, description);
}
assert.equal(other({description:'GRADE B 10%'}).status, 'review');
assert.notEqual(other({description:'SEALANT MODEL 101'}).key, other({description:'SEALANT MODEL 102'}).key);
const fallback = reader({description:'UNLISTED ITEM 3/10 LB',brand:'Plain Brand'});
assert.equal(fallback.key, reader({description:'ITEM UNLISTED 4/5 LB'}).key);
assert.equal(fallback.status, 'literal');
assert.equal(reader({description:"Ken's"}).status, 'review');
const source = Object.freeze({description:'KETCHUP BrandCo', brand:'BrandCo', packSize:'4/1 GAL', price:25});
assert.equal(reader(source).key, 'product:ketchup');
assert.deepEqual(source, {description:'KETCHUP BrandCo',brand:'BrandCo',packSize:'4/1 GAL',price:25});
console.log(`PASS product labels: ${same.length} same-product sets, ${distinct.length} distinct-product sets, ${Object.keys(expansions).length} shorthand controls, review, literal fallback and independent industry profiles.`);

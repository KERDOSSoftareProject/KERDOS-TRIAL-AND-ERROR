import {restaurantAssociations} from './restaurant-associations.js';
import {restaurantCellBrands} from './restaurant-dictionaries.js';
import {dictionaryTokens} from '../core/term-dictionary.js';
import vocabulary from './restaurant-vocabulary-v1-3.json' with {type:'json'};

// This profile is for the new label reader. The catalog's existing association
// profile continues to serve its callers until the label reader is activated.
const concepts = new Map(restaurantAssociations.concepts.map(concept => [concept.label.toLowerCase(), {
  ...concept,
  broader: restaurantAssociations.broaderConcepts[concept.label.toLowerCase()],
}]));

function concept(label, terms, broader) {
  const key = label.toLowerCase();
  const existing = concepts.get(key);
  concepts.set(key, {label, terms: [...new Set([...(existing?.terms ?? []), ...terms])], broader: broader ?? existing?.broader});
}

function levelsOf(label, ...levels) {
  concept(label, []);
  for (const [name, terms] of levels) {
    concept(name, terms);
    concepts.get(name.toLowerCase()).levelOf = label;
  }
}

levelsOf('Olive Oil',
  ['Extra Virgin Olive Oil', ['olive oil extra virgin']],
  ['Pure Olive Oil', ['olive oil pure']],
  ['Pomace Oil', ['oil pomace']]);
for (const [label, oldName] of [['Paper Towels', 'paper towel'], ['Trash Bags', 'trash liner']]) {
  const old = concepts.get(oldName);
  concept(label, [old.label, ...old.terms]);
  concepts.delete(oldName);
}

concept('Balsamic Vinegar', ['balsamic vinegar', 'vinegar balsamic']);
concept('Balsamic Vinaigrette', [], ['vinaigrette']);
concept('Vinaigrette', ['vinaigrette']);
concept('Parmesan Peppercorn Dressing', ['parmesan peppercorn', 'parmesan pepperco', 'peppercorn parmesan'], ['parmesan']);
concept('Turkey Bacon', ['turkey bacon', 'bacon turkey'], ['turkey', 'bacon']);
concept('Sausage', [], ['pork']);
concept('Hamburger', ['hamburger'], ['beef']);
concepts.get('beef patties').terms = concepts.get('beef patties').terms.filter(term => term !== 'hamburgers');
concept('Beef Patties', ['hamburger patty', 'patty hamburger'], ['hamburger', 'beef']);
concept('Beef Base', ['base beef'], ['beef']);
concept('Chicken Base', ['base chicken'], ['chicken']);
concept('Clam Base', ['clam base', 'base clam'], ['clams']);
concept('Beef Stew Meat', ['beef stew cube', 'beef stew meat', 'stew beef'], ['beef']);
concept('Beef Short Ribs', ['rib short beef', 'short rib beef', 'beef short rib'], ['beef']);
concept('Eye of Round Beef', ['round beef', 'beef eye round'], ['beef']);
concept('Gyro Meat', ['gyro beef', 'beef gyro', 'gyro meat'], ['beef']);
concept('Chicken Breast', [], ['chicken']);
concept('Chicken Thigh', [], ['chicken']);
concept('Chicken Wing', [], ['chicken']);
concept('Chicken Tender', [], ['chicken']);
concept('Beef Brisket', ['beef brisket', 'brisket beef', 'brisket'], ['beef']);
concept('Corned Beef', ['corned beef', 'beef corned'], ['beef']);
concept('Sage', ['sage']);
concept('Corn', ['corn']);
levelsOf('Milk',
  ['Whole Milk', ['milk whole', 'full fat milk', 'milk full fat']],
  ['Skim Milk', ['milk skim', 'skimmed milk', 'milk skimmed', 'nonfat milk', 'milk nonfat']],
  ['Reduced Fat Milk', ['milk reduced fat', 'low fat milk', 'milk low fat', 'fat free milk', 'milk fat free']]);
levelsOf('Cream',
  ['Heavy Cream', ['cream heavy', 'heavy whipping cream', 'cream heavy whipping']],
  ['Light Cream', ['cream light', 'single cream', 'cream single']],
  ['Whipping Cream', ['cream whipping', 'double cream', 'cream double']]);
concept('Whipped Cream', ['cream whipped'], ['cream']);
concept('Buttermilk', ['buttermilk'], ['milk']);
concept('Sour Cream', ['cream sour'], ['cream']);
concept('Half and Half', [], ['cream', 'milk']);
concept('Tofu', []);
concept('Butter Blend', ['butter blend', 'blend butter'], ['butter']);
concept('Butter Substitute', ['butter substitute', 'substitute butter', 'butter sub', 'oil butter sub'], ['butter']);
concept('White Mushroom', ['white mushroom', 'mushroom white'], ['mushroom']);
concept('Portabella Mushroom', ['portabella mushroom', 'mushroom portabella', 'portobello mushroom', 'mushroom portobello'], ['mushroom']);
concept('Shiitake Mushroom', ['shiitake mushroom', 'mushroom shiitake', 'shitake mushroom', 'mushroom shitake'], ['mushroom']);
concept('Garlic Powder', ['powder garlic'], ['garlic']);
concept('Onion Powder', ['powder onion'], ['onion']);
concept('Shallot', ['shallot']);
concept('Yam', ['yam']);
concept('Pickle', ['pickle']);
concept('Black Bean', ['black bean']);
concept('Red Kidney Bean', ['red kidney bean', 'red kidney', 'kidney bean']);
concept('Cannellini Bean', ['cannellini bean', 'cannellini']);
concept('Celery Root', ['celery root', 'celeriac'], ['celery']);
concept('Red Cabbage', ['red cabbage', 'cabbage red'], ['cabbage']);
concept('Green Cabbage', ['green cabbage', 'cabbage green'], ['cabbage']);
concept('English Cucumber', ['english cucumber', 'cucumber english'], ['cucumber']);
concept('Green Leaf Lettuce', ['green leaf lettuce', 'lettuce green leaf', 'greenleaf lettuce', 'lettuce greenleaf'], ['lettuce']);
concept('Boston Lettuce', ['boston lettuce', 'lettuce boston', 'lettuce hydro boston'], ['lettuce']);
concept('Salad Mix', ['lettuce salad mix', 'salad mix', 'lettuce mix'], ['lettuce']);
concept('Spinach Wrap', ['spinach wrap', 'wrap spinach'], ['spinach', 'tortilla']);
concept('Wheat Wrap', ['wheat wrap', 'wrap wheat', 'whole wheat tortilla'], ['tortilla']);
concept('White Wrap', ['white wrap', 'wrap white'], ['tortilla']);
concept('Sun-Dried Tomato Tortilla', ['sun dried tomato tortilla', 'sundried tomato tortilla'], ['tomato', 'tortilla']);
concept('Tortilla', ['wrap']);
concept('Grape Jelly', ['grape jelly', 'jelly grape'], ['grapes']);
concept('Stuffed Grape Leaves', ['stuffed grape leaves', 'dolmade', 'dolma'], ['grapes']);
concept('Green Grapes', ['green grape', 'grape green'], ['grapes']);
concept('Red Grapes', ['red grape', 'grape red'], ['grapes']);
concept('Yellow Squash', ['yellow squash', 'squash yellow'], ['squash']);
concept('Green Squash', ['green squash', 'squash green'], ['squash']);
concept('Spaghetti Squash', ['spaghetti squash', 'squash spaghetti'], ['spaghetti', 'squash']);
concept('Strawberry Jam', ['strawberry jam', 'jam strawberry'], ['strawberry']);
concept('Strawberry Jelly', ['strawberry jelly', 'jelly strawberry'], ['strawberry']);
concept('Sazón Seasoning', ['sazon'], ['cilantro']);
concept('Round Tomato', ['round tomato', 'tomato round'], ['tomato']);
concept('Grape Tomato', ['grape tomato', 'tomato grape'], ['tomato', 'grapes']);
concept('Cherry Tomato', ['cherry tomato', 'tomato cherry'], ['tomato']);
concept('Plum Tomato', ['plum tomato', 'tomato plum'], ['tomato']);
concept('Heirloom Tomato', ['heirloom tomato', 'tomato heirloom'], ['tomato']);
concept('Cluster Tomato', ['cluster tomato', 'tomato cluster'], ['tomato']);
concept('Vine Ripe Tomato', ['vine ripe tomato', 'tomato vine ripe'], ['tomato']);
concept('Roma Tomato', ['roma tomato', 'tomato roma', 'pear tomato', 'tomato pear'], ['tomato']);
concept('Spanish Onion', ['spanish onion', 'onion spanish']);
concept('Vidalia Onion', ['vidalia onion', 'onion vidalia']);
concept('Yukon Gold Potato', ['yukon potato', 'potato yukon'], ['potato']);
concept('Russet Potato', ['idaho potato', 'potato idaho'], ['potato']);
concept('Red Potato', ['potato red'], ['potato']);
concept('Fingerling Potato', ['fingerling potato', 'potato fingerling'], ['potato']);
concept('Parboiled Rice', ['parboiled rice', 'par boil rice', 'rice parboiled']);

const defining = (label, terms, concepts, exclusive) => ({label, terms, concepts, exclusive, role:'defining'});
const informational = (label, terms, concepts) => ({label, terms, concepts, role:'informational'});
const level = (label, terms, concepts) => ({label, terms, concepts, role:'level'});
const poultry = ['chicken', 'turkey', 'duck'];
const beans = ['black bean', 'red kidney bean', 'cannellini bean'];
const herbs = ['basil', 'cilantro', 'dill', 'oregano', 'parsley', 'sage', 'mint'];

const modifiers = [
  defining('Whole', ['whole'], poultry, 'poultry cut'),
  defining('Breast', ['breast'], poultry, 'poultry cut'),
  defining('Thigh', ['thigh'], poultry, 'poultry cut'),
  defining('Wing', ['wing'], poultry, 'poultry cut'),
  defining('Leg', ['leg'], poultry, 'poultry cut'),
  defining('Leg Quarter', ['leg quarter'], poultry, 'poultry cut'),
  defining('Drumstick', ['drumstick'], poultry, 'poultry cut'),
  defining('Tender', ['tender'], poultry, 'poultry cut'),
  defining('Link', ['link'], ['sausage'], 'sausage form'),
  defining('Patty', ['patty', 'pattie'], ['sausage'], 'sausage form'),
  defining('Canned', ['canned'], undefined, 'preservation'),
  defining('Canned', ['can', 'cans'], beans, 'preservation'),
  defining('Jarred', ['jarred'], undefined, 'preservation'),
  defining('Dried', ['dried', 'dehydrated', 'sundried', 'sun dried'], undefined, 'preservation'),
  defining('Dried', ['dry'], [...beans, ...herbs], 'preservation'),
  defining('Halves', ['halves', 'halved']),
  defining('Julienne', ['julienne', 'julienned']),
  defining('Peeled', ['peel'], ['garlic', 'shallot', 'tomato']),
  defining('Peeled', ['peeled']),
  defining('Chips', ['chip'], ['pickle'], 'pickle cut'),
  defining('Spears', ['spear'], ['pickle'], 'pickle cut'),
  defining('Relish', ['relish'], ['pickle'], 'pickle cut'),
  defining('Hearts', ['heart'], ['romaine lettuce'], 'romaine form'),
  defining('Chopped', ['chopped'], undefined, 'preparation cut'),
  defining('Cut', ['cut'], ['carrots']),
  defining('Baby', ['baby', 'mini'], ['carrots']),
  defining('Fillets', ['fillet'], ['green leaf lettuce']),
  defining('Curly', ['curly'], ['parsley'], 'parsley variety'),
  defining('Flat Leaf', ['plain', 'flat', 'flat leaf'], ['parsley'], 'parsley variety'),
  defining('Sliced', ['sliced', 'slicing'], undefined, 'preparation cut'),
  defining('Shredded', ['shredded'], undefined, 'preparation cut'),
  defining('Diced', ['diced'], undefined, 'preparation cut'),
  defining('Strips', ['strip', 'strips'], ['chicken', 'turkey', 'beef', 'pork', 'fish'], 'preparation cut'),
  defining('Minced', ['minced']),
  defining('Ground', ['ground']),
  defining('Pureed', ['pureed', 'puree']),
  defining('Granulated', ['granulated'], ['garlic', 'ginger', 'shallot']),
  defining('Powdered', ['powder', 'powdered'], [...herbs, 'ginger', 'shallot']),
  defining('Dried', ['powder', 'powdered'], ['milk'], 'preservation'),
  defining('Cooked', ['cooked', 'fully cooked', 'precooked', 'pre cooked'], undefined, 'cooking state'),
  defining('Raw', ['raw', 'uncooked'], undefined, 'cooking state'),
  defining('Breaded', ['breaded']),
  defining('Battered', ['battered']),
  defining('Roasted', ['roasted']),
  defining('Grilled', ['grilled']),
  defining('Braised', ['braised']),
  defining('Blanched', ['blanched']),
  defining('Marinated', ['marinated']),
  defining('Pickled', ['pickled']),
  defining('Crinkle Cut', ['crinkle cut']),
  defining('Straight Cut', ['straight cut']),
  defining('Shoestring', ['shoestring', 'shoe string']),
  defining('Waffle Cut', ['waffle cut']),
  defining('Roasted', ['roast'], ['green bell peppers', 'red bell peppers', 'orange bell peppers', 'yellow bell peppers']),
  informational('Brand and packaging', ['layout', 'laid out'], ['bacon', 'turkey bacon']),
  level('Olive oil grade', ['extra virgin', 'pure', 'pomace'], ['olive oil']),
  level('Coffee roast level', ['light roast', 'light roasted', 'medium roast', 'medium roasted',
    'dark roast', 'dark roasted', 'roast', 'roasted'], ['coffee']),
  informational('Bone and skin', ['boneless skinless', 'boneless', 'skinless', 'bone in', 'skin on', 'deboned']),
  informational('Size', ['small', 'medium', 'med', 'large', 'lg', 'extra large', 'xl', 'jumbo']),
  level('Grade', ['standard', 'choice', 'select', 'prime']),
  informational('Storage state', ['fresh', 'frozen', 'individually quick frozen', 'refrigerated']),
];

const spelling = value => dictionaryTokens(value).join(' ');
const spellings = entry => [entry.name, ...entry.aliases, ...(entry.reversed_aliases || [])];
const pending = new Set(vocabulary.undecided_terms.flatMap(spellings).map(spelling));
// These exact product names describe the baby-versus-regular decision in the draft.
const pendingProducts = new Set(['baby carrot', 'baby spinach']);
const pendingProductTerms = vocabulary.products.filter(entry => pendingProducts.has(entry.name)).flatMap(spellings);
const existingProductKeys = new Map([
  ['beef patty', 'beef patties'],
  ['carrot', 'carrots'],
  ['paper towel', 'paper towels'],
  ['paper plate', 'paper plates'],
  ['paper hot cup', 'paper cups'],
  ['trash bag', 'trash bags'],
  ['leek', 'leeks'],
  ['napkin', 'napkins'],
  ['banana', 'bananas'],
  ['lemon', 'lemons'],
  ['lime', 'limes'],
  ['orange', 'oranges'],
  ['feta', 'feta cheese'],
  ['gouda', 'gouda cheese'],
  ['green bell pepper', 'green bell peppers'],
  ['red bell pepper', 'red bell peppers'],
  ['orange bell pepper', 'orange bell peppers'],
  ['fuji apple', 'fuji apples'],
  ['gala apple', 'gala apples'],
  ['granny smith apple', 'granny smith apples'],
  ['golden delicious apple', 'golden delicious apples'],
  ['red delicious apple', 'red delicious apples'],
  ['mcintosh apple', 'mcintosh apples'],
  ['honeycrisp apple', 'honeycrisp apples'],
  ['portobello mushroom', 'portabella mushroom'],
  ['yellow bell pepper', 'yellow bell peppers'],
  ['eye of round', 'eye of round beef'],
  ['strip loin', 'beef strip loin'],
  ['beef short rib', 'beef short ribs'],
  ['shaved steak', 'shaved beef steak'],
  ['black beans', 'black bean'],
  ['kidney beans', 'red kidney bean'],
  ['cannellini beans', 'cannellini bean'],
]);
const additionalSpellings = new Map([
  ['dry milk', ['milk powder', 'dried milk', 'milk dried', 'skim milk powder', 'whole milk powder']],
  ['bacon', ['bacon sliced']],
  ['birch beer', ['soda birch', 'birch soda']],
  ['chicken', ['whole chicken without giblets']],
]);
const broaderProducts = new Map([
  ['broccolini', ['broccoli']],
  ['orzo', ['pasta']],
  ['romaine hearts', ['romaine lettuce']],
  ['grape leaves', ['grapes']],
  ['birch beer', ['soda']],
  ['canola oil', ['fryer oil']],
  ['wheat wrap', ['wrap','tortilla']],
  ['white wrap', ['wrap','tortilla']],
  ['spinach wrap', ['wrap','tortilla','spinach']],
  ['sun-dried tomato wrap', ['wrap','tortilla','sun-dried tomato']],
]);
const draftConcepts = vocabulary.products.filter(entry => !pendingProducts.has(entry.name)).map(entry => {
  const old = concepts.get(existingProductKeys.get(entry.name) || entry.name);
  return {
    ...old,
    label:old?.label || entry.name,
    terms:[...new Set([...spellings(entry), ...(old?.terms || []), ...(additionalSpellings.get(entry.name) || [])])],
    broader:[...new Set([...(old?.broader || []), ...(broaderProducts.get(entry.name) || []),
      ...(entry.name.endsWith(' apple') ? ['apple'] : [])])],
    authoritative:true,
    ...(entry.name === 'american cheese' ? {definingOutsideName:['sliced']} : {}),
  };
});
// Established product names that happen to contain a manufacturer name.
draftConcepts.push(
  {label:'Candy M&M',terms:['candy m m'],authoritative:true,broader:['candy']},
  {label:'Candy M&M Peanut',terms:['candy m m peanut'],authoritative:true,broader:['candy','peanuts']},
  {label:'Candy Skittles',terms:[],authoritative:true,broader:['candy']},
  {label:'Candy Snickers',terms:[],authoritative:true,broader:['candy']},
);
const draftProductLabels = new Set(draftConcepts.map(entry => spelling(entry.label)));
const draftModifiers = [
  ...vocabulary.defining_terms.map(entry => {
    const prior = modifiers.find(rule => rule.role === 'defining'
      && [rule.label, ...rule.terms].some(term => spelling(term) === spelling(entry.name)));
    return {...prior,label:prior?.label || entry.name,terms:spellings(entry),role:'defining',authoritative:!prior,
      concepts:entry.group === 'Cuts' ? prior?.concepts : undefined};
  }),
  ...vocabulary.information_terms.map(entry => ({
    label:entry.name,terms:[...entry.aliases,
      ...(entry.name === 'peeled and deveined' ? ['peeled deveined tail on'] : []),
      ...(entry.name === 'angus' ? ['certified angus beef'] : [])],
    role:/^(Grade or level|Fat level|Size|Packing medium)/.test(entry.group) ? 'level' : 'informational',
    authoritative:true,
    ...(entry.name === 'whole (fat level)' ? {concepts:['milk']} : {}),
  })),
];
const draftModifierTerms = new Set(draftModifiers.flatMap(entry => [entry.label, ...entry.terms]).map(spelling));
const legacyModifiers = modifiers.flatMap(entry => {
  if (entry.label === 'Baby') return [];
  const terms = [entry.label, ...entry.terms].filter(term => !pending.has(spelling(term))
    && !draftModifierTerms.has(spelling(term)));
  return terms.length ? [{...entry,terms,includeLabel:false}] : [];
});

export const restaurantProductLabels = {
  concepts: [
    ...draftConcepts,
    ...[...concepts.values()].filter(entry => !draftProductLabels.has(spelling(entry.label))),
  ],
  modifiers: [...draftModifiers, ...legacyModifiers],
  shorthand: vocabulary.shorthand,
  undecidedTerms: [...pending, ...pendingProductTerms.filter(term => /\bmini\b/.test(term))],
  standalone: ['american', 'brown', 'cheese', 'corn', 'green', 'hamburger', 'roast', 'sage', 'vinaigrette'],
  knownWords: ['america', 'can', 'chip', 'chop', 'cube', 'fresh', 'grill', 'heart', 'jar', 'one', 'pasta', 'peel', 'pot', 'roast', 'sage', 'size', 'slice', 'split', 'trim', 'whole'],
  requiredBaseWords: ['breast', 'thigh', 'wing', 'leg quarter', 'drumstick'],
  fragments: ['bagged', 'split', 'usa', 'mex', 'ct', 'lb', 'oz', 'case', 'total', 'subtotal', 'invoice', 'description', 'price', 'product prices'],
  origins: ['al', 'arg', 'bel', 'cal', 'can', 'canada', 'chl', 'chn', 'col', 'cos', 'fl', 'florida', 'ga', 'gtm', 'hnd', 'ita', 'mex', 'mor', 'nj', 'ny', 'pa', 'per', 'ri', 'spa', 'tx', 'usa', 'wa'],
  brandTerms: [...new Set([...vocabulary.brands, ...restaurantAssociations.brandTerms, ...restaurantCellBrands])],
};

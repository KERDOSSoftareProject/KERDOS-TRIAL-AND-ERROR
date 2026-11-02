import {restaurantDictionaries} from './restaurant-dictionaries.js';

// Product vocabulary, not vendor/customer rules. Additional industries can
// supply the same data contract without adding branches to the grouping engine.
const modifiers=new Set();
const excluded=['vegetable','beverage','decaffeinated','breast','wing','thigh','leg','leg quarter','drumstick','tender','frozen','individually quick frozen','canned','jarred','dehydrated','refrigerated','pasteurized','ultra pasteurized','ultra high temperature','low sodium','no salt added','no sugar added','gluten free','grass fed','organic','stainless steel','disposable'];
excluded.forEach(term=>modifiers.add(term));
const extra=[
 ['Honey Mustard Dressing',['honey mustard','honey mustrd']],['Pomace Oil',['pomace oil','oil pomace']],
 ['Balsamic Vinaigrette',['balsamic vinaigrette','vinaigrette balsamic','balsamic vingre']],
 ['Ranch Dressing',['ranch dressing','dress ranch','dressing ranch']],['Blue Cheese Dressing',['blue cheese dressing','dress blue cheese','blue cheese chunky','bleu cheese dressing','blue chs dress']],
 ['Italian Dressing',['italian dressing','dress italian','dressing italian']],
 ['Chicken Breast',['chicken breast','breast chicken']],['Chicken Thigh',['chicken thigh','thigh chicken']],
 ['Chicken Wing',['chicken wing','wing chicken']],['Chicken Tender',['chicken tender','tender chicken']],
 ['Beef Patties',['beef patty','hamburger patty','hamburgers']],['Shaved Beef Steak',['shaved steak','steak shave','philly steak','supreme steak']],
 ['Eye of Round Beef',['eye round','eye of round']],['Beef Strip Loin',['strip loin','ny strip']],
 ['Green Bell Peppers',['green pepper','pepper green']],['Red Bell Peppers',['red pepper','pepper red']],
 ['Orange Bell Peppers',['orange pepper','pepper orange']],['Yellow Bell Peppers',['yellow pepper','pepper yellow']],
 ['Red Onion',['red onion','onion red']],['Yellow Onion',['yellow onion','onion yellow']],['White Onion',['white onion','onion white']],
 ['Fuji Apples',['fuji apple','apple fuji']],['Gala Apples',['gala apple','apple gala']],
 ['Granny Smith Apples',['granny smith','apple granny']],['Golden Delicious Apples',['golden delicious','apple golden del']],
 ['Red Delicious Apples',['red delicious','apple red del']],['McIntosh Apples',['mcintosh','macintosh']],
 ['Honeycrisp Apples',['honeycrisp']],['Bananas',['banana']],['Honeydew',['honeydew']],['Cantaloupe',['cantaloupe','cantal']],
 ['Lemons',['lemon']],['Limes',['lime']],['Oranges',['orange']],['Grapes',['grape']],['Watermelon',['watermelon']],
 ['Asparagus',['asparagus']],['Alfalfa Sprouts',['alfalfa sprout']],['Bean Sprouts',['bean sprout']],['Beets',['beet']],
 ['Belgian Endive',['belgian endive','endive']],['Celery',['celery']],['Carrots',['carrot']],['Cabbage',['cabbage']],
 ['Spinach',['spinach']],['Cilantro',['cilantro']],['Parsley',['parsley']],['Mint',['mint']],['Dill',['dill']],
 ['Garlic',['garlic']],['Ginger',['ginger']],['Leeks',['leek']],['Kale',['kale']],['Lettuce',['lettuce']],
 ['Butter',['butter']],['Milk',['milk']],['Eggs',['egg']],['Heavy Cream',['heavy cream','cream heavy']],
 ['Pepper Jack Cheese',['pepper jack','pepperjack']],['American Cheese',['american cheese','amer cheese','cheese amer','american sliced']],
 ['Swiss Cheese',['swiss cheese','cheese swiss']],['Feta Cheese',['feta']],['Gouda Cheese',['gouda']],
 ['Salami',['salami']],['Ham',['ham']],['Roast Beef',['roast beef']],['Pastrami',['pastrami']],['Bologna',['bologna']],
 ['Tuna',['tuna']],['Cod',['cod']],['Haddock',['haddock']],['Clams',['clam']],['Scallops',['scallop']],
 ['Aluminum Foil',['aluminum foil','alum foil']],['Plastic Wrap',['plastic wrap','film wrap']],
 ['Napkins',['napkin']],['Paper Plates',['paper plate']],['Paper Cups',['paper cup']],
];
const terms=new Map();
for(const group of ['food','ingredient','hospitality'])for(const entry of restaurantDictionaries[group]||[]){
 if(entry.kind==='product'&&!modifiers.has(entry.term))terms.set(entry.term,{label:entry.term,terms:[entry.term,...entry.aliases||[]]});
}
for(const [label,aliases] of extra)terms.set(label.toLowerCase(),{label,terms:aliases});
export const restaurantAssociations={version:'restaurant-associations-2',concepts:[...terms.values()],
 // Group by the product alone. Cut, portion, brand, pack and percentages
 // remain on the source listing; they do not create client-facing groups.
 groupDetails:false,
 facets:[],
 fragments:['usa','mex','can','per','hnd','bel','ny','fl','ga','ct','lb','oz','case','total','subtotal','invoice','description','price','product prices'],
};

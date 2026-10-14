-- KERDOS vocabulary packs v1. Data only - the engine never sees these words
-- until an organization picks the industry. Industry strings must match
-- the ones used in industry_templates.

-- Restaurant: food-service abbreviations as they appear on real price sheets.
insert into industry_vocabulary (industry, kind, term, canonical) values
  ('Restaurant','synonym','chix','chicken'),
  ('Restaurant','synonym','chkn','chicken'),
  ('Restaurant','synonym','bnls','boneless'),
  ('Restaurant','synonym','sknls','skinless'),
  ('Restaurant','synonym','frz','frozen'),
  ('Restaurant','synonym','frzn','frozen'),
  ('Restaurant','synonym','whl','whole'),
  ('Restaurant','synonym','grnd','ground'),
  ('Restaurant','synonym','ckd','cooked'),
  ('Restaurant','synonym','slcd','sliced'),
  ('Restaurant','synonym','shrd','shredded'),
  ('Restaurant','synonym','veg','vegetable'),
  ('Restaurant','synonym','choc','chocolate'),
  ('Restaurant','synonym','van','vanilla'),
  ('Restaurant','packaging','flat'),
  ('Restaurant','packaging','flats'),
  ('Restaurant','packaging','sleeve'),
  ('Restaurant','packaging','sleeves'),
  ('Restaurant','packaging','bunch'),
  ('Restaurant','packaging','bunches'),
  ('Restaurant','unit','bushel','BU'),
  ('Restaurant','unit','bushels','BU'),
  ('Restaurant','unit','bu','BU')
on conflict (industry, kind, term) do nothing;

-- Building Supply: an example second pack proving the same engine reads a
-- different trade with nothing but data.
insert into industry_vocabulary (industry, kind, term, canonical) values
  ('Building Supply','unit','sheet','SHEET'),
  ('Building Supply','unit','sheets','SHEET'),
  ('Building Supply','unit','sht','SHEET'),
  ('Building Supply','unit','bf','BF'),
  ('Building Supply','unit','bdft','BF'),
  ('Building Supply','unit','board feet','BF'),
  ('Building Supply','unit','board foot','BF'),
  ('Building Supply','unit','lf','FT'),
  ('Building Supply','unit','lft','FT'),
  ('Building Supply','unit','linear ft','FT'),
  ('Building Supply','unit','linear feet','FT'),
  ('Building Supply','unit','sq ft','SQFT'),
  ('Building Supply','unit','sqft','SQFT'),
  ('Building Supply','unit','sf','SQFT'),
  ('Building Supply','packaging','bundle'),
  ('Building Supply','packaging','bundles'),
  ('Building Supply','packaging','skid'),
  ('Building Supply','packaging','skids'),
  ('Building Supply','synonym','plywd','plywood'),
  ('Building Supply','synonym','ply','plywood'),
  ('Building Supply','synonym','drywl','drywall'),
  ('Building Supply','synonym','gyp','gypsum'),
  ('Building Supply','synonym','galv','galvanized')
on conflict (industry, kind, term) do nothing;

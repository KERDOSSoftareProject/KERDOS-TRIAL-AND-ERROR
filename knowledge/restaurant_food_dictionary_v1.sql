-- Restaurant Food Dictionary v1 - REPLACES all earlier Restaurant SQL
-- files (restaurant_template.sql, expand_keywords.sql). This is a full,
-- deliberate keyword set organized the way a foodservice person actually
-- thinks about inventory, not a pile of reactive one-word patches.
--
-- Built-in disambiguation: several categories include specific 2-3 word
-- phrases (e.g. "chicken base", "imitation crab meat", "coconut milk")
-- whose whole point is to OUTRANK a shorter, more generic keyword that
-- would otherwise misfire (e.g. "chicken" alone matching Meat). This only
-- works together with the classifyCategory fix in App.jsx that weights a
-- match by how many words matched, not how many keyword entries matched -
-- deploy that code change together with this SQL, not one without the
-- other.
--
-- This is v1, not a finished, exhaustive dictionary - extend it the same
-- way going forward: add words as real gaps turn up, always as a
-- deliberate one-time review rather than scattered one-off patches.
--
-- Safe to re-run: clears existing Restaurant template rows and any
-- Restaurant-industry org's matching category names, then re-applies
-- this full set (a real REPLACE, not an incremental append, so old
-- partial patches don't linger alongside this).

DELETE FROM industry_templates WHERE industry = 'Restaurant';
INSERT INTO industry_templates (industry, category_name, keywords, sort_order) VALUES
('Restaurant','Produce','["lettuce", "tomato", "onion", "produce", "vegetable", "fruit", "potato", "pepper", "garlic", "herb", "fresh", "mushroom", "avocado", "cabbage", "cantaloupe", "carrot", "celery", "cucumber", "blueberry", "blueberries", "apple", "banana", "orange", "lemon", "lime", "melon", "watermelon", "grape", "strawberry", "raspberry", "spinach", "kale", "broccoli", "cauliflower", "zucchini", "squash", "eggplant", "radish", "beet", "corn", "cilantro", "mint", "ginger", "scallion", "leek", "asparagus", "artichoke", "green bean"]'::jsonb,10),
('Restaurant','Meat','["chicken", "beef", "pork", "turkey", "meat", "poultry", "steak", "sausage", "bacon", "lamb", "seafood", "fish", "shrimp", "salmon", "ham", "veal", "duck", "wing", "thigh", "rib", "brisket", "tenderloin", "ground beef", "tuna", "crab", "lobster", "scallop", "tilapia", "cod", "halibut", "oyster", "clam", "mussel"]'::jsonb,20),
('Restaurant','Dairy','["milk", "cheese", "egg", "butter", "cream", "yogurt", "dairy", "mozzarella", "sour cream", "cream cheese", "cottage cheese", "ricotta", "parmesan", "cheddar", "provolone", "half and half", "whipped cream"]'::jsonb,30),
('Restaurant','Paper Goods','["napkin", "cup", "paper", "togo", "container", "straw", "lid", "utensil", "plate", "bag", "tissue", "towel", "foil", "wrap", "plasticware", "cutlery", "sleeve", "doily", "liner"]'::jsonb,40),
('Restaurant','General','["pasta", "rice", "flour", "sugar", "bean", "kidney", "noodle", "dressing", "mustard", "ketchup", "mayo", "sauce", "condiment", "vinegar", "oil", "spice", "seasoning", "oregano", "basil", "cumin", "soda", "juice", "water", "beverage", "coffee", "tea", "beer", "wine", "frozen", "fries", "bread", "bun", "roll", "bakery", "dough", "tortilla", "canned", "jarred", "olive", "pickle", "cleaner", "soap", "sanitizer", "cleaning", "janitorial", "detergent", "glove", "pan", "knife", "equipment", "smallware", "thermometer", "base", "bouillon", "stock", "broth", "concentrate", "margarine", "chicken base", "beef base", "vegetable base", "ham base", "turkey base", "chicken bouillon", "beef bouillon", "chicken broth", "beef broth", "vegetable broth", "chicken stock", "beef stock", "vegetable stock", "turkey stock", "imitation crab", "imitation bacon", "imitation seafood", "coconut milk", "almond milk", "soy milk", "oat milk", "peanut butter", "apple butter", "cocoa butter", "egg substitute", "egg replacer", "tomato sauce", "tomato paste", "tomato juice", "potato chips", "potato starch", "onion powder", "garlic powder", "apple juice", "orange juice", "lemon juice", "lime juice", "imitation crab meat"]'::jsonb,50);

-- Apply the same full replacement directly to any Restaurant-industry
-- org's already-loaded categories, so this takes effect immediately
-- (not just for future template loads). Re-run "Reclassify
-- Uncategorized items" afterward to sweep up anything already stuck.
UPDATE catalog_categories SET keywords = '["lettuce", "tomato", "onion", "produce", "vegetable", "fruit", "potato", "pepper", "garlic", "herb", "fresh", "mushroom", "avocado", "cabbage", "cantaloupe", "carrot", "celery", "cucumber", "blueberry", "blueberries", "apple", "banana", "orange", "lemon", "lime", "melon", "watermelon", "grape", "strawberry", "raspberry", "spinach", "kale", "broccoli", "cauliflower", "zucchini", "squash", "eggplant", "radish", "beet", "corn", "cilantro", "mint", "ginger", "scallion", "leek", "asparagus", "artichoke", "green bean"]'::jsonb WHERE name = 'Produce' AND organization_id IN (SELECT id FROM organizations WHERE industry ILIKE 'Restaurant');
UPDATE catalog_categories SET keywords = '["chicken", "beef", "pork", "turkey", "meat", "poultry", "steak", "sausage", "bacon", "lamb", "seafood", "fish", "shrimp", "salmon", "ham", "veal", "duck", "wing", "thigh", "rib", "brisket", "tenderloin", "ground beef", "tuna", "crab", "lobster", "scallop", "tilapia", "cod", "halibut", "oyster", "clam", "mussel"]'::jsonb WHERE name = 'Meat' AND organization_id IN (SELECT id FROM organizations WHERE industry ILIKE 'Restaurant');
UPDATE catalog_categories SET keywords = '["milk", "cheese", "egg", "butter", "cream", "yogurt", "dairy", "mozzarella", "sour cream", "cream cheese", "cottage cheese", "ricotta", "parmesan", "cheddar", "provolone", "half and half", "whipped cream"]'::jsonb WHERE name = 'Dairy' AND organization_id IN (SELECT id FROM organizations WHERE industry ILIKE 'Restaurant');
UPDATE catalog_categories SET keywords = '["napkin", "cup", "paper", "togo", "container", "straw", "lid", "utensil", "plate", "bag", "tissue", "towel", "foil", "wrap", "plasticware", "cutlery", "sleeve", "doily", "liner"]'::jsonb WHERE name = 'Paper Goods' AND organization_id IN (SELECT id FROM organizations WHERE industry ILIKE 'Restaurant');
UPDATE catalog_categories SET keywords = '["pasta", "rice", "flour", "sugar", "bean", "kidney", "noodle", "dressing", "mustard", "ketchup", "mayo", "sauce", "condiment", "vinegar", "oil", "spice", "seasoning", "oregano", "basil", "cumin", "soda", "juice", "water", "beverage", "coffee", "tea", "beer", "wine", "frozen", "fries", "bread", "bun", "roll", "bakery", "dough", "tortilla", "canned", "jarred", "olive", "pickle", "cleaner", "soap", "sanitizer", "cleaning", "janitorial", "detergent", "glove", "pan", "knife", "equipment", "smallware", "thermometer", "base", "bouillon", "stock", "broth", "concentrate", "margarine", "chicken base", "beef base", "vegetable base", "ham base", "turkey base", "chicken bouillon", "beef bouillon", "chicken broth", "beef broth", "vegetable broth", "chicken stock", "beef stock", "vegetable stock", "turkey stock", "imitation crab", "imitation bacon", "imitation seafood", "coconut milk", "almond milk", "soy milk", "oat milk", "peanut butter", "apple butter", "cocoa butter", "egg substitute", "egg replacer", "tomato sauce", "tomato paste", "tomato juice", "potato chips", "potato starch", "onion powder", "garlic powder", "apple juice", "orange juice", "lemon juice", "lime juice", "imitation crab meat"]'::jsonb WHERE name = 'General' AND organization_id IN (SELECT id FROM organizations WHERE industry ILIKE 'Restaurant');

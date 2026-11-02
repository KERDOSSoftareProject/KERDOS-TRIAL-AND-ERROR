import {PGlite} from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {priceQuoteFixture,upgradePriceQuoteRecovery} from './fixtures/price-quote-db.mjs';
const db=new PGlite();
try{
 const f=await priceQuoteFixture(db,{upgrade:!process.argv.includes('--before-guard')});
 const {owner,manager,employee,outsider,actor,call,quote,document}=f;
 await actor(db,owner);
 const old=await document(),cmd=quote(old),item=await call(db,cmd);
 const initial=(await db.query('select * from vendor_items where id=$1',[item])).rows[0];
 assert.equal(await call(db,cmd),item,'lost first reply returns the committed listing even without a caller ID');
 assert.deepEqual((await db.query('select * from vendor_items where id=$1',[item])).rows[0],initial,'exact retry must not mutate price, revision or incoming evidence');
 assert.equal((await db.query('select count(*)::int as n from vendor_items')).rows[0].n,1);
 const next=await document();await call(db,quote(next,{item,price:43.25,line:'newer quotation'}));
 const newer=(await db.query('select * from vendor_items where id=$1',[item])).rows[0];
 await actor(db,manager);assert.equal(await call(db,quote(old,{item})),item);
 assert.deepEqual((await db.query('select * from vendor_items where id=$1',[item])).rows[0],newer,'old interrupted replay cannot roll back the newer price');
 assert.equal((await db.query('select count(*)::int as n from price_history')).rows[0].n,2);
 for(const patch of [{price:99},{line:'altered original'},{description:'different product'},{unavailable:true}])await assert.rejects(call(db,quote(old,{item,...patch})),/Saved source row differs/);
 for(const user of [employee,outsider]){await actor(db,user);await assert.rejects(call(db,cmd),/Owner or manager/);}
 await actor(db,owner);const other=await call(db,quote(await document(),{price:50,line:'another listing'}));
 await assert.rejects(call(db,quote(old,{item:other})),/Saved source row differs/);
 // No-key clients retain their established behavior; the new guard does not invent row identities.
 const legacy=await document();await call(db,quote(legacy,{item,key:null,price:45,line:'legacy source'}));
 assert.equal(Number((await db.query('select price from vendor_items where id=$1',[item])).rows[0].price),45);
 const heldDoc=await document(),heldCmd=quote(heldDoc,{unavailable:true}),held=await call(db,heldCmd);
 const staged=(await db.query('select * from vendor_items where id=$1',[held])).rows[0];
 assert.equal(await call(db,heldCmd),held,'lost held-row reply must return its first listing despite having no accepted history');
 assert.deepEqual((await db.query('select * from vendor_items where id=$1',[held])).rows[0],staged);
 assert.equal((await db.query('select count(*)::int as n from price_history where source_document_id=$1',[heldDoc])).rows[0].n,0);
 // Deliberate correction uses the known identity; it must remain possible.
 await call(db,quote(heldDoc,{item:held,price:42.25}));
 const corrected=(await db.query('select * from vendor_items where id=$1',[held])).rows[0];
 assert.equal(await call(db,heldCmd),held);
 assert.deepEqual((await db.query('select * from vendor_items where id=$1',[held])).rows[0],corrected,'an old held-row retry cannot undo a later correction');
 await call(db,quote(await document(),{item:held,price:44.25,line:'new supplier price'}));
 const latest=(await db.query('select * from vendor_items where id=$1',[held])).rows[0];
 assert.equal(await call(db,heldCmd),held);
 assert.deepEqual((await db.query('select * from vendor_items where id=$1',[held])).rows[0],latest,'held-row identity survives a later source taking over incoming evidence');
 await assert.rejects(call(db,quote(heldDoc,{unavailable:true,price:99})),/Saved source row differs/);
 const receipt=(await db.query('select staged_row_receipts from import_documents where id=$1',[heldDoc])).rows[0].staged_row_receipts;
 assert.equal(receipt['row:0'].vendorItemId,held);assert.match(receipt['row:0'].sourceSha256,/^[a-f0-9]{64}$/);
 await assert.rejects(db.query(`update import_documents set staged_row_receipts='{}' where id=$1`,[heldDoc]),/cannot be changed or cleared/);
 await assert.rejects(db.query('update import_documents set staged_row_receipts=$1 where id=$2',[JSON.stringify({'row:0':{...receipt['row:0'],vendorItemId:other}}),heldDoc]),/cannot be changed or cleared/);
 const abandoned=await document(),abandonedItem=await call(db,quote(abandoned,{unavailable:true}));
 await call(db,quote(await document(),{item:abandonedItem,price:48,line:'superseding accepted quote'}));
 await assert.rejects(call(db,quote(abandoned,{item:abandonedItem,price:49})),/staged source is no longer current/);
 const beforeCount=(await db.query('select count(*)::int as n from vendor_items')).rows[0].n;
 await assert.rejects(call(db,quote(await document(),{unavailable:true,key:''})),/receipt does not match/);
 assert.equal((await db.query('select count(*)::int as n from vendor_items')).rows[0].n,beforeCount,'receipt failure rolls back the new listing in the same transaction');
 await actor(db,outsider);assert.equal((await db.query('select staged_row_receipts from import_documents')).rows.length,0,'existing RLS hides receipt identities from other organizations');
 console.log('PASS SQL quote recovery: lost reply, stable accepted/held identity/revision, deliberate held correction, immutable receipts, atomic receipt rollback, newer-price preservation, conflicting evidence/identity rejection, role isolation and legacy no-key path; migration applied twice');
}finally{await db.close();}

const legacyDb=new PGlite();
try{
 const f=await priceQuoteFixture(legacyDb,{upgrade:false});await f.actor(legacyDb,f.owner);
 const doc=await f.document(),cmd=f.quote(doc,{unavailable:true}),item=await f.call(legacyDb,cmd);
 const missing=await f.document(),ambiguous=await f.document(),changed=await f.document();
 await f.call(legacyDb,f.quote(ambiguous,{unavailable:true}));await f.call(legacyDb,f.quote(ambiguous,{unavailable:true}));
 const edited=await f.call(legacyDb,f.quote(changed,{unavailable:true}));await legacyDb.query('update vendor_items set price=99 where id=$1',[edited]);
 await legacyDb.query('reset role');await upgradePriceQuoteRecovery(legacyDb);await f.actor(legacyDb,f.owner);
 const before=(await legacyDb.query('select * from vendor_items where id=$1',[item])).rows[0];
 assert.equal(await f.call(legacyDb,cmd),item,'exact legacy staged identity may be recovered without guessing');
 assert.deepEqual((await legacyDb.query('select * from vendor_items where id=$1',[item])).rows[0],before);
 assert.equal((await legacyDb.query('select staged_receipts_version from import_documents where id=$1',[doc])).rows[0].staged_receipts_version,null);
 await assert.rejects(legacyDb.query('update import_documents set staged_receipts_version=1 where id=$1',[doc]),/version cannot be changed/);
 const count=(await legacyDb.query('select count(*)::int as n from vendor_items')).rows[0].n;
 for(const id of [missing,ambiguous])await assert.rejects(f.call(legacyDb,f.quote(id,{unavailable:true})),/no unique saved listing/);
 await assert.rejects(f.call(legacyDb,f.quote(changed,{unavailable:true})),/no longer matches/);
 assert.equal((await legacyDb.query('select count(*)::int as n from vendor_items')).rows[0].n,count);
 console.log('PASS legacy staged recovery: exact identity retained; absent/ambiguous/edited listings stay for review with no new listing; legacy marker cannot be bypassed');
}finally{await legacyDb.close();}

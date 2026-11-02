import {PGlite} from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {priceQuoteFixture} from './fixtures/price-quote-db.mjs';
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
 console.log('PASS SQL quote recovery: lost reply, stable identity/revision, newer-price preservation, conflicting evidence/identity rejection, role isolation and legacy no-key path; migration applied twice');
}finally{await db.close();}

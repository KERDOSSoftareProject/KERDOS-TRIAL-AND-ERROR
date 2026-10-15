import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {PGlite} from "@electric-sql/pglite";

const db=new PGlite();
const sql=fs.readFileSync(fileURLToPath(new URL("../../knowledge/migration_012_vendor_nvim.sql",import.meta.url)),"utf8");
await db.exec(`create role authenticated; create role anon;
create table public.vendor_items(id uuid primary key,organization_id uuid not null,vendor_id uuid not null,
  vendor_item_code text,description text,pack_size text,price numeric);
insert into public.vendor_items values
  ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000020','A','A','1/5 LB',5),
  ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000020',null,'B','1/5 LB',6),
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000021','A','C','1/5 LB',7);`);
await db.exec(sql);
const query=()=>db.query("select id,nvim_number from public.vendor_items order by id");
assert.deepEqual((await query()).rows.map(r=>r.nvim_number==null?null:Number(r.nvim_number)),[null,1,null],"only unnumbered vendor items receive NVIM");
await db.query(`insert into public.vendor_items values
  ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000020',null,'D','1/5 LB',8)`);
assert.equal(Number((await db.query("select nvim_number from public.vendor_items where description='D'")).rows[0].nvim_number),2);
await db.query("update public.vendor_items set price=9, vendor_item_code='NEW' where description='B'");
assert.equal(Number((await db.query("select nvim_number from public.vendor_items where description='B'")).rows[0].nvim_number),1,"a previously unnumbered item retains its link when a vendor later supplies a code");
await assert.rejects(db.query("update public.vendor_items set nvim_number=44 where description='B'"),/cannot change/);
await assert.rejects(db.query("update public.vendor_items set vendor_id='00000000-0000-0000-0000-000000000021' where description='B'"),/cannot change/);
await db.exec(sql);
assert.deepEqual((await query()).rows.map(r=>r.nvim_number==null?null:Number(r.nvim_number)),[null,1,null,2],"migration is safe to rerun");
await db.query(`insert into public.vendor_items values
  ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000020','E','E','1/5 LB',8)`);
assert.equal((await db.query("select nvim_number from public.vendor_items where description='E'")).rows[0].nvim_number,null,"vendor supplied codes do not receive NVIM");
await db.query("update public.vendor_items set vendor_item_code=null where description='E'");
assert.equal(Number((await db.query("select nvim_number from public.vendor_items where description='E'")).rows[0].nvim_number),3,"removing a vendor code creates the next stable NVIM");
await db.close();
console.log("KERDOS vendor NVIM SQL tests passed");

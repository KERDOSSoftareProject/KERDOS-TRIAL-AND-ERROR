import {createClient} from '@supabase/supabase-js';
import {createProcurementContext} from '../src/procurement.js';

const {SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key} = process.env;
const args = process.argv.slice(2);
const organizationId = args[0];
const apply = args[1] === '--apply';
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(organizationId || '')
    || args.length > 2 || (args.length === 2 && !apply)) {
  throw new Error('Usage: node scripts/backfill-product-labels.mjs ORGANIZATION_UUID [--apply]');
}
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');

const client = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}});
const batchSize = 200;

async function read(query, action) {
  const {data, error} = await query;
  if (error) throw new Error(`${action}: ${error.message}`);
  return data;
}

async function* batches(query, action) {
  let after = null;
  while (true) {
    let page = query().order('id').limit(batchSize);
    if (after) page = page.gt('id', after);
    const rows = await read(page, action);
    if (!rows.length) return;
    yield rows;
    after = rows.at(-1).id;
  }
}

const organization = await read(
  client.from('organizations').select('industry').eq('id', organizationId).single(),
  'Read organization industry'
);
const vocabulary = [];
for await (const rows of batches(
  () => client.from('org_vocabulary').select('id,kind,term,canonical').eq('organization_id', organizationId),
  'Read organization vocabulary'
)) vocabulary.push(...rows);
const procurement = createProcurementContext({industry: organization.industry, vocabulary});

let reviewed = 0;
let candidates = 0;
let updated = 0;
for await (const rows of batches(
  () => client.from('catalog_items').select('id,name').eq('organization_id', organizationId)
    .eq('lifecycle_state', 'active').eq('concept_review_required', false)
    .is('merged_into_id', null).is('concept_key', null),
  'Read active unlabelled catalog items'
)) {
  reviewed += rows.length;
  const labels = rows.flatMap(({id, name}) => {
    const {key} = procurement.readProductLabel({description: name});
    return key && Buffer.byteLength(key, 'utf8') <= 1024 ? [{id, name, key}] : [];
  });
  candidates += labels.length;
  if (apply && labels.length) {
    updated += await read(client.rpc('kerdos_backfill_product_labels', {
      p_organization_id: organizationId,
      p_items: labels,
    }), 'Save labels');
  }
}

console.log(JSON.stringify({organizationId, mode: apply ? 'apply' : 'dry-run', reviewed, candidates, updated}));

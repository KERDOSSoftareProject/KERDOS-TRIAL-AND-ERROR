import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const raw=process.env.EXPECTED_BASE_PATH||"/";
const base=raw==="/"?"/":`/${raw.replace(/^\/+|\/+$/g,"")}/`;
const html=fs.readFileSync("dist/index.html","utf8");
const assets=[...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match=>match[1]).filter(value=>value.includes("/assets/"));
assert.ok(assets.length,"The production page does not reference a built JavaScript asset");
for(const asset of assets){
  assert.ok(asset.startsWith(`${base}assets/`),`Broken Pages path: ${asset}; expected it below ${base}`);
  const local=path.join("dist",asset.slice(base.length));
  assert.ok(fs.existsSync(local),`The page references a missing build asset: ${local}`);
}
console.log(`GitHub Pages build paths verified for ${base}`);

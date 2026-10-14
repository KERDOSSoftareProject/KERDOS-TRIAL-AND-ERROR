import assert from "node:assert/strict";
import {priceDocumentStatus} from "./import-status.js";

assert.equal(priceDocumentStatus({failedRows:0,failuresBeforeGroup:0,completedKeys:new Set(["row:0","row:1"]),rowCount:2}),"complete");
assert.equal(priceDocumentStatus({failedRows:1,failuresBeforeGroup:0,completedKeys:new Set(["row:0"]),rowCount:2}),"partial");
assert.equal(priceDocumentStatus({failedRows:0,failuresBeforeGroup:0,completedKeys:new Set(["row:0"]),rowCount:2}),"partial");
console.log("Price document completion follows saved rows, independent of quotation review.");

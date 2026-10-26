/**
 * portable-file-reader.mjs
 *
 * Converts raw attachment bytes into a normalised read result that
 * background-import.mjs can parse without browser APIs.
 *
 * Supported input kinds:
 *   • text/csv, text/plain, text/tab-separated-values
 *     → { kind: "lines", lines: string[] }
 *       lines are raw text rows (header included); background-import joins
 *       them with "\n" and passes the string to parseDocument().
 *
 *   • application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (.xlsx)
 *   • application/vnd.ms-excel (.xls)
 *   • text/csv that Postmark mis-labels as an Excel MIME
 *     → { kind: "sheets", sheets: Array<{ name: string, rows: string[][] }> }
 *       background-import converts the first non-empty sheet back to CSV text.
 *
 *   • anything else
 *     → { kind: "unsupported", mimeType: string }
 *
 * FileReadError is thrown only when a supported MIME type cannot be decoded
 * (corrupt XLSX, non-UTF-8 text).  Unsupported MIMEs return { kind:
 * "unsupported" } without throwing so the caller can set processing_status
 * = 'needs_review' rather than triggering a Postmark retry.
 *
 * Zero browser APIs — confirmed by audit.  atob / TextDecoder are available
 * in Deno (Edge Functions) and Node ≥ 18 (tests).
 */

// ── FileReadError ─────────────────────────────────────────────────────────────

export class FileReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileReadError";
  }
}

// ── MIME helpers ──────────────────────────────────────────────────────────────

const TEXT_MIMES = new Set([
  "text/csv",
  "text/plain",
  "text/tab-separated-values",
  "text/tsv",
  "application/csv",
  "application/x-csv",
  // Postmark sometimes labels CSVs with an Excel MIME — normalise here.
  "application/vnd.ms-excel",
]);

const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/x-xlsx",
]);

function normaliseMime(mimeType, filename) {
  const m = (mimeType || "").toLowerCase().split(";")[0].trim();
  if (m) return m;
  // Fall back to filename extension when Content-Type is absent or generic.
  const ext = (filename || "").split(".").pop().toLowerCase();
  if (ext === "csv")  return "text/csv";
  if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "xls")  return "application/vnd.ms-excel";
  if (ext === "txt")  return "text/plain";
  return m;
}

// ── Text / CSV reading ────────────────────────────────────────────────────────

function readTextBytes(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Normalise line endings; filter trailing blank lines but keep content lines.
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    // Trim a single trailing empty line (common in saved CSV files) but
    // preserve intentional blank lines inside the content.
    if (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return { kind: "lines", lines };
  } catch (e) {
    throw new FileReadError(`UTF-8 decode failed: ${e.message}`);
  }
}

// ── XLSX reading ──────────────────────────────────────────────────────────────
//
// XLSX is a ZIP file containing XML.  We parse it without an external library.
// ZIP method 8 (deflate) entries are decompressed with DecompressionStream
// ("deflate-raw"), which is available in Deno (Edge Functions), Node 18+, and
// modern browsers.
//
// For the purposes of the background processing pipeline we only need the cell
// values as strings.  Full formula / type fidelity is handled by the browser's
// PasteModal if the attachment is escalated to needs_review.
//
// If the workbook cannot be parsed (corrupt ZIP, encrypted file, OOXML variant
// we don't handle), we throw FileReadError so the attachment goes to
// needs_review rather than causing a Postmark retry loop.

async function readXlsxBytes(bytes) {
  // Try to decompress as ZIP and find the shared strings + worksheet XML.
  // We use a minimal parser that handles the subset of OOXML produced by
  // common spreadsheet applications (Excel, LibreOffice, Google Sheets export).
  try {
    const sheets = await parseXlsx(bytes);
    if (!sheets || sheets.length === 0) {
      throw new FileReadError("XLSX workbook contains no sheets");
    }
    return { kind: "sheets", sheets };
  } catch (e) {
    if (e instanceof FileReadError) throw e;
    throw new FileReadError(`XLSX parse failed: ${e.message}`);
  }
}

/**
 * Minimal XLSX parser — pure JS, no dependencies.
 * Returns Array<{ name: string, rows: string[][] }>.
 *
 * Supports the subset of OOXML that Excel / LibreOffice / Google Sheets
 * produce: shared strings, inline strings, and numeric cell values.
 * Does not handle: formula evaluation, rich text runs, merged cells,
 * multiple string tables, or non-standard compression methods.
 */
async function parseXlsx(bytes) {
  // ── 1. Unzip ─────────────────────────────────────────────────────────────
  // We walk the ZIP central directory to locate the files we need.
  const zip = await parseZip(bytes);

  const sharedStringsEntry = zip["xl/sharedStrings.xml"];
  const workbookEntry      = zip["xl/workbook.xml"];
  const relsEntry          = zip["xl/_rels/workbook.xml.rels"];

  if (!workbookEntry) {
    throw new FileReadError("Not a valid XLSX file (missing xl/workbook.xml)");
  }

  // ── 2. Parse shared strings ───────────────────────────────────────────────
  const sharedStrings = sharedStringsEntry
    ? parseSharedStrings(bytesToString(sharedStringsEntry))
    : [];

  // ── 3. Parse workbook to get sheet names and relationship ids ─────────────
  const sheetDefs = parseWorkbookSheets(bytesToString(workbookEntry));
  const rels      = relsEntry ? parseRels(bytesToString(relsEntry)) : {};

  // ── 4. Parse each worksheet ───────────────────────────────────────────────
  const results = [];
  for (const def of sheetDefs) {
    const target = rels[def.rId];
    if (!target) continue;

    // Normalise path: xl/worksheets/sheet1.xml
    const sheetPath = target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\.\//, "")}`;

    const sheetEntry = zip[sheetPath];
    if (!sheetEntry) continue;

    const rows = parseWorksheet(bytesToString(sheetEntry), sharedStrings);
    results.push({ name: def.name, rows });
  }

  return results;
}

// ── ZIP decompression ─────────────────────────────────────────────────────────

/**
 * Decompress raw deflate (ZIP method 8) bytes using the platform's built-in
 * DecompressionStream with the "deflate-raw" format.
 *
 * "deflate-raw" = RFC 1951 raw deflate, no zlib (RFC 1950) wrapper and no
 * gzip (RFC 1952) wrapper — exactly what ZIP method 8 stores.
 *
 * Available in:
 *   • Deno 1.9+ (Supabase Edge Functions run Deno 1.30+)
 *   • Node.js 18+
 *   • Modern browsers (Chrome 80+, Firefox 113+, Safari 16.4+)
 */
async function decompressDeflateRaw(compressed) {
  // DecompressionStream("deflate-raw") decodes raw DEFLATE (RFC 1951).
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write the compressed data then close the writable side.
  await writer.write(compressed);
  await writer.close();

  // Collect all output chunks.
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate into a single Uint8Array.
  const totalLen = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

// ── ZIP parser ────────────────────────────────────────────────────────────────

async function parseZip(bytes) {
  // Locate End of Central Directory record (signature 0x06054b50)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new FileReadError("Not a ZIP file (no EOCD record)");

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdSize   = view.getUint32(eocdOffset + 12, true);

  // First pass: collect raw entry data from the central directory.
  const rawEntries = []; // { filename, compression, compData }
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (view.getUint32(pos, true) !== 0x02014b50) break; // Central dir signature

    const compression  = view.getUint16(pos + 10, true);
    const fnLen        = view.getUint16(pos + 28, true);
    const extraLen     = view.getUint16(pos + 30, true);
    const commentLen   = view.getUint16(pos + 32, true);
    const localOffset  = view.getUint32(pos + 42, true);
    const fnBytes      = bytes.slice(pos + 46, pos + 46 + fnLen);
    const filename     = new TextDecoder().decode(fnBytes);
    // compressed_size is at offset 20 in the CD entry (before pos was advanced)
    const compSize     = view.getUint32(pos + 20, true);

    pos += 46 + fnLen + extraLen + commentLen;

    // Read local file header to find data offset
    const localView = new DataView(bytes.buffer, bytes.byteOffset + localOffset, 30);
    if (localView.getUint32(0, true) !== 0x04034b50) continue;
    const localFnLen    = localView.getUint16(26, true);
    const localExtraLen = localView.getUint16(28, true);
    const dataOffset    = localOffset + 30 + localFnLen + localExtraLen;
    const compData      = bytes.slice(dataOffset, dataOffset + compSize);

    rawEntries.push({ filename, compression, compData });
  }

  // Second pass: decompress asynchronously where needed.
  // Decompression runs in parallel for all deflate entries.
  const deflateJobs = rawEntries
    .filter(e => e.compression === 8)
    .map(async e => {
      try {
        return { filename: e.filename, data: await decompressDeflateRaw(e.compData) };
      } catch (_) {
        // Decompression failure → omit this entry so the caller can throw
        // FileReadError ("missing xl/workbook.xml") rather than crashing.
        return { filename: e.filename, data: null };
      }
    });

  const decompressed = Object.fromEntries(
    (await Promise.all(deflateJobs))
      .filter(r => r.data !== null)
      .map(r => [r.filename, r.data])
  );

  // Assemble final entries map.
  const entries = {};
  for (const e of rawEntries) {
    if (e.compression === 0) {
      entries[e.filename] = e.compData;
    } else if (e.compression === 8 && decompressed[e.filename]) {
      entries[e.filename] = decompressed[e.filename];
    }
    // Other compression methods are silently skipped; they will surface as
    // a FileReadError when a required OOXML file is missing from the map.
  }

  return entries;
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function bytesToString(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Extract all <si> text values from sharedStrings.xml */
function parseSharedStrings(xml) {
  const results = [];
  // Match <si>…</si> blocks, then extract text content.
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    // Concatenate all <t> values (handles rich text runs with multiple <t> elements).
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let text = "";
    let tm;
    while ((tm = tRe.exec(m[1])) !== null) {
      text += xmlUnescape(tm[1]);
    }
    results.push(text);
  }
  return results;
}

/** Extract sheet name + rId pairs from workbook.xml */
function parseWorkbookSheets(xml) {
  const results = [];
  const re = /<sheet\s[^>]*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const name  = attrVal(tag, "name")  || `Sheet${results.length + 1}`;
    const rId   = attrVal(tag, "r:id") || attrVal(tag, "id") || "";
    if (rId) results.push({ name, rId });
  }
  return results;
}

/** Extract relationship id → target from workbook.xml.rels */
function parseRels(xml) {
  const rels = {};
  const re = /<Relationship\s[^>]*>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const id     = attrVal(tag, "Id")     || "";
    const target = attrVal(tag, "Target") || "";
    if (id) rels[id] = target;
  }
  return rels;
}

/** Parse a worksheet XML into string[][] rows */
function parseWorksheet(xml, sharedStrings) {
  // Extract the <sheetData> block.
  const dataMatch = /<sheetData>([\s\S]*?)<\/sheetData>/.exec(xml);
  if (!dataMatch) return [];

  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;

  while ((rowMatch = rowRe.exec(dataMatch[1])) !== null) {
    const cells = [];
    const cellRe = /<c\s([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;

    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const attrs  = cellMatch[1];
      const inner  = cellMatch[2];
      const cellRef  = attrVal(`<c ${attrs}>`, "r") || "";
      const cellType = attrVal(`<c ${attrs}>`, "t") || "n";

      // Calculate column index from cell reference (e.g. "C3" → 2)
      const colLetter = cellRef.replace(/\d/g, "");
      const colIndex  = colLetterToIndex(colLetter);

      // Pad cells array to the correct column position.
      while (cells.length < colIndex) cells.push("");

      // Extract value
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const isVal  = /<is>([\s\S]*?)<\/is>/.exec(inner);

      let cellValue = "";
      if (cellType === "s" && vMatch) {
        // Shared string index
        const idx = parseInt(vMatch[1], 10);
        cellValue = sharedStrings[idx] ?? "";
      } else if (cellType === "inlineStr" && isVal) {
        const tMatch = /<t[^>]*>([\s\S]*?)<\/t>/.exec(isVal[1]);
        cellValue = tMatch ? xmlUnescape(tMatch[1]) : "";
      } else if (vMatch) {
        cellValue = vMatch[1];
      }

      if (cells.length === colIndex) {
        cells.push(String(cellValue));
      } else {
        cells[colIndex] = String(cellValue);
      }
    }

    if (cells.some(c => c !== "")) {
      rows.push(cells);
    }
  }

  return rows;
}

function colLetterToIndex(letters) {
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1; // 0-based
}

function attrVal(tag, name) {
  const re = new RegExp(`${name}="([^"]*)"`, "i");
  const m = re.exec(tag);
  return m ? m[1] : null;
}

function xmlUnescape(s) {
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Read attachment bytes into a normalised read result.
 *
 * @param {Uint8Array} bytes
 * @param {string}     mimeType   — Content-Type from Postmark (may be empty/generic)
 * @param {string}     filename   — original filename for extension fallback
 * @returns {{ kind: "lines", lines: string[] }
 *          |{ kind: "sheets", sheets: Array<{ name: string, rows: string[][] }> }
 *          |{ kind: "unsupported", mimeType: string }}
 * @throws {FileReadError} when a supported type fails to decode (corrupt data)
 */
export async function readAttachment(bytes, mimeType, filename) {
  const mime = normaliseMime(mimeType, filename);

  if (TEXT_MIMES.has(mime)) {
    return readTextBytes(bytes);
  }

  if (XLSX_MIMES.has(mime)) {
    return readXlsxBytes(bytes);
  }

  return { kind: "unsupported", mimeType: mime || mimeType || "unknown" };
}

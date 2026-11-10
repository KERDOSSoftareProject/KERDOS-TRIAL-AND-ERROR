// Bind a studied layout to one source row before interpreting any values.
export function identifyRowFields({cells, columnMap, sourceHeaders, fieldOrigins, rowIndex, columnStart = 0}) {
  const values = {};
  const bindings = {};
  for (const [field, index] of Object.entries(columnMap)) {
    if (!Number.isInteger(index) || index < 0) continue;
    const rawValue = cells[index];
    values[field] = rawValue;
    bindings[field] = {
      rowIndex,
      columnIndex: columnStart + index,
      header: sourceHeaders[index] || null,
      rawValue: rawValue ?? null,
      evidence: fieldOrigins[field] || "inferred",
    };
  }

  const description = bindings.description;
  const conflicts = Object.keys(bindings).filter(field =>
    field !== "description" && bindings[field].columnIndex === description?.columnIndex
  );
  const status = conflicts.length ? "ambiguous"
    : !String(description?.rawValue ?? "").trim() ? "missing"
    : description.evidence === "inferred" ? "inferred" : "identified";
  const anchor = {
    field: "description",
    status,
    rowIndex,
    columnIndex: description?.columnIndex ?? null,
    rawValue: description?.rawValue ?? null,
    conflicts,
  };
  return {version: 1, anchor, values, bindings};
}

// Presentation markers are layout furniture. Keep the bound text itself
// intact and use this view for row admission and the interpreted label.
export function withoutDescriptionFormatting(value){
  return value.trim()
    .replace(/\s+\*{2,}[A-Z0-9]+\*{2,}/gi,"")
    .replace(/\*+([^*]+)\*+/g,"$1")
    .replace(/\*+/g,"")
    .replace(/\s{2,}/g," ")
    .trim();
}

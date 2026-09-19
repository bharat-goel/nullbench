// Canonical JSON, an RFC 8785 subset sufficient for registration hashing.
//
// The registration hash must not move when someone runs a formatter over
// nullbench.json. JSON.stringify preserves insertion order, so it is not stable across
// hand edits; this sorts keys at every level and emits no insignificant whitespace.
//
// Values with no canonical form throw rather than serialize. JSON.stringify drops
// undefined and functions from objects and turns NaN into null, any of which would
// produce two different registrations that hash identically.

export function canonicalJSON(value) {
  return ser(value);
}

function ser(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`no canonical form for ${v}`);
    return JSON.stringify(v);
  }
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(ser).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${ser(v[k])}`).join(",")}}`;
  }
  throw new TypeError(`no canonical form for value of type ${t}`);
}

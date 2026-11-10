/**
 * Upstream issue #320: do Result.getValue/getText accept the documented options
 * form {name, join, summary} as well as a search.Column? Read-only. Returns
 * plain data only (value types, no ids or values).
 *
 * @NApiVersion 2.1
 * @scriptType Restlet
 */
define(["N/search"], (search) => ({
  run() {
    const result = {};
    const t = (key, fn) => {
      try {
        result[key] = fn();
      } catch (e) {
        result[key] = `THROWS: ${e.name}: ${e.message}`;
      }
    };
    const shape = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
    const first = (columns) =>
      search.create({ type: "transaction", columns }).run().getRange({ start: 0, end: 1 })[0];
    const plain = (() => {
      try {
        return first([
          search.createColumn({ name: "tranid" }),
          search.createColumn({ name: "entity" }),
          search.createColumn({ name: "email", join: "customer" }),
        ]);
      } catch (e) {
        result["plain search"] = `THROWS: ${e.name}: ${e.message}`;
      }
    })();
    // Grouped search so a summary is legal; every column needs a summary.
    const grp = (() => {
      try {
        return first([
          search.createColumn({ name: "entity", summary: search.Summary.GROUP }),
          search.createColumn({ name: "email", join: "customer", summary: search.Summary.GROUP }),
          search.createColumn({ name: "internalid", summary: search.Summary.COUNT }),
        ]);
      } catch (e) {
        result["grouped search"] = `THROWS: ${e.name}: ${e.message}`;
      }
    })();
    result["plain row found"] = !!plain;
    result["grouped row found"] = !!grp;
    if (plain) {
      t("getValue({name})", () => shape(plain.getValue({ name: "tranid" })));
      t("getValue({name, join})", () => shape(plain.getValue({ name: "email", join: "customer" })));
      t("getText({name})", () => shape(plain.getText({ name: "entity" })));
      t("getText({name, join})", () => shape(plain.getText({ name: "email", join: "customer" })));
      t("getValue(Column)", () => shape(plain.getValue(plain.columns[0])));
      t("getText(Column)", () => shape(plain.getText(plain.columns[1])));
      t("getValue('tranid')", () => shape(plain.getValue("tranid")));
    }
    if (grp) {
      const G = search.Summary.GROUP;
      t("getValue({name, summary})", () =>
        shape(grp.getValue({ name: "internalid", summary: search.Summary.COUNT })));
      t("getValue({name, summary: 'COUNT'})", () =>
        shape(grp.getValue({ name: "internalid", summary: "COUNT" })));
      t("getValue({name, join, summary})", () =>
        shape(grp.getValue({ name: "email", join: "customer", summary: G })));
      t("getText({name, summary})", () => shape(grp.getText({ name: "entity", summary: G })));
      t("getText({name, join, summary})", () =>
        shape(grp.getText({ name: "email", join: "customer", summary: G })));
    }
    return result;
  },
}));

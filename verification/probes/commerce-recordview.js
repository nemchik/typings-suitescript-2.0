/**
 * What do `recordView.viewItems` and `recordView.viewWebsite` return in a
 * deployed server script, and what does `fields` accept? Oracle's sample (copied
 * from one method to the other) shows an array of `{ value }` wrappers; the
 * module members table says `Object`.
 *
 * Needs a website with id 1 and at least two items available on it. Change the
 * ids below for your account.
 *
 * Typings: headintheclouddev/typings-suitescript-2.0 pull request 385.
 *
 * @NApiVersion 2.1
 * @scriptType Restlet
 */
define(["N/commerce/recordView"], (recordView) => ({
  run() {
    const websiteId = 1;
    const itemIds = [2930, 2937];
    const result = {};
    const t = (key, fn) => {
      try {
        result[key] = fn();
      } catch (e) {
        result[key] = `THROWS: ${e.name}: ${e.message}`;
      }
    };
    const summarize = (v) => ({
      first:
        Array.isArray(v) && v.length
          ? {
              keys: v[0] && typeof v[0] === "object" ? Object.keys(v[0]) : null,
              length: v.length,
              string: String(v[0]).slice(0, 80),
              typeof: typeof v[0],
            }
          : null,
      isArray: Array.isArray(v),
      string: String(v).slice(0, 80),
      typeof: typeof v,
    });
    for (const field of ["displayname", "internalid", "languages", "name"]) {
      t(`viewWebsite field ${field}`, () => {
        const r = recordView.viewWebsite({ fields: [field], id: websiteId });
        return {
          top: { isArray: Array.isArray(r), keys: Object.keys(r) },
          value: summarize(r[field]),
        };
      });
    }
    t("viewItems", () => {
      const r = recordView.viewItems({
        fields: ["itemid", "itemtype"],
        ids: itemIds,
      });
      const first = r[Object.keys(r)[0]];
      return {
        firstJson: JSON.stringify(first),
        isArray: Array.isArray(r),
        keys: Object.keys(r),
        typeof: typeof r,
      };
    });
    t("viewItems with fields as a string", () => {
      const r = recordView.viewItems({ fields: "itemid", ids: itemIds });
      return { isArray: Array.isArray(r), keys: Object.keys(r) };
    });
    return result;
  },
}));

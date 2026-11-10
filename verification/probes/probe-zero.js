/**
 * Probe zero: proves the whole verification chain works (token, deploy, call,
 * JSON back) and reports a few facts about the runtime.
 *
 * @NApiVersion 2.1
 * @scriptType Restlet
 */
define([], () => ({
  run() {
    const result = {};
    const t = (key, fn) => {
      try {
        result[key] = fn();
      } catch (e) {
        result[key] = `THROWS: ${e.name}: ${e.message}`;
      }
    };
    t("util is a global", () => typeof util);
    t("util.isArray([])", () => util.isArray([]));
    t("log is a global", () => typeof log);
    t("typeof performance", () => typeof performance);
    t("typeof process", () => typeof process);
    return result;
  },
}));

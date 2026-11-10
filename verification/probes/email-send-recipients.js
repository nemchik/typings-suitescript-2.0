/**
 * Does `email.send` accept a mixed array of internal ids and email addresses for
 * `recipients`, `cc` and `bcc`, and a single value (id or address) for `cc` and
 * `bcc`? Oracle's text says mixed arrays are valid; the typings only allow
 * `number[]` or `string[]`.
 *
 * Unlike most probes this WRITES: each accepted call creates a Message record and
 * sends one email to the user the token maps to (the sender, by id, and that user's
 * own address). Run it only in a sandbox and expect about 6 messages.
 *
 * @NApiVersion 2.1
 * @scriptType Restlet
 */
define(["N/email", "N/runtime"], (email, runtime) => ({
  run() {
    const result = {};
    const t = (key, fn) => {
      try {
        fn();
        result[key] = "OK";
      } catch (e) {
        result[key] = `THROWS: ${e.name}: ${e.message}`;
      }
    };
    const user = runtime.getCurrentUser();
    const id = user.id;
    const address = user.email;
    result["user has email"] = typeof address === "string" && address.length > 0;
    const send = (extra) => () =>
      email.send({
        author: id,
        recipients: id,
        subject: "typings probe",
        body: "typings probe: safe to delete",
        ...extra,
      });
    t("recipients: [id, address]", send({ recipients: [id, address] }));
    t("recipients: [address, id]", send({ recipients: [address, id] }));
    t("cc: [id, address]", send({ cc: [id, address] }));
    t("bcc: [id, address]", send({ bcc: [id, address] }));
    t("cc: id (single)", send({ cc: id }));
    t("cc: address (single)", send({ cc: address }));
    t("bcc: id (single)", send({ bcc: id }));
    t("bcc: address (single)", send({ bcc: address }));
    // Over the documented maximum of 10; should throw before sending.
    t(
      "11 recipients (expected to throw)",
      send({ recipients: Array.from({ length: 11 }, () => address) }),
    );
    return result;
  },
}));

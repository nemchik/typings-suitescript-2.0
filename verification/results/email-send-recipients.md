# email.send recipients, cc and bcc: mixed arrays and single values

- **NetSuite version:** not run yet
- **Account type:** sandbox (required: every accepted call sends an email)
- **Date:** not run yet
- **Method:** script debugger, run by hand (not the runner: this test writes to the account)
- **Probe:** none. It was `probes/email-send-recipients.js`; the probe was removed because the runner only runs probes that do not write

Does `email.send` accept a mixed array of internal ids and email addresses for `recipients`, `cc` and `bcc`, and a single value (id or address) for `cc` and `bcc`? Oracle's text says mixed arrays are valid; the typings only allow `number[]` or `string[]`.

**Status: unverified.** The claim stays unverified until someone runs the test below and fills in this page.

## Test

Each accepted call creates a Message record and sends one email to the user running it (the author, by id, and that user's own address): expect about 8 messages. Run it in a **sandbox** only, in Customization > Scripting > Script Debugger (API version 2.1), then copy the logged JSON into Results.

```js
require(["N/email", "N/runtime", "N/log"], (email, runtime, log) => {
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
  log.debug("result", JSON.stringify(result));
});
```

The script debugger can behave differently from a deployed script; confirm a surprising result with a deployed script.

## Results

Not run yet. Paste the logged JSON here. The output holds only `OK` or the error per key, no ids or addresses; check that before committing.

## Explanation

Not run yet.

## Decision

Not run yet. No typing change should cite this page until it has results.

# Runtime verification

Oracle's help pages, its samples and these typings sometimes disagree with each other and with the platform. A **probe** is a small script that runs in a NetSuite **sandbox** and returns what the platform really does, so a typing change can cite evidence instead of a documentation page.

This folder is a project of its own. It is not part of the published package (`package.json` `files` only lists the typings), and nothing here is compiled with them (`tsconfig.json` excludes it).

## How it works

1. A probe is one file, `probes/<module>-<member>.js`, whose `run()` returns plain data. Its header says what it checks and links the pull request or issue that needs it.
2. `runner/runner.template.js` becomes one RESTlet, deployed to your sandbox, that runs a probe **by name** from a fixed list generated from `probes/`. It never runs code from a request, and refuses to run unless the account is a sandbox.
3. `npm run verify:run -- <probe>` gets an OAuth 2.0 machine-to-machine token, calls the runner and prints the result. Paste the output and the NetSuite version it reports into the pull request.

A probe runs as a **RESTlet**, as the role mapped to the token. Behavior that depends on another script type, or on a browser, has to be tested by hand.

## Writing a probe

```js
/**
 * Does `util.isArray` exist in a deployed server script?
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
    t("typeof util.isArray", () => typeof util.isArray);
    return result;
  },
}));
```

Wrap each check so a failure is data, not a crash. A probe that fails while loading takes the whole runner down (every probe then answers `HTTP 400`), so keep work inside `run()`. Every added or edited probe needs a new deploy.

A probe must not write to the account. Do not put account numbers, ids of real records or credentials in a probe or in the output you paste: the tooling refuses to print output that looks like an identifier, but check it.

## Commands

Run from the repository root; pass arguments after `--`.

| Command                                | Does                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify:doctor`                | Read-only checklist. For each failing step it says what to do next.                                                         |
| `npm run verify:certificate`           | Generates the two key pairs with `openssl` (outside the repository) and saves their paths to `verification/.env.local`.     |
| `npm run verify:passkey`               | Generates the SuiteCloud CLI passkey and saves it to `verification/.env.local`.                                             |
| `npm run verify:env -- set NAME=value` | Saves one value (account, client id, certificate id) to `verification/.env.local`.                                          |
| `npm run verify:setup-ci`              | Runs `account:setup:ci` for `verification/sdf` from the saved values.                                                       |
| `npm run verify:deploy`                | Builds the runner and **dry-runs** the deployment. Add `-- --approved` to deploy: you type `DEPLOY` at a terminal.         |
| `npm run verify:run -- <probe>`        | Runs one probe and prints its output.                                                                                       |
| `npm run verify:cleanup`               | Dry-runs turning the runner's deployment off. Add `-- --approved` to do it: you type `CLEANUP` at a terminal.               |

Install the tooling once with `npm ci --prefix verification` (Node from `.nvmrc`, and Oracle JDK 17 or 21).

## Setup

The doctor checks these in order.

1. **Tools.** `npm ci --prefix verification` installs the SuiteCloud CLI at a pinned version. Its install script downloads Oracle's SDK jar to `~/.suitecloud-sdk/`; read [Oracle's license](https://www.oracle.com/downloads/licenses/oracle-free-license.html) first. On a headless machine you have to accept it yourself by setting `SUITECLOUD_CLI_ACCEPT_LICENSE=true`.
2. **Browser login, once.** With `SUITECLOUD_CI_PASSKEY` unset, run `node verification/node_modules/@oracle/suitecloud-cli/src/suitecloud.js account:setup` from `verification/sdf`, log in to the sandbox and choose a role. The first authentication has to be browser-based so Oracle's SuiteCloud Development Integration is installed in the account.
3. **Role and integration** (in the sandbox):
   - A custom role with the ID `customrole_biome_verification` (the runner deployment is limited to it; change the two references in `sdf/src` if you use another ID). Give it **Log in using OAuth 2.0 Access Tokens**, **REST Web Services**, **User Access Tokens**, **Documents and Files**, **Allow JS / HTML Uploads** and **SuiteScript**, and add whatever a failing call shows is missing for the probes you write.
   - An integration record with **Client Credentials (Machine to Machine) Grant** checked, the token-based authentication flags, and the **RESTlets** and **REST Web Services** scopes. Note its client id.
4. **Certificates.** `npm run verify:certificate` generates two key pairs: one for the runner's integration and one for the SuiteCloud Development Integration that deploys use (Oracle allows one certificate per integration, role and entity). Upload the two public certificates (Setup > Integration > Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup) and note both certificate ids.
5. **Local configuration.** Everything lives in `verification/.env.local` (gitignored). `npm run verify:certificate` and `npm run verify:passkey` save the key paths and passkey; save the rest with `npm run verify:env -- set NAME=value`: `SUITESCRIPT_VERIFY_ACCOUNT` (`<digits>_SB<n>`), `SUITESCRIPT_VERIFY_CLIENT_ID`, `SUITESCRIPT_VERIFY_CERTIFICATE_ID` and `SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID`.
6. `npm run verify:setup-ci`, then `npm run verify:doctor` until it passes.
7. `npm run verify:deploy`, review the dry run, then run it with `-- --approved` and type `DEPLOY`.
8. `npm run verify:run -- probe-zero` proves the chain (token, deploy, call, JSON back).

A sandbox refresh clears the mappings and the deployed runner; if calls fail with an authentication or "not found" error after one, redo steps 3 to 7.

## Guardrails

- **Sandbox only.** The tooling refuses an account id that is not `<digits>_SB<n>`, and the runner refuses unless `runtime.envType` is a sandbox.
- **No arbitrary code.** A request carries a probe name, never code.
- **Approval for every write.** `verify:deploy` and `verify:cleanup` only dry-run unless you add `--approved` and type the confirmation at a terminal.
- **Secrets stay out.** Private keys live outside the repository; the passkey and ids live in the gitignored `verification/.env.local`. Output is scrubbed of the configured ids and refused if it still looks like an account, host, token, key or email.
- **The runner persists.** The CLI cannot delete a script, so it stays deployed. `npm run verify:cleanup -- --approved` deactivates the deployment; revoke the certificate mapping to remove access.

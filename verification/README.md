# Runtime verification

Oracle's help pages, its samples and these typings sometimes disagree with each other and with the platform. A **probe** is a small script that runs in a NetSuite **sandbox** and returns what the platform really does, so a typing change can cite evidence instead of a documentation page.

This folder is an npm project of its own, built on [suitescript-verify](https://www.npmjs.com/package/suitescript-verify). It is not part of the published typings (`package.json` `files` lists only the typings, and `tsconfig.json` excludes this folder).

## The guide

The package README is the whole guide: method, setup, deploy, probes, settings and troubleshooting. Read the copy installed with the version this folder pins:

```sh
npm ci --prefix verification
# then read verification/node_modules/suitescript-verify/README.md
```

Run the commands from the repository root as `npm run verify:<command>`, with arguments after `--` (for example `npm run verify:run -- probe-zero`). They call the package with `--dir .`, so this folder is the verification folder: `.env` (committed layout), `.env.local` (gitignored credentials), `probes/`, `results/` and the generated `sdf/`.

## Conventions in this repository

- **One probe per question**, named `probes/<module>-<member>.js` (for example `search-create-columns-shape.js`).
- **The probe header links what it supports:** the typings pull request or upstream issue (`Typings: headintheclouddev/typings-suitescript-2.0 pull request <n>` or `Upstream issue #<n>`), and says what the account needs if it needs anything (a feature, records passed with `--param`).
- **No account numbers, URLs, users, tokens or real record ids** in a probe, a results page or a pull request. A probe that needs a real record takes its id as a `@param`.
- **Probes only read.** A test that writes to the account is run by hand, and its code lives in its results page (see `results/email-send-recipients.md`).
- **Results pages go in `verification/results/`**, one per verification (`run <probe> --draft` writes the first version). Link the page from the pull request instead of pasting output into it.
- The runner id is `typings` (committed in `.env`; at most 12 characters with suitescript-verify 1.1.0, whose runner title must fit in 40), so this repository's runner does not collide with other projects in the same sandbox. The committed role id is the package default; set your real role id as `SUITESCRIPT_VERIFY_ROLE_ID` in `.env.local`, which takes priority.

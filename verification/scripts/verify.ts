/**
 * Agent-only tooling for running probes in a NetSuite sandbox. It is not part
 * of the published package or any CI. See verification/README.md.
 *
 *   node scripts/verify.ts doctor
 *   node scripts/verify.ts certificate [--only runner|sdf] [--dir <path>] [--overwrite | --keep]
 *   node scripts/verify.ts passkey [--overwrite | --keep]
 *   node scripts/verify.ts env set NAME=value [--overwrite | --keep]
 *   node scripts/verify.ts setup-ci
 *   node scripts/verify.ts deploy [--approved]
 *   node scripts/verify.ts run <slug>
 *   node scripts/verify.ts cleanup [--approved]
 */
import { spawnSync } from "node:child_process";
import { createPrivateKey, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { formatChecks, runChecks } from "./verify/doctor.ts";
import { applyEnvUpdate, envNames, planEnvUpdate } from "./verify/envfile.ts";
import {
  assertSandbox,
  buildSdfProject,
  clientAssertion,
  configNames,
  listProbes,
  read,
  readConfig,
  restletUrl,
  root,
  scrub,
  sdfDir,
  tokenUrl,
} from "./verify/lib.ts";

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const positional = rest.filter((arg) => !arg.startsWith("--"));

/** The repository root: the verification folder is a project of its own inside it. */
const repoRoot = dirname(root);
const envFile = join(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const cliEntry = join(
  root,
  "node_modules",
  "@oracle",
  "suitecloud-cli",
  "src",
  "suitecloud.js",
);

/** Runs the project's local SuiteCloud CLI from the SDF project folder. */
function suitecloud(args: string[]): number {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Hand the passkey to the CLI for this child process only, so a user-wide
  // SUITECLOUD_CI_PASSKEY never has to exist (it would stop browser login in
  // the user's other SuiteCloud projects).
  if (env.SUITESCRIPT_VERIFY_PASSKEY) {
    env.SUITECLOUD_CI_PASSKEY = env.SUITESCRIPT_VERIFY_PASSKEY;
  }
  if (env.SUITECLOUD_CI_PASSKEY) env.SUITECLOUD_CI = "1";
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: sdfDir,
    env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

/**
 * Saves values to verification/.env.local. A name that already holds a
 * different value is a conflict: ask the person (overwrite or keep). Without a
 * terminal, or with --keep, keep it and say so; --overwrite replaces it.
 * Values are never printed.
 */
async function saveEnv(entries: Record<string, string>) {
  const text = existsSync(envFile) ? read(envFile) : "";
  const plan = planEnvUpdate(text, entries);
  const overwrite = new Set<string>();
  const kept: string[] = [];
  for (const name of plan.conflicts) {
    if (await allowReplace(`${name} in verification/.env.local`)) {
      overwrite.add(name);
    } else {
      kept.push(name);
    }
  }
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, applyEnvUpdate(text, entries, overwrite));
  for (const name of [...plan.fresh, ...overwrite]) {
    console.log(`Saved ${name} to verification/.env.local.`);
  }
  for (const name of plan.same) console.log(`${name} already has this value.`);
  for (const name of kept) {
    console.log(
      `Kept the existing ${name}. To replace it, ask the user, then rerun with --overwrite.`,
    );
  }
}

/** True when the person (or --overwrite) allows replacing something that exists. */
async function allowReplace(description: string) {
  if (flags.has("--overwrite")) return true;
  if (flags.has("--keep") || !process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `${description} already exists. Overwrite it? [y/N] `,
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * A write to the sandbox needs a person at a terminal, on top of --approved:
 * an agent's shell has none, so an agent can not run it. The person types the
 * action name to confirm.
 */
async function confirmWrite(action: string, what: string) {
  if (!process.stdin.isTTY) {
    fail(
      `${what} needs the user at a terminal. Ask the user to run this same command, with --approved, in their own terminal (in Claude Code: type ! before the command).`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${what}. Type ${action} to continue: `);
  rl.close();
  if (answer.trim() !== action) fail("Not confirmed. Nothing was changed.");
}

function requireConfig() {
  const { config, missing } = readConfig(process.env);
  if (!config) fail(`Missing ${missing.join(", ")}. Run the doctor first.`);
  assertSandbox(config.account);
  return config;
}

function doctor() {
  const checks = runChecks({
    env: process.env,
    exists: existsSync,
    home: homedir(),
    keyType: (path) => {
      try {
        const key = createPrivateKey(read(path));
        if (key.asymmetricKeyType === "ec") {
          return `ec:${key.asymmetricKeyDetails?.namedCurve ?? "unknown"}`;
        }
        if (key.asymmetricKeyType === "rsa") {
          return `rsa:${key.asymmetricKeyDetails?.modulusLength ?? 0}`;
        }
      } catch {
        // Unreadable or not a private key.
      }
      return "other";
    },
    mode: (path) =>
      process.platform === "win32" ? undefined : statSync(path).mode,
    nodeVersion: process.versions.node,
    platform: process.platform,
    readText: read,
    repoRoot: root,
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
      return { output: `${r.stdout}${r.stderr}`, status: r.status };
    },
  });
  console.log(formatChecks(checks));
  process.exit(checks.every((check) => check.ok) ? 0 : 1);
}

async function passkey() {
  await saveEnv({
    SUITESCRIPT_VERIFY_PASSKEY: randomBytes(30).toString("hex"),
  });
}

async function setEnv() {
  const [action, assignment] = positional;
  const match = /^([A-Z0-9_]+)=([\s\S]*)$/.exec(assignment ?? "");
  if (action !== "set" || !match) {
    fail(
      "Usage: node scripts/verify.ts env set NAME=value [--overwrite | --keep]",
    );
  }
  const name = match[1] ?? "";
  if (!(envNames as readonly string[]).includes(name)) {
    fail(`Unknown variable ${name}. Known: ${envNames.join(", ")}`);
  }
  if (name === "SUITESCRIPT_VERIFY_PASSKEY") {
    fail("Generate the passkey with `node scripts/verify.ts passkey`.");
  }
  await saveEnv({ [name]: match[2] ?? "" });
}

async function certificate() {
  const dirFlag = rest.indexOf("--dir");
  const dir = resolve(
    dirFlag >= 0 && rest[dirFlag + 1]
      ? (rest[dirFlag + 1] ?? "")
      : join(homedir(), ".suitescript-verification"),
  );
  const rel = relative(repoRoot, dir);
  if (rel === "" || !(rel.startsWith("..") || isAbsolute(rel))) {
    fail("Choose a directory outside the repository.");
  }
  const openssl = [
    "openssl",
    ...(process.platform === "win32"
      ? ["C:\\Program Files\\Git\\usr\\bin\\openssl.exe"]
      : []),
  ].find((candidate) => {
    const r = spawnSync(candidate, ["version"], { encoding: "utf8" });
    return r.status === 0;
  });
  if (!openssl) {
    fail(
      "openssl was not found. Generate the key pair by hand with Oracle's ES256 command (see verification/README.md).",
    );
  }
  // The runner token is signed here (ES256, EC P-256). Oracle's SDK signs the
  // SDF login with PS256 and an RSA key only, so that pair is RSA-4096.
  const kinds = { runner: "ec", sdf: "rsa" } as const;
  const onlyFlag = rest.indexOf("--only");
  const only = onlyFlag >= 0 ? rest[onlyFlag + 1] : undefined;
  if (only !== undefined && only !== "runner" && only !== "sdf") {
    fail("--only takes runner or sdf.");
  }
  const names = (["runner", "sdf"] as const).filter(
    (name) => only === undefined || only === name,
  );
  const paths = (name: string) => ({
    privateKey: join(dir, `${name}-private.pem`),
    publicKey: join(dir, `${name}-public.pem`),
  });
  mkdirSync(dir, { mode: 0o700, recursive: true });
  for (const name of names) {
    const pair = paths(name);
    const exists = existsSync(pair.privateKey) || existsSync(pair.publicKey);
    const mapped =
      process.env[
        name === "runner"
          ? configNames.certificateId
          : configNames.sdfCertificateId
      ];
    if (exists && mapped) {
      console.log(
        `Warning: a ${name} certificate id is already saved. A mapping can not be recreated with the same certificate, and replacing this pair makes that mapping unusable (its private key is lost).`,
      );
    }
    if (!exists || (await allowReplace(`The ${name} key pair in ${dir}`))) {
      generatePair({ kind: kinds[name], openssl, ...pair });
      console.log(
        `Generated the ${name} key pair (${kinds[name] === "ec" ? "EC P-256" : "RSA-4096, RSA-PSS certificate"}, valid for 365 days).`,
      );
    } else {
      console.log(`Kept the existing ${name} key pair.`);
    }
  }
  const runner = paths("runner");
  const sdf = paths("sdf");
  await saveEnv({
    [configNames.privateKeyPath]: runner.privateKey,
    [configNames.sdfPrivateKeyPath]: sdf.privateKey,
  });
  console.log(
    [
      "",
      "Upload these public certificates in NetSuite (verification/README.md, step 5):",
      `  runner: ${runner.publicKey}`,
      `  SDF:    ${sdf.publicKey}`,
    ].join("\n"),
  );
}

/** Oracle's documented `openssl` commands: ES256 (EC P-256) and RSA-PSS (RSA-4096, PS256). */
function generatePair({
  kind,
  openssl,
  privateKey,
  publicKey,
}: {
  kind: "ec" | "rsa";
  openssl: string;
  privateKey: string;
  publicKey: string;
}) {
  const keyArgs =
    kind === "ec"
      ? [
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-pkeyopt",
          "ec_param_enc:named_curve",
        ]
      : [
          "-newkey",
          "rsa:4096",
          "-sigopt",
          "rsa_padding_mode:pss",
          "-sha256",
          "-sigopt",
          "rsa_pss_saltlen:64",
        ];
  const result = spawnSync(
    openssl,
    [
      "req",
      "-new",
      "-x509",
      ...keyArgs,
      "-nodes",
      "-days",
      "365",
      "-subj",
      "/CN=typings-suitescript-verification",
      "-out",
      publicKey,
      "-keyout",
      privateKey,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) fail("openssl failed to generate the key pair.");
  try {
    chmodSync(privateKey, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
  if (process.platform === "win32" && process.env.USERNAME) {
    spawnSync("icacls", [
      privateKey,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERNAME}:F`,
    ]);
  }
}

function setupCi() {
  const config = requireConfig();
  const authId = "typings-verification";
  process.exit(
    suitecloud([
      "account:setup:ci",
      "--account",
      config.account,
      "--authid",
      authId,
      "--certificateid",
      config.sdfCertificateId,
      "--privatekeypath",
      config.sdfPrivateKeyPath,
      // Only for a non-standard domain: a regular sandbox needs none.
      ...(process.env.SUITESCRIPT_VERIFY_DOMAIN
        ? ["--domain", process.env.SUITESCRIPT_VERIFY_DOMAIN]
        : []),
    ]),
  );
}

async function deploy() {
  requireConfig();
  const { files, slugs } = buildSdfProject();
  console.log(`Probes in the runner: ${slugs.join(", ")}`);
  console.log(`Files to upload: ${files.join(", ")}`);
  const approved = flags.has("--approved");
  if (!approved) {
    console.log(
      "\nDry run only. Deploying writes to the sandbox, so ask the user for approval, then rerun with --approved.",
    );
  }
  if (approved) await confirmWrite("DEPLOY", "This deploys to the sandbox");
  process.exit(
    suitecloud(["project:deploy", ...(approved ? [] : ["--dryrun"])]),
  );
}

async function run() {
  const config = requireConfig();
  const slug = positional[0];
  const probe = listProbes().find((candidate) => candidate.slug === slug);
  if (!probe) {
    fail(
      `Unknown probe "${slug}". Known: ${listProbes()
        .map((p) => p.slug)
        .join(", ")}`,
    );
  }
  if (probe.scriptType.toLowerCase() !== "restlet") {
    fail(
      `${probe.slug} needs a ${probe.scriptType || "(undeclared)"} script. The runner only runs RESTlet probes; ask the user to run it by hand (verification/README.md).`,
    );
  }
  if (probe.writes) {
    fail(
      `${probe.slug} declares @writes, which needs the user's separate approval. That path is not automated yet.`,
    );
  }

  const known = {
    account: config.account,
    certificateId: config.certificateId,
    clientId: config.clientId,
    sdfCertificateId: config.sdfCertificateId,
  };
  const endpoint = tokenUrl(config.account);
  const assertion = clientAssertion({
    certificateId: config.certificateId,
    clientId: config.clientId,
    privateKeyPem: readFileSync(config.privateKeyPath, "utf8"),
    tokenEndpoint: endpoint,
  });
  const tokenResponse = await fetch(endpoint, {
    body: new URLSearchParams({
      client_assertion: assertion,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      grant_type: "client_credentials",
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    fail(
      scrub(
        `Token request failed: HTTP ${tokenResponse.status} ${tokenBody.error ?? ""} ${tokenBody.error_description ?? ""}`.trim(),
        known,
      ).text,
    );
  }

  const response = await fetch(restletUrl(config.account), {
    body: JSON.stringify({ probe: probe.slug }),
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    fail(
      `The runner call failed: HTTP ${response.status}\n${scrub(text.slice(0, 500), known).text}`,
    );
  }
  const scrubbed = scrub(text, known);
  if (scrubbed.problems.length > 0) {
    fail(
      `Refusing to print or record the output: ${scrubbed.problems.join("; ")}. Review it by hand.`,
    );
  }
  const body = JSON.parse(scrubbed.text) as {
    error?: string;
    result?: unknown;
    version?: string;
  };
  if (body.error) fail(`The runner refused: ${body.error}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cleanup() {
  requireConfig();
  const objectFile = join(
    sdfDir,
    "src",
    "Objects",
    "customscript_typings_verification_runner.xml",
  );
  const original = read(objectFile);
  const disabled = original.replace(
    "<isdeployed>T</isdeployed>",
    "<isdeployed>F</isdeployed>",
  );
  const approved = flags.has("--approved");
  if (!approved) {
    console.log(
      "Dry run only. This turns the runner's deployment off in the sandbox, so ask the user for approval, then rerun with --approved.\nTo remove access entirely, the user revokes the certificate mapping (Setup > Integration > Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup).",
    );
  }
  if (approved) {
    await confirmWrite("CLEANUP", "This turns the runner's deployment off");
  }
  buildSdfProject();
  writeFileSync(objectFile, disabled);
  try {
    const status = suitecloud([
      "project:deploy",
      ...(approved ? [] : ["--dryrun"]),
    ]);
    process.exitCode = status;
  } finally {
    writeFileSync(objectFile, original);
  }
}

switch (command) {
  case "doctor":
    doctor();
    break;
  case "certificate":
    await certificate();
    break;
  case "passkey":
    await passkey();
    break;
  case "env":
    await setEnv();
    break;
  case "setup-ci":
    setupCi();
    break;
  case "deploy":
    await deploy();
    break;
  case "run":
    await run();
    break;
  case "cleanup":
    await cleanup();
    break;
  default:
    fail(
      "Usage: node scripts/verify.ts doctor | certificate | setup-ci | deploy [--approved] | run <slug> | cleanup [--approved]",
    );
}

import { createPrivateKey, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const probesDir = join(root, "probes");
export const sdfDir = join(root, "sdf");
export const runnerTemplate = join(root, "runner", "runner.template.js");

/** Where the runner and the probes are uploaded to in the File Cabinet. */
export const fileCabinetFolder = "typings-suitescript-verification";
export const runnerScriptId = "customscript_typings_verification_runner";
export const runnerDeployId = "customdeploy_typings_verification_runner";

export const read = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------- probes

export interface Probe {
  scriptType: string;
  slug: string;
  writes: boolean;
}

/** Reads the tags in a probe's leading JSDoc block. */
export function parseProbe(slug: string, source: string): Probe {
  const block = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? "";
  const tags = (name: string) =>
    [...block.matchAll(new RegExp(`@${name}\\b[ \\t]*([^\\n*]*)`, "g"))].map(
      (match) => (match[1] ?? "").trim(),
    );
  return {
    scriptType: tags("scriptType")[0] ?? "",
    slug,
    writes: tags("writes").length > 0,
  };
}

export function listProbes(dir = probesDir): Probe[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => {
      const slug = file.replace(/\.js$/, "");
      return parseProbe(slug, read(join(dir, file)));
    });
}

// ---------------------------------------------------------------- account

/** A sandbox account id looks like `1234567_SB1`. Production and release previews do not. */
export const isSandboxAccount = (account: string) =>
  /^\d{5,8}_SB\d+$/i.test(account.trim());

const host = (account: string) =>
  account.trim().toLowerCase().replace(/_/g, "-");

export const tokenUrl = (account: string) =>
  `https://${host(account)}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

export const restletUrl = (account: string) =>
  `https://${host(account)}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${runnerScriptId}&deploy=${runnerDeployId}`;

export interface Config {
  account: string;
  certificateId: string;
  clientId: string;
  privateKeyPath: string;
  /** The SDF deployment authenticates with its own certificate: Oracle allows one per integration, role and entity. */
  sdfCertificateId: string;
  sdfPrivateKeyPath: string;
}

export const configNames = {
  account: "SUITESCRIPT_VERIFY_ACCOUNT",
  certificateId: "SUITESCRIPT_VERIFY_CERTIFICATE_ID",
  clientId: "SUITESCRIPT_VERIFY_CLIENT_ID",
  privateKeyPath: "SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH",
  sdfCertificateId: "SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID",
  sdfPrivateKeyPath: "SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH",
} as const;

export function readConfig(env: Record<string, string | undefined>): {
  config?: Config;
  missing: string[];
} {
  const missing = Object.values(configNames).filter((name) => !env[name]);
  if (missing.length > 0) return { missing };
  return {
    config: {
      account: env[configNames.account] ?? "",
      certificateId: env[configNames.certificateId] ?? "",
      clientId: env[configNames.clientId] ?? "",
      privateKeyPath: env[configNames.privateKeyPath] ?? "",
      sdfCertificateId: env[configNames.sdfCertificateId] ?? "",
      sdfPrivateKeyPath: env[configNames.sdfPrivateKeyPath] ?? "",
    },
    missing,
  };
}

/** Throws unless the account is a sandbox: production never gets a token or a deploy. */
export function assertSandbox(account: string): void {
  if (!isSandboxAccount(account)) {
    throw new Error(
      `${configNames.account} is not a sandbox account id (expected digits_SBn). Verification runs in a sandbox only.`,
    );
  }
}

// -------------------------------------------------------------- credentials

const base64url = (data: Buffer | string) =>
  Buffer.from(data).toString("base64url");

/**
 * The signed JWT NetSuite's OAuth 2.0 client credentials flow expects.
 * ES256 with a P-256 key only: that is what `verify:certificate` generates.
 */
export function clientAssertion(options: {
  certificateId: string;
  clientId: string;
  now?: number;
  privateKeyPem: string;
  tokenEndpoint: string;
}): string {
  const key = createPrivateKey(options.privateKeyPem);
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
    throw new Error(
      "The private key must be an EC P-256 key (ES256). Generate one with `npm run verify:certificate`.",
    );
  }
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const header = { alg: "ES256", kid: options.certificateId, typ: "JWT" };
  const claims = {
    aud: options.tokenEndpoint,
    exp: iat + 55 * 60,
    iat,
    iss: options.clientId,
    scope: "restlets",
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(input), {
    dsaEncoding: "ieee-p1363",
    key,
  });
  return `${input}.${base64url(signature)}`;
}

// ------------------------------------------------------------------ scrub

const identifierPatterns: Array<[string, RegExp]> = [
  ["an account number", /\b\d{5,8}[_-](?:SB|RP|TSTDRV)\w*\b/i],
  ["an account number", /\bTSTDRV\d+\b/i],
  ["a NetSuite host", /[a-z0-9-]+\.[a-z0-9.-]*netsuite\.com/i],
  ["a JWT", /\beyJ[\w-]{10,}\.[\w-]{10,}\./],
  ["a long hex token", /\b[a-f0-9]{40,}\b/i],
  ["a PEM block", /-----BEGIN [A-Z ]+-----/],
  ["an email address", /[\w.+-]+@[\w-]+\.[\w.-]+/],
];

/**
 * Replaces the configured account, client and certificate ids with
 * placeholders, then reports anything that still looks like an identifier.
 * Callers fail closed: they write nothing when `problems` is not empty.
 */
export function scrub(
  text: string,
  known: {
    account?: string;
    certificateId?: string;
    clientId?: string;
    sdfCertificateId?: string;
  },
): { problems: string[]; text: string } {
  let out = text;
  const replacements: Array<[string | undefined, string]> = [
    [known.account, "<ACCOUNT>"],
    [known.clientId, "<CLIENT-ID>"],
    [known.certificateId, "<CERTIFICATE-ID>"],
    [known.sdfCertificateId, "<SDF-CERTIFICATE-ID>"],
  ];
  for (const [value, placeholder] of replacements) {
    if (value && value.length >= 4) {
      out = out.split(value).join(placeholder);
      out = out.split(value.toLowerCase()).join(placeholder);
      out = out.split(value.replace(/_/g, "-").toLowerCase()).join(placeholder);
    }
  }
  const problems = identifierPatterns
    .filter(([, pattern]) => pattern.test(out))
    .map(([label]) => `the output looks like it contains ${label}`);
  return { problems: [...new Set(problems)], text: out };
}

// ------------------------------------------------------------------ build

const q = (value: string) => JSON.stringify(value);

/** The runner source with its dependency list generated from the probe slugs. */
export function generateRunner(slugs: string[], template: string): string {
  const names = slugs.map((_, i) => `probe${i}`);
  // Each list item carries its own leading comma, so the template stays valid
  // when the formatter moves the placeholder comments around.
  return template
    .replace(
      "/*PROBE_PATHS*/",
      slugs.map((slug) => `, ${q(`./probes/${slug}`)}`).join(""),
    )
    .replace("/*PROBE_NAMES*/", names.map((name) => `, ${name}`).join(""))
    .replace(
      "/*PROBE_ENTRIES*/",
      slugs.map((slug, i) => `[${q(slug)}, ${names[i]}],`).join(" "),
    );
}

/** Writes the generated, gitignored runner and probe copies into the SDF project. */
export function buildSdfProject(): { files: string[]; slugs: string[] } {
  const probes = listProbes();
  const folder = join(
    sdfDir,
    "src",
    "FileCabinet",
    "SuiteScripts",
    fileCabinetFolder,
  );
  rmSync(join(sdfDir, "src", "FileCabinet"), { force: true, recursive: true });
  mkdirSync(join(folder, "probes"), { recursive: true });
  const slugs = probes.map((probe) => probe.slug);
  const files = ["runner.js"];
  writeFileSync(
    join(folder, "runner.js"),
    generateRunner(slugs, read(runnerTemplate)),
  );
  for (const slug of slugs) {
    writeFileSync(
      join(folder, "probes", `${slug}.js`),
      read(join(probesDir, `${slug}.js`)),
    );
    files.push(`probes/${slug}.js`);
  }
  return { files, slugs };
}

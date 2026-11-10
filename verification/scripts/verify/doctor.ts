import { isAbsolute, join, relative } from "node:path";
import { configNames, isSandboxAccount, readConfig, sdfDir } from "./lib.ts";

/** Everything the doctor reads from the machine, so tests can fake it. */
export interface DoctorContext {
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  home: string;
  nodeVersion: string;
  platform: string;
  readText(path: string): string;
  repoRoot: string;
  /** `ec:<curve>`, `rsa:<bits>` or `other`, from a private key file. Never the key itself. */
  keyType(path: string): string;
  /** Mode bits of a file, or undefined when unknown (Windows). */
  mode(path: string): number | undefined;
  run(
    command: string,
    args: string[],
  ): { output: string; status: number | null };
}

export interface Check {
  name: string;
  next?: string;
  ok: boolean;
}

const cli = (ctx: DoctorContext) =>
  join(ctx.repoRoot, "node_modules", "@oracle", "suitecloud-cli");

/** Read-only checklist. Each failed check says what you, the person, must do next. */
export function runChecks(ctx: DoctorContext): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, next?: string) =>
    checks.push(next === undefined ? { name, ok } : { name, next, ok });

  const nodeMajor = Number(ctx.nodeVersion.split(".")[0]);
  add(
    "Node 24 or later",
    nodeMajor >= 24,
    "Install the Node version in .nvmrc.",
  );

  const java = ctx.run("java", ["-version"]);
  const javaMajor = Number(/version "(\d+)/.exec(java.output)?.[1] ?? 0);
  add(
    "Oracle JDK 17 or 21 on the PATH",
    javaMajor === 17 || javaMajor === 21,
    "Install JDK 17 or 21 and make sure `java -version` works (SuiteCloud CLI requires it).",
  );

  const cliPackage = join(cli(ctx), "package.json");
  let cliVersion = "";
  let sdkFilename = "";
  if (ctx.exists(cliPackage)) {
    const parsed = JSON.parse(ctx.readText(cliPackage)) as {
      sdkFilename?: string;
      version?: string;
    };
    cliVersion = parsed.version ?? "";
    sdkFilename = parsed.sdkFilename ?? "";
  }
  const pinned =
    (
      JSON.parse(ctx.readText(join(ctx.repoRoot, "package.json"))) as {
        devDependencies?: Record<string, string>;
      }
    ).devDependencies?.["@oracle/suitecloud-cli"] ?? "";
  add(
    `Local @oracle/suitecloud-cli installed at the pinned version (${pinned || "not pinned"})`,
    cliVersion !== "" && cliVersion === pinned,
    "Run `npm ci`. Do not rely on a global `suitecloud`: the project uses the local copy.",
  );

  add(
    "SuiteCloud SDK jar downloaded",
    sdkFilename !== "" &&
      ctx.exists(join(ctx.home, ".suitecloud-sdk", "cli", sdkFilename)),
    "Read Oracle's license (https://www.oracle.com/downloads/licenses/oracle-free-license.html). If you accept it, run `node node_modules/@oracle/suitecloud-cli/postinstall.js` with the environment variable SUITECLOUD_CLI_ACCEPT_LICENSE=true. The agent must not accept the license for you.",
  );

  add(
    "Browser-based `account:setup` done once (installs the SuiteCloud Development Integration)",
    ctx.exists(
      join(ctx.home, ".suitecloud-sdk", "credentials_browser_based.p12"),
    ),
    "With SUITECLOUD_CI_PASSKEY unset, run `node node_modules/@oracle/suitecloud-cli/src/suitecloud.js account:setup` from verification/sdf, log in to the sandbox, and choose a role. (The doctor cannot tell which account was used.)",
  );

  const { config, missing } = readConfig(ctx.env);
  add(
    "Account, client id, both certificate ids and both private key paths are set",
    missing.length === 0,
    `Missing: ${missing.join(", ")}. ` +
      "Generate the key paths and the passkey with `npm run verify:certificate` and `npm run verify:passkey`. Save the others (account, client id, certificate ids) with `node scripts/verify.ts env set NAME=value`, or edit verification/.env.local. Values come from the integration record and the M2M mapping (docs/verification/automation.md). Never set them system-wide or user-wide.",
  );

  if (config) {
    add(
      "The account is a sandbox",
      isSandboxAccount(config.account),
      `${configNames.account} must look like digits_SBn. Verification never runs in production.`,
    );
    // The runner token is signed by this tooling (ES256, EC P-256). The SDF
    // deploy is signed by Oracle's SDK, which only does PS256 with an RSA key.
    for (const [label, keyPath, expected, accepts] of [
      [
        "runner",
        config.privateKeyPath,
        "an EC P-256 key",
        (type: string) => type === "ec:prime256v1",
      ],
      [
        "SDF",
        config.sdfPrivateKeyPath,
        "an RSA key of 3072 or 4096 bits",
        (type: string) => type === "rsa:3072" || type === "rsa:4096",
      ],
    ] as const) {
      const keyExists = ctx.exists(keyPath);
      add(
        `The ${label} private key exists`,
        keyExists,
        "Run `npm run verify:certificate` to generate the pairs.",
      );
      if (keyExists) {
        add(
          `The ${label} private key is ${expected}`,
          accepts(ctx.keyType(keyPath)),
          `Regenerate it: \`npm run verify:certificate -- --only ${label.toLowerCase()} --overwrite\`, then upload the new public certificate in a new mapping (an uploaded certificate stops matching a replaced key).`,
        );
        const rel = relative(ctx.repoRoot, keyPath);
        add(
          `The ${label} private key is outside the repository`,
          isAbsolute(rel) || rel.startsWith(".."),
          "Move the private key out of the repository.",
        );
        const mode = ctx.mode(keyPath);
        add(
          `The ${label} private key is readable by its owner only`,
          mode === undefined || (mode & 0o077) === 0,
          "Run `chmod 600` on the private key.",
        );
      }
    }
  }

  const passkey =
    ctx.env.SUITESCRIPT_VERIFY_PASSKEY ?? ctx.env.SUITECLOUD_CI_PASSKEY ?? "";
  add(
    "SUITESCRIPT_VERIFY_PASSKEY (or SUITECLOUD_CI_PASSKEY) is set, 32 to 100 letters and digits",
    /^[A-Za-z0-9]{32,100}$/.test(passkey),
    "Run `npm run verify:passkey`. It saves a random passkey to verification/.env.local, and the tooling passes it to the CLI as SUITECLOUD_CI_PASSKEY for its own commands only. Keep a copy somewhere safe: it encrypts the stored credentials.",
  );
  add(
    "SUITECLOUD_FALLBACK_PASSKEY is not set",
    !ctx.env.SUITECLOUD_FALLBACK_PASSKEY,
    "Unset it: the CLI refuses to run with both passkeys.",
  );

  const gitignored =
    ctx.run("git", ["check-ignore", "-q", ".env.local"]).status ===
    0;
  add(
    "verification/.env.local is gitignored",
    gitignored,
    "Restore the `verification/.env.local` line in .gitignore before saving any value: that file holds the passkey and ids.",
  );

  const projectJson = join(sdfDir, "project.json");
  let authId = "";
  if (ctx.exists(projectJson)) {
    authId =
      (JSON.parse(ctx.readText(projectJson)) as { defaultAuthId?: string })
        .defaultAuthId ?? "";
  }
  add(
    "verification/sdf has a default auth id (account:setup:ci done)",
    authId !== "",
    "Run `npm run verify:setup-ci` (the agent runs it once the checks above pass).",
  );

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((check) =>
    check.ok
      ? `ok   ${check.name}`
      : `FAIL ${check.name}\n     Next step for you: ${check.next ?? ""}`,
  );
  const failed = checks.filter((check) => !check.ok).length;
  lines.push(
    failed === 0
      ? "\nAll checks passed. Run `npm run verify:run -- probe-zero` to prove the chain."
      : `\n${failed} check(s) failed. Relay the next steps to the user and wait.`,
  );
  return lines.join("\n");
}

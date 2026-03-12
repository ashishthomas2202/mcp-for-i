#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const PACKAGE_NAME = "mcp-for-i";
const BUMP_LEVELS = new Set(["patch", "minor", "major"]);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(" ");
  console.log(`$ ${printable}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(stderr || stdout || `Command failed: ${command} ${args.join(" ")}`);
  }
  return (result.stdout || "").trim();
}

function parseSemver(input) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid semver: ${input}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a, b) {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (va[i] > vb[i]) return 1;
    if (va[i] < vb[i]) return -1;
  }
  return 0;
}

function getLocalVersion() {
  const raw = capture("npm", ["pkg", "get", "version"]);
  return raw.replace(/^"|"$/g, "");
}

function getPublishedVersion() {
  try {
    return capture("npm", ["view", PACKAGE_NAME, "version"]);
  } catch {
    return undefined;
  }
}

function getOptionValue(args, key) {
  const prefix = `${key}=`;
  const found = args.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const bump = args.find(arg => !arg.startsWith("--")) || "patch";
  if (!BUMP_LEVELS.has(bump)) {
    fail(`Unsupported bump '${bump}'. Use patch, minor, or major.`);
  }

  const skipTests = args.includes("--skip-tests");
  const noPush = args.includes("--no-push");
  const otp = getOptionValue(args, "--otp");

  const dirty = capture("git", ["status", "--porcelain"]);
  if (dirty.trim()) {
    fail("Git working directory is not clean. Commit or stash changes first.");
  }

  if (!skipTests) {
    run("npm", ["test"]);
  }

  let localVersion = getLocalVersion();
  const publishedVersion = getPublishedVersion();

  console.log(`Local version: ${localVersion}`);
  console.log(`Published version: ${publishedVersion || "(none)"}`);

  if (!publishedVersion || compareSemver(localVersion, publishedVersion) <= 0) {
    console.log(`Bumping version with 'npm version ${bump}'...`);
    run("npm", ["version", bump]);
    localVersion = getLocalVersion();
    console.log(`Bumped local version to ${localVersion}`);
  } else {
    console.log(`Using existing local version ${localVersion} (already ahead of published).`);
  }

  const publishArgs = ["publish", "--access", "public"];
  if (otp) publishArgs.push(`--otp=${otp}`);
  run("npm", publishArgs);

  if (!noPush) {
    run("git", ["push", "origin", "HEAD", "--follow-tags"]);
  } else {
    console.log("Skipping git push (--no-push).");
  }

  console.log(`Release complete: ${PACKAGE_NAME}@${localVersion}`);
}

main();

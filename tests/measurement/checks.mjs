import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const results = [];

function check(name, fn) {
  let passed = false;
  let detail = "";
  try {
    const outcome = fn();
    passed = outcome === true || (outcome && outcome.passed === true);
    detail = outcome && typeof outcome === "object" ? outcome.detail || "" : "";
  } catch (error) {
    detail = String(error?.message || error);
  }
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

function text(relativePath) {
  return readFileSync(join(REPO, relativePath), "utf8");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || REPO,
    encoding: "utf8",
    timeout: options.timeout || 120000,
  });
}

function python() {
  const candidates = [
    process.env.CW_SPEC_PYTHON,
    join(REPO, "grader/.venv/bin/python"),
    "python3",
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      run(candidate, ["-c", "import numpy, scipy"]);
      return candidate;
    } catch {
      continue;
    }
  }
  for (const candidate of candidates) {
    if (candidate) try {
      run(candidate, ["-c", "pass"]);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("no python interpreter found");
}

const suite = JSON.parse(text("tests/suite.json"));

check("suite parses and covers A-F", () => {
  const ids = suite.tests.map((test) => test.id).join("");
  return { passed: ids === "ABCDEF", detail: ids };
});

check("pre-registered counts are 3 and 5", () => {
  return { passed: suite.repeats === 3 && suite.cwRuns === 5, detail: `${suite.repeats}/${suite.cwRuns}` };
});

check("every prompt is non-empty", () => {
  const prompts = suite.tests.flatMap((test) => test.prompts).concat([suite.cw.prompt]);
  return { passed: prompts.every((prompt) => typeof prompt === "string" && prompt.trim().length > 0), detail: `${prompts.length} prompts` };
});

check("no stale small-window references", () => {
  const files = ["tests/suite.json", "tests/REFRESHED_SUITE.md", "tests/measurement/run-baseline.mjs"];
  const hits = files.flatMap((file) =>
    text(file)
      .split("\n")
      .map((line, index) => ({ file, line: index + 1, lineText: line }))
      .filter((entry) => entry.lineText.includes("8192")),
  );
  return { passed: hits.length === 0, detail: hits.map((hit) => `${hit.file}:${hit.line}`).join(",") };
});

check("no absolute host paths or LAN IPs in suite files", () => {
  const files = ["tests/suite.json", "tests/REFRESHED_SUITE.md"];
  const pattern = /\/home\/|\/data\/jamie|192\.168\./;
  const hits = files.filter((file) => pattern.test(text(file)));
  return { passed: hits.length === 0, detail: hits.join(",") };
});

check("fixtures exist", () => {
  const files = [
    "tests/fixtures/circuit_spec.py",
    "tests/fixtures/solve_circuit_buggy.py",
    "tests/fixtures/solve_circuit_fixed.py",
    "grader/spec_cw_filter.py",
  ];
  const missing = files.filter((file) => !existsSync(join(REPO, file)));
  return { passed: missing.length === 0, detail: missing.join(",") };
});

check("circuit oracle accepts the fixed fixture", () => {
  const output = run("python3", [
    join(REPO, "tests/fixtures/circuit_spec.py"),
    join(REPO, "tests/fixtures/solve_circuit_fixed.py"),
  ]);
  const match = output.match(/(\d+)\/(\d+) passed/);
  return { passed: match?.[1] === "21" && match?.[2] === "21", detail: match?.[0] || "no score" };
});

check("circuit oracle rejects the buggy fixture", () => {
  let output = "";
  try {
    output = run("python3", [
      join(REPO, "tests/fixtures/circuit_spec.py"),
      join(REPO, "tests/fixtures/solve_circuit_buggy.py"),
    ]);
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  const match = output.match(/(\d+)\/(\d+) passed/);
  return { passed: match && Number(match[1]) < 21, detail: match?.[0] || "no score" };
});

check("CW oracle accepts the shipped reference", () => {
  const output = run(python(), [
    join(REPO, "grader/spec_cw_filter.py"),
    join(REPO, "grader/cw_filter.py"),
  ]);
  const match = output.match(/(\d+)\/(\d+) checks passed/);
  return { passed: match?.[1] === "11" && match?.[2] === "11", detail: match?.[0] || "no score" };
});

check("runner syntax is valid", () => {
  run(process.execPath, ["--check", join(REPO, "tests/measurement/run-baseline.mjs")]);
  return true;
});

check("runner captures fresh PTY sessions and writes JSON", () => {
  const source = text("tests/measurement/run-baseline.mjs");
  const required = ["script", "-qec", "--session-dir", "--session-id", "report.json", "suite.cw.spec"];
  const missing = required.filter((token) => !source.includes(token));
  return { passed: missing.length === 0, detail: missing.join(",") };
});

const failed = results.filter((result) => !result.passed).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;

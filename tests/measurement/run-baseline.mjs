import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const HOME = homedir();

function parseArgs(argv) {
  const opts = {
    out: null,
    workRoot: null,
    model: null,
    repeats: null,
    cwRuns: null,
    maxCwRetries: 3,
    timeoutMs: 15 * 60 * 1000,
    pi: null,
    python: null,
    hostRole: process.env.BASELINE_HOST_ROLE || "local",
    suiteOnly: false,
    cwOnly: false,
    keep: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--suite-only") opts.suiteOnly = true;
    else if (arg === "--cw-only") opts.cwOnly = true;
    else if (arg === "--no-keep") opts.keep = false;
    else if (["--out", "--work-root", "--model", "--repeats", "--cw-runs", "--max-cw-retries", "--timeout-ms", "--pi", "--python", "--host-role"].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      if (arg === "--out") opts.out = value;
      if (arg === "--work-root") opts.workRoot = value;
      if (arg === "--model") opts.model = value;
      if (arg === "--repeats") opts.repeats = Number(value);
      if (arg === "--cw-runs") opts.cwRuns = Number(value);
      if (arg === "--max-cw-retries") opts.maxCwRetries = Number(value);
      if (arg === "--timeout-ms") opts.timeoutMs = Number(value);
      if (arg === "--pi") opts.pi = value;
      if (arg === "--python") opts.python = value;
      if (arg === "--host-role") opts.hostRole = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      try {
        execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 5000 });
        return candidate;
      } catch {
        continue;
      }
    }
  }
  throw new Error(`no executable found; tried: ${candidates.filter(Boolean).join(", ")}`);
}

function findPi(override) {
  return firstExecutable([
    override,
    process.env.PI_BIN,
    join(HOME, ".local/bin/pi"),
    join(HOME, ".pi/agent/bin/pi"),
    "pi",
  ]);
}

function findPython(override) {
  return firstExecutable([
    override,
    process.env.CW_SPEC_PYTHON,
    join(REPO, "grader/.venv/bin/python"),
    join(HOME, "projects/local-ai-stack/grader/.venv/bin/python"),
    "python3",
  ]);
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function expandHome(path) {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return join(HOME, path.slice(2));
  return path;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs || undefined,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      resolveRun({
        code: code === null ? null : code,
        signal,
        timedOut: signal === "SIGTERM" || signal === "SIGKILL",
        stdout,
        stderr,
      });
    });
  });
}

function cleanOutput(text) {
  return String(text || "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function findSessionFile(sessionDir) {
  if (!existsSync(sessionDir)) return null;
  const files = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] || null;
}

function parseSession(file) {
  const result = {
    file,
    assistantTurns: 0,
    userTurns: 0,
    finalText: "",
    emptyFinal: true,
    toolCalls: [],
    toolResults: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  };
  if (!file || !existsSync(file)) return result;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") result.userTurns += 1;
    if (message.role !== "assistant") {
      if (message.role === "toolResult") {
        result.toolResults.push({
          name: message.toolName || null,
          isError: Boolean(message.isError),
        });
      }
      continue;
    }
    result.assistantTurns += 1;
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: String(message.content || "") }];
    const text = blocks
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) result.finalText = text;
    for (const block of blocks) {
      if (block && block.type === "toolCall") {
        result.toolCalls.push({ name: block.name || null, arguments: block.arguments || {} });
      }
    }
    if (message.usage) {
      for (const key of Object.keys(result.usage)) {
        result.usage[key] += Number(message.usage[key] || 0);
      }
    }
  }
  result.emptyFinal = !result.finalText;
  return result;
}

function domainOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    const match = String(url).match(/https?:\/\/([^/\s]+)/i);
    return match ? match[1].replace(/^www\./, "") : null;
  }
}

function enrichSession(session) {
  const fetchCalls = session.toolCalls.filter((call) =>
    ["webfetch", "fetch", "web_fetch"].includes(String(call.name || "").toLowerCase()),
  );
  const domains = new Set();
  for (const call of fetchCalls) {
    for (const key of ["url", "path"]) {
      const domain = domainOf(call.arguments?.[key]);
      if (domain) domains.add(domain);
    }
  }
  return {
    ...session,
    fetchCalls: fetchCalls.length,
    domains: [...domains].sort(),
  };
}

function regexChecks(text, patterns = []) {
  return patterns.map((pattern) => {
    const flags = pattern.startsWith("(?i)") ? "i" : "";
    const source = pattern.startsWith("(?i)") ? pattern.slice(4) : pattern;
    let passed = false;
    try {
      passed = new RegExp(source, flags).test(text || "");
    } catch {
      passed = false;
    }
    return { pattern, passed };
  });
}

function scoreFromOutput(text, total) {
  const match = String(text || "").match(/(\d+)\s*\/\s*(\d+)\s+(?:checks?\s+)?passed/i);
  if (!match) return { passed: null, total: total || null };
  return { passed: Number(match[1]), total: Number(match[2]) };
}

function findFiles(root, predicate, depth = 0) {
  if (!existsSync(root) || depth > 6) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "sessions" || entry.name === "node_modules") continue;
      found.push(...findFiles(path, predicate, depth + 1));
    } else if (entry.isFile() && predicate(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function checkDhtLcd(source) {
  const lcd = String(source || "").match(/LiquidCrystal\s+\w+\s*\(([^)]*)\)/);
  const dht =
    String(source || "").match(/#define\s+DHTPIN\s+(\d+)/i) ||
    String(source || "").match(/\bDHTPIN\s*=\s*(\d+)/i);
  const lcdPins = lcd
    ? lcd[1]
        .split(",")
        .map((part) => part.trim())
        .filter((part) => /^\d+$/.test(part))
        .map(Number)
    : [];
  const dhtPin = dht ? Number(dht[1]) : null;
  const delays = [...String(source || "").matchAll(/delay\s*\(\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
  return [
    { name: "sketch present", passed: Boolean(source) },
    { name: "lcd constructor present", passed: lcdPins.length >= 6 },
    { name: "dht pin present", passed: dhtPin !== null },
    { name: "no pin conflict", passed: dhtPin === null || !lcdPins.includes(dhtPin) },
    { name: "pull-up or module noted", passed: /10\s*k|pull.?up|PULLUP|module/i.test(String(source || "")) },
    { name: "delay >= 2000ms present", passed: delays.some((value) => value >= 2000) },
    { name: "nan handled", passed: /isnan|nan/i.test(String(source || "")) },
  ];
}

function verdict(checks) {
  return checks.every((check) => check.passed) ? "pass" : "fail";
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function piVersion(pi) {
  try {
    return execFileSync(pi, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

async function gradeCwCandidate(candidatePath, python, suite, timeoutMs) {
  if (!candidatePath) return null;
  const result = await runProcess(
    python,
    [join(REPO, suite.cw.spec), candidatePath],
    { cwd: join(REPO, "grader"), timeoutMs },
  );
  return {
    ...scoreFromOutput(result.stdout, suite.cw.requiredChecks),
    exitCode: result.code,
    stdoutExcerpt: cleanOutput(result.stdout).slice(-2000),
    stderrExcerpt: cleanOutput(result.stderr).slice(-1000),
  };
}

function gradeFailureSummary(grade) {
  const lines = String(grade?.stdoutExcerpt || "")
    .split("\n")
    .filter((line) => /^(FAILED:|FAIL\s)/.test(line.trim()));
  return lines.length ? lines.join("\n") : "(no failing check names captured)";
}

function cwIsGraded(grade, session, requiredChecks) {
  return (
    grade?.passed === requiredChecks &&
    grade?.total === requiredChecks &&
    grade?.exitCode === 0 &&
    !session.emptyFinal &&
    !session.failed
  );
}

function mergeSession(previous, next, attempt) {
  return {
    ...next,
    userTurns: (previous.userTurns || 0) + (next.userTurns || 0),
    assistantTurns: (previous.assistantTurns || 0) + (next.assistantTurns || 0),
    toolCalls: [...(previous.toolCalls || []), ...(next.toolCalls || [])],
    fetchCalls: (previous.fetchCalls || 0) + (next.fetchCalls || 0),
    domains: [...new Set([...(previous.domains || []), ...(next.domains || [])])].sort(),
    usage: Object.fromEntries(
      Object.keys(next.usage || previous.usage || {}).map((key) => [
        key,
        (previous.usage?.[key] || 0) + (next.usage?.[key] || 0),
      ]),
    ),
    turnOutputs: [
      ...(previous.turnOutputs || []).map((turn) => ({ ...turn, attempt: turn.attempt ?? 0 })),
      ...(next.turnOutputs || []).map((turn) => ({ ...turn, attempt })),
    ],
    failed: Boolean(next.failed || previous.failed),
    error: next.error || previous.error || null,
  };
}

async function runPiTurns(options) {
  const command = [
    shellQuote(options.pi),
    "-p",
    "--model",
    shellQuote(options.model),
    "--session-dir",
    shellQuote(options.sessionDir),
    ...(options.resume ? ["--session", shellQuote(options.sessionId)] : ["--session-id", shellQuote(options.sessionId)]),
    "--",
    shellQuote(options.prompt),
  ].join(" ");
  const result = await runProcess("script", ["-qec", command, "/dev/null"], {
    cwd: options.cwd,
    env: options.env || process.env,
    timeoutMs: options.timeoutMs,
  });
  return {
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: cleanOutput(result.stdout),
    stderr: cleanOutput(result.stderr),
  };
}

async function runSession(options) {
  mkdirSync(options.sessionDir, { recursive: true });
  const outputs = [];
  for (let index = 0; index < options.prompts.length; index++) {
    const turn = await runPiTurns({
      ...options,
      prompt: options.prompts[index],
      resume: options.resume || index > 0,
    });
    outputs.push({ promptIndex: index, ...turn });
    if (turn.code !== 0 || turn.timedOut) break;
  }
  const session = enrichSession(parseSession(findSessionFile(options.sessionDir)));
  session.stdout = outputs.map((turn) => turn.stdout).filter(Boolean).join("\n").slice(-4000);
  session.turnOutputs = outputs.map((turn) => ({
    promptIndex: turn.promptIndex,
    code: turn.code,
    signal: turn.signal,
    timedOut: turn.timedOut,
    stdoutExcerpt: turn.stdout.slice(-1200),
    stderrExcerpt: turn.stderr.slice(-1200),
  }));
  session.failed = outputs.some((turn) => turn.code !== 0 || turn.timedOut);
  return session;
}

function candidateText(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const suite = JSON.parse(readFileSync(join(REPO, "tests/suite.json"), "utf8"));
  const repeats = opts.repeats ?? suite.repeats;
  const cwRuns = opts.cwRuns ?? suite.cwRuns;
  const pi = findPi(opts.pi);
  const python = findPython(opts.python);
  const model = opts.model || suite.model;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workRoot = resolve(opts.workRoot || join(REPO, "tests/results", stamp));
  const out = resolve(opts.out || join(workRoot, "report.json"));
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });

  const report = {
    schema: "local-ai-stack-baseline/v1",
    generatedAt: new Date().toISOString(),
    repoCommit: gitCommit(),
    suiteVersion: suite.version,
    model,
    host: { role: opts.hostRole },
    config: {
      repeats,
      cwRuns,
      maxCwRetries: opts.maxCwRetries,
      timeoutMs: opts.timeoutMs,
      piVersion: piVersion(pi),
      python: relative(REPO, python) || python,
    },
    tests: [],
    cw: [],
  };

  if (!opts.cwOnly) {
    for (const test of suite.tests) {
      const runs = [];
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const runDir = join(workRoot, "suite", test.id, `r${repeat}`);
        const cwd = join(runDir, "work");
        const sessionDir = join(runDir, "sessions");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(sessionDir, { recursive: true });
        for (const fixture of test.fixtures || []) {
          copyFileSync(join(REPO, fixture.source), join(cwd, fixture.target));
        }
        const oracleCandidate = test.checks?.candidate ? expandHome(test.checks.candidate) : null;
        if (oracleCandidate && existsSync(oracleCandidate) && test.id === "C") {
          rmSync(oracleCandidate);
        }
        let session;
        try {
          session = await runSession({
            pi,
            model,
            cwd,
            sessionDir,
            sessionId: randomUUID(),
            prompts: test.prompts,
            timeoutMs: opts.timeoutMs,
          });
        } catch (error) {
          session = {
            file: null,
            failed: true,
            emptyFinal: true,
            finalText: "",
            toolCalls: [],
            fetchCalls: 0,
            domains: [],
            userTurns: 0,
            assistantTurns: 0,
            usage: {},
            turnOutputs: [],
            error: String(error?.message || error),
          };
        }
        let checks = [];
        let oracle = null;
        let candidate = null;
        if (test.id === "A") {
          checks = [
            { name: "two fetches", passed: session.fetchCalls >= (test.checks.minFetchCalls || 0) },
            ...regexChecks(session.finalText, test.checks.finalMustMatch).map((c) => ({ name: `answer: ${c.pattern}`, passed: c.passed })),
            ...regexChecks(session.finalText, test.checks.finalMustNotMatch).map((c) => ({ name: `answer not: ${c.pattern}`, passed: !c.passed })),
          ];
        } else if (test.id === "B") {
          checks = [
            { name: "nine user turns", passed: session.userTurns >= (test.checks.minTurns || 0) },
            { name: "no empty final answer", passed: !session.emptyFinal },
            { name: "run completed", passed: !session.failed },
          ];
        } else if (test.id === "C") {
          if (oracleCandidate && existsSync(oracleCandidate)) {
            const result = await runProcess(
              "python3",
              [join(REPO, test.checks.oracle), oracleCandidate],
              { cwd: runDir, timeoutMs: opts.timeoutMs },
            );
            oracle = {
              ...scoreFromOutput(result.stdout, test.checks.requiredChecks),
              exitCode: result.code,
              stdoutExcerpt: cleanOutput(result.stdout).slice(-2000),
              stderrExcerpt: cleanOutput(result.stderr).slice(-1000),
            };
          }
          checks = [
            { name: "candidate written", passed: Boolean(oracleCandidate && existsSync(oracleCandidate)) },
            { name: "oracle 21/21", passed: oracle?.passed === test.checks.requiredChecks && oracle?.exitCode === 0 },
            { name: "no empty final answer", passed: !session.emptyFinal },
          ];
        } else if (test.id === "D") {
          checks = [
            ...regexChecks(session.finalText, test.checks.finalMustMatch).map((c) => ({ name: `answer: ${c.pattern}`, passed: c.passed })),
            ...regexChecks(session.finalText, test.checks.fabricationMustNotMatch).map((c) => ({ name: `no unfetched cite: ${c.pattern}`, passed: !c.passed })),
          ];
        } else if (test.id === "E") {
          checks = [
            { name: "at least one fetch", passed: session.fetchCalls >= (test.checks.minFetchCalls || 0) },
            ...regexChecks(session.finalText, test.checks.finalMustMatch).map((c) => ({ name: `answer: ${c.pattern}`, passed: c.passed })),
            ...regexChecks(session.finalText, test.checks.finalMustNotMatch).map((c) => ({ name: `answer not: ${c.pattern}`, passed: !c.passed })),
          ];
        } else if (test.id === "F") {
          const sketches = findFiles(cwd, (name) => name.endsWith(".ino"));
          candidate = sketches[0] ? relative(workRoot, sketches[0]) : null;
          checks = checkDhtLcd(candidateText(sketches[0])).map((c) => ({ name: c.name, passed: c.passed }));
        }
        const runRecord = {
          repeat,
          verdict: verdict(checks),
          heuristic: true,
          checks,
          sessionFile: session.file ? relative(workRoot, session.file) : null,
          finalTextExcerpt: String(session.finalText || "").slice(-1200),
          finalText: session.finalText || "",
          emptyFinal: Boolean(session.emptyFinal),
          failed: Boolean(session.failed),
          error: session.error || null,
          toolCalls: session.toolCalls?.length || 0,
          fetchCalls: session.fetchCalls || 0,
          domains: session.domains || [],
          userTurns: session.userTurns || 0,
          assistantTurns: session.assistantTurns || 0,
          usage: session.usage || {},
          oracle,
          candidate,
          turnOutputs: session.turnOutputs || [],
        };
        runs.push(runRecord);
        console.log(`${test.id} r${repeat}: ${runRecord.verdict} (${checks.filter((c) => c.passed).length}/${checks.length})`);
      }
      report.tests.push({
        id: test.id,
        name: test.name,
        groundTruth: test.groundTruth,
        runs,
        passCount: runs.filter((run) => run.verdict === "pass").length,
      });
    }
  }

  if (!opts.suiteOnly) {
    for (let run = 1; run <= cwRuns; run++) {
      const runDir = join(workRoot, "cw", `r${run}`);
      const cwd = join(runDir, "work");
      const sessionDir = join(runDir, "sessions");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
      const sessionId = randomUUID();
      const baseOptions = {
        pi,
        model,
        cwd,
        sessionDir,
        sessionId,
        timeoutMs: opts.timeoutMs,
      };
      let session;
      try {
        session = await runSession({ ...baseOptions, prompts: [suite.cw.prompt], resume: false });
      } catch (error) {
        session = {
          file: null,
          failed: true,
          emptyFinal: true,
          finalText: "",
          toolCalls: [],
          fetchCalls: 0,
          domains: [],
          userTurns: 0,
          assistantTurns: 0,
          usage: {},
          turnOutputs: [],
          error: String(error?.message || error),
        };
      }
      let candidatePath = findFiles(cwd, (name) => name === suite.cw.candidate)[0] || null;
      let grade = await gradeCwCandidate(candidatePath, python, suite, opts.timeoutMs);
      let graded = cwIsGraded(grade, session, suite.cw.requiredChecks);
      const iterations = [
        {
          attempt: 0,
          grade,
          candidate: candidatePath ? relative(workRoot, candidatePath) : null,
          finalTextExcerpt: String(session.finalText || "").slice(-1200),
          toolCalls: session.toolCalls?.length || 0,
          emptyFinal: Boolean(session.emptyFinal),
        },
      ];
      let retries = 0;
      while (!graded && retries < opts.maxCwRetries && !session.failed && !session.emptyFinal) {
        retries += 1;
        const feedback = [
          "The deterministic grader failed. Read its output, fix the candidate file, and write it again.",
          "Do not copy the reference implementation. Fix the exact failing checks named here.",
          `candidate: ${suite.cw.candidate}`,
          "Failing checks:",
          gradeFailureSummary(grade),
          grade?.stdoutExcerpt || "(no grader output)",
          grade?.stderrExcerpt || "",
        ]
          .filter(Boolean)
          .join("\n\n");
        let follow;
        try {
          follow = await runSession({ ...baseOptions, prompts: [feedback], resume: true });
        } catch (error) {
          follow = {
            file: session.file,
            failed: true,
            emptyFinal: true,
            finalText: "",
            toolCalls: [],
            fetchCalls: 0,
            domains: [],
            userTurns: 0,
            assistantTurns: 0,
            usage: {},
            turnOutputs: [],
            error: String(error?.message || error),
          };
        }
        session = mergeSession(session, follow, retries);
        candidatePath = findFiles(cwd, (name) => name === suite.cw.candidate)[0] || candidatePath;
        grade = await gradeCwCandidate(candidatePath, python, suite, opts.timeoutMs);
        graded = cwIsGraded(grade, session, suite.cw.requiredChecks);
        iterations.push({
          attempt: retries,
          grade,
          candidate: candidatePath ? relative(workRoot, candidatePath) : null,
          finalTextExcerpt: String(follow.finalText || "").slice(-1200),
          toolCalls: follow.toolCalls?.length || 0,
          emptyFinal: Boolean(follow.emptyFinal),
        });
      }
      const record = {
        run,
        graded,
        grade,
        iterations,
        retries,
        attempts: iterations.length,
        candidate: candidatePath ? relative(workRoot, candidatePath) : null,
        sessionFile: session.file ? relative(workRoot, session.file) : null,
        finalTextExcerpt: String(session.finalText || "").slice(-1200),
        emptyFinal: Boolean(session.emptyFinal),
        failed: Boolean(session.failed),
        error: session.error || null,
        toolCalls: session.toolCalls?.length || 0,
        usage: session.usage || {},
        turnOutputs: session.turnOutputs || [],
      };
      report.cw.push(record);
      console.log(`CW r${run}: ${graded ? "graded" : "not-graded"} (${grade?.passed ?? 0}/${grade?.total ?? suite.cw.requiredChecks}; ${record.attempts} attempt(s))`);
    }
  }

  const allSuiteRuns = report.tests.flatMap((test) => test.runs);
  report.summary = {
    suiteRuns: allSuiteRuns.length,
    suitePassed: allSuiteRuns.filter((run) => run.verdict === "pass").length,
    cwRuns: report.cw.length,
    cwGraded: report.cw.filter((run) => run.graded).length,
    suiteComplete: allSuiteRuns.length === suite.tests.length * repeats,
    cwComplete: report.cw.length === cwRuns,
  };
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  if (!opts.keep) rmSync(workRoot, { recursive: true, force: true });
  console.log(`report: ${relative(REPO, out) || out}`);
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
});

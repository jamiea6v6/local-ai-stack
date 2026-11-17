/**
 * verify — run a deterministic test spec against a candidate file.
 *
 * Why this exists: measured on gemma4:e4b-it-qat at 6GB VRAM, the model is reliable at
 * arithmetic (7/7 on spot checks including 47*89 and 2^10) but unreliable at *enumeration
 * under an open spec* — it omitted P=V^2/R, and across four separate runs it overrode a
 * stated requirement because its own physics disagreed with it. Neither failure is a
 * calculation error, so a calculator tool would not help.
 *
 * What does help is removing the judgement from the model. It writes a file; a python
 * process decides pass/fail. The model never assesses its own work — the same discipline as
 * `check_fetch.py` and the sifter/counts split already in the workflow.
 *
 * The spec file is any python script that takes the candidate path as argv[1], imports it,
 * runs assertions, and prints a report. Exit code 0 means everything passed.
 *
 * Deliberately narrow: it runs one python file against one spec, with a timeout, no shell
 * interpolation of the arguments. Anything more general belongs in Pi's own bash tool.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;

const Params = Type.Object({
	spec: Type.Optional(
		Type.String({ description: "Path to a python test spec that takes the candidate path as argv[1]" }),
	),
	candidate: Type.Optional(
		Type.String({ description: "Path to the candidate file to test. Defaults to the spec's own default." }),
	),
	project: Type.Optional(
		Type.String({
			description:
				"Directory containing gates.json. Runs every gate in order and reports pass/fail per gate. " +
				"Use this for a project's own checks (pins, libraries, compile, behavior).",
		}),
	),
	python: Type.Optional(
		Type.String({
			description:
				"Python interpreter for spec mode (default: $PI_VERIFY_PYTHON, else python3). " +
				"Point this at a project venv when the candidate imports packages installed there.",
		}),
	),
});

interface GateResult {
	name: string;
	cmd: string[];
	passed: boolean;
	exitCode: number;
	timeout: boolean;
	stdout: string;
	stderr: string;
}

interface VerifyDetails {
	spec?: string;
	candidate?: string;
	project?: string;
	gates?: GateResult[];
	passed: boolean;
	exitCode: number;
	timeout: boolean;
	stdout: string;
	stderr: string;
}

/**
 * Refuse a candidate that is the shipped reference implementation.
 *
 * The grader directory holds cw_filter.py, the 11/11 known-good answer. On a
 * test whose point is to measure what the model can write, accepting that path
 * lets it submit someone else's work as its own. Set PI_VERIFY_ALLOW_REFERENCE=1
 * when deliberately grading the reference (e.g. to check the spec itself).
 */
function referenceRefusal(candidate: string): string | null {
	if (process.env.PI_VERIFY_ALLOW_REFERENCE === "1") return null;
	const parts = resolve(candidate).split(sep);
	if (parts.includes("grader")) {
		return (
			`Refusing to verify a file under grader/: ${candidate}. ` +
			"That directory holds the reference implementation; write your own candidate and verify that. " +
			"(Set PI_VERIFY_ALLOW_REFERENCE=1 to grade the reference on purpose.)"
		);
	}
	return null;
}

async function exists(p: string): Promise<boolean> {
	try {
		await access(p, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function clip(text: string, limit = 1200): string {
	const t = text.trim();
	return t.length > limit ? `${t.slice(0, limit)}\n[... ${t.length - limit} chars omitted]` : t;
}

/**
 * Project mode: run the checks a project declares in gates.json.
 *
 * This is the seam that stops one task's spec from judging another's work. On
 * 2026-11-17 the global verify pointed at the CW audio spec while the task was
 * an audio TUI; every turn failed an unsatisfiable check and the session
 * compacted before producing a program. A project names its own gates:
 *
 *   { "gates": [
 *       { "name": "pins",   "cmd": ["python3", "check_pins_src.py", "firmware"] },
 *       { "name": "compile","cmd": ["arduino-cli", "compile", "--fqbn", "esp8266:esp8266:d1",
 *                                   "firmware/vma203/vma203"] }
 *   ] }
 *
 * Commands are arrays, never shell strings: no quoting bugs, no injection.
 */
async function runProject(project: string, signal?: AbortSignal) {
	const dir = resolve(project);
	let raw: string;
	try {
		raw = await readFile(join(dir, "gates.json"), "utf8");
	} catch {
		throw new Error(
			`No gates.json in ${dir}. A project gate file looks like ` +
				'{"gates":[{"name":"pins","cmd":["python3","check_pins_src.py","firmware"]}]}.',
		);
	}

	let config: unknown;
	try {
		config = JSON.parse(raw);
	} catch (err) {
		throw new Error(`gates.json is not valid JSON: ${(err as Error).message}`);
	}
	const gates = Array.isArray(config) ? config : (config as { gates?: unknown }).gates;
	if (!Array.isArray(gates) || gates.length === 0) {
		throw new Error('gates.json must be {"gates":[{"name":"...","cmd":["..."]}]} with at least one gate.');
	}

	const results: GateResult[] = [];
	for (const item of gates) {
		const gate = item as { name?: unknown; cmd?: unknown };
		if (!Array.isArray(gate.cmd) || gate.cmd.length === 0 || gate.cmd.some((x) => typeof x !== "string")) {
			throw new Error(
				`gates.json: ${String(gate.name ?? "unnamed gate")} needs "cmd" as a non-empty array of strings ` +
					"(no shell strings).",
			);
		}
		const cmd = gate.cmd as string[];
		const name = typeof gate.name === "string" ? gate.name : cmd[0];
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		let timedOut = false;
		try {
			const r = await run(cmd[0], cmd.slice(1), {
				cwd: dir,
				signal: combined,
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
			});
			stdout = r.stdout ?? "";
			stderr = r.stderr ?? "";
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; name?: string };
			stdout = e.stdout ?? "";
			stderr = e.stderr ?? "";
			exitCode = typeof e.code === "number" ? e.code : 1;
			timedOut = e.killed === true || e.name === "AbortError" || e.name === "TimeoutError";
		}
		results.push({ name, cmd, passed: exitCode === 0 && !timedOut, exitCode, timeout: timedOut, stdout, stderr });
	}

	const passed = results.every((r) => r.passed);
	const passedCount = results.filter((r) => r.passed).length;
	const lines: string[] = [];
	for (const r of results) {
		lines.push(
			`${r.passed ? "PASS" : `FAIL (exit ${r.exitCode}${r.timeout ? ", timed out" : ""})`}  ${r.name}  ` +
				`[${r.cmd.join(" ")}]`,
		);
		if (!r.passed) {
			const out = clip([r.stdout, r.stderr].filter(Boolean).join("\n"));
			if (out) lines.push(out, "");
		}
	}

	const text =
		`VERIFY: ${passed ? "PASS" : "FAIL"} (${passedCount}/${results.length} gates)\n` +
		`PROJECT: ${dir}\n\n` +
		lines.join("\n");
	const details: VerifyDetails = {
		project: dir,
		gates: results,
		passed,
		exitCode: passed ? 0 : 1,
		timeout: false,
		stdout: "",
		stderr: "",
	};
	return { content: [{ type: "text" as const, text }], details };
}


export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "verify",
		label: "verify",
		description:
			"Run a project's deterministic gates (gates.json) or one python test spec against a candidate file, " +
			"and report pass/fail per case. This runs a separate process — the result is decided by the test, " +
			"not by the model. Use it after writing or editing code. Do not reason about correctness; run it.",
		promptSnippet: "verify: run a python test spec against a file, report pass/fail",
		promptGuidelines: [
			"After writing or editing code, call verify with the project's gates (verify(project=<dir>)) or its spec instead of asserting the result yourself. Pass the file you wrote — never a reference implementation.",
			"If verify reports failures, read them and fix the specific case named, rather than rewriting the whole file.",
		],
		parameters: Params,
		annotations: { readOnlyHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal) {
			if (params.project) {
				if (params.spec) {
					throw new Error("Pass either spec=... (one python spec) or project=... (run gates.json), not both.");
				}
				return runProject(params.project, signal);
			}

			const spec = params.spec;
			if (!spec) {
				throw new Error("Pass spec=... (one python spec) or project=... (run gates.json).");
			}
			const candidate = params.candidate;
			const python = params.python ?? process.env.PI_VERIFY_PYTHON ?? "python3";

			if (!(await exists(spec))) {
				throw new Error(`Spec not found or unreadable: ${spec}`);
			}
			if (candidate && !(await exists(candidate))) {
				throw new Error(`Candidate not found: ${candidate}`);
			}
			if (candidate) {
				const refusal = referenceRefusal(candidate);
				if (refusal) throw new Error(refusal);
			}

			const args = candidate ? [spec, candidate] : [spec];

			// Own timeout, raced against the turn's abort signal.
			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			let timedOut = false;

			try {
				const r = await run(python, args, {
					signal: combined,
					maxBuffer: 8 * 1024 * 1024,
					env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
				});
				stdout = r.stdout ?? "";
				stderr = r.stderr ?? "";
				exitCode = 0;
			} catch (err) {
				const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; name?: string };
				stdout = e.stdout ?? "";
				stderr = e.stderr ?? "";
				exitCode = typeof e.code === "number" ? e.code : 1;
				timedOut = e.killed === true || e.name === "AbortError" || e.name === "TimeoutError";
				if (timedOut) {
					throw new Error(`verify timed out after ${TIMEOUT_MS / 1000}s running ${spec}`);
				}
			}

			const passed = exitCode === 0 && !timedOut;
			const details: VerifyDetails = { spec, candidate, passed, exitCode, timeout: timedOut, stdout, stderr };

			const header = passed
				? `VERIFY: PASS (exit 0)\nSPEC: ${spec}${candidate ? `\nFILE: ${candidate}` : ""}\n\n`
				: `VERIFY: FAIL (exit ${exitCode})\nSPEC: ${spec}${candidate ? `\nFILE: ${candidate}` : ""}\n\n`;

			let body = stdout.trim();
			if (stderr.trim()) body += `\n\nSTDERR:\n${stderr.trim()}`;

			if (!body) body = "(no output — the spec printed nothing)";

			return { content: [{ type: "text", text: header + body }], details };
		},

		renderCall(args, theme, _c) {
			let s = theme.fg("toolTitle", theme.bold("verify "));
			s += theme.fg("accent", args.project ?? args.spec ?? "?");
			if (args.candidate) s += theme.fg("muted", ` → ${args.candidate}`);
			return new Text(s, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _c) {
			if (isPartial) return new Text(theme.fg("warning", "Running tests..."), 0, 0);
			const d = result.details as VerifyDetails | undefined;
			if (!d) return new Text(theme.fg("dim", "verified"), 0, 0);

			if (d.gates) {
				const passed = d.gates.filter((g) => g.passed).length;
				let s = d.passed
					? theme.fg("success", "PASS")
					: theme.fg("error", `FAIL (${d.gates.length - passed} of ${d.gates.length})`);
				s += theme.fg("dim", ` · ${passed}/${d.gates.length} gates`);
				if (expanded) {
					for (const g of d.gates) {
						s += `\n${g.passed ? theme.fg("dim", `PASS  ${g.name}`) : theme.fg("error", `FAIL  ${g.name}`)}`;
					}
				}
				return new Text(s, 0, 0);
			}

			const lines = (d.stdout || "").trim().split("\n");
			const failCount = lines.filter((l) => l.trim().startsWith("FAIL")).length;
			const passCount = lines.filter((l) => l.trim().startsWith("PASS")).length;

			let s = d.passed ? theme.fg("success", "PASS") : theme.fg("error", `FAIL (exit ${d.exitCode})`);
			if (passCount) s += theme.fg("dim", ` · ${passCount} passed`);
			if (failCount) s += theme.fg("error", ` · ${failCount} failed`);

			if (expanded && d.stdout) {
				for (const l of lines.slice(0, 25)) {
					const c = l.startsWith("FAIL") ? theme.fg("error", l) : theme.fg("dim", l);
					s += `\n${c}`;
				}
			}
			return new Text(s, 0, 0);
		},
	});
}
/**
 * compile — build an Arduino sketch with arduino-cli and report the real result.
 *
 * Why this exists: measured 2026-11-17 on gemma4:e4b-it-qat (6 GB), the model
 * wrote a correct-looking sketch, then spent four turns trying to compile it
 * with `arduino-cli compile ... VMA203_Hello.ino` from a home directory. The
 * file was flat in the directory, so arduino-cli treated the directory as the
 * sketch and demanded `jamie.ino` ("main file missing from sketch"). The model
 * never saw the cause, called the environment broken, and answered "should
 * compile" without ever producing a green build.
 *
 * Arduino's layout rule is mechanical: a sketch is a directory whose name
 * matches its .ino file. This tool applies that rule, resolves the FQBN from
 * the project's device sheet instead of letting the model guess, and runs the
 * compiler with an explicit timeout. The verdict comes from the compiler.
 *
 * Deliberately narrow: one sketch, one FQBN, no shell interpolation. A green
 * build also runs the pin gate (pins.ts) against the sheet; libraries and
 * behavior belong in `verify(project=...)`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, constants, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { checkPins, renderPinReport, type PinReport } from "./pins.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 5_000;

const Params = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"Project directory, sketch directory, or .ino file. Defaults to the current directory. " +
				"A stray <name>.ino is moved into <name>/<name>.ino, which arduino-cli requires.",
		}),
	),
	fqbn: Type.Optional(
		Type.String({
			description:
				"Board FQBN, e.g. esp8266:esp8266:d1. If omitted, the tool reads a `FQBN:` line from " +
				"BRIEF.md or devices/*.txt. It never guesses a board.",
		}),
	),
});

interface CompileDetails {
	cli: string;
	sketch: string;
	moved?: string;
	fqbn: string;
	passed: boolean;
	exitCode: number;
	timeout: boolean;
	stdout: string;
	stderr: string;
	pins?: PinReport;
}

async function isFile(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isFile();
	} catch {
		return false;
	}
}

async function isDir(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function isExecutable(p: string): Promise<boolean> {
	try {
		await access(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findArduinoCli(): Promise<string> {
	const fromPath = (process.env.PATH ?? "")
		.split(":")
		.filter(Boolean)
		.map((dir) => join(dir, "arduino-cli"));
	const candidates = [
		process.env.ARDUINO_CLI,
		...fromPath,
		join(homedir(), ".local/bin/arduino-cli"),
		"/usr/local/bin/arduino-cli",
		"/usr/bin/arduino-cli",
	].filter((p): p is string => Boolean(p));

	for (const candidate of candidates) {
		if (await isExecutable(candidate)) return candidate;
	}
	throw new Error(
		"arduino-cli not found. Install it (the stack's bootstrap.sh does), or pass " +
			"ARDUINO_CLI=/path/to/arduino-cli in the environment.",
	);
}

interface Sketch {
	dir: string;
	moved?: string;
}

/**
 * Apply the one-live-sketch rule: <dir>/<name>.ino.
 *
 * Order: an explicit .ino, the directory itself, firmware/<name>/<name>.ino,
 * any single immediate <name>/<name>.ino, then a single stray .ino which is
 * moved into its own directory. More than one candidate is an error — the tool
 * will not guess which sketch is live.
 */
async function findSketch(root: string): Promise<Sketch> {
	const target = resolve(root);

	if (await isFile(target)) {
		if (!target.endsWith(".ino")) {
			throw new Error(`${target} is not an .ino file. Pass a project directory or a sketch file.`);
		}
		const name = basename(target, ".ino");
		const parent = dirname(target);
		if (basename(parent) === name) return { dir: parent };

		const sketchDir = join(parent, name);
		const sketchFile = join(sketchDir, `${name}.ino`);
		if (await isFile(sketchFile)) {
			throw new Error(
				`Both ${target} and ${sketchFile} exist. Keep one live sketch: delete or rename the stray file, ` +
					`then run compile again.`,
			);
		}
		await mkdir(sketchDir, { recursive: true });
		await rename(target, sketchFile);
		return { dir: sketchDir, moved: `${target} -> ${sketchFile}` };
	}

	if (!(await isDir(target))) {
		throw new Error(`Not found: ${target}. Pass the project directory or the sketch path.`);
	}

	const name = basename(target);
	if (await isFile(join(target, `${name}.ino`))) return { dir: target };

	const firmware = join(target, "firmware");
	if (await isDir(firmware)) {
		const found: string[] = [];
		for (const entry of await readdir(firmware, { withFileTypes: true })) {
			if (entry.isDirectory() && (await isFile(join(firmware, entry.name, `${entry.name}.ino`)))) {
				found.push(join(firmware, entry.name));
			}
		}
		if (found.length === 1) return { dir: found[0] };
		if (found.length > 1) {
			throw new Error(
				`Multiple sketches under firmware/: ${found.map((p) => basename(p)).join(", ")}. ` +
					"Pass path=<sketch directory> to choose the live one.",
			);
		}
	}

	const subdirs: string[] = [];
	for (const entry of await readdir(target, { withFileTypes: true })) {
		if (entry.isDirectory() && (await isFile(join(target, entry.name, `${entry.name}.ino`)))) {
			subdirs.push(join(target, entry.name));
		}
	}
	if (subdirs.length === 1) return { dir: subdirs[0] };
	if (subdirs.length > 1) {
		throw new Error(
			`Multiple sketches in ${target}: ${subdirs.map((p) => basename(p)).join(", ")}. ` +
				"Keep one live sketch or pass path=<sketch directory>.",
		);
	}

	const stray: string[] = [];
	for (const entry of await readdir(target, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".ino")) stray.push(join(target, entry.name));
	}
	if (stray.length === 1) {
		const file = stray[0];
		const base = basename(file, ".ino");
		const sketchDir = join(target, base);
		const sketchFile = join(sketchDir, `${base}.ino`);
		await mkdir(sketchDir, { recursive: true });
		await rename(file, sketchFile);
		return { dir: sketchDir, moved: `${file} -> ${sketchFile}` };
	}
	if (stray.length > 1) {
		throw new Error(
			`${target} has ${stray.length} .ino files (${stray.map((p) => basename(p)).join(", ")}). ` +
				"Arduino needs one sketch per directory; pass path=<sketch directory>.",
		);
	}

	throw new Error(
		`No Arduino sketch found in ${target}. Expected ${join(target, "<name>", "<name>.ino")} ` +
			"(or firmware/<name>/<name>.ino).",
	);
}

async function findFqbn(root: string): Promise<string | null> {
	const files = [join(root, "BRIEF.md")];
	try {
		for (const entry of await readdir(join(root, "devices"))) {
			if (entry.endsWith(".txt") || entry.endsWith(".md")) files.push(join(root, "devices", entry));
		}
	} catch {
		// No devices/ directory: fall through to BRIEF.md only.
	}

	const found = new Set<string>();
	for (const file of files) {
		try {
			const text = await readFile(file, "utf8");
			const match = text.match(/^FQBN:\s*([A-Za-z0-9_.:-]+)/m);
			if (match) found.add(match[1]);
		} catch {
			// Sheet may not exist; keep looking.
		}
	}
	if (found.size > 1) {
		throw new Error(
			`Conflicting FQBN values in ${root}: ${[...found].join(", ")}. ` +
				"Keep one board sheet, or pass fqbn explicitly.",
		);
	}
	return found.values().next().value ?? null;
}

async function findProjectRoot(start: string): Promise<string> {
	let dir = resolve(start);
	for (let depth = 0; depth < 4; depth++) {
		if ((await isDir(join(dir, "devices"))) || (await isFile(join(dir, "BRIEF.md")))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(start);
}

/** Turn common compiler failures into the next action, not a guess. */
function hint(stderr: string): string | null {
	if (/main file missing from sketch:.*\/([^/]+)\.ino/.test(stderr)) {
		return (
			"This is the Arduino layout rule: arduino-cli expects <dir>/<name>.ino where <dir> and <name> match. " +
			"Put the sketch in firmware/<name>/<name>.ino and run compile again (this tool moves a single stray file for you)."
		);
	}
	if (/Unknown FQBN|Invalid FQBN|platform (?:.* )?not installed|Platform .* not found/i.test(stderr)) {
		return "The FQBN is wrong or its core is missing. Read `FQBN:` from devices/<board>.txt (do not guess), " +
			"and install the core with `arduino-cli core install <package>:<arch>`.";
	}
	if (/No such file or directory.*\.h|fatal error: .*: No such file/i.test(stderr)) {
		return "A header/library is missing. Check `#include` names against the device sheet, then " +
			"`arduino-cli lib install \"<library>\"`; do not substitute a different library.";
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "compile",
		label: "compile",
		description:
			"Build an Arduino sketch with arduino-cli and return the compiler's verdict. " +
			"Applies the <name>/<name>.ino layout rule, takes the FQBN from devices/*.txt or BRIEF.md, " +
			"and returns the real error text. A green build also checks the sketch's pins against the board " +
			"sheet (PINS: PASS/FAIL; non-GPIO projects skip). Use it instead of claiming code should compile.",
		promptSnippet: "compile: build an Arduino sketch and report pass/fail",
		promptGuidelines: [
			"After writing firmware, run compile and fix the error it names. Never answer 'it should compile'.",
			"Do not guess the board: put `FQBN: <package>:<arch>:<board>` in the device sheet, or pass fqbn explicitly.",
		],
		parameters: Params,
		annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false },

		async execute(_toolCallId, params, signal) {
			const cli = await findArduinoCli();
			const sketch = await findSketch(params.path ?? ".");
			const projectRoot = await findProjectRoot(sketch.dir);
			const fqbn = params.fqbn ?? (await findFqbn(projectRoot)) ?? (await findFqbn(sketch.dir));

			if (!fqbn) {
				throw new Error(
					"No FQBN. Add a line `FQBN: esp8266:esp8266:d1` to devices/<board>.txt or BRIEF.md, " +
						"or pass fqbn. Find the exact ID with `arduino-cli board listall | grep -i <board>` — do not guess.",
				);
			}

			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			let timedOut = false;

			try {
				const r = await run(cli, ["compile", "--fqbn", fqbn, sketch.dir], {
					signal: combined,
					cwd: sketch.dir,
					maxBuffer: 8 * 1024 * 1024,
					env: { ...process.env, PATH: `${dirname(cli)}:${process.env.PATH ?? ""}` },
				});
				stdout = r.stdout ?? "";
				stderr = r.stderr ?? "";
			} catch (err) {
				const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; name?: string };
				stdout = e.stdout ?? "";
				stderr = e.stderr ?? "";
				exitCode = typeof e.code === "number" ? e.code : 1;
				timedOut = e.killed === true || e.name === "AbortError" || e.name === "TimeoutError";
				if (timedOut) {
					throw new Error(`compile timed out after ${TIMEOUT_MS / 1000}s (${fqbn}).`);
				}
			}

			const passed = exitCode === 0 && !timedOut;
			const details: CompileDetails = {
				cli,
				sketch: sketch.dir,
				moved: sketch.moved,
				fqbn,
				passed,
				exitCode,
				timeout: timedOut,
				stdout,
				stderr,
			};

			let body = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
			if (body.length > MAX_OUTPUT) {
				body = body.slice(0, MAX_OUTPUT) + `\n[... ${body.length - MAX_OUTPUT} chars omitted]`;
			}
			if (!body) body = "(compiler printed nothing)";

			const summary = /Sketch uses .*?bytes.*\n(?:Global variables use .*?bytes)?/m.exec(stdout)?.[0];
			const next = passed ? null : hint(stderr);

			let pins: PinReport | undefined;
			if (passed) {
				try {
					pins = await checkPins(projectRoot, {
						sketch: join(sketch.dir, `${basename(sketch.dir)}.ino`),
					});
					details.pins = pins;
				} catch (err) {
					pins = {
						verdict: "FAIL",
						reason: `pin check could not run: ${String((err as Error).message ?? err)}`,
						sheet: null,
						sketches: [],
						uses: 0,
						allowed: [],
						findings: [],
					};
					details.pins = pins;
				}
			}

			const header =
				`COMPILE: ${passed ? "PASS" : `FAIL (exit ${exitCode})`}\n` +
				`SKETCH: ${sketch.dir}\n` +
				`FQBN: ${fqbn}` +
				(sketch.moved ? `\nMOVED: ${sketch.moved}` : "") +
				(pins ? `\n${renderPinReport(pins)}` : "") +
				"\n\n";
			const footer = [
				summary ? `\n\n${summary}` : "",
				next ? `\n\nNEXT: ${next}` : "",
			].join("");

			return { content: [{ type: "text", text: header + body + footer }], details };
		},

		renderCall(args, theme, _c) {
			let s = theme.fg("toolTitle", theme.bold("compile "));
			s += theme.fg("accent", args.path ?? ".");
			if (args.fqbn) s += theme.fg("muted", ` · ${args.fqbn}`);
			return new Text(s, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _c) {
			if (isPartial) return new Text(theme.fg("warning", "Compiling..."), 0, 0);
			const d = result.details as CompileDetails | undefined;
			if (!d) return new Text(theme.fg("dim", "compiled"), 0, 0);

			let s = d.passed ? theme.fg("success", "PASS") : theme.fg("error", `FAIL (exit ${d.exitCode})`);
			s += theme.fg("dim", ` · ${d.fqbn}`);
			if (d.pins && d.pins.verdict !== "SKIP") {
				s += d.pins.verdict === "PASS"
					? theme.fg("success", " · pins ok")
					: theme.fg("error", " · pins FAIL");
			}
			if (d.moved) s += theme.fg("warning", " · moved to sketch dir");
			if (expanded && !d.passed) {
				for (const line of (d.stderr || d.stdout).split("\n").slice(0, 20)) {
					s += `\n${theme.fg("dim", line)}`;
				}
			}
			return new Text(s, 0, 0);
		},
	});
}

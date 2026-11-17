/**
 * pins — check every pin a sketch names against the project's board sheet.
 *
 * Why this exists: measured 2026-11-17, a model wrote `LiquidCrystal lcd(8, 9,
 * 4, 5, 6, 7)` after correctly annotating that the shield's D8 is GPIO0. On
 * ESP8266 those literals are GPIO8/9/4/5/6/7 — GPIO6-11 are the SPI flash and
 * 8/9 are not on the D1 sheet at all — yet arduino-cli compiled it happily.
 * A valid number is not a valid pin, so the compiler cannot be the last gate.
 *
 * The sheet is the source of truth:
 *   D8 -> GPIO0            allowed labels and pins
 *   RESERVED: GPIO6-11     pins that must not be used (per platform)
 *
 * Auto-bypass: no board sheet, no sketch, or no pin calls means SKIP. A Python
 * or Linux-app project has none of these, so the gate costs it nothing.
 *
 * What is checked: pinMode/digitalWrite/digitalRead/analogRead/analogWrite/
 * pulseIn/tone/attachInterrupt, Servo.attach, Wire.begin, SPI.begin, and the
 * LiquidCrystal/SoftwareSerial constructors. Constants defined in the sketch are
 * resolved one level at a time. An identifier that cannot be resolved is a FAIL,
 * not a guess: use a literal or a sheet label.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export type PinVerdict = "PASS" | "FAIL" | "SKIP";

export interface PinFinding {
	pin: number | null;
	line: number;
	text: string;
	reason: string;
}

export interface PinReport {
	verdict: PinVerdict;
	reason: string;
	sheet: string | null;
	sketches: string[];
	uses: number;
	allowed: number[];
	findings: PinFinding[];
}

interface Sheet {
	labels: Map<string, number>;
	reserved: Set<number>;
}

const PIN_CALLS =
	/\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|pulseIn|tone)\s*\(([^()]*)\)/g;
const CONSTRUCTORS =
	/\b(LiquidCrystal|SoftwareSerial)\s+[A-Za-z_]\w*\s*\(([^()]*)\)/g;
const OTHER_CALLS = [
	/\b([A-Za-z_]\w*)\s*\.\s*attach\s*\(([^()]*)\)/g, // Servo.attach(pin) / pinMode via objects
	/\b(Wire|SPI)\s*\.\s*begin\s*\(([^()]*)\)/g,
];
const INTERRUPT =
	/attachInterrupt\s*\(\s*digitalPinToInterrupt\s*\(\s*([^()]*)\s*\)/g;

function lineOf(src: string, index: number): number {
	let n = 1;
	for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") n++;
	return n;
}

/** Remove comments and string/char literals so their contents are never pins. */
function strip(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, "")
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function parseSheet(text: string): Sheet {
	const labels = new Map<string, number>();
	const reserved = new Set<number>();
	for (const line of text.split("\n")) {
		const pin = line.match(/^\s*([A-Za-z_]\w*)\s*->\s*GPIO(\d+)/);
		if (pin) labels.set(pin[1], Number(pin[2]));
		const res = line.match(/^\s*RESERVED:\s*(.+)$/i);
		if (res) {
			for (const m of res[1].matchAll(/GPIO\s*(\d+)\s*-\s*(\d+)|GPIO\s*(\d+)/gi)) {
				if (m[1]) for (let i = Number(m[1]); i <= Number(m[2]); i++) reserved.add(i);
				else if (m[3]) reserved.add(Number(m[3]));
			}
		}
	}
	return { labels, reserved };
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

async function findSheet(project: string, board?: string): Promise<string | null> {
	if (board) {
		const p = isAbsolute(board) ? board : resolve(project, board);
		return (await isFile(p)) ? p : null;
	}
	const dir = join(project, "devices");
	let entries: string[] = [];
	try {
		entries = await readdir(dir);
	} catch {
		return null;
	}
	const sheets: string[] = [];
	for (const name of entries.sort()) {
		if (!name.endsWith(".txt") && !name.endsWith(".md")) continue;
		const p = join(dir, name);
		const text = await readFile(p, "utf8");
		if (/^\s*PINS\b/m.test(text) && /->\s*GPIO\d+/m.test(text)) sheets.push(p);
	}
	if (sheets.length > 1) {
		throw new Error(
			`Multiple board sheets in ${dir}: ${sheets.map((p) => basename(p)).join(", ")}. ` +
				"Keep one board per project, or pass board=<file>.",
		);
	}
	return sheets[0] ?? null;
}

async function findSketches(project: string, sketch?: string): Promise<string[]> {
	if (sketch) {
		const p = isAbsolute(sketch) ? sketch : resolve(project, sketch);
		return (await isFile(p)) ? [p] : [];
	}
	const firmware = join(project, "firmware");
	const found: string[] = [];
	if (await isDir(firmware)) {
		for (const entry of await readdir(firmware, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const p = join(firmware, entry.name, `${entry.name}.ino`);
			if (await isFile(p)) found.push(p);
		}
	}
	if (found.length) return found.sort();
	for (const entry of await readdir(project, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".ino")) found.push(join(project, entry.name));
	}
	return found.sort();
}

interface Parsed {
	consts: Map<string, string>;
	uses: { expr: string; line: number; text: string }[];
}

function firstArg(args: string): string {
	return args.split(",")[0].trim();
}

function allArgs(args: string): string[] {
	return args
		.split(",")
		.map((a) => a.trim())
		.filter(Boolean);
}

function parseSketch(raw: string): Parsed {
	const src = strip(raw);
	const consts = new Map<string, string>();
	for (const m of src.matchAll(/#define\s+([A-Za-z_]\w*)\s+([^\n]+)/g)) {
		if (!m[1].includes("(")) consts.set(m[1], m[2].trim());
	}
	for (const m of src.matchAll(
		/\b(?:const\s+)?(?:unsigned\s+)?(?:int|uint8_t|byte|short|long)\s+([A-Za-z_]\w*)\s*=\s*([^;,]+)[;,]/g,
	)) {
		consts.set(m[1], m[2].trim());
	}

	const uses: Parsed["uses"] = [];
	const add = (expr: string, index: number, text: string) =>
		uses.push({ expr: expr.trim(), line: lineOf(src, index), text });

	for (const m of src.matchAll(PIN_CALLS)) add(firstArg(m[2]), m.index ?? 0, m[1]);
	for (const m of src.matchAll(INTERRUPT)) add(m[1], m.index ?? 0, "attachInterrupt");
	for (const m of src.matchAll(CONSTRUCTORS)) {
		for (const arg of allArgs(m[2])) add(arg, m.index ?? 0, m[1]);
	}
	for (const re of OTHER_CALLS) {
		for (const m of src.matchAll(re)) {
			const name = m[1] === "Wire" || m[1] === "SPI" ? m[1] + ".begin" : "attach";
			for (const arg of allArgs(m[2])) add(arg, m.index ?? 0, name);
		}
	}
	return { consts, uses };
}

interface Resolved {
	pin?: number;
	expr: string;
	error?: string;
}

function resolveExpr(expr: string, sheet: Sheet, consts: Map<string, string>, depth = 0): Resolved {
	const e = expr.trim();
	if (!e) return { expr: e, error: "empty pin expression" };
	if (/^\d+$/.test(e)) return { pin: Number(e), expr: e };
	if (sheet.labels.has(e)) return { pin: sheet.labels.get(e), expr: e };
	const local = consts.get(e);
	if (local !== undefined && depth < 5) {
		const inner = resolveExpr(local, sheet, consts, depth + 1);
		if (inner.pin !== undefined) return { pin: inner.pin, expr: `${e} (= ${inner.expr})` };
		return { ...inner, expr: `${e} (= ${local})` };
	}
	if (/^\(.*\)$/.test(e)) return resolveExpr(e.slice(1, -1), sheet, consts, depth + 1);
	return {
		expr: e,
		error: `cannot resolve ${e} — use a number or a label from the board sheet`,
	};
}

export interface PinOptions {
	board?: string;
	sketch?: string;
}

export async function checkPins(project: string, options: PinOptions = {}): Promise<PinReport> {
	const root = resolve(project);
	const sheetPath = await findSheet(root, options.board);
	if (!sheetPath) {
		return {
			verdict: "SKIP",
			reason: "no board sheet with a PINS section under devices/ — not a GPIO project",
			sheet: null,
			sketches: [],
			uses: 0,
			allowed: [],
			findings: [],
		};
	}
	const sketches = await findSketches(root, options.sketch);
	if (!sketches.length) {
		return {
			verdict: "SKIP",
			reason: "no Arduino sketch in this project",
			sheet: sheetPath,
			sketches: [],
			uses: 0,
			allowed: [],
			findings: [],
		};
	}

	const sheet = parseSheet(await readFile(sheetPath, "utf8"));
	const allowed = [...new Set(sheet.labels.values())].sort((a, b) => a - b);
	const findings: PinFinding[] = [];
	let uses = 0;

	for (const file of sketches) {
		const parsed = parseSketch(await readFile(file, "utf8"));
		for (const use of parsed.uses) {
			uses++;
			const r = resolveExpr(use.expr, sheet, parsed.consts);
			if (r.pin === undefined) {
				findings.push({ pin: null, line: use.line, text: use.text, reason: r.error ?? "unresolved" });
			} else if (sheet.reserved.has(r.pin)) {
				findings.push({
					pin: r.pin,
					line: use.line,
					text: use.text,
					reason: `GPIO${r.pin} is reserved (see the sheet's RESERVED line)`,
				});
			} else if (!allowed.includes(r.pin)) {
				findings.push({
					pin: r.pin,
					line: use.line,
					text: use.text,
					reason: `GPIO${r.pin} is not on the board sheet (allowed: ${allowed.join(", ")})`,
				});
			}
		}
	}

	if (!uses) {
		return {
			verdict: "SKIP",
			reason: `no pin usage in ${sketches.map((p) => basename(dirname(p)) + "/" + basename(p)).join(", ")}`,
			sheet: sheetPath,
			sketches: sketches.map((p) => p.replace(root + "/", "")),
			uses: 0,
			allowed,
			findings: [],
		};
	}

	const seen = new Set<string>();
	const unique = findings.filter((f) => {
		const key = `${f.pin}:${f.reason}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	if (unique.length) {
		return {
			verdict: "FAIL",
			reason: `${unique.length} pin problem(s): ${unique
				.slice(0, 3)
				.map((f) => (f.pin === null ? f.reason : `GPIO${f.pin}`))
				.join(", ")}${unique.length > 3 ? ", ..." : ""}`,
			sheet: sheetPath,
			sketches: sketches.map((p) => p.replace(root + "/", "")),
			uses,
			allowed,
			findings: unique,
		};
	}

	return {
		verdict: "PASS",
		reason: `${uses} pin use(s), all on ${basename(sheetPath)}`,
		sheet: sheetPath,
		sketches: sketches.map((p) => p.replace(root + "/", "")),
		uses,
		allowed,
		findings: [],
	};
}

export function renderPinReport(report: PinReport): string {
	const lines = [`PINS: ${report.verdict} — ${report.reason}`];
	for (const f of report.findings) {
		lines.push(
			`  ${report.sketches[0] ?? "sketch"}:${f.line}  ${f.text}  → ${f.reason}` +
				(f.pin === null ? "" : ` (GPIO${f.pin})`),
		);
	}
	if (report.verdict === "FAIL") {
		lines.push(
			"NEXT: use the GPIO or label from the board sheet. A pin that compiles is not necessarily a pin " +
				"that exists; labels are not numbers (D8 is GPIO0, not 8).",
		);
	}
	return lines.join("\n");
}

const Params = Type.Object({
	path: Type.Optional(
		Type.String({
			description: "Project directory. Defaults to the current directory.",
		}),
	),
	board: Type.Optional(
		Type.String({
			description:
				"Board sheet path (default: the single devices/*.txt with a PINS section). " +
				"Projects without a board sheet are skipped, not failed.",
		}),
	),
	sketch: Type.Optional(Type.String({ description: "Sketch path (default: firmware/*/*.ino)." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "pincheck",
		label: "pincheck",
		description:
			"Check every pin in the sketch against the board sheet: labels resolve to GPIOs, reserved pins " +
			"(GPIO6-11 on ESP8266) and pins not on the sheet fail. Skips non-GPIO projects automatically.",
		promptSnippet: "pincheck: verify sketch pins against the board sheet",
		promptGuidelines: [
			"Run pincheck after writing firmware, or let compile run it. Fix a PINS: FAIL before calling the task done.",
			"Do not use a bare label digit as a pin: D8 is GPIO0, never 8.",
		],
		parameters: Params,
		annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

		async execute(_toolCallId, params) {
			const report = await checkPins(params.path ?? ".", {
				board: params.board,
				sketch: params.sketch,
			});
			return {
				content: [{ type: "text", text: renderPinReport(report) }],
				details: report,
			};
		},

		renderCall(args, theme, _c) {
			let s = theme.fg("toolTitle", theme.bold("pincheck "));
			s += theme.fg("accent", args.path ?? ".");
			return new Text(s, 0, 0);
		},

		renderResult(result, { expanded }, theme, _c) {
			const d = result.details as PinReport | undefined;
			if (!d) return new Text(theme.fg("dim", "checked"), 0, 0);
			const color = d.verdict === "PASS" ? "success" : d.verdict === "FAIL" ? "error" : "muted";
			let s = theme.fg(color, d.verdict) + theme.fg("dim", ` · ${d.reason}`);
			if (expanded && d.verdict === "FAIL") {
				for (const f of d.findings) s += `\n${theme.fg("dim", `line ${f.line}: ${f.reason}`)}`;
			}
			return new Text(s, 0, 0);
		},
	});
}

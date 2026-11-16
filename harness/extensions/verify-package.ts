/**
 * verify-package — check that a package, repo, or URL the model is about to recommend
 * actually exists.
 *
 * Why this exists: on Test B the model produced a confident, well-structured plan built
 * entirely around `pi install npm:pi-local-rag` — a package it appears to have invented. It
 * fetched a real-looking GitHub page (github.com/vahidkowsari/pi-local-rag), anchored on it,
 * and then presented a full command set — `/rag index`, `/rag on`, `/rag status` — as fact.
 * Nothing in the transcript distinguished that from a real package.
 *
 * The failure is not retrieval. Fetch enforcement worked; the fetch happened. The failure is
 * that the model cannot tell "this exists" from "this page looked plausible," and it has no
 * way to check before asserting.
 *
 * This tool gives it the check. Three registries are queried and the result is reported
 * verbatim, with THREE verdicts rather than two — found, missing, and "could not check".
 * The third exists because the first version mapped every infrastructure failure (timeout,
 * DNS, missing npm, a crashed probe) to "DOES NOT EXIST", which told the model a real
 * package was fake. A network problem must never be evidence about a package.
 *
 * Deliberately narrow: it resolves whether something exists, it does not install anything.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;

type Status = "found" | "missing" | "unknown";

interface CheckResult {
	status: Status;
	detail: string;
}

const Params = Type.Object({
	kind: Type.String({
		description:
			"What to check: 'npm' for a package name (e.g. 'pi-local-rag' or '@scope/name'), 'pypi' for a python package, or 'url' for a URL to probe.",
	}),
	value: Type.String({ description: "The package name or URL to verify exists." }),
});

interface CheckDetails {
	kind: string;
	value: string;
	status: Status;
	detail: string;
}

/** `npm view a b c` prints `field = value` lines; turn those into a lookup. */
function parseNpmFields(out: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const line of out.split("\n")) {
		const m = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/);
		if (!m) continue;
		fields.set(m[1], m[2].replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1"));
	}
	return fields;
}

async function checkNpm(name: string): Promise<CheckResult> {
	// `npm view` exits 1 with E404 for an unknown package, which is the only signal
	// that means "does not exist". Everything else is an infrastructure problem.
	try {
		const r = await run("npm", ["view", name, "name", "version", "description"], {
			timeout: TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		const out = (r.stdout || "").trim();
		if (!out) return { status: "unknown", detail: "npm returned no metadata — could not confirm" };
		const fields = parseNpmFields(out);
		const pkg = fields.get("name") ?? name;
		const version = fields.get("version");
		const description = fields.get("description");
		return {
			status: "found",
			detail: `FOUND on npm: ${pkg}${version ? `@${version}` : ""}${description ? ` — ${description}` : ""}`,
		};
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
		const errText = (e.stderr || e.stdout || "").trim();
		if (e.killed) return { status: "unknown", detail: "npm view timed out — could not check" };
		if (/\bE404\b|404 Not Found/i.test(errText)) {
			return { status: "missing", detail: `NOT FOUND on npm: no package named "${name}".` };
		}
		return {
			status: "unknown",
			detail: `COULD NOT CHECK npm (exit ${e.code ?? "?"}). ${errText.slice(0, 300)}`,
		};
	}
}

async function checkPypi(name: string): Promise<CheckResult> {
	// Node's fetch, not a python subprocess. The previous version built a python
	// one-liner inside a JS template literal, so JS evaluated `${...sys...}` itself
	// and threw before python ever started — every PyPI check became NOT FOUND.
	const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(20_000),
			headers: { accept: "application/json", "user-agent": "pi-verify-package/1.1" },
		});
		if (res.status === 200) {
			const data = (await res.json()) as { info?: { name?: string; version?: string } };
			const pkg = data.info?.name ?? name;
			const version = data.info?.version;
			return { status: "found", detail: `FOUND on PyPI: ${pkg}${version ? ` ${version}` : ""}` };
		}
		if (res.status === 404) return { status: "missing", detail: `NOT FOUND on PyPI: no package named "${name}".` };
		return { status: "unknown", detail: `COULD NOT CHECK PyPI: HTTP ${res.status}` };
	} catch (err) {
		return {
			status: "unknown",
			detail: `COULD NOT CHECK PyPI: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
		};
	}
}

async function checkUrl(url: string): Promise<CheckResult> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return { status: "missing", detail: `Invalid URL: ${url}` };
	}
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 20_000);
	try {
		const res = await fetch(u, {
			signal: ctl.signal,
			redirect: "follow",
			headers: { "user-agent": "pi-verify-package/1.1", accept: "*/*" },
		});
		if (res.status >= 200 && res.status < 400) {
			return { status: "found", detail: `REACHABLE: HTTP ${res.status} at ${res.url}` };
		}
		if (res.status === 404 || res.status === 410) {
			return { status: "missing", detail: `NOT REACHABLE: HTTP ${res.status} at ${res.url}` };
		}
		// 401/403/429/5xx mean something answered, just not usefully.
		return { status: "unknown", detail: `COULD NOT CHECK: HTTP ${res.status} at ${res.url}` };
	} catch (err) {
		return {
			status: "unknown",
			detail: `COULD NOT CHECK: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
		};
	} finally {
		clearTimeout(timer);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "verify_package",
		label: "verify-package",
		description:
			"Check whether a package or URL actually exists, before recommending or installing it. " +
			"kind='npm' for a node package, kind='pypi' for a python package, kind='url' to probe a URL. " +
			"If this reports NOT FOUND, do not recommend it or write install commands for it — say it " +
			"does not exist and search for the real one instead. If it reports COULD NOT CHECK, the " +
			"check itself failed: do not treat that as proof either way. A package that appears in " +
			"search results is not evidence that it exists.",
		promptSnippet: "verify_package: confirm a package or URL exists before recommending it",
		promptGuidelines: [
			"Before recommending a specific package, extension, or repo by name, call verify_package. If it is not found, do not present it as a real option.",
			"Never invent a package name. If you are unsure of the exact name, say so rather than guessing one.",
		],
		parameters: Params,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

		async execute(_toolCallId, params) {
			const kind = params.kind.trim().toLowerCase();
			const value = params.value.trim();
			if (!value) throw new Error("value is required.");

			let result: CheckResult;
			if (kind === "npm") {
				result = await checkNpm(value);
			} else if (kind === "pypi") {
				result = await checkPypi(value);
			} else if (kind === "url") {
				result = await checkUrl(value);
			} else {
				throw new Error(`Unknown kind "${kind}". Use 'npm', 'pypi', or 'url'.`);
			}

			const details: CheckDetails = { kind, value, status: result.status, detail: result.detail };
			const verdict =
				result.status === "found"
					? "EXISTS — safe to recommend or install."
					: result.status === "missing"
						? "DOES NOT EXIST — do not recommend it or write install commands for it. Search for the correct name."
						: "COULD NOT CHECK — not evidence that it exists or that it does not. Retry, or say plainly that you could not verify it.";

			return {
				content: [{ type: "text", text: `CHECK ${kind}: ${value}\n${result.detail}\n\nVERDICT: ${verdict}` }],
				details,
			};
		},

		renderCall(args, theme, _c) {
			let s = theme.fg("toolTitle", theme.bold("verify_package "));
			s += theme.fg("accent", args.value);
			return new Text(s, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _c) {
			if (isPartial) return new Text(theme.fg("warning", "Checking..."), 0, 0);
			const d = result.details as CheckDetails | undefined;
			if (!d) return new Text(theme.fg("dim", "checked"), 0, 0);
			if (d.status === "found") return new Text(theme.fg("success", `EXISTS: ${d.value}`), 0, 0);
			if (d.status === "missing") return new Text(theme.fg("error", `NOT FOUND: ${d.value}`), 0, 0);
			return new Text(theme.fg("warning", `COULD NOT CHECK: ${d.value}`), 0, 0);
		},
	});
}

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
 * This tool gives it the check. Three registries are queried, the exit code and status are
 * reported verbatim, and the description tells the model that a miss means "do not recommend
 * this, find the real one." Deliberately narrow: it resolves whether something exists, it
 * does not install anything.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;

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
	found: boolean;
	detail: string;
}

async function checkNpm(name: string): Promise<{ found: boolean; detail: string }> {
	// `npm view` exits non-zero with code E404 for an unknown package, which is the signal.
	try {
		const r = await run("npm", ["view", name, "name", "version", "description"], {
			timeout: TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		});
		const out = (r.stdout || "").trim();
		if (!out) return { found: false, detail: "npm returned no metadata (treated as not found)" };
		const [pkg, version, ...desc] = out.split("\n");
		return {
			found: true,
			detail: `FOUND on npm: ${pkg}@${version}${desc.length ? ` — ${desc.join(" ").trim()}` : ""}`,
		};
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
		const errText = (e.stderr || e.stdout || "").trim();
		if (e.killed) return { found: false, detail: "npm view timed out" };
		return {
			found: false,
			detail: `NOT FOUND on npm (exit ${e.code ?? "?"}). ${errText.slice(0, 300)}`,
		};
	}
}

async function checkPypi(name: string): Promise<{ found: boolean; detail: string }> {
	try {
		const r = await run(
			"python3",
			["-c", `import urllib.request,json,sys;d=json.load(urllib.request.urlopen("https://pypi.org/pypi/${encodeURIComponent(sys.argv[1])}/json",timeout=20));print(d["info"]["name"],d["info"]["version"])`,
			 name],
			{ timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
		);
		const out = (r.stdout || "").trim();
		return { found: true, detail: `FOUND on PyPI: ${out}` };
	} catch (err) {
		const e = err as { stderr?: string; code?: number };
		return {
			found: false,
			detail: `NOT FOUND on PyPI (exit ${e.code ?? "?"}). ${(e.stderr || "").trim().slice(0, 300)}`,
		};
	}
}

async function checkUrl(url: string): Promise<{ found: boolean; detail: string }> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return { found: false, detail: `Invalid URL: ${url}` };
	}
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 20_000);
	try {
		const res = await fetch(u, {
			signal: ctl.signal,
			redirect: "follow",
			headers: { "user-agent": "pi-verify-package/1.0", accept: "*/*" },
		});
		if (res.status >= 200 && res.status < 400) {
			return { found: true, detail: `REACHABLE: HTTP ${res.status} at ${res.url}` };
		}
		return { found: false, detail: `NOT REACHABLE: HTTP ${res.status} at ${res.url}` };
	} catch (err) {
		return {
			found: false,
			detail: `NOT REACHABLE: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
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
			"does not exist and search for the real one instead. A package that appears in search " +
			"results is not evidence that it exists.",
		promptSnippet: "verify_package: confirm a package or URL exists before recommending it",
		promptGuidelines: [
			"Before recommending a specific package, extension, or repo by name, call verify_package. If it is not found, do not present it as a real option.",
			"Never invent a package name. If you are unsure of the exact name, say so rather than guessing one.",
		],
		parameters: Params,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal) {
			const kind = params.kind.trim().toLowerCase();
			const value = params.value.trim();
			if (!value) throw new Error("value is required.");

			const race = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : undefined;

			let found: boolean;
			let detail: string;
			if (kind === "npm") {
				({ found, detail } = await checkNpm(value));
			} else if (kind === "pypi") {
				({ found, detail } = await checkPypi(value));
			} else if (kind === "url") {
				({ found, detail } = await checkUrl(value));
			} else {
				throw new Error(`Unknown kind "${kind}". Use 'npm', 'pypi', or 'url'.`);
			}
			void race;

			const details: CheckDetails = { kind, value, found, detail };
			const verdict = found
				? "EXISTS — safe to recommend or install."
				: "DOES NOT EXIST — do not recommend it or write install commands for it. Search for the correct name.";

			return {
				content: [{ type: "text", text: `CHECK ${kind}: ${value}\n${detail}\n\nVERDICT: ${verdict}` }],
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
			return new Text(
				d.found ? theme.fg("success", `EXISTS: ${d.value}`) : theme.fg("error", `NOT FOUND: ${d.value}`),
				0,
				0,
			);
		},
	});
}
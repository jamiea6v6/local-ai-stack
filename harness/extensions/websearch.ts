/**
 * websearch — search the web and return result titles, URLs, and snippets.
 *
 * Exists because webfetch alone cannot bootstrap: a model that has to guess a product
 * URL will guess wrong (measured: two invented ti.com paths, both 404). Search is the
 * missing first hop in the fetch -> cite -> answer loop.
 *
 * Engine order is DuckDuckGo HTML, then Bing. DuckDuckGo's html endpoint answers
 * datacenter IPs with an HTTP 202 anomaly challenge instead of results, so the fallback
 * is not theoretical — it is what actually fires from this machine.
 *
 * Only titles, URLs, and short snippets reach the model. Full pages are one webfetch
 * away, which keeps the context cost of a search near zero on a small VRAM budget.
 *
 * ── CAPS TIGHTENED 2026-11-13 ─────────────────────────────────────────────────────
 * Measured on brain1: one search with the old caps cost ~709 tokens (8 results, 220-char
 * snippets). Combined with a webfetch page and a program-sized answer, that exceeded the
 * 8192-token window the box is pinned to, and the turn ended with stopReason=length and
 * no output at all. The window cannot be raised from Pi (see webfetch.ts for the details).
 *
 *   MAX_RESULTS    8 -> 5
 *   SNIPPET_CHARS  220 -> 140
 * One search now costs ~250 tokens, which leaves room inside 8192 for the fetch, the
 * answer, and a second lookup if one is needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 5;
const SNIPPET_CHARS = 140;

const UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const Params = Type.Object({
	query: Type.String({ description: "Search query terms" }),
	results: Type.Optional(
		Type.Number({ description: `How many results to return (default ${MAX_RESULTS}, max 15)` }),
	),
});

interface Result {
	title: string;
	url: string;
	snippet: string;
}

interface SearchDetails {
	query: string;
	engine: string;
	attempts: string[];
	resultCount: number;
	urls: string[];
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&hellip;/g, "…")
		.replace(/&mdash;/g, "—")
		.replace(/&ndash;/g, "–")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function clean(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Bing wraps result links in /ck/a?...&u=<base64url of target>. Unwrap to the real URL. */
function unwrapBing(href: string): string {
	if (!href.includes("/ck/a?")) return href;
	const u = new URL(href).searchParams.get("u");
	if (!u || !u.startsWith("a1")) return href;
	try {
		const b64 = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
		const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		const decoded = Buffer.from(pad, "base64").toString("utf8");
		if (/^https?:\/\//i.test(decoded)) return decoded;
	} catch {
		/* fall through to the wrapped URL */
	}
	return href;
}

async function fetchText(url: string, signal: AbortSignal): Promise<{ status: number; body: string }> {
	const r = await fetch(url, {
		signal,
		headers: {
			"user-agent": UA,
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"accept-language": "en-US,en;q=0.9",
		},
		redirect: "follow",
	});
	return { status: r.status, body: await r.text() };
}

async function duckduckgo(q: string, limit: number, signal: AbortSignal): Promise<Result[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
	const { status, body } = await fetchText(url, signal);

	// DDG signals refusal with 202 plus an anomaly.js form and zero results.
	if (status === 202 || body.includes("anomaly.js") || !body.includes("result__a")) {
		throw new Error("DuckDuckGo returned an anti-bot challenge (HTTP 202)");
	}

	const out: Result[] = [];
	for (const m of body.matchAll(
		/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g,
	)) {
		let href = decodeEntities(m[1]);
		// DDG redirect: //duckduckgo.com/l/?uddg=<encoded target>
		if (href.includes("uddg=")) {
			const t = new URL(href, "https://duckduckgo.com").searchParams.get("uddg");
			if (t) href = t;
		}
		const snipM = m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
		out.push({
			title: clean(m[2]),
			url: href,
			snippet: snipM ? clean(snipM[1]).slice(0, SNIPPET_CHARS) : "",
		});
		if (out.length >= limit) break;
	}
	if (!out.length) throw new Error("DuckDuckGo returned no parseable results");
	return out;
}

async function bing(q: string, limit: number, signal: AbortSignal): Promise<Result[]> {
	const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${limit}`;
	const { status, body } = await fetchText(url, signal);
	if (status !== 200) throw new Error(`Bing returned HTTP ${status}`);
	if (!body.includes("b_algo")) throw new Error("Bing returned no parseable results");

	const out: Result[] = [];
	for (const m of body.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
		const block = m[0];
		const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
		if (!link) continue;
		const cap = block.match(/<p class="b_[^"]*"[^>]*>([\s\S]*?)<\/p>/);
		out.push({
			title: clean(link[2]),
			url: unwrapBing(decodeEntities(link[1])),
			snippet: cap ? clean(cap[1]).slice(0, SNIPPET_CHARS) : "",
		});
		if (out.length >= limit) break;
	}
	if (!out.length) throw new Error("Bing returned no parseable results");
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "websearch",
		label: "websearch",
		description:
			"Search the web and return ranked result titles, URLs, and short snippets. Use this when you do not already know a fact or the exact URL of a page — search first, then fetch a promising URL with webfetch, then answer. " +
			`Returns up to ${MAX_RESULTS} results. Never guess a URL to fetch; search for it instead.`,
		promptSnippet: "websearch: search the web, return titles/URLs/snippets",
		promptGuidelines: [
			"If you need a fact you are not certain of, or you do not know a page's URL, call websearch before webfetch.",
			"Do not invent URLs. Search, then fetch a real result URL.",
			"After fetching a page, answer the question and stop. Cite the URL you used.",
		],
		parameters: Params,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("Search query is empty.");

			const limit = Math.min(Math.max(Math.trunc(params.results ?? MAX_RESULTS), 1), 15);
			const combined = signal
				? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
				: AbortSignal.timeout(TIMEOUT_MS);

			const attempts: string[] = [];
			let results: Result[] | undefined;
			let engine = "";

			for (const [name, fn] of [
				["duckduckgo", duckduckgo],
				["bing", bing],
			] as const) {
				try {
					results = await fn(query, limit, combined);
					engine = name;
					break;
				} catch (err) {
					attempts.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			if (!results) {
				throw new Error(
					`All search engines failed for "${query}".\n  ${attempts.join("\n  ")}\n` +
						"Give a direct URL to webfetch instead, or ask the user for the page address.",
				);
			}

			const details: SearchDetails = {
				query,
				engine,
				attempts,
				resultCount: results.length,
				urls: results.map((r) => r.url),
			};

			const lines = results.map((r, i) => {
				const snip = r.snippet ? `\n   ${r.snippet}` : "";
				return `${i + 1}. ${r.title}\n   ${r.url}${snip}`;
			});

			const fallbackNote = attempts.length
				? `\n(Note: ${attempts.join("; ")})`
				: "";

			return {
				content: [
					{
						type: "text",
						text:
							`SEARCH: ${query}\nENGINE: ${engine} — ${results.length} results\n\n` +
							`${lines.join("\n\n")}${fallbackNote}`,
					},
				],
				details,
			};
		},

		renderCall(args, theme, _c) {
			let s = theme.fg("toolTitle", theme.bold("websearch "));
			s += theme.fg("accent", `"${args.query}"`);
			return new Text(s, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _c) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			const d = result.details as SearchDetails | undefined;
			if (!d) return new Text(theme.fg("dim", "searched"), 0, 0);

			let s = theme.fg("success", `${d.resultCount} results`);
			s += theme.fg("dim", ` via ${d.engine} for "${d.query}"`);
			if (d.attempts.length) s += theme.fg("warning", ` (${d.attempts.length} fallback)`);

			if (expanded) {
				d.urls.slice(0, 8).forEach((u, i) => {
					s += `\n${theme.fg("dim", `${i + 1}. ${u}`)}`;
				});
			}
			return new Text(s, 0, 0);
		},
	});
}
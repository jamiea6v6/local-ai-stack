/**
 * webfetch — fetch a URL and return readable text.
 *
 * Built for a 6GB VRAM budget, where context is the scarce resource. Two decisions:
 *   1. HTML is reduced to text before the model ever sees it. Raw markup is mostly
 *      tokens the model cannot use, and on a small model it actively degrades the answer.
 *   2. Output is hard-capped. Pages routinely exceed any usable context window, and a
 *      truncated page with an explicit note is far better than an overflow that pushes
 *      out the tool definitions.
 *
 * Named to match the webfetch tool in the opencode setup so the same prompt text works
 * on both.
 *
 * ── CAPS TIGHTENED 2026-11-13 ─────────────────────────────────────────────────────
 * Measured on brain1 (P106-100, Ollama 0.32.15, OLLAMA_CONTEXT_LENGTH=8192):
 *   baseline prompt           4718 tokens
 *   one websearch result set  ~709 tokens  (8 results, 220-char snippets)
 *   one webfetch page         ~1460 tokens  (8 KB cap)
 *   -> search + fetch + a full program-sized answer did NOT fit in 8192. The run ended
 *      with stopReason=length and produced zero output, which is worse than no answer.
 *
 * The window on brain1 cannot be raised without root: Pi talks to Ollama's /v1
 * endpoint, which ignores num_ctx (FAILURE_LEDGER C-04), so the only knob is
 * OLLAMA_CONTEXT_LENGTH in a root-owned systemd drop-in. /api/generate does honour
 * per-request num_ctx, and 32768 was measured at 4314 MiB of the 6144 MiB card — so the
 * VRAM headroom exists, but it is not reachable from Pi.
 *
 * So the budget is bought back where it can be bought back, with zero VRAM cost:
 *   MAX_BYTES  8 KB -> 3 KB   (~1460 -> ~768 tokens per fetch)
 *   MAX_LINES  400  -> 150
 * That fits a search (~250 tok) + a fetch (~768 tok) + a program-sized answer inside
 * 8192 with room to spare. Full text is still saved to a file the model can read.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_BYTES = 3 * 1024;
const MAX_LINES = 150;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const Params = Type.Object({
	url: Type.String({ description: "Absolute URL to fetch, including the https:// prefix" }),
	format: Type.Optional(
		Type.String({
			description:
				"Output format: 'text' (default, HTML stripped to readable text) or 'raw' (untruncated-ish response body)",
		}),
	),
});

interface FetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	bytes: number;
	lines: number;
	truncated: boolean;
	fullOutputPath?: string;
	title?: string;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&mdash;/g, "—")
		.replace(/&ndash;/g, "–")
		.replace(/&hellip;/g, "…")
		.replace(/&copy;/g, "©")
		.replace(/&reg;/g, "®")
		.replace(/&trade;/g, "™")
		.replace(/&deg;/g, "°")
		.replace(/&euro;/g, "€")
		.replace(/&pound;/g, "£")
		.replace(/&times;/g, "×")
		.replace(/&middot;/g, "·")
		.replace(/&bull;/g, "•")
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripHtml(html: string): string {
	let s = html;

	// Drop non-content elements entirely, including their text.
	s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, " ");
	// HTML comments.
	s = s.replace(/<!--[\s\S]*?-->/g, " ");
	// Preserve structure as line breaks so tables and lists stay legible.
	s = s.replace(/<\/(p|div|section|article|tr|li|h[1-6]|blockquote|pre)>/gi, "\n");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
	// Table cells read better tab-separated.
	s = s.replace(/<\/(td|th)>/gi, "\t");
	// Remaining tags carry no information here.
	s = s.replace(/<[^>]+>/g, " ");
	// Drop any stray head/body wrappers that survived.
	s = decodeEntities(s);
	// Collapse whitespace but keep paragraph structure.
	s = s.replace(/\r/g, "");
	s = s.replace(/[ \t ]+/g, " ");
	s = s.replace(/ *\n */g, "\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
}

function extractTitle(html: string): string | undefined {
	const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!m) return undefined;
	const t = decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim();
	return t || undefined;
}

async function saveFull(body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
	const file = join(dir, "page.txt");
	await writeFile(file, body, "utf8");
	return file;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "webfetch",
		description:
			"Fetch a URL over HTTP(S) and return its readable text content. HTML markup, scripts, and styles are stripped so only meaningful text reaches the model. Output is capped at " +
			`${MAX_LINES} lines / ${formatSize(MAX_BYTES)}; when truncated the model is told the full text is saved to a file it can read with the read tool. ` +
			"Use this for anything you do not already know — product facts, part numbers, current prices, documentation. Cite the URL you were given in your answer.",
		promptSnippet: "webfetch: fetch a URL and return readable text",
		promptGuidelines: [
			"Treat a webfetch result as evidence: base the answer on what the page says, and cite the source URL.",
			"After using webfetch, answer the original question. Do not keep fetching pages once the evidence is in hand.",
		],
		parameters: Params,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			let target: URL;
			try {
				target = new URL(params.url);
			} catch {
				throw new Error(
					`Invalid URL: ${params.url}. Pass an absolute URL including the https:// prefix.`,
				);
			}
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				throw new Error(`Unsupported protocol ${target.protocol} — only http and https are allowed.`);
			}

			// Timeout must also respect an aborted turn, so race both.
			const timeout = AbortSignal.timeout(TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

			let response: Response;
			let hops = 0;
			let current = target;
			while (true) {
				response = await fetch(current, {
					signal: combined,
					redirect: "manual",
					headers: {
						"user-agent": "Mozilla/5.0 (X11; Linux aarch64) pi-agent/1.0 (+local research fetch)",
						accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
						"accept-language": "en-US,en;q=0.9",
					},
				});

				if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
					if (++hops > MAX_REDIRECTS) throw new Error("Too many redirects.");
					current = new URL(response.headers.get("location")!, current);
					continue;
				}
				break;
			}

			if (!response.ok) {
				throw new Error(
					`HTTP ${response.status} ${response.statusText} for ${current.href}`,
				);
			}

			const contentType = response.headers.get("content-type") ?? "unknown";
			const body = await response.text();

			const isHtml = /text\/html|application\/xhtml/i.test(contentType);
			const wantsRaw = params.format === "raw";
			const title = isHtml ? extractTitle(body) : undefined;

			// JSON stays JSON — reformatting it would corrupt it.
			const isJson = /application\/json/i.test(contentType);
			let text = isJson || wantsRaw ? body : stripHtml(body);

			if (!text.trim()) {
				throw new Error(
					`Fetched ${current.href} (${formatSize(body.length)}) but it contained no readable text. ` +
						"It may be JavaScript-rendered; try a different URL.",
				);
			}

			const truncation = truncateHead(text, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
			const details: FetchDetails = {
				url: params.url,
				finalUrl: current.href,
				status: response.status,
				contentType,
				bytes: body.length,
				lines: text.split("\n").length,
				truncated: truncation.truncated,
			};

			let out = truncation.content;
			const header = title ? `TITLE: ${title}\nSOURCE: ${current.href}\n\n` : `SOURCE: ${current.href}\n\n`;

			if (truncation.truncated) {
				const path = await saveFull(text);
				details.fullOutputPath = path;
				out +=
					`\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
					`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
					`Full text saved to ${path} — read that file if you need the rest.]`;
			}

			return { content: [{ type: "text", text: header + out }], details };
		},

		renderCall(args, theme, _c) {
			let s = theme.fg("toolTitle", theme.bold("webfetch "));
			s += theme.fg("accent", args.url);
			return new Text(s, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _c) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			const d = result.details as FetchDetails | undefined;
			if (!d) return new Text(theme.fg("dim", "fetched"), 0, 0);

			let s = theme.fg("success", `HTTP ${d.status}`);
			s += theme.fg("dim", ` · ${d.lines} lines · ${formatSize(d.bytes)}`);
			if (d.finalUrl !== d.url) s += theme.fg("dim", ` · ${d.finalUrl}`);
			if (d.truncated) s += theme.fg("warning", " · truncated");

			if (expanded) {
				const c = result.content[0];
				if (c?.type === "text") {
					for (const line of c.text.split("\n").slice(0, 20)) {
						s += `\n${theme.fg("dim", line)}`;
					}
				}
				if (d.fullOutputPath) s += `\n${theme.fg("dim", `Full text: ${d.fullOutputPath}`)}`;
			}
			return new Text(s, 0, 0);
		},
	});
}
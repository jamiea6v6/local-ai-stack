#!/usr/bin/env node
/**
 * ollama-v1-shim — give Pi a working context window on brain1.
 *
 * The problem: brain1's Ollama serves the OpenAI-compatible endpoint at
 * /v1, and that endpoint IGNORES num_ctx. Verified on this box:
 *
 *     POST /v1/chat/completions  {"options":{"num_ctx":32768}}
 *       -> server still reports context_length 8192
 *
 * The native endpoint HONOURS it, even against the server's own env cap:
 *
 *     POST /api/generate  {"options":{"num_ctx":32768}}
 *       -> server reports context_length 32768, VRAM 4314 MiB of 6144
 *
 * So the window is reachable, it just is not reachable through /v1.
 *
 * This shim sits between Pi and Ollama. It accepts Pi's /v1 requests, and
 * forwards them to the native /api/chat endpoint with num_ctx injected.
 * Responses are converted back to the OpenAI shape Pi expects.
 *
 * Why bother, rather than just raising the server's env var:
 *   - the env var lives in a root-owned systemd drop-in, and brain1 has no
 *     passwordless sudo, so it needs a privileged user
 *   - the native endpoint's per-request num_ctx works right now, with no
 *     service restart and no change to the running Ollama
 *   - VRAM cost is measured and small: 8192 -> 4086 MiB, 32768 -> 4314 MiB
 *     (+228 MiB of the 6144 MiB card). The KV rate is ~9.5 MiB per 1k tokens.
 *
 * It is deliberately small and deliberately a shim rather than a replacement:
 * everything except the chat path is passed straight through to Ollama.
 *
 * Run:  node ollama-v1-shim.mjs            # listens on 127.0.0.1:11435
 * Env:  OLLAMA_SHIM_PORT   listen port          (default 11435)
 *       OLLAMA_SHIM_TARGET upstream base URL    (default http://127.0.0.1:11434)
 *       OLLAMA_SHIM_CTX    context to request  (default 32768)
 */

import { createServer } from "node:http";

const PORT = Number(process.env.OLLAMA_SHIM_PORT || 11435);
const TARGET = process.env.OLLAMA_SHIM_TARGET || "http://127.0.0.1:11434";
const CTX = Number(process.env.OLLAMA_SHIM_CTX || 32768);

// A small model sometimes ends a turn after emitting only a channel artifact:
// no content, no tool call, done_reason "stop". Pi assembles that into an empty
// final answer ("Command completed successfully") and the task silently dies.
// Measured on gemma4:e4b-it-qat with think:false: 12 output tokens, empty
// content, 0 tool calls, reproducible 8/8 on the same request. Re-asking with a
// one-line nudge makes the model call its tool (3/3); keep the retry bounded.
const EMPTY_RETRIES = Number(process.env.OLLAMA_SHIM_EMPTY_RETRIES ?? 2);
const EMPTY_NUDGE = "Reply now with your final answer.";

// Tool-call ids must be unique across the whole process. `call_${i}` made
// every turn's first call `call_0`, so a client matching by id could pair a
// result with the wrong call.
let toolCallSeq = 0;

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	return Buffer.concat(chunks).toString("utf8");
}

/** True only when the model produced something the client can show or run. */
function hasAssistantOutput(native) {
	const m = native?.message || {};
	return Boolean(
		(typeof m.content === "string" && m.content.trim()) ||
			(Array.isArray(m.tool_calls) && m.tool_calls.length),
	);
}

/** Re-ask the same question with a trailing nudge (not visible to the client). */
function withNudge(native) {
	return {
		...native,
		messages: [...(native.messages || []), { role: "user", content: EMPTY_NUDGE }],
	};
}

function postChat(native, signal) {
	return fetch(`${TARGET}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(native),
		signal,
	});
}

/** Convert an OpenAI-style request body into Ollama's native /api/chat body. */
function toNative(body) {
	const messages = [];

	const toolNamesById = new Map();
	for (const m of body.messages || []) {
		// OpenAI tool messages carry only tool_call_id; Ollama pairs by name.
		if (Array.isArray(m.tool_calls)) {
			for (const tc of m.tool_calls) {
				if (tc?.id) toolNamesById.set(tc.id, tc.function?.name || "");
			}
		}
		const role =
			m.role === "assistant"
				? "assistant"
				: m.role === "tool"
					? "tool"
					: m.role === "system" || m.role === "developer"
						? "system"
						: "user";
		const content =
			typeof m.content === "string"
				? m.content
				: Array.isArray(m.content)
					? m.content.map((c) => c.text || "").join("\n")
					: "";

		const msg = { role, content };

		// CRITICAL: the assistant's tool_calls must be carried through. A tool
		// result is meaningless without the call it answers — Ollama pairs them
		// by matching the call's function name. Dropping them makes the model
		// blind to what its tools returned, and it loops on the same search
		// forever. This was measured: 196 messages of assistant/tool pairs with
		// no tool_calls, and the model re-ran the same websearch 20 times.
		//
		// ALSO CRITICAL: Ollama's native API wants `arguments` as a JSON
		// OBJECT, not a string. OpenAI's wire format uses a string. Passing the
		// string through makes Ollama reject the whole request with
		// "Value looks like object, but can't find closing '}' symbol", and the
		// model never sees the tool result.
		if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
			msg.tool_calls = m.tool_calls.map((tc) => {
				let args = tc.function?.arguments;
				if (typeof args === "string") {
					try {
						args = JSON.parse(args);
					} catch {
						args = {};
					}
				}
				return {
					function: {
						name: tc.function?.name || "",
						arguments: args && typeof args === "object" ? args : {},
					},
				};
			});
			// Ollama wants an empty content string alongside tool_calls.
			msg.content = content || "";
		}

		// A tool result carries the call's name so Ollama can pair it.
		if (role === "tool" && m.tool_call_id) {
			msg.tool_name = toolNamesById.get(m.tool_call_id) || m.name || m.tool_name || "";
		}

		messages.push(msg);
	}

	const options = { ...(body.options || {}), num_ctx: CTX };
	// Ollama's native endpoint takes sampling params at the top level.
	for (const k of ["temperature", "top_p", "top_k", "seed", "stop", "num_predict"]) {
		if (body[k] !== undefined) options[k] = body[k];
	}
	// Ollama takes stop as an array; a bare string works on some versions only.
	if (typeof options.stop === "string") options.stop = [options.stop];
	// OpenAI clients send max_tokens (or max_completion_tokens), not num_predict.
	// Without this mapping models.json's maxOutputTokens never reaches Ollama and
	// a truncated answer is indistinguishable from a finished one.
	if (options.num_predict === undefined) {
		const max = body.max_tokens ?? body.max_completion_tokens;
		if (typeof max === "number" && max > 0) options.num_predict = max;
	}

	const native = {
		model: body.model,
		messages,
		stream: Boolean(body.stream),
		options,
	};
	// `think` is an Ollama-native extension that the /v1 endpoint honours but
	// the native endpoint takes at the TOP level, not inside options. Without
	// it, gemma4 emits "thinking" chunks, which the client then has to parse
	// as reasoning — and the harness's think-control sets think:false
	// precisely to stop that. Dropping it silently re-enabled thinking.
	if (body.think !== undefined) native.think = body.think;
	if (body.tools) native.tools = body.tools;
	if (body.tool_choice) native.tool_choice = body.tool_choice;
	// Forward keep_alive when the client sets it; otherwise Ollama unloads the
	// model after its default 5 minutes and the next turn pays a cold load.
	if (body.keep_alive !== undefined) native.keep_alive = body.keep_alive;
	return native;
}

/** Convert Ollama's native response back into the OpenAI shape Pi expects. */
function toOpenAI(native, model) {
	const content = native.message?.content ?? "";
	const toolCalls = (native.message?.tool_calls || []).map((tc) => ({
		id: tc.id || `call_${++toolCallSeq}`,
		type: "function",
		function: {
			name: tc.function?.name || "",
			// Ollama returns arguments as an object; the OpenAI wire format
			// expects a JSON string. Serialise it here.
			arguments:
				typeof tc.function?.arguments === "string"
					? tc.function.arguments
					: JSON.stringify(tc.function?.arguments || {}),
		},
	}));

	const message = { role: "assistant", content: toolCalls.length ? null : content };
	if (toolCalls.length) message.tool_calls = toolCalls;

	return {
		id: `chatcmpl-${native.created_at || Date.now()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: model || native.model,
		choices: [
			{
				index: 0,
				message,
				// Ollama reports "stop" even when it called tools. The client
				// closes the turn on "stop" and never runs the tool, so tool usage
				// must win. A truncated answer reports "length", not "stop".
				finish_reason: toolCalls.length
					? "tool_calls"
					: native.done_reason === "length"
						? "length"
						: "stop",
			},
		],
		usage: {
			prompt_tokens: native.prompt_eval_count || 0,
			completion_tokens: native.eval_count || 0,
			total_tokens: (native.prompt_eval_count || 0) + (native.eval_count || 0),
		},
	};
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
	const isChat = req.method === "POST" && /\/v1\/chat\/completions/.test(url.pathname);

	// If the client goes away, cancel the upstream request. On a single-card box
	// an abandoned generation otherwise keeps the GPU busy for nobody, and the
	// next request queues behind it — which looks like a hang after a cancel.
	const upstreamAbort = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) upstreamAbort.abort();
	});

	if (!isChat) {
		// Pass everything else straight through. This branch used to have no
		// try/catch, so a /v1/models probe while Ollama was down was an unhandled
		// rejection — and Node 22 exits on those.
		try {
			const body = await readBody(req);
			const upstream = await fetch(TARGET + req.url, {
				method: req.method,
				headers: { "content-type": "application/json" },
				body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
				signal: upstreamAbort.signal,
			});
			const text = await upstream.text();
			res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
			res.end(text);
		} catch (err) {
			if (res.headersSent) {
				res.end();
				return;
			}
			res.writeHead(502, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					error: { message: String(err && err.message ? err.message : err), type: "shim_error" },
				}),
			);
		}
		return;
	}

	try {
		const raw = await readBody(req);
		const body = JSON.parse(raw || "{}");
		const native = toNative(body);

		const upstream = await fetch(`${TARGET}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(native),
			signal: upstreamAbort.signal,
		});

		if (!body.stream) {
			let nativeJson = await upstream.json();
			if (nativeJson.error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: nativeJson.error }));
				return;
			}
			for (let i = 0; i < EMPTY_RETRIES && !hasAssistantOutput(nativeJson); i++) {
				const retried = await postChat(withNudge(native), upstreamAbort.signal);
				nativeJson = await retried.json();
				if (nativeJson.error) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: nativeJson.error }));
					return;
				}
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(toOpenAI(nativeJson, body.model)));
			return;
		}

		// Streaming path. The client requires SSE chunks that carry a
		// finish_reason, otherwise it errors with "Stream ended without
		// finish_reason". Ollama's native endpoint streams NDJSON, so each
		// line is converted to an OpenAI-style SSE chunk and the last one
		// carries the finish_reason.
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		const id = `chatcmpl-${Date.now()}`;
		const created = Math.floor(Date.now() / 1000);
		// Buffer one completion before emitting: an empty answer is only visible
		// after the done event, and SSE cannot be taken back. Chunks here are tens
		// of tokens, so the buffering cost is not measurable.
		const sendChunk = (state, delta, finishReason) => {
			const payload = {
				id,
				object: "chat.completion.chunk",
				created,
				model: body.model,
				choices: [
					{
						index: 0,
						delta,
						finish_reason: finishReason ?? null,
					},
				],
			};
			state.outbox.push(`data: ${JSON.stringify(payload)}\n\n`);
		};

		// A stream index that restarts merges tool calls that arrive in separate
		// events, so it lives in the state reset for each retry attempt.
		const newState = () => ({
			usage: null,
			sawToolCall: false,
			sawContent: false,
			doneReason: null,
			streamToolIndex: 0,
			errored: null,
			outbox: [],
		});

		// Returns true when the upstream sent an error and collection should stop.
		const handleEvent = (evt, state) => {
			if (evt.error) {
				state.errored = evt.error;
				return true;
			}
			if (evt.message?.content) {
				state.sawContent = true;
				sendChunk(state, { content: evt.message.content }, null);
			}
			// Pass reasoning through in the field the client reads. The harness
			// sets think:false, so this should not fire, but if thinking is ever
			// enabled the reasoning must not be silently dropped or the answer
			// text will not match. Reasoning alone does NOT count as output: the
			// client is configured with reasoning:false and would show nothing.
			if (evt.message?.thinking) {
				sendChunk(state, { reasoning_content: evt.message.thinking }, null);
			}
			if (evt.message?.tool_calls?.length) {
				state.sawToolCall = true;
				const toolCalls = evt.message.tool_calls.map((tc) => ({
					id: tc.id || `call_${++toolCallSeq}`,
					type: "function",
					// The client keys streaming tool-call blocks by `index`.
					// Without it, each chunk is treated as a separate call and the
					// arguments never assemble.
					index: state.streamToolIndex++,
					function: {
						name: tc.function?.name || "",
						arguments:
							typeof tc.function?.arguments === "string"
								? tc.function.arguments
								: JSON.stringify(tc.function?.arguments || {}),
					},
				}));
				sendChunk(state, { tool_calls: toolCalls }, null);
			}
			if (evt.done) {
				state.usage = {
					prompt_tokens: evt.prompt_eval_count || 0,
					completion_tokens: evt.eval_count || 0,
				};
				state.doneReason = evt.done_reason ?? null;
			}
			return false;
		};

		const collect = async (response, state) => {
			const decoder = new TextDecoder();
			let buffer = "";
			const reader = response.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					let evt;
					try {
						evt = JSON.parse(trimmed);
					} catch {
						continue;
					}
					if (handleEvent(evt, state)) return;
				}
			}
			// A final NDJSON line without a trailing newline is still an event.
			const tail = buffer.trim();
			if (tail) {
				try {
					handleEvent(JSON.parse(tail), state);
				} catch {
					// A partial trailing fragment is not a usable event.
				}
			}
		};

		let state = newState();
		await collect(upstream, state);
		for (let i = 0; i < EMPTY_RETRIES && !state.sawToolCall && !state.sawContent && !state.errored; i++) {
			const retried = await postChat(withNudge(native), upstreamAbort.signal);
			state = newState();
			await collect(retried, state);
		}

		if (state.errored) {
			res.write(`data: ${JSON.stringify({ error: state.errored })}\n\n`);
			res.end();
			return;
		}
		for (const chunk of state.outbox) res.write(chunk);

		// Final chunk carries the finish_reason and the usage, which the client
		// requires. Tool calls must report "tool_calls" (with "stop" the client
		// closes the turn and never runs the tool); a cut-off answer must report
		// "length" so truncation is visible instead of looking complete.
		const finalPayload = {
			id,
			object: "chat.completion.chunk",
			created,
			model: body.model,
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: state.sawToolCall
						? "tool_calls"
						: state.doneReason === "length"
							? "length"
							: "stop",
				},
			],
			usage: state.usage
				? {
						prompt_tokens: state.usage.prompt_tokens,
						completion_tokens: state.usage.completion_tokens,
						total_tokens: state.usage.prompt_tokens + state.usage.completion_tokens,
					}
				: undefined,
		};
		res.write(`data: ${JSON.stringify(finalPayload)}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	} catch (err) {
		// Once the SSE stream has started, writeHead throws ERR_HTTP_HEADERS_SENT —
		// inside the catch, which is another unhandled rejection. Just close.
		if (res.headersSent) {
			res.end();
			return;
		}
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: String(err && err.message ? err.message : err), type: "shim_error" } }));
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.error(`ollama-v1-shim listening on 127.0.0.1:${PORT} -> ${TARGET} (num_ctx=${CTX})`);
});

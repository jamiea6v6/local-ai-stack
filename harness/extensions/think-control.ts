/**
 * think-control — set Ollama's per-request `think` field.
 *
 * Why this exists: gemma4:e4b-it-qat reports `thinking: null` from /api/show and its chat
 * template contains no {thinking} block, so nothing tells it not to think. Pi's
 * `--thinking off` and a `reasoning: false` entry in models.json never reach the wire —
 * `reasoning` describes whether the model *can* think, it does not send an instruction.
 * Measured: `think:false` cut a 164-token response to 21 tokens and 5.6s to 1.0s.
 *
 * Per-request matters. Thinking is worth it when a task genuinely needs deliberation and
 * the budget is large enough to finish; it is a liability when the model reasons its way
 * past the point of acting, which is what 0/4 code-write runs looked like (10,517 thinking
 * chars against a 258-char trivial write). Rather than guess which case applies, this
 * exposes a toggle: `/think off` for execution work, `/think on` for open problems.
 *
 * Hooks `before_provider_request`, which receives the raw payload. That is the reliable
 * route — `samplingParams` in models.json is scoped to OpenAI-compatible fields, and `think`
 * is an Ollama-native extension to /v1, so its pass-through is unverified.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "off" | "on" | "auto";

export default function (pi: ExtensionAPI) {
	// Default to off: on a 6GB card the observed failure mode is reasoning that never
	// reaches the action, not insufficient deliberation.
	let mode: Mode = "off";

	pi.registerCommand("think", {
		description: "Set Ollama thinking for this session: /think off | on | auto",
		handler: async (arg, ctx) => {
			const v = (arg ?? "").trim().toLowerCase();
			if (v !== "off" && v !== "on" && v !== "auto") {
				ctx.ui.notify(
					`thinking is "${mode}". Usage: /think off | /think on | /think auto`,
					"warning",
				);
				return;
			}
			mode = v;
			ctx.ui.notify(
				v === "auto"
					? "thinking: auto (server default)"
					: `thinking: ${v} (forced on every request)`,
				"info",
			);
		},
	});

	pi.on("before_provider_request", (event) => {
		if (mode === "auto") return;

		const payload = event.payload as Record<string, unknown> | null;
		if (!payload || typeof payload !== "object") return;

		// Only touch Ollama traffic. A cloud provider would reject an unknown field.
		const isOllama =
		payload.model === "gpt-oss" ||
		typeof payload.model === "string" && /qwen|gemma|llama|mistral|phi|deepseek|granite|nemotron|olmo|smollm|devstral|gpt-oss/i.test(
				payload.model as string,
			);
		if (!isOllama) return;

		(payload as Record<string, unknown>).think = mode === "on";
	});
}
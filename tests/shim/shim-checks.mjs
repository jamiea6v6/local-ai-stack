// Shim checks — empty-final-answer retry, driven against a fake upstream.
// run-checks.sh picks a node >= 22. No Ollama, GPU, or Pi session is needed.

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIM = join(REPO, "tools", "ollama-v1-shim.mjs");
const NUDGE = "Reply now with your final answer.";

let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
  if (!cond) fails++;
};

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

const done = (extra = {}) => ({
  model: "fake",
  message: { role: "assistant", content: "" },
  done: true,
  done_reason: "stop",
  eval_count: 12,
  ...extra,
});
const chunk = (message) => ({ model: "fake", message, done: false });
const emptyDone = () => done();
const contentChunk = (text) => chunk({ role: "assistant", content: text });
const contentDone = (text) => done({ message: { role: "assistant", content: text }, eval_count: 20 });
const toolChunk = () =>
  chunk({
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name: "pincheck", arguments: { path: "." } } }],
  });
const toolDone = () =>
  done({
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "pincheck", arguments: { path: "." } } }],
    },
    eval_count: 20,
  });
const thinkingChunk = () => chunk({ role: "assistant", content: "", thinking: "thinking only" });

function makeUpstream(plan) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (!req.url.includes("/api/chat")) {
      res.setHeader("content-type", "application/json");
      res.end('{"data":[]}');
      return;
    }
    const body = JSON.parse(raw || "{}");
    calls.push(body);
    const step = plan(calls.length - 1, body);
    if (body.stream) {
      res.setHeader("content-type", "application/x-ndjson");
      res.end((step.events || []).map((e) => JSON.stringify(e)).join("\n") + "\n");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(step.json || done()));
    }
  });
  return { server, calls };
}

async function withShim(plan, fn) {
  const upstreamPort = await freePort();
  const shimPort = await freePort();
  const { server, calls } = makeUpstream(plan);
  await new Promise((r) => server.listen(upstreamPort, "127.0.0.1", r));
  let stderr = "";
  const child = spawn(process.execPath, [SHIM], {
    env: {
      ...process.env,
      OLLAMA_SHIM_PORT: String(shimPort),
      OLLAMA_SHIM_TARGET: `http://127.0.0.1:${upstreamPort}`,
      OLLAMA_SHIM_CTX: "4096",
      OLLAMA_SHIM_EMPTY_RETRIES: "2",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (b) => (stderr += b.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${shimPort}/v1/models`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    await fn({ shimPort, calls, stderr });
  } finally {
    child.kill();
    await new Promise((r) => server.close(r));
  }
}

const chat = (port, extra) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fake-model",
      messages: [{ role: "user", content: "do the thing" }],
      ...extra,
    }),
  });

// 1. Streaming: an empty first answer must be retried and the retry emitted.
await withShim(
  (i) => (i === 0 ? { events: [emptyDone()] } : { events: [toolChunk(), toolDone()] }),
  async ({ shimPort, calls, stderr }) => {
    const r = await chat(shimPort, { stream: true });
    const text = await r.text();
    check("shim: empty-first retried", calls.length === 2, `calls=${calls.length} stderr=${stderr}`);
    check(
      "shim: nudge appended on retry",
      calls[1]?.messages?.at(-1)?.content === NUDGE,
      JSON.stringify(calls[1]?.messages?.at(-1)),
    );
    check("shim: retry emits tool_calls", /"tool_calls"/.test(text) && /"finish_reason":"tool_calls"/.test(text), text.slice(0, 300));
    check("shim: SSE closes cleanly", /data: \[DONE\]/.test(text));
  },
);

// 2. Streaming: a normal answer must NOT be retried or altered.
await withShim(() => ({ events: [contentChunk("PINS: PASS"), contentDone("PINS: PASS")] }), async ({ shimPort, calls }) => {
  const text = await (await chat(shimPort, { stream: true })).text();
  check("shim: content-first not retried", calls.length === 1, `calls=${calls.length}`);
  check("shim: content preserved", /PINS: PASS/.test(text) && !/finish_reason":"tool_calls/.test(text));
});

// 3. Non-streaming path gets the same retry.
await withShim(
  (i) => (i === 0 ? { json: emptyDone() } : { json: toolDone() }),
  async ({ shimPort, calls }) => {
    const r = await chat(shimPort, { stream: false });
    const out = await r.json();
    check("shim: non-stream empty retried", calls.length === 2, `calls=${calls.length}`);
    check("shim: non-stream tool_calls returned", out.choices[0].finish_reason === "tool_calls", JSON.stringify(out.choices[0]));
    check("shim: non-stream nudge appended", calls[1]?.messages?.at(-1)?.content === NUDGE);
  },
);

// 4. Always empty: bounded by OLLAMA_SHIM_EMPTY_RETRIES (2), no hang.
await withShim(() => ({ events: [emptyDone()], json: emptyDone() }), async ({ shimPort, calls }) => {
  const text = await (await chat(shimPort, { stream: true })).text();
  check("shim: retry count bounded", calls.length === 3, `calls=${calls.length}`);
  check("shim: exhausted retry still closes", /data: \[DONE\]/.test(text) && /"finish_reason":"stop"/.test(text));
});

// 5. Reasoning-only output is empty to a reasoning:false client, so retry.
await withShim(
  (i) => (i === 0 ? { events: [thinkingChunk(), emptyDone()] } : { events: [contentChunk("ok"), contentDone("ok")] }),
  async ({ shimPort, calls }) => {
    const text = await (await chat(shimPort, { stream: true })).text();
    check("shim: reasoning-only retried", calls.length === 2, `calls=${calls.length}`);
    check("shim: reasoning retry yields content", /"content":"ok"/.test(text));
  },
);

// 6. Truncated-but-present content is not an empty answer; finish_reason stays length.
await withShim(
  () => ({ events: [contentChunk("partial"), done({ message: { role: "assistant", content: "partial" }, done_reason: "length" })] }),
  async ({ shimPort, calls }) => {
    const text = await (await chat(shimPort, { stream: true })).text();
    check("shim: length finish not retried", calls.length === 1, `calls=${calls.length}`);
    check("shim: length finish preserved", /"finish_reason":"length"/.test(text));
  },
);

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);

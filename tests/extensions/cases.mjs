// Extension checks — driven directly, no Pi session.
// run-checks.sh copies this next to the extensions and provides stub packages.

import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

const root = process.cwd();
const proj = join(root, "proj");
await rm(proj, { recursive: true, force: true });
await mkdir(join(proj, "devices"), { recursive: true });
await writeFile(
  join(proj, "devices", "wemos-d1.txt"),
  "BOARD: Wemos D1 R1\nLOGIC LEVEL: 3.3V\nFQBN: esp8266:esp8266:d1\n",
);
await writeFile(
  join(proj, "Blink.ino"),
  "void setup(){ pinMode(LED_BUILTIN, OUTPUT); }\n" +
    "void loop(){ digitalWrite(LED_BUILTIN, LOW); delay(500); digitalWrite(LED_BUILTIN, HIGH); delay(500); }\n",
);

function load(file) {
  const tools = {};
  return import(file).then((m) => {
    m.default({ registerTool: (t) => (tools[t.name] = t) });
    return tools;
  });
}
const [{ compile }, { verify }, { webfetch }, { pincheck }] = await Promise.all([
  load(join(root, "compile.ts")),
  load(join(root, "verify.ts")),
  load(join(root, "webfetch.ts")),
  load(join(root, "pins.ts")),
]);
let fails = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
  if (!cond) fails++;
};

const cliCandidates = [
  process.env.ARDUINO_CLI,
  ...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "arduino-cli")),
  join(process.env.HOME ?? "", ".local", "bin", "arduino-cli"),
  join(process.env.HOME ?? "", "bin", "arduino-cli"),
].filter(Boolean);
if (cliCandidates.some((p) => existsSync(p))) {
  const c1 = await compile.execute("1", { path: proj }, undefined);
  check("compile: stray .ino moved", /Blink\.ino -> .*Blink\/Blink\.ino/.test(c1.details.moved ?? ""), JSON.stringify(c1.details.moved));
  check("compile: PASS", c1.details.passed === true, c1.content[0].text.slice(0, 300));
  check("compile: layout on disk", await access(join(proj, "Blink", "Blink.ino")).then(() => true, () => false));
  check("compile: output has verdict", /COMPILE: PASS/.test(c1.content[0].text));
  check("compile: non-GPIO sheet skips pins", /PINS: SKIP/.test(c1.content[0].text));

  const c3 = await compile.execute("3", { path: proj, fqbn: "esp8266:esp8266:not-a-board" }, undefined);
  check("compile: bad FQBN FAIL", c3.details.passed === false && /NEXT:/.test(c3.content[0].text), c3.content[0].text.slice(0, 300));
} else {
  console.log("SKIP  compile checks (arduino-cli not installed)");
}

const proj2 = join(root, "proj2");
await rm(proj2, { recursive: true, force: true });
await mkdir(join(proj2, "Sketch"), { recursive: true });
await writeFile(join(proj2, "Sketch", "Sketch.ino"), "void setup(){}\nvoid loop(){}\n");
let missing = "";
try {
  await compile.execute("2", { path: proj2 }, undefined);
} catch (e) {
  missing = String(e.message ?? e);
}
check("compile: missing FQBN errors", /No FQBN/.test(missing), missing);

await writeFile(
  join(proj, "gates.json"),
  JSON.stringify({
    gates: [
      { name: "ok", cmd: ["sh", "-c", "echo fine"] },
      { name: "bad", cmd: ["sh", "-c", "echo boom; exit 3"] },
    ],
  }),
);
const v1 = await verify.execute("4", { project: proj }, undefined);
check("verify: project FAIL count", v1.details.passed === false && /1\/2 gates/.test(v1.content[0].text), v1.content[0].text.slice(0, 300));
check("verify: failing gate output shown", /boom/.test(v1.content[0].text));

await writeFile(
  join(proj, "gates.json"),
  JSON.stringify({ gates: [{ name: "ok", cmd: ["sh", "-c", "echo fine"] }] }),
);
const v2 = await verify.execute("5", { project: proj }, undefined);
check("verify: project PASS", v2.details.passed === true && /PASS \(1\/1 gates\)/.test(v2.content[0].text));

await writeFile(join(root, "spec.py"), "import sys\nprint('PY=' + sys.executable)\n");
const v3 = await verify.execute("6", { spec: join(root, "spec.py"), python: "/usr/bin/python3" }, undefined);
check("verify: python= honoured", v3.details.passed === true && /PY=\/usr\/bin\/python3/.test(v3.content[0].text), v3.content[0].text.slice(0, 200));
const v4 = await verify.execute("7", { spec: join(root, "spec.py"), python: "/bin/false" }, undefined);
check("verify: python= failure reported", v4.details.passed === false);

const srv = http.createServer((req, res) => {
  if (req.url === "/x.pdf") {
    res.setHeader("content-type", "application/pdf");
    res.end("%PDF-1.4\n%binary\n");
  } else {
    res.setHeader("content-type", "text/plain");
    res.end("hello world");
  }
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;
let pdfErr = "";
try {
  await webfetch.execute("8", { url: `http://127.0.0.1:${port}/x.pdf` }, undefined);
} catch (e) {
  pdfErr = String(e.message ?? e);
}
check("webfetch: PDF refused", /Refusing PDF/.test(pdfErr), pdfErr);
const w2 = await webfetch.execute("9", { url: `http://127.0.0.1:${port}/plain` }, undefined);
check("webfetch: text still works", /hello world/.test(w2.content[0].text));
srv.close();

const pinsProj = join(root, "pinsProj");
await rm(pinsProj, { recursive: true, force: true });
await mkdir(join(pinsProj, "devices"), { recursive: true });
await mkdir(join(pinsProj, "firmware", "lcd"), { recursive: true });
await writeFile(
  join(pinsProj, "devices", "wemos-d1.txt"),
  [
    "BOARD: Wemos D1 R1",
    "FQBN: esp8266:esp8266:d1",
    "RESERVED: GPIO6-11 (SPI flash)",
    "PINS (board label -> GPIO; source: test)",
    "  D8 -> GPIO0",
    "  D9 -> GPIO2",
    "  D4 -> GPIO4",
    "  D5 -> GPIO14",
    "  D6 -> GPIO12",
    "  D7 -> GPIO13",
    "  A0 -> GPIO17",
    "  LED_BUILTIN -> GPIO2",
    "",
  ].join("\n"),
);
const sketch = join(pinsProj, "firmware", "lcd", "lcd.ino");
const checkPins = async (src) => {
  await writeFile(sketch, src);
  return pincheck.execute("p", { path: pinsProj }, undefined);
};

let p1 = await checkPins("LiquidCrystal lcd(8, 9, 4, 5, 6, 7);\nvoid setup(){} void loop(){}\n");
check("pins: manual Uno numbers FAIL", p1.details.verdict === "FAIL", p1.content[0].text);
check("pins: flash GPIO named", /GPIO8|GPIO9|reserved/.test(p1.content[0].text), p1.content[0].text.slice(0, 300));

p1 = await checkPins("LiquidCrystal lcd(D8, D9, D4, D5, D6, D7);\nvoid setup(){} void loop(){}\n");
check("pins: sheet labels PASS", p1.details.verdict === "PASS", p1.content[0].text);

p1 = await checkPins("LiquidCrystal lcd(0, 2, 4, 14, 12, 13);\nvoid setup(){} void loop(){}\n");
check("pins: sheet GPIOs PASS", p1.details.verdict === "PASS", p1.content[0].text);

p1 = await checkPins("void setup(){ pinMode(6, OUTPUT); } void loop(){}\n");
check("pins: reserved GPIO6 FAIL", p1.details.verdict === "FAIL" && /reserved/.test(p1.content[0].text), p1.content[0].text);

p1 = await checkPins("const int ledPin = 2;\nvoid setup(){ pinMode(ledPin, OUTPUT); } void loop(){}\n");
check("pins: const resolves", p1.details.verdict === "PASS", p1.content[0].text);

p1 = await checkPins("void setup(){ pinMode(ledPin, OUTPUT); } void loop(){}\n");
check("pins: unknown identifier FAIL", p1.details.verdict === "FAIL" && /cannot resolve/.test(p1.content[0].text), p1.content[0].text);

p1 = await checkPins("void setup(){ analogRead(A0); } void loop(){}\n");
check("pins: analogue label PASS", p1.details.verdict === "PASS", p1.content[0].text);

p1 = await checkPins("void setup(){ Serial.begin(115200); } void loop(){}\n");
check("pins: no pin use SKIP", p1.details.verdict === "SKIP", p1.content[0].text);

const plain = join(root, "plainproj");
await rm(plain, { recursive: true, force: true });
await mkdir(plain, { recursive: true });
await writeFile(join(plain, "app.py"), "print('no gpio here')\n");
const p2 = await pincheck.execute("q", { path: plain }, undefined);
check("pins: non-GPIO project SKIP", p2.details.verdict === "SKIP", p2.content[0].text);

const sketchOnly = join(root, "sketchonly");
await rm(sketchOnly, { recursive: true, force: true });
await mkdir(sketchOnly, { recursive: true });
await writeFile(join(sketchOnly, "x.ino"), "void setup(){ pinMode(13, OUTPUT); } void loop(){}\n");
const p3 = await pincheck.execute("r", { path: sketchOnly }, undefined);
check("pins: no board sheet SKIP", p3.details.verdict === "SKIP", p3.content[0].text);

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);

"use strict";

// Unit tests for location mapping, and a stdio test with a fake gopls.
// Run with: node --test tests/

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { pathToFileURL } = require("node:url");

const PROXY = path.join(__dirname, "..", "src", "gopls-templ-proxy.js");
const { findDeclaration, frameReader, mapLocation, rewriteResult } = require(PROXY);

const TEMPL = `package ui

// Hello text in a comment.
templ Hello(name string) {
	<div>
		Footer
		{ name }
	</div>
}

templ (p Page) Footer() {
	<p>é</p>
}

templ List[T any](items []T) {
	<ul></ul>
}

css primary() {
	color: red;
}

script greet() {
	alert("x");
}

func Helper() string {
	return "x"
}

func (p Page) Method() string {
	return ""
}

type Page struct {
	Title string // Heading text.
}

var (
	First, Second = 1, 2
)

const Single = 1
`;

const GENERATED = `package ui

func Hello(name string) templ.Component {
	return nil
}

func (p Page) Footer() templ.Component {
	return nil
}

func Unknown() {}
`;

let directory;
let generatedPath;
let generatedUri;
let templUri;

function lineAndColumn(text, needle) {
  const offset = text.indexOf(needle);
  const before = text.slice(0, offset);
  return {
    line: before.split("\n").length - 1,
    character: offset - (before.lastIndexOf("\n") + 1),
  };
}

function rangeOf(text, needle) {
  const start = lineAndColumn(text, needle);
  return { start, end: { line: start.line, character: start.character + needle.length } };
}

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "gopls templ proxy "));
  generatedPath = path.join(directory, "hello_templ.go");
  fs.writeFileSync(generatedPath, GENERATED);
  fs.writeFileSync(path.join(directory, "hello.templ"), TEMPL);
  generatedUri = pathToFileURL(generatedPath).href;
  templUri = pathToFileURL(path.join(directory, "hello.templ")).href;
});

after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("finds top-level declarations of each kind", () => {
  for (const [name, text] of [
    ["Hello", "templ Hello("],
    ["Footer", "templ (p Page) Footer("],
    ["List", "templ List["],
    ["primary", "css primary("],
    ["greet", "script greet("],
    ["Helper", "func Helper("],
    ["Method", "func (p Page) Method("],
    ["Page", "type Page "],
    ["Single", "const Single "],
  ]) {
    assert.equal(findDeclaration(TEMPL, name), TEMPL.indexOf(text) + text.indexOf(name), name);
  }
});

test("finds members of declaration blocks", () => {
  assert.equal(findDeclaration(TEMPL, "Title"), TEMPL.indexOf("Title string"));
  assert.equal(findDeclaration(TEMPL, "Second"), TEMPL.indexOf("Second = 1"));
});

test("does not match markup, comments, or name prefixes", () => {
  assert.equal(findDeclaration("templ A() {\n\tFooter\n}\n", "Footer"), -1);
  assert.equal(findDeclaration("templ HelloWorld() {\n}\n", "Hello"), -1);
  assert.equal(findDeclaration("type T struct {\n\tA int // Heading\n}\n", "Heading"), -1);
});

test("maps a component location to the name in the templ file", () => {
  const mapped = mapLocation(generatedUri, rangeOf(GENERATED, "Hello"));
  const start = lineAndColumn(TEMPL, "Hello(name");
  assert.deepEqual(mapped, {
    uri: templUri,
    range: { start, end: { line: start.line, character: start.character + "Hello".length } },
  });
});

test("does not map ordinary Go files, unknown names, or missing sources", () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  assert.equal(mapLocation("file:///tmp/main.go", range), null);
  assert.equal(mapLocation(generatedUri, rangeOf(GENERATED, "Unknown")), null);
  assert.equal(mapLocation("file:///nonexistent/x_templ.go", range), null);
  assert.equal(mapLocation("untitled:x_templ.go", range), null);
});

test("rewrites each result shape and keeps unrelated entries", () => {
  const range = rangeOf(GENERATED, "Footer");
  const other = { uri: "file:///tmp/main.go", range };

  assert.equal(rewriteResult(null), null);
  assert.equal(rewriteResult({ uri: generatedUri, range }).uri, templUri);

  const list = rewriteResult([{ uri: generatedUri, range }, other]);
  assert.equal(list[0].uri, templUri);
  assert.deepEqual(list[1], other);

  const originSelectionRange = range;
  const [link] = rewriteResult([
    { originSelectionRange, targetUri: generatedUri, targetRange: range, targetSelectionRange: range },
  ]);
  assert.equal(link.targetUri, templUri);
  assert.equal(link.originSelectionRange, originSelectionRange);
  assert.deepEqual(link.targetRange, link.targetSelectionRange);
});

test("frame reader handles split and joined frames", () => {
  const bodies = [];
  const read = frameReader((raw, body) => bodies.push(body.toString()));
  const frameOf = (text) => `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`;
  const stream = Buffer.from(frameOf('{"a":"é"}') + frameOf('{"b":2}'));
  read(stream.subarray(0, 7));
  read(stream.subarray(7, 22));
  read(stream.subarray(22));
  assert.deepEqual(bodies, ['{"a":"é"}', '{"b":2}']);
});

test("proxy rewrites only navigation responses from gopls", async () => {
  const fakeGopls = path.join(directory, "fake-gopls.js");
  fs.writeFileSync(
    fakeGopls,
    `#!/usr/bin/env node
const { frameReader } = require(${JSON.stringify(PROXY)});
const send = (m) => {
  const b = Buffer.from(JSON.stringify(m));
  process.stdout.write("Content-Length: " + b.length + "\\r\\n\\r\\n");
  process.stdout.write(b);
};
const location = { uri: ${JSON.stringify(generatedUri)}, range: ${JSON.stringify(rangeOf(GENERATED, "Hello"))} };
process.stdin.on("data", frameReader((raw, body) => {
  const m = JSON.parse(body);
  if (m.method === "exit") process.exit(0);
  if (m.id !== undefined) {
    send({ id: 900, method: "workspace/configuration", params: {} });
    send({ jsonrpc: "2.0", id: m.id, result: [location] });
  }
}));
`,
    { mode: 0o755 },
  );

  const proxy = spawn(process.execPath, [PROXY], {
    env: { ...process.env, TEMPL_GOPLS_PATH: fakeGopls },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const responses = new Map();
  const waiters = new Map();
  proxy.stdout.on(
    "data",
    frameReader((raw, body) => {
      const message = JSON.parse(body);
      if (message.method) return;
      responses.set(message.id, message);
      waiters.get(message.id)?.();
    }),
  );
  const request = (id, method) =>
    new Promise((resolve) => {
      waiters.set(id, () => resolve(responses.get(id)));
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
      proxy.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });

  const definition = await request(1, "textDocument/definition");
  assert.equal(definition.result[0].uri, templUri);

  const references = await request(2, "textDocument/references");
  assert.equal(references.result[0].uri, generatedUri);

  const closed = new Promise((resolve) => proxy.on("exit", resolve));
  const exit = JSON.stringify({ jsonrpc: "2.0", method: "exit" });
  proxy.stdin.write(`Content-Length: ${exit.length}\r\n\r\n${exit}`);
  assert.equal(await closed, 0);
});

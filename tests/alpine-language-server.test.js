"use strict";

// Runs the server over stdio, as Zed does. Run with: node --test tests/

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { pathToFileURL } = require("node:url");

const SERVER = path.join(__dirname, "..", "src", "alpine-language-server.js");

const SCRIPT = `declare const Alpine: any;
const brace = /[{]/; // regex and "strings" with { must not break member scanning
document.addEventListener("alpine:init", () => {
  Alpine.data("uploader", (url: string, opts: { a: string } = { a: "}" }) => ({
    rows: [] as Row[],
    sizes: new Map<string, number>(),
    label: \`x \${url}\`,
    pick(e: Event) {
      const nested = { notAMember: 1 };
      return nested;
    },
    async add(file: File) {},
    get count() {
      return 0;
    },
  }));

  Alpine.data("block", function () {
    const hidden = 1;
    return {
      open() {},
    };
  });

  Alpine.data("outer", () => ({
    shared() {},
  }));
});
`;

const TEMPL = `package sample

// <div x-data="commentOnly">
templ Sample(id string, kept bool) {
	<div
		x-data={ "uploader('" + id + "')" }
		id={ id }
		x-on:change="pick"
		if kept && len(id) > 1 {
			hx-preserve="true"
			{ attrs()... }
		}
	>
		<input x-on:input="add" x-model="pick" type="file"/>
		<template x-for="row in rows" :key="row.key">
			<li :class="row.tone" @click="add(row)" x-text="count">text</li>
		</template>
		<span x-ref="pick" class="pick" hx-get="pick"></span>
	</div>
	<div x-on:click="pick"></div>
	<section x-data="outer">
		<div x-data="block">
			<button @click="open(); shared(); this.open()">go</button>
		</div>
		<p x-text="open"></p>
	</section>
	<div x-data="{ open: false }"></div>
	<div x-data="missing" @click="pick"></div>
}
`;

let root;
let server;
let nextId = 1;
const pending = new Map();
const TEMPL_URI = "file:///sample.templ";

function write(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    write({ id, method, params });
  });
}

// Requests go to definition at `needle`, optionally the nth match, plus `delta` chars.
async function goTo(needle, { nth = 0, delta = 0 } = {}) {
  let offset = -1;
  for (let n = 0; n <= nth; n++) offset = TEMPL.indexOf(needle, offset + 1);
  assert.ok(offset >= 0, `fixture has no ${needle}`);
  offset += delta;
  const before = TEMPL.slice(0, offset).split("\n");
  const position = { line: before.length - 1, character: before[before.length - 1].length };
  const reply = await request("textDocument/definition", {
    textDocument: { uri: TEMPL_URI },
    position,
  });
  assert.equal(reply.error, undefined);
  return reply.result;
}

// Converts a result to the text and path it points at.
function target(result) {
  assert.ok(Array.isArray(result), `expected locations, got ${JSON.stringify(result)}`);
  return result.map(({ uri, range }) => {
    const file = path.join(root, path.basename(new URL(uri).pathname));
    const lines = fs.readFileSync(file, "utf8").split("\n");
    return {
      file: path.basename(file),
      text: lines[range.start.line].slice(range.start.character, range.end.character),
      line: lines[range.start.line].trim(),
    };
  });
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpine-ls-")));
  fs.writeFileSync(path.join(root, "app.ts"), SCRIPT);
  // A bundle and a dependency repeat the registration. Neither may be returned.
  fs.writeFileSync(
    path.join(root, "bundle.js"),
    `${"x".repeat(3000)};Alpine.data("uploader",()=>({pick(){}}));\n`,
  );
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "dep.js"), `Alpine.data("uploader",()=>({pick(){}}));\n`);

  server = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = Buffer.alloc(0);
  server.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: (\d+)/.exec(buffer.toString("ascii", 0, headerEnd))[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.toString("utf8", headerEnd + 4, headerEnd + 4 + length));
      buffer = buffer.subarray(headerEnd + 4 + length);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const init = await request("initialize", {
    rootUri: pathToFileURL(root).href,
    capabilities: {},
  });
  assert.equal(init.result.capabilities.definitionProvider, true);
  write({ method: "initialized", params: {} });
  write({
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: TEMPL_URI, languageId: "templ", version: 1, text: TEMPL },
    },
  });
});

after(async () => {
  await request("shutdown", null);
  write({ method: "exit" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("x-data name resolves to the registration, also in a Go expression", async () => {
  const [hit, ...rest] = target(await goTo(`"uploader('`, { delta: 1 }));
  assert.deepEqual(rest, []);
  assert.equal(hit.file, "app.ts");
  assert.equal(hit.text, "uploader");
  assert.match(hit.line, /^Alpine\.data\("uploader"/);
  assert.equal(target(await goTo(`x-data="block"`, { delta: 9 }))[0].text, "block");
});

test("cursor elsewhere in a Go x-data expression returns null", async () => {
  assert.equal(await goTo(`+ id +`, { delta: 2 }), null);
});

test("member on the x-data element itself, past a Go condition with >", async () => {
  const [hit] = target(await goTo(`x-on:change="pick"`, { delta: 14 }));
  assert.equal(hit.text, "pick");
  assert.equal(hit.line, "pick(e: Event) {");
});

test("members in child elements resolve, for each member form", async () => {
  assert.equal(target(await goTo(`x-on:input="add"`, { delta: 13 }))[0].line, "async add(file: File) {},");
  assert.equal(target(await goTo(`x-for="row in rows"`, { delta: 15 }))[0].line, "rows: [] as Row[],");
  assert.equal(target(await goTo(`x-text="count"`, { delta: 9 }))[0].line, "get count() {");
  assert.equal(target(await goTo(`@click="add(row)"`, { delta: 9 }))[0].text, "add");
});

test("nested values are not members", async () => {
  assert.equal(await goTo(`:key="row.key"`, { delta: 11 }), null);
  assert.equal(await goTo(`row in rows`, { delta: 1 }), null);
  assert.equal(await goTo(`x-data="{ open`, { delta: 11 }), null);
});

test("non-Alpine attributes return null", async () => {
  assert.equal(await goTo(`x-ref="pick"`, { delta: 8 }), null);
  assert.equal(await goTo(`class="pick"`, { delta: 8 }), null);
  assert.equal(await goTo(`hx-get="pick"`, { delta: 9 }), null);
});

test("scope ends at the closing tag", async () => {
  assert.equal(await goTo(`<div x-on:click="pick"`, { delta: 18 }), null);
  assert.equal(await goTo(`x-data="missing" @click="pick"`, { delta: 26 }), null);
});

test("scopes resolve innermost first, then outward", async () => {
  assert.equal(target(await goTo(`@click="open();`, { delta: 9 }))[0].line, "open() {},");
  assert.equal(target(await goTo(`shared();`, { delta: 1 }))[0].line, "shared() {},");
  assert.equal(target(await goTo(`this.open()`, { delta: 6 }))[0].line, "open() {},");
  // Outside the inner element, only `outer` is in scope, and `outer` has no `open`.
  assert.equal(await goTo(`<p x-text="open"`, { delta: 12 }), null);
});

test("definition follows didChange and didClose", async () => {
  const uri = "file:///changed.templ";
  const definitionOfName = async () => {
    const reply = await request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 1, character: 14 },
    });
    return reply.result;
  };

  write({
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "templ", version: 1, text: `templ A() {\n\t<div x-data="missing"></div>\n}\n` },
    },
  });
  assert.equal(await definitionOfName(), null);

  write({
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: `templ A() {\n\t<div x-data="block"></div>\n}\n` }],
    },
  });
  assert.equal(target(await definitionOfName())[0].text, "block");

  write({ method: "textDocument/didClose", params: { textDocument: { uri } } });
  assert.equal(await definitionOfName(), null);
});

test("an HTML attribute named like a Go keyword is an attribute", () => {
  const { attributeContext } = require(SERVER);
  const text = `templ A() {\n\t<div x-data="foo">\n\t\t<label for="e" @click="pick">x</label>\n\t\t<p x-text="pick"></p>\n\t</div>\n}\n`;
  const onLabel = attributeContext(text, text.indexOf(`@click="pick"`) + 8);
  assert.equal(onLabel.attribute.name, "@click");
  assert.deepEqual(onLabel.scopes, ["foo"]);
  const afterLabel = attributeContext(text, text.indexOf(`x-text="pick"`) + 8);
  assert.equal(afterLabel.attribute.name, "x-text");
  assert.deepEqual(afterLabel.scopes, ["foo"]);
});

test("top-level code outside templ declarations does not open tags", () => {
  const { attributeContext } = require(SERVER);
  const component = `templ A() {\n\t<div x-data="foo"><b @click="pick"></b></div>\n}\n`;
  for (const before of [
    `script s(n int) {\n\tfor (let i=0;i<n;i++) { f(i) }\n}\n`,
    `const t = "a<b"\n`,
    `var a = 1 // the <script> tag\n`,
    `templ First() {\n\t<p>one</p>\n}\n\nconst t = "a<b"\n`,
  ]) {
    const text = before + component;
    const context = attributeContext(text, text.indexOf(`@click="pick"`) + 8);
    assert.deepEqual(context?.scopes, ["foo"], before);
  }
});

test("a repeat scan within the window reuses the result for the same roots", () => {
  const { findComponents } = require(SERVER);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alpine-scan-"));
  const script = path.join(directory, "a.js");
  fs.writeFileSync(script, `Alpine.data("first", () => ({}));\n`);
  const roots = [directory];
  try {
    assert.equal(findComponents(roots)[0].name, "first");
    fs.writeFileSync(script, `Alpine.data("second", () => ({}));\n`);
    assert.equal(findComponents(roots)[0].name, "first");
    assert.equal(findComponents([directory])[0].name, "second");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a function body factory hides its local variables", async () => {
  const { factoryObjectStart, objectMembers } = require(SERVER);
  const source = `Alpine.data("b", function () { const hidden = 1; return { open() {} }; });`;
  const start = factoryObjectStart(source, source.indexOf(`"b"`) + 3);
  assert.deepEqual(objectMembers(source, start).map((m) => m.name), ["open"]);
});

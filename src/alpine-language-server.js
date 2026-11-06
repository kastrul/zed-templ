"use strict";

// Minimal language server: go to definition from Alpine attribute values in
// templ files to the Alpine.data(...) registration in the workspace's scripts.
//
// Resolution is a text heuristic, not type analysis. Alpine links markup to
// components by runtime string, so there is nothing for a type checker to follow.
// Requests that cannot be resolved return null, so other servers still answer.
//
// Zed runs this file with its bundled Node. It must stay dependency-free.

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);
const GO_KEYWORD_LINES = new Set(["if", "else", "for", "switch", "case", "default"]);
const ALPINE_EXPRESSION_ATTRIBUTE =
  /^(x-(?!ref\b|transition\b|teleport\b|cloak\b|ignore\b)|@|:)/;
const SCRIPT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "vendor", "target", "coverage",
]);
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
// Lines longer than this are bundler output, a copy of the real source.
const MAX_SOURCE_LINE_LENGTH = 2000;
const IDENTIFIER_CHAR = /[\w$]/;
const SCAN_REUSE_MS = 2000;

let lastScan = null;

// ---------------------------------------------------------------------------
// Templ markup
// ---------------------------------------------------------------------------

function skipGoExpression(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
    } else if (c === "`") {
      i = text.indexOf("`", i + 1);
      if (i < 0) return text.length;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

function parseTag(text, start) {
  const nameMatch = /[A-Za-z][\w:.-]*/y;
  nameMatch.lastIndex = start + 1;
  const name = nameMatch.exec(text)[0];
  const attributes = [];
  let i = start + 1 + name.length;

  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c) || c === "}") {
      i++;
    } else if (c === ">") {
      return { name, attributes, selfClosing: false, end: i + 1 };
    } else if (c === "/" && text[i + 1] === ">") {
      return { name, attributes, selfClosing: true, end: i + 2 };
    } else if (c === "{") {
      i = skipGoExpression(text, i);
    } else if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      i = close < 0 ? text.length : close + 1;
    } else {
      const attributeName = /[^\s=>{}"']+/y;
      attributeName.lastIndex = i;
      const match = attributeName.exec(text);
      if (!match) {
        i++;
        continue;
      }
      i += match[0].length;
      let j = i;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] !== "=") {
        // A Go statement in the tag. With `=`, the same word is an attribute, as in `for="id"`.
        if (GO_KEYWORD_LINES.has(match[0])) {
          const lineEnd = text.indexOf("\n", i);
          i = lineEnd < 0 ? text.length : lineEnd;
        }
        continue;
      }
      j++;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] === '"' || text[j] === "'") {
        let close = text.indexOf(text[j], j + 1);
        if (close < 0) close = text.length;
        attributes.push({
          name: match[0],
          kind: "quoted",
          valueStart: j + 1,
          valueEnd: close,
        });
        i = close + 1;
      } else if (text[j] === "{") {
        const end = skipGoExpression(text, j);
        attributes.push({
          name: match[0],
          kind: "expression",
          valueStart: j + 1,
          valueEnd: end - 1,
        });
        i = end;
      } else {
        i = j;
      }
    }
  }
  return { name, attributes, selfClosing: false, end: text.length };
}

// Returns the component name in an x-data value and where the name starts.
// Handles x-data="name", x-data="name(args)" and x-data={ "name(" + arg + ")" }.
function componentReference(text, attribute) {
  const value = text.slice(attribute.valueStart, attribute.valueEnd);
  const pattern =
    attribute.kind === "quoted"
      ? /^(\s*)([A-Za-z_$][\w$]*)/
      : /^(\s*["`]\s*)([A-Za-z_$][\w$]*)/;
  const match = pattern.exec(value);
  if (!match) return null;
  return { name: match[2], start: attribute.valueStart + match[1].length };
}

// Returns the offset of the next `templ` declaration at or after `start`.
function nextTemplDeclaration(text, start) {
  const declaration = /^templ\b/gm;
  declaration.lastIndex = start;
  const match = declaration.exec(text);
  return match ? match.index : text.length;
}

// Finds the attribute value at `offset` and the Alpine components in scope,
// innermost first. Returns null when the offset is not in an attribute value.
//
// shortcut: a `}` in column 0 ends the component, as templ fmt writes it. Unformatted
// markup with such a line loses the rest of its component. Track brace depth if that occurs.
function attributeContext(text, offset) {
  const open = [];
  // Other top-level code is Go, CSS or JavaScript, where `<` does not open a tag.
  let i = nextTemplDeclaration(text, 0);

  while (i <= offset && i < text.length) {
    const atLineStart =
      text[i] === "/" && text.slice(text.lastIndexOf("\n", i - 1) + 1, i).trim() === "";
    if (text[i] === "}" && text[i - 1] === "\n") {
      i = nextTemplDeclaration(text, i);
    } else if (atLineStart && text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (atLineStart && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
    } else if (text[i] === "<" && /[A-Za-z]/.test(text[i + 1] ?? "")) {
      const tag = parseTag(text, i);
      const dataAttribute = tag.attributes.find((a) => a.name === "x-data");
      const reference = dataAttribute && componentReference(text, dataAttribute);

      if (offset < tag.end) {
        const attribute = tag.attributes.find(
          (a) => offset >= a.valueStart && offset <= a.valueEnd,
        );
        if (!attribute) return null;
        const scopes = open.map((e) => e.component).filter(Boolean).reverse();
        if (reference) scopes.unshift(reference.name);
        return { attribute, reference, scopes };
      }

      const tagName = tag.name.toLowerCase();
      if (RAW_TEXT_ELEMENTS.has(tagName) && !tag.selfClosing) {
        const close = text.toLowerCase().indexOf(`</${tagName}`, tag.end);
        i = close < 0 ? text.length : close;
        continue;
      }
      if (!tag.selfClosing && !VOID_ELEMENTS.has(tagName)) {
        open.push({ name: tagName, component: reference?.name });
      }
      i = tag.end;
    } else if (text[i] === "<" && text[i + 1] === "/" && /[A-Za-z]/.test(text[i + 2] ?? "")) {
      const end = text.indexOf(">", i);
      const name = text.slice(i + 2, end < 0 ? text.length : end).trim().toLowerCase();
      for (let k = open.length - 1; k >= 0; k--) {
        if (open[k].name === name) {
          open.length = k;
          break;
        }
      }
      i = end < 0 ? text.length : end + 1;
    } else {
      i++;
    }
  }
  return null;
}

function identifierAt(text, offset) {
  let start = offset;
  let end = offset;
  while (start > 0 && IDENTIFIER_CHAR.test(text[start - 1])) start--;
  while (end < text.length && IDENTIFIER_CHAR.test(text[end])) end++;
  return start === end ? null : { word: text.slice(start, end), start, end };
}

// ---------------------------------------------------------------------------
// Script scanning
// ---------------------------------------------------------------------------

function skipTemplateLiteral(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
    } else if (text[i] === "`") {
      return i + 1;
    } else if (text[i] === "$" && text[i + 1] === "{") {
      i = skipTemplateExpression(text, i + 1);
    } else {
      i++;
    }
  }
  return text.length;
}

function skipTemplateExpression(text, start) {
  let depth = 0;
  for (const i of codePositions(text, start)) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

// Yields the index of each character that is code, not comment or literal text.
function* codePositions(text, start) {
  let previous = "";
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") {
        i += text[i] === "\\" ? 2 : 1;
      }
      i++;
      previous = c;
    } else if (c === "`") {
      i = skipTemplateLiteral(text, i);
      previous = c;
    } else if (c === "/" && (previous === "" || "(,=:[!&|?{};".includes(previous))) {
      let inClass = false;
      i++;
      while (i < text.length && text[i] !== "\n" && (inClass || text[i] !== "/")) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        i++;
      }
      i++;
      previous = "/";
    } else {
      yield i;
      if (!/\s/.test(c)) previous = c;
      i++;
    }
  }
}

function nextCode(text, start) {
  for (const i of codePositions(text, start)) {
    if (!/\s/.test(text[i])) return i;
  }
  return -1;
}

function objectInBlock(text, blockStart) {
  let depth = 0;
  let found = -1;
  for (const i of codePositions(text, blockStart)) {
    const c = text[i];
    if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) {
      if (--depth === 0) break;
    } else if (depth === 1 && text.startsWith("return", i) && !IDENTIFIER_CHAR.test(text[i - 1])) {
      let j = nextCode(text, i + "return".length);
      if (text[j] === "(") j = nextCode(text, j + 1);
      if (text[j] === "{") found = j;
    }
  }
  return found;
}

// Finds the object literal that a component factory returns.
function factoryObjectStart(text, afterName) {
  let depth = 0;
  for (const i of codePositions(text, afterName)) {
    const c = text[i];
    if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) {
      if (depth === 0) return -1;
      depth--;
    } else if (depth === 0 && c === "=" && text[i + 1] === ">") {
      let j = nextCode(text, i + 2);
      if (text[j] === "(") {
        j = nextCode(text, j + 1);
        return text[j] === "{" ? j : -1;
      }
      return text[j] === "{" ? objectInBlock(text, j) : -1;
    } else if (depth === 0 && text.startsWith("function", i)) {
      let parens = 0;
      for (const k of codePositions(text, i)) {
        if (text[k] === "(") parens++;
        else if (text[k] === ")") parens--;
        else if (text[k] === "{" && parens === 0) return objectInBlock(text, k);
      }
      return -1;
    }
  }
  return -1;
}

// Returns the top-level property and method names of the object at `objectStart`.
function objectMembers(text, objectStart) {
  const members = [];
  let depth = 0;
  let atMemberStart = false;
  for (const i of codePositions(text, objectStart)) {
    const c = text[i];
    if (/\s/.test(c)) continue;
    if ("{([".includes(c)) {
      depth++;
      atMemberStart = depth === 1;
    } else if ("})]".includes(c)) {
      if (--depth === 0) break;
      atMemberStart = false;
    } else if (depth === 1 && c === ",") {
      atMemberStart = true;
    } else {
      if (depth === 1 && atMemberStart) {
        const pattern = /(?:(?:async|get|set)\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*(?=[(:<,}?])/y;
        pattern.lastIndex = i;
        const match = pattern.exec(text);
        if (match) {
          members.push({ name: match[1], offset: i + match[0].lastIndexOf(match[1]) });
        }
      }
      atMemberStart = false;
    }
  }
  return members;
}

function* scriptFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name)) {
        yield* scriptFiles(full);
      }
    } else if (
      entry.isFile() &&
      SCRIPT_EXTENSIONS.has(path.extname(entry.name)) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".min.js")
    ) {
      yield full;
    }
  }
}

function isBundledLine(text, offset) {
  const start = text.lastIndexOf("\n", offset) + 1;
  const end = text.indexOf("\n", offset);
  return (end < 0 ? text.length : end) - start > MAX_SOURCE_LINE_LENGTH;
}

// Scans again after SCAN_REUSE_MS. It keeps results current without a file watcher, and
// the window stops repeated requests, as from cmd-hover, from each walking the workspace.
function findComponents(roots) {
  if (lastScan?.roots === roots && Date.now() - lastScan.time < SCAN_REUSE_MS) {
    return lastScan.components;
  }
  const components = [];
  for (const root of roots) {
    for (const file of scriptFiles(root)) {
      let text;
      try {
        if (fs.statSync(file).size > MAX_SCRIPT_BYTES) continue;
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const registration = /\bAlpine\.data\(\s*(["'`])([\w$-]+)\1/g;
      let match;
      while ((match = registration.exec(text))) {
        if (isBundledLine(text, match.index)) continue;
        components.push({
          name: match[2],
          file,
          text,
          nameOffset: match.index + match[0].lastIndexOf(match[2]),
          afterName: match.index + match[0].length,
        });
      }
    }
  }
  lastScan = { roots, time: Date.now(), components };
  return components;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

function offsetAt(text, position) {
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + position.character, text.length);
}

function positionAt(text, offset) {
  let line = 0;
  let lineStart = 0;
  for (;;) {
    const next = text.indexOf("\n", lineStart);
    if (next < 0 || next >= offset) break;
    line++;
    lineStart = next + 1;
  }
  return { line, character: offset - lineStart };
}

function locationOf(file, text, offset, length) {
  return {
    uri: pathToFileURL(file).href,
    range: {
      start: positionAt(text, offset),
      end: positionAt(text, offset + length),
    },
  };
}

function definition(text, offset, roots) {
  const context = attributeContext(text, offset);
  if (!context) return null;
  const identifier = identifierAt(text, offset);
  if (!identifier) return null;
  const { attribute, reference, scopes } = context;

  if (attribute.name === "x-data") {
    if (!reference || identifier.start !== reference.start) return null;
    const matches = findComponents(roots).filter((c) => c.name === reference.name);
    if (matches.length === 0) return null;
    return matches.map((c) => locationOf(c.file, c.text, c.nameOffset, c.name.length));
  }

  if (attribute.kind !== "quoted" || !ALPINE_EXPRESSION_ATTRIBUTE.test(attribute.name)) {
    return null;
  }
  // `row.key` needs the type of `row`. Only `this.member` is known to be the component.
  if (text[identifier.start - 1] === ".") {
    if (text.slice(identifier.start - 5, identifier.start) !== "this.") return null;
  }

  const components = findComponents(roots);
  for (const scope of scopes) {
    const locations = [];
    for (const component of components) {
      if (component.name !== scope) continue;
      const objectStart = factoryObjectStart(component.text, component.afterName);
      if (objectStart < 0) continue;
      const member = objectMembers(component.text, objectStart).find(
        (m) => m.name === identifier.word,
      );
      if (member) {
        locations.push(
          locationOf(component.file, component.text, member.offset, member.name.length),
        );
      }
    }
    if (locations.length > 0) return locations;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function workspaceRoots(params) {
  const uris = (params.workspaceFolders ?? []).map((folder) => folder.uri);
  if (uris.length === 0 && params.rootUri) uris.push(params.rootUri);
  return uris.filter((uri) => uri.startsWith("file:")).map((uri) => fileURLToPath(uri));
}

function start() {
  const documents = new Map();
  let roots = [];
  let shutdownRequested = false;

  const handleRequest = (method, params) => {
    switch (method) {
      case "initialize":
        roots = workspaceRoots(params);
        return {
          capabilities: { textDocumentSync: 1, definitionProvider: true },
          serverInfo: { name: "alpine-language-server" },
        };
      case "shutdown":
        shutdownRequested = true;
        return null;
      case "textDocument/definition": {
        const text = documents.get(params.textDocument.uri);
        if (text === undefined) return null;
        return definition(text, offsetAt(text, params.position), roots);
      }
      default:
        throw Object.assign(new Error(`Unsupported method: ${method}`), { code: -32601 });
    }
  };

  const handleNotification = (method, params) => {
    if (method === "textDocument/didOpen") {
      documents.set(params.textDocument.uri, params.textDocument.text);
    } else if (method === "textDocument/didChange") {
      const change = params.contentChanges[params.contentChanges.length - 1];
      if (change) documents.set(params.textDocument.uri, change.text);
    } else if (method === "textDocument/didClose") {
      documents.delete(params.textDocument.uri);
    } else if (method === "exit") {
      process.exit(shutdownRequested ? 0 : 1);
    }
  };

  const handleMessage = (message) => {
    if (message.id === undefined) {
      if (message.method) handleNotification(message.method, message.params);
      return;
    }
    if (!message.method) return;
    try {
      send({ id: message.id, result: handleRequest(message.method, message.params) });
    } catch (error) {
      send({
        id: message.id,
        error: { code: error.code ?? -32603, message: String(error.message) },
      });
    }
  };

  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = /Content-Length: *(\d+)/i.exec(buffer.toString("ascii", 0, headerEnd));
      if (!header) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyEnd = headerEnd + 4 + Number(header[1]);
      if (buffer.length < bodyEnd) return;
      const body = buffer.toString("utf8", headerEnd + 4, bodyEnd);
      buffer = buffer.subarray(bodyEnd);
      handleMessage(JSON.parse(body));
    }
  });
  process.stdin.on("end", () => process.exit(shutdownRequested ? 0 : 1));
}

if (require.main === module) start();

module.exports = { attributeContext, definition, factoryObjectStart, findComponents, objectMembers };

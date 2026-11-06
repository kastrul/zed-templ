#!/usr/bin/env node
"use strict";

// Transparent proxy around gopls for Go files. It forwards every message
// unchanged, except navigation results that point into a generated *_templ.go
// file. Those are rewritten to the matching declaration in the .templ source.
//
// Zed merges definition results from all servers of a buffer, so a second server
// could only add a .templ entry next to the _templ.go one. Replacing the result
// is the only way to jump directly. Users opt in through lsp.gopls.binary.path.
//
// Resolution is a text search for top-level declarations, because templ writes
// no source map to disk. A location that cannot be resolved stays unchanged.
//
// It must stay dependency-free, like the Alpine server.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const NAVIGATION_METHODS = [
  "textDocument/definition",
  "textDocument/declaration",
  "textDocument/typeDefinition",
  "textDocument/implementation",
];
const GENERATED_SUFFIX = "_templ.go";
const IDENTIFIER_CHAR = /[\p{L}\p{N}_]/u;

// ---------------------------------------------------------------------------
// Location mapping
// ---------------------------------------------------------------------------

function identifierAt(line, character) {
  let start = character;
  while (start > 0 && IDENTIFIER_CHAR.test(line[start - 1])) start--;
  let end = character;
  while (end < line.length && IDENTIFIER_CHAR.test(line[end])) end++;
  return line.slice(start, end);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length - 1, character: offset - lineStart };
}

// Returns the offset of a block declaration member, such as a struct field or a
// name inside var ( ... ). Blocks end at the first closing line in column 0.
function findInBlocks(source, name) {
  const word = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "u");
  const blockStart = /^(?:type|var|const)\b.*[({]\s*$/gm;
  for (let start; (start = blockStart.exec(source)); ) {
    const bodyStart = start.index + start[0].length;
    const close = /^[)}]/m.exec(source.slice(bodyStart));
    const body = source.slice(bodyStart, close ? bodyStart + close.index : source.length);
    let lineOffset = bodyStart;
    for (const line of body.split("\n")) {
      const code = line.split("//")[0];
      const match = word.exec(code);
      if (match) return lineOffset + match.index;
      lineOffset += line.length + 1;
    }
  }
  return -1;
}

// Returns the UTF-16 offset of the name's declaration, or -1. Only column 0 counts
// as top level, so markup text inside a component body does not match.
function findDeclaration(source, name) {
  const id = escapeRegExp(name);
  const boundary = "(?![\\p{L}\\p{N}_])";
  const declaration = new RegExp(
    `^(?:(?:templ|func)[ \\t]+(?:\\([^)\\n]*\\)[ \\t]*)?|(?:css|script|type|var|const)[ \\t]+)(${id})${boundary}`,
    "mu",
  );
  const match = declaration.exec(source);
  if (match) return match.index + match[0].length - match[1].length;
  return findInBlocks(source, name);
}

function mapLocation(uri, range) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  let generatedPath;
  try {
    generatedPath = fileURLToPath(uri);
  } catch {
    return null;
  }
  if (!generatedPath.endsWith(GENERATED_SUFFIX) || !range) return null;
  const templPath = generatedPath.slice(0, -GENERATED_SUFFIX.length) + ".templ";
  let generated;
  let source;
  try {
    generated = fs.readFileSync(generatedPath, "utf8");
    source = fs.readFileSync(templPath, "utf8");
  } catch {
    return null;
  }
  const line = generated.split("\n")[range.start.line];
  if (line === undefined) return null;
  const name = identifierAt(line, range.start.character);
  if (!name) return null;
  const offset = findDeclaration(source, name);
  if (offset < 0) return null;
  const start = positionAt(source, offset);
  return {
    uri: pathToFileURL(templPath).href,
    range: { start, end: { line: start.line, character: start.character + name.length } },
  };
}

function rewriteEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  if (entry.targetUri) {
    const mapped = mapLocation(entry.targetUri, entry.targetSelectionRange);
    if (!mapped) return entry;
    return {
      ...entry,
      targetUri: mapped.uri,
      targetRange: mapped.range,
      targetSelectionRange: mapped.range,
    };
  }
  const mapped = mapLocation(entry.uri, entry.range);
  return mapped ? { ...entry, ...mapped } : entry;
}

// Accepts each result shape of the navigation methods: Location, Location[],
// LocationLink[], or null.
function rewriteResult(result) {
  return Array.isArray(result) ? result.map(rewriteEntry) : rewriteEntry(result);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// Calls onMessage with the raw frame and the parsed JSON of each complete message.
function frameReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
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
      onMessage(buffer.subarray(0, bodyEnd), buffer.subarray(headerEnd + 4, bodyEnd));
      buffer = buffer.subarray(bodyEnd);
    }
  };
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function findGopls() {
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    process.env.GOBIN,
    process.env.GOPATH && path.join(process.env.GOPATH, "bin"),
    path.join(os.homedir(), "go", "bin"),
  ];
  const names = process.platform === "win32" ? ["gopls.exe"] : ["gopls"];
  for (const directory of directories) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function start() {
  const gopls = process.env.TEMPL_GOPLS_PATH || findGopls();
  if (!gopls) {
    process.stderr.write("gopls-templ-proxy: gopls not found. Install gopls or set TEMPL_GOPLS_PATH.\n");
    process.exit(1);
  }
  const child = spawn(gopls, process.argv.slice(2), {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Set();

  child.on("error", (error) => {
    process.stderr.write(`gopls-templ-proxy: cannot start ${gopls}: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  child.stdin.on("error", () => {});

  process.stdin.on(
    "data",
    frameReader((raw, body) => {
      // A byte search skips the parse for other messages, such as large didChange
      // bodies. A match can still be file text, so the parsed method decides.
      if (NAVIGATION_METHODS.some((method) => body.includes(method))) {
        const message = JSON.parse(body.toString("utf8"));
        if (message.id !== undefined && NAVIGATION_METHODS.includes(message.method)) {
          pending.add(message.id);
        }
      }
      child.stdin.write(raw);
    }),
  );
  process.stdin.on("end", () => child.stdin.end());

  child.stdout.on(
    "data",
    frameReader((raw, body) => {
      if (pending.size > 0) {
        const message = JSON.parse(body.toString("utf8"));
        // A message with a method is a request from gopls, whose ids are separate.
        if (message.method === undefined && pending.delete(message.id)) {
          if (message.result) {
            process.stdout.write(frame({ ...message, result: rewriteResult(message.result) }));
            return;
          }
        }
      }
      process.stdout.write(raw);
    }),
  );
}

if (require.main === module) start();

module.exports = { findDeclaration, frameReader, mapLocation, rewriteResult };

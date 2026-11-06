# AGENTS.md

Repository-specific guidance for coding agents.

Claude Code loads this file only while the repository has no `CLAUDE.md`. If you add one, import this file from it with `@AGENTS.md`.

## Design Direction

The repository prefers:

- parser correctness first
- a minimal query surface
- direct host-language highlighting for Go AST nodes exposed by the templ grammar
- injections only for true embedded-language regions such as JavaScript, CSS, comment content, and regex string arguments

If you change highlighting behavior, verify whether the issue is a grammar problem, a query problem, or a theme/capture fallback problem. Do not assume every visual issue should be solved with more injection.

## Query Files

The query layout in `languages/templ/` is intentionally consolidated. Go-shaped syntax inside templ files is handled directly in the main query files.

- Do not assume Neovim-style `; inherits:` behavior exists in Zed.
- Zed loads query files by filename prefix, so files such as `highlights_go.scm` used to work by concatenation. Keep behavior in the main query files unless there is a strong reason not to.
- Avoid reintroducing Go injection for general templ expressions unless there is a clear, verified regression that requires it.
- If you add new query captures, prefer standard Zed capture names and use fallback captures when theme compatibility matters.

## Grammar

`grammars/` is gitignored, except for the tracked `grammars/templ.toml`. `grammars/templ/` is a local clone of upstream `tree-sitter-templ` at the pinned commit, so edits there do not ship with this repository, and a new checkout or worktree does not have the clone. A grammar fix needs an upstream commit and a new pin, set in both `extension.toml` and `grammars/templ.toml`.

The templ grammar inherits from Go and exposes many Go nodes directly in the templ parse tree. Declarations, call expressions, selectors, literals, `if`, `for`, `switch`, `range`, and raw Go blocks often appear as normal Go AST nodes inside `.templ` files.

Hybrid templ nodes are not suitable for whole-node Go injection:

- `component_for_statement`
- `component_if_statement`
- `component_switch_statement`
- `component_declaration`

If parser behavior looks wrong, inspect `grammars/templ/grammar.js` before changing queries aggressively.

## Extension Notes

- `gopls` is an external prerequisite for the templ language server to work correctly.
- `src/alpine-language-server.js` answers go to definition from Alpine attribute values to `Alpine.data(...)` registrations. It is embedded in the extension and runs on Zed's Node, so it must stay dependency-free. Test it with `node --test tests/`.
- `src/gopls-templ-proxy.js` is an opt-in wrapper around `gopls` for Go files, set through `lsp.gopls.binary.path`. It rewrites navigation results from `_templ.go` to `.templ`. Do not register it or `templ lsp` as a server for the Go language: Zed merges definition results, so an extra server gives a list and not a jump, and it starts for every Go project. `templ lsp` also cannot replace `gopls`, because it returns no completions or code actions for Go files. The proxy is embedded in the extension, must stay dependency-free, and has the same test command.

## Workflows

- Changing or diagnosing syntax behavior: follow `.claude/skills/templ-syntax-change/SKILL.md`.
- Bumping the version or the grammar pin: follow `.claude/skills/templ-release/SKILL.md`.

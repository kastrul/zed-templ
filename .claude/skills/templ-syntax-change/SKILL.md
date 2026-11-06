---
name: templ-syntax-change
description: Use when changing or diagnosing Templ syntax behavior in Zed, including highlighting, injections, indents, outline, brackets, text objects, or Tree-sitter query and grammar problems in .templ files.
---

# Templ Syntax Change

Run the Tree-sitter commands from `grammars/templ/`.

If `grammars/templ/` is missing, as it is in a new checkout or worktree, clone upstream at the commit pinned in `extension.toml`:

```bash
git clone https://github.com/vrischmann/tree-sitter-templ grammars/templ
git -C grammars/templ checkout <commit from extension.toml>
```

## Steps

1. Inspect the parse tree for a focused example:

   ```bash
   npx tree-sitter parse ../../examples/<file>.templ
   ```

2. Decide whether the issue is in the grammar, a query, or a theme/capture fallback.

3. Update the query files minimally.

4. Show what a changed query captures:

   ```bash
   npx tree-sitter query ../../languages/templ/<name>.scm ../../examples/<file>.templ
   ```

5. Check every query against every example. An invalid query exits non-zero:

   ```bash
   for q in ../../languages/templ/*.scm; do npx tree-sitter query "$q" ../../examples/*.templ >/dev/null || echo "FAILED: $q"; done
   ```

6. Run `cargo check` from the repository root.

7. Ask the user to verify in Zed. The commands above do not exercise Zed themes, injected-language rendering, or editor behavior.

## Manual Verification Targets

`examples/README.md` says what to check in each file. Good targets:

- `examples/04-raw-go-blocks.templ`
- `examples/07-for-loop-with-dynamic-attrs.templ`
- basic component and attribute examples in `examples/`

## Grammar Changes

Edits to `grammars/templ/` do not ship with this repository, so a grammar fix belongs upstream. To work on one locally:

```bash
npx tree-sitter test
npx tree-sitter build --wasm
```

Keep the corpus expectations in the grammar repository in sync with the change. After the fix lands upstream, update the pin with the `templ-release` skill.

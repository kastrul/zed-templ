# Zed Templ Extension

A comprehensive language extension for [Templ](https://github.com/a-h/templ) in [Zed](https://zed.dev), providing syntax highlighting, language server support, and integration with web development tools.

## ✨ Features

- 🎨 **Syntax Highlighting** for Templ templates
- 🔧 **Language Server Protocol (LSP)** support via the official Templ language server
- 🌈 **Tailwind CSS** autocomplete support (requires configuration)
- 📝 **HTML/CSS/JavaScript** support within templates
- 🚀 **Emmet** abbreviations (requires configuration)
- 🔍 **Go code** support with gopls integration
- 🏔️ **Alpine.js** attribute highlighting and go to definition

## 📋 Prerequisites

Before installing this extension, you must have the following installed:

### 1. Go Language Tools
```bash
# Install Go (if not already installed)
# Visit: https://go.dev/doc/install

# Install gopls (REQUIRED - templ LSP depends on this)
go install golang.org/x/tools/gopls@latest

# Install templ
go install github.com/a-h/templ/cmd/templ@latest
```

### 2. Verify Installation
```bash
# Check that everything is installed correctly
templ version  # Should print an installed templ version
gopls version  # Should print an installed gopls version
```

## 🚀 Installation

1. Open Zed
2. Press `cmd+shift+x` (macOS) or `ctrl+shift+x` (Linux) to open extensions
3. Search for "Templ"
4. Click Install

## ⚙️ Configuration

### Basic Setup
The extension works out of the box for basic Templ syntax highlighting and LSP features.

For manual verification examples, open the `examples/` folder in Zed. It includes a small Go module plus focused `.templ` files for syntax highlighting, Emmet, raw Go blocks, formatting behavior, and embedded language checks.

### Tailwind CSS Autocomplete
To enable Tailwind CSS class autocomplete in Templ files, add this to your Zed settings (`cmd+,` or `ctrl+,`):

```json
{
  "languages": {
    "Templ": {
      "language_servers": [
        "templ",
        "alpine",
        "tailwindcss-language-server",
        "vscode-html-language-server",
        "emmet-language-server"
      ]
    }
  },
  "lsp": {
    "tailwindcss-language-server": {
      "settings": {
        "includeLanguages": {
          "templ": "html"
        },
        "experimental": {
          "classRegex": ["class=\"([^\"]*)\"", "className=\"([^\"]*)\""]
        }
      }
    }
  }
}
```

### Emmet Support
Emmet works in Templ markup when `emmet-language-server` is enabled for the `Templ` language. Use it by typing abbreviations and pressing `tab`:
- `div.container` → `<div class="container"></div>`
- `ul>li*3` → Creates a list with 3 items

If Emmet does not expand in `.templ` files:
1. Ensure the `emmet` extension is installed in Zed
2. Keep `emmet-language-server` in `languages.Templ.language_servers`
3. Restart Zed after changing language server settings

### Alpine.js Support
Alpine support works without configuration. If you set `languages.Templ.language_servers`, keep `"alpine"` in the list, because Zed disables servers that the list leaves out.

**Highlighting**: Quoted values of Alpine attributes are highlighted as JavaScript. This covers `x-data`, `x-init`, `x-show`, `x-bind`, `x-on`, `x-text`, `x-html`, `x-model`, `x-modelable`, `x-effect`, `x-if`, `x-id`, and the `@` and `:` shorthands. Values of `x-for`, `x-ref`, `x-transition`, `x-teleport`, and `x-cloak` are not highlighted, because they are not plain JavaScript.

**Go to definition**: The bundled `alpine` language server links markup to `Alpine.data(...)` registrations in your workspace's scripts:

```templ
templ Counter(start string) {
    <div x-data={ "counter(" + start + ")" }>
        <button @click="increment">+</button>
        <span x-text="count"></span>
    </div>
}
```

```ts
Alpine.data("counter", (start) => ({
  count: Number(start),
  increment() {
    this.count++;
  },
}));
```

- From a component name in `x-data`, it jumps to the `Alpine.data(...)` call. The name can be in a quoted value or at the start of a string in a Go expression.
- From a member name in an Alpine attribute, it jumps to the property or method in the object the factory returns. Components in scope are searched innermost first.

Resolution is a text search, not type analysis, so some cases are not resolved:
- Components must be registered with a string literal name, as in `Alpine.data("name", ...)`.
- Factories must return an object literal.
- Members are only resolved in quoted attribute values, not in Go expressions.
- Property access is only resolved for `this.member`. In `row.key`, `key` is not resolved.

The scan covers `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, and `.cts` files. It skips hidden directories, `node_modules`, `dist`, `build`, `vendor`, `target`, `coverage`, `.d.ts` and `.min.js` files, files over 2 MB, and bundled output.

### Go to Definition from Go Files
By default, go to definition from a `.go` file to a templ component opens the generated `_templ.go` file, because Zed asks `gopls`, and `gopls` only knows the generated code.

To open the `.templ` source instead, run `gopls` through the proxy that this extension installs. Open a `.templ` file once so the extension writes the proxy, then add this to your Zed settings:

```json
{
  "lsp": {
    "gopls": {
      "binary": {
        "path": "/Users/YOU/Library/Application Support/Zed/extensions/work/templ/gopls-templ-proxy.js"
      }
    }
  }
}
```

On Linux, the path is `~/.local/share/zed/extensions/work/templ/gopls-templ-proxy.js`, written as an absolute path. Then restart `gopls`, or restart Zed.

The proxy needs `node` and `gopls` on your `PATH`. It also checks `$GOBIN`, `$GOPATH/bin`, and `~/go/bin` for `gopls`. To use a specific `gopls`, set `TEMPL_GOPLS_PATH` in `lsp.gopls.binary.env`.

All other `gopls` messages pass through unchanged. The proxy rewrites results of go to definition, declaration, type definition, and implementation:
- It resolves top-level `templ`, `css`, `script`, `func`, `type`, `var`, and `const` declarations, plus members of `type`, `var`, and `const` blocks.
- Resolution is a text search by name in the source file. If two receivers declare the same method name in one file, it opens the first.
- Find references still lists `_templ.go` locations.

### Prettier Formatting
To use Prettier with Templ files:

1. Install the [Prettier plugin for Templ](https://github.com/therealparmesh/prettier-plugin-templ-script):
```bash
npm install --save-dev prettier prettier-plugin-templ-script
```

2. Add to your `.prettierrc`:
```json
{
  "plugins": ["prettier-plugin-templ-script"],
  "overrides": [
    {
      "files": ["*.templ"],
      "options": {
        "parser": "templ"
      }
    }
  ]
}
```

## 🐛 Troubleshooting

### "Language server templ failed to start" or "LSP not starting"
**Solution**: Install gopls (see Prerequisites above). The Templ language server requires gopls to be installed.

### "No Tailwind CSS autocomplete"
**Solution**: 
1. Ensure you have the Tailwind CSS language server installed
2. Add the configuration shown in the Tailwind CSS section above
3. Restart Zed

### "Stuck on 'Setting up workspace: Loading packages'"
**Solution**: This was a compatibility issue with older Zed versions. Update Zed to a recent stable release.

### "Spaces inserted between {{ }}" or "Raw Go code syntax issues"
**Problem**: Raw Go blocks can be sensitive to editor auto-pairing and `templ fmt`. In practice this can show up as `{{` turning into `{ {`, or formatting/highlighting getting confused around raw Go blocks.

**Workarounds**:
1. Type `{{` quickly without pause
2. Use the undo function if spaces are inserted
3. For raw Go blocks, ensure your code is syntactically valid
4. If `templ fmt` rewrites the block, disable format on save for Templ files:

```json
{
  "languages": {
    "Templ": {
      "format_on_save": "off"
    }
  }
}
```

### "Empty lines are deleted on save"
**Note**: This comes from the `templ fmt` formatter rather than the Zed extension itself. You can disable format on save:
```json
{
  "languages": {
    "Templ": {
      "format_on_save": "off"
    }
  }
}
```

## 🌟 Usage Tips

### Basic Templ Syntax
```templ
package main

import "fmt"

templ Hello(name string) {
    <div class="greeting">
        <h1>Hello, { name }!</h1>
        { fmt.Sprintf("Welcome to Templ") }
    </div>
}

// Using Go code blocks
templ Counter(count int) {
    {{ formattedCount := fmt.Sprintf("%d", count) }}
    <div>Count: { formattedCount }</div>
}
```

### Working with Components
```templ
// Define a layout
templ Layout(title string) {
    <!DOCTYPE html>
    <html>
        <head><title>{ title }</title></head>
        <body>
            { children... }
        </body>
    </html>
}

// Use the layout
templ Page() {
    @Layout("My Page") {
        <h1>Content goes here</h1>
    }
}
```

## 🤝 Contributing

Found a bug or have a feature request? Please open an issue on [GitHub](https://github.com/makifdb/zed-templ/issues).

## 📝 License

MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [a-h/templ](https://github.com/a-h/templ) - The Templ templating language
- [vrischmann/tree-sitter-templ](https://github.com/vrischmann/tree-sitter-templ) - Tree-sitter grammar for Templ
- [Zed](https://zed.dev) - The Zed editor

# Code Design

An Obsidian desktop plugin for reviewing Era Code design-document edits in context.

## Features

- **Inline review:** Shows deletions in red and additions in green inside the active Markdown document.
- **Contextual explanations:** Shows code-level reasons for semantic changes outside the saved document and hides empty explanations for clarity-only edits.
- **Selection context:** Lets Era Code read selected document text or a selected proposal explanation.
- **Atomic approval:** Accepts or rejects every change in one file as a single proposal.
- **Iterative proposals:** Lets Era Code revise unresolved suggestions after follow-up feedback.
- **Manual navigation:** Moves between a proposal's changes only when the user selects previous or next.
- **Document outline:** Shows linked Markdown headings in the left gutter and includes a view-toolbar visibility toggle.
- **Inline explanations:** Keeps each technical explanation directly below its related document change.
- **Local operation:** Binds its MCP endpoint to `127.0.0.1` and keeps proposal state in memory.

## Development

Requirements: Node.js 22 and an Obsidian desktop vault at `~/.codedesign`.

```bash
npm install
npm run build
mkdir -p ~/.codedesign/.obsidian/plugins/code-design
ln -sfn "$(pwd)/main.js" ~/.codedesign/.obsidian/plugins/code-design/main.js
ln -sfn "$(pwd)/manifest.json" ~/.codedesign/.obsidian/plugins/code-design/manifest.json
ln -sfn "$(pwd)/styles.css" ~/.codedesign/.obsidian/plugins/code-design/styles.css
```

Open `~/.codedesign` as an Obsidian vault. Enable **Code Design** under Community plugins.

Connect Era Code to `http://127.0.0.1:27123/mcp`. The port is configurable in Obsidian.

## Tool workflow

Era Code calls `get_selection` when a request refers to “this” or selected Obsidian content.
It calls `propose_changes` with one file, anchored edits, and optional technical explanations.
It calls `update_proposal` to revise pending text, explanations, or source ranges without discarding review progress.
The plugin never reads source repositories, invokes Git, or creates Linear tickets.

See [the protocol reference](./docs/protocol.md) for tool inputs and review behavior.

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

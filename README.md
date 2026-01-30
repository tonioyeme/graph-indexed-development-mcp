# GID MCP Server

**Model Context Protocol server for [Graph-Indexed Development](https://zenodo.org/records/18425984)**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![npm](https://img.shields.io/npm/v/gid-mcp)](https://www.npmjs.com/package/gid-mcp)

> Give AI assistants structural awareness of your codebase. GID represents software systems as typed, directed graphs — so AI can reason about architecture, not just syntax.

---

## Why GID?

AI can generate code, but it can't answer:
- *"What breaks if I change UserService?"*
- *"Which components implement the auth feature?"*
- *"What's the dependency path from Controller to Database?"*

GID fills this gap by providing a **graph-based map** of your software architecture that AI assistants can query and update.

---

## Tools

### Query & Analysis

| Tool | Description |
|------|-------------|
| `gid_query_impact` | Analyze what components and features are affected by changing a node |
| `gid_query_deps` | Get dependencies or dependents of a node (with depth control) |
| `gid_query_common_cause` | Find shared dependencies between two nodes (useful for debugging) |
| `gid_query_path` | Find dependency path between two nodes |
| `gid_analyze` | Deep analysis of a file (functions, classes, complexity) |
| `gid_get_file_summary` | Structured file analysis for AI summarization |
| `gid_advise` | Graph health score, validation issues, and improvement suggestions |
| `gid_get_schema` | Get the GID graph schema with dynamic relations |

### Graph Management

| Tool | Description |
|------|-------------|
| `gid_read` | Read graph structure (YAML, JSON, or summary) |
| `gid_init` | Initialize a new GID graph in a project |
| `gid_edit_graph` | Add, update, or delete nodes, edges, and relation types |
| `gid_refactor` | Rename, move, or delete nodes with cascade |
| `gid_history` | Version history — list, diff, or restore previous versions |

### AI-Assisted

| Tool | Description |
|------|-------------|
| `gid_design` | Generate a graph from natural language requirements |
| `gid_extract` | Extract dependency graph from existing code (TypeScript/JavaScript) |
| `gid_semantify` | Propose semantic upgrades — map files to components, assign layers, detect features |
| `gid_complete` | Analyze docs to identify gaps and suggest graph additions |
| `gid_visual` | Generate interactive D3.js HTML visualization |

### Resources

| Resource | Description |
|----------|-------------|
| `gid://graph` | Current dependency graph (YAML) |
| `gid://health` | Health score and validation results |
| `gid://features` | List of all features in the graph |

---

## Installation

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gid": {
      "command": "npx",
      "args": ["gid-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add gid -- npx gid-mcp
```

### Cursor / VS Code

Add to your MCP settings:

```json
{
  "gid": {
    "command": "npx",
    "args": ["gid-mcp"]
  }
}
```

---

## Quick Start

1. Install the MCP server (see above)
2. Initialize a graph in your project:

```
You: "Initialize a GID graph for this project"
→ Claude uses gid_init
```

3. Extract dependencies from your code:

```
You: "Extract the dependency graph from the codebase"
→ Claude uses gid_extract
```

4. Start querying:

```
You: "What would break if I change UserService?"
→ Claude uses gid_query_impact

You: "Design the architecture for a notification feature"
→ Claude uses gid_design

You: "Show me the project health score"
→ Claude uses gid_advise
```

---

## Example Conversations

### Impact Analysis
**You:** "What would be affected if I change the UserService?"

**Claude** uses `gid_query_impact` → *"Changing UserService affects 5 components across 2 features. AuthController and ProfileController depend on it directly..."*

### Debugging Shared Failures
**You:** "OrderService and PaymentService keep failing together. Why?"

**Claude** uses `gid_query_common_cause` → *"Both depend on DatabaseService — that's likely the root cause."*

### Architecture from Requirements
**You:** "Design an e-commerce backend with auth, payments, and order tracking"

**Claude** uses `gid_design` → Generates a complete graph with features, components, layers, and relationships.

### Graph Visualization
**You:** "Visualize the current project architecture"

**Claude** uses `gid_visual` → Generates an interactive D3.js HTML file with color-coded nodes, health score, and search.

---

## Graph Format

GID uses a YAML-based graph format (`.gid/graph.yml`):

```yaml
nodes:
  UserAuth:
    type: Feature
    description: User authentication and authorization
    priority: core
    status: active
  AuthService:
    type: Component
    layer: application
    description: Handles authentication logic
    path: src/services/auth.ts
  AuthController:
    type: Component
    layer: interface
    path: src/controllers/auth.ts

edges:
  - from: AuthService
    to: UserAuth
    relation: implements
  - from: AuthController
    to: AuthService
    relation: depends_on
```

**Node types:** Feature, Component, Interface, Data, File, Test, Decision

**Relation types:** implements, depends_on, calls, reads, writes, tested_by, defined_in, enables, blocks, requires, precedes, refines, validates, related_to, decided_by — plus custom relations you define.

---

## Requirements

- Node.js >= 20.0.0

---

## Related

- [GID CLI](https://github.com/tonioyeme/graph-indexed-development-cli) — Command line interface
- [GID Paper](https://zenodo.org/records/18425984) — Formal methodology (Zenodo)

---

## License

**AGPL-3.0** — See [LICENSE](LICENSE) for details.

For commercial licensing, see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

---

## Author

**Toni Tang** — [@tonioyeme](https://github.com/tonioyeme)

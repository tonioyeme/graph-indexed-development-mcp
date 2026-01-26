# GID MCP Server

**Model Context Protocol server for Graph-Indexed Development**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![npm](https://img.shields.io/npm/v/gid-mcp)](https://www.npmjs.com/package/gid-mcp)

> Query and analyze dependency graphs through Claude and other AI assistants.

Part of the [Graph-Indexed Development (GID)](https://github.com/tonioyeme/graph-indexed-development-cli) methodology.

---

## Features

This free MCP server provides **read-only query tools** for GID graphs:

| Tool | Description |
|------|-------------|
| `gid_query_impact` | Analyze what's affected by changing a node |
| `gid_query_deps` | Get dependencies or dependents of a node |
| `gid_query_common_cause` | Find shared dependencies between nodes |
| `gid_query_path` | Find dependency path between nodes |
| `gid_read` | Read graph structure (YAML/JSON/summary) |
| `gid_get_schema` | Get GID schema and examples |
| `gid_history` | List graph version history |

### Pro Features

For full features (extract, design, analyze, semantify, refactor, visualize), upgrade to [GID Pro MCP](https://gid-mcp.com).

---

## Installation

### For Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

### For Other MCP Clients

```bash
npx gid-mcp
```

---

## Usage

Once installed, you can ask Claude:

- "What would be affected if I change UserService?"
- "What does OrderService depend on?"
- "Find the path from Controller to Database"
- "What dependencies do ComponentA and ComponentB share?"
- "Show me the current graph summary"

---

## Example Conversations

### Impact Analysis

**User:** "What would be affected if I change the UserService?"

**Claude uses:** `gid_query_impact` with `node: "UserService"`

**Response:** "Changing UserService affects 5 components and 2 features..."

### Debugging

**User:** "OrderService and PaymentService keep failing together. Why?"

**Claude uses:** `gid_query_common_cause` with `nodeA: "OrderService", nodeB: "PaymentService"`

**Response:** "Both services depend on DatabaseService. Check that first..."

---

## Requirements

- Node.js >= 20.0.0
- A GID graph in your project (`.gid/graph.yml`)

Create a graph using the [GID CLI](https://github.com/tonioyeme/graph-indexed-development-cli):

```bash
npm install -g graph-indexed-development-cli
gid init
gid extract .
```

---

## Resources

The server also exposes MCP resources:

| Resource | Description |
|----------|-------------|
| `gid://graph` | Current graph in YAML format |
| `gid://health` | Health score and validation summary |

---

## Related

- [GID CLI](https://github.com/tonioyeme/graph-indexed-development-cli) - Command line tool
- [GID Pro MCP](https://gid-mcp.com) - Full-featured MCP with extract, design, analyze

---

## License

AGPL-3.0 - See [LICENSE](LICENSE) for details.

---

## Author

**Toni Tang** - [@tonioyeme](https://github.com/tonioyeme)

# hfsql-mcp

[![npm version](https://img.shields.io/npm/v/hfsql-mcp)](https://www.npmjs.com/package/hfsql-mcp)

MCP (Model Context Protocol) server for **HFSQL** databases via PowerShell ODBC.

Built for [Claude Code](https://claude.ai/claude-code) — works with any MCP-compatible client.

## Why?

HFSQL (PC SOFT / WinDev) has quirks that break standard ODBC tooling:
- No `SELECT` without a `FROM` clause (no DUAL table)
- Calculated fields that silently reject `INSERT`
- Date format must be `YYYYMMDD`
- French-accented column/table names
- No `INFORMATION_SCHEMA` support

This server handles all of that transparently via PowerShell + native ODBC.

## Prerequisites

- **Windows** with PowerShell 7+ (`pwsh`)
- **HFSQL ODBC driver** installed (32-bit or 64-bit)
- A configured **ODBC DSN** pointing to your HFSQL server
- **Node.js** 18+

## Installation

### From npm (recommended)

```bash
npm install -g hfsql-mcp
```

### From source

```bash
git clone https://github.com/kbdevs/hfsql-mcp.git
cd hfsql-mcp
npm install
```

## Configuration

### Claude Code (recommended)

```bash
claude mcp add hfsql -- npx hfsql-mcp
```

Or manually add to your `~/.mcp.json`:

```json
{
  "mcpServers": {
    "hfsql": {
      "command": "npx",
      "args": ["hfsql-mcp"]
    }
  }
}
```

**If installed from source:**
```json
{
  "mcpServers": {
    "hfsql": {
      "command": "node",
      "args": ["C:\\path\\to\\hfsql-mcp\\index.js"]
    }
  }
}
```

### Other MCP clients

Any MCP-compatible client can use this server via stdio transport. Point it to the `index.js` entry point.

## ODBC DSN Setup

Before using, configure an ODBC DSN in Windows:

1. Open **ODBC Data Source Administrator** (64-bit)
2. Add a new **User DSN** with the **HFSQL** driver
3. Set: `Server Name`, `Server Port` (default 4900), `Database`
4. Note the DSN name — you'll use it in `hfsql_connect`

## Tools

| Tool | Description |
|------|-------------|
| `hfsql_connect` | Connect to an HFSQL database via ODBC DSN |
| `hfsql_disconnect` | Close a registered connection |
| `hfsql_list_tables` | List all tables with column count and optional row count |
| `hfsql_describe_table` | Get table schema (columns, types, sizes, nullable) |
| `hfsql_query` | Execute SELECT queries, returns JSON (default limit: 100 rows) |
| `hfsql_execute` | Execute INSERT / UPDATE / DELETE, returns affected row count |
| `hfsql_insert` | Smart insert from JSON object — auto-skips calculated fields, auto-formats dates |
| `hfsql_schema_summary` | Full schema overview: all tables with columns, types and row counts |

## Usage Examples

### Connect
```
hfsql_connect(id: "mydb", dsn: "kbpro", uid: "admin", pwd: "admin")
```

### List tables
```
hfsql_list_tables(id: "mydb", with_row_count: true)
```

### Describe a table
```
hfsql_describe_table(id: "mydb", table: "Articles")
```

### Query
```
hfsql_query(id: "mydb", sql: "SELECT Reference, Libellé, Prix_Vente_HT FROM [Articles]")
```

### Smart insert
```
hfsql_insert(id: "mydb", table: "Articles", data: {
  "Reference": "M004",
  "Libellé": "BLÉ TENDRE",
  "Prix_Achat_HT": 4500
})
```
Calculated fields are detected and skipped automatically. Dates in `YYYY-MM-DD` format are converted to `YYYYMMDD` for HFSQL.

### Execute UPDATE / DELETE
```
hfsql_execute(id: "mydb", sql: "UPDATE [Articles] SET Libellé = 'MAÏS EN VRAC' WHERE IDArticle = 1")
```

### Full schema summary
```
hfsql_schema_summary(id: "mydb")
```

## How It Works

```
Claude Code  ──MCP/stdio──▶  hfsql-mcp (Node.js)
                                  │
                        PowerShell ODBC via temp file
                                  │
                          HFSQL Server (port 4900)
```

1. Each tool call builds a PowerShell script that opens an ODBC connection
2. The script executes the operation and writes JSON to a UTF-8 temp file
3. Node.js reads the temp file — **no console encoding issues** with French characters
4. Results are returned to the MCP client as structured content

## HFSQL Quirks Handled

| Quirk | How it's handled |
|-------|-----------------|
| No DUAL table | Always uses real table in FROM |
| Calculated fields | `hfsql_insert` auto-detects via `IsReadOnly` schema flag |
| Date format | Auto-converts `YYYY-MM-DD` → `YYYYMMDD` |
| French accents | UTF-8 temp file output, square-bracket identifiers |
| No INFORMATION_SCHEMA | Uses ODBC `GetSchema("Tables")` + `GetSchemaTable()` |

## License

MIT

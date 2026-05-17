# hfsql-mcp

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

```bash
git clone https://github.com/YOUR_USER/hfsql-mcp.git
cd hfsql-mcp
npm install
```

## Configuration

Add to your `.mcp.json` (Claude Code) or MCP client config:

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

## Usage examples

### Connect
```
hfsql_connect(id: "mydb", dsn: "kbpro", uid: "admin", pwd: "admin")
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

### Execute
```
hfsql_execute(id: "mydb", sql: "UPDATE [Articles] SET Libellé = 'MAÏS EN VRAC' WHERE IDArticle = 1")
```

## License

MIT

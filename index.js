#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "child_process";
import { readFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── State ───────────────────────────────────────────────────────────────────
const connections = new Map();
const TMP_DIR = mkdtempSync(join(tmpdir(), "hfsql-"));
let psCallId = 0;

// ─── PowerShell engine ──────────────────────────────────────────────────────
// Scripts must assign their result to $__result (hashtable or array).
// The wrapper serialises it to a UTF-8 JSON temp file that Node reads back.
function psJson(script) {
  const outPath = join(TMP_DIR, `r${++psCallId}.json`);
  const psOutPath = outPath.replace(/\\/g, "\\\\");

  const wrapper = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try {
${script}
  $__json = $__result | ConvertTo-Json -Compress -Depth 6
  [System.IO.File]::WriteAllText("${psOutPath}", $__json, (New-Object System.Text.UTF8Encoding $false))
} catch {
  $__e = @{ __error = $true; message = $_.Exception.Message } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText("${psOutPath}", $__e, (New-Object System.Text.UTF8Encoding $false))
}`;

  const encoded = Buffer.from(wrapper, "utf16le").toString("base64");
  try {
    execSync(`pwsh -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120_000,
      stdio: "ignore",
    });
  } catch {}

  try {
    const json = readFileSync(outPath, "utf8").trim();
    try { unlinkSync(outPath); } catch {}
    if (!json) return null;
    const obj = JSON.parse(json);
    if (obj?.__error) throw new Error(obj.message);
    return obj;
  } catch (err) {
    try { unlinkSync(outPath); } catch {}
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function connStr(dsn, uid, pwd) {
  return `DSN=${dsn};UID=${uid};PWD=${pwd}`;
}
function esc(v) {
  return String(v).replace(/'/g, "''");
}
function getConn(id) {
  const c = connections.get(id);
  if (!c)
    throw new Error(
      `Connexion "${id}" introuvable. Utilisez hfsql_connect d'abord.`
    );
  return c;
}

// ─── Tool catalogue ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "hfsql_connect",
    description:
      "Se connecter à une base HFSQL via un DSN ODBC déjà configuré.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Identifiant unique pour cette connexion (ex: kbpro)",
        },
        dsn: { type: "string", description: "Nom du DSN ODBC (ex: kbpro)" },
        uid: { type: "string", description: "Utilisateur", default: "admin" },
        pwd: { type: "string", description: "Mot de passe", default: "admin" },
      },
      required: ["id", "dsn"],
    },
  },
  {
    name: "hfsql_disconnect",
    description: "Fermer une connexion enregistrée.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifiant de la connexion" },
      },
      required: ["id"],
    },
  },
  {
    name: "hfsql_list_tables",
    description:
      "Lister toutes les tables avec nombre de colonnes et nombre de lignes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifiant de la connexion" },
        with_row_count: {
          type: "boolean",
          description: "Inclure le nombre de lignes (plus lent)",
          default: false,
        },
      },
      required: ["id"],
    },
  },
  {
    name: "hfsql_describe_table",
    description:
      "Décrire la structure d'une table (colonnes, types, tailles, nullable).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifiant de la connexion" },
        table: { type: "string", description: "Nom de la table" },
      },
      required: ["id", "table"],
    },
  },
  {
    name: "hfsql_query",
    description:
      "Exécuter une requête SELECT et retourner les résultats en JSON. Limite par défaut : 100 lignes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifiant de la connexion" },
        sql: { type: "string", description: "Requête SQL SELECT" },
        limit: {
          type: "number",
          description: "Nombre max de lignes",
          default: 100,
        },
      },
      required: ["id", "sql"],
    },
  },
  {
    name: "hfsql_execute",
    description:
      "Exécuter une requête INSERT, UPDATE ou DELETE. Retourne le nombre de lignes affectées.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifiant de la connexion" },
        sql: {
          type: "string",
          description: "Requête SQL (INSERT/UPDATE/DELETE)",
        },
      },
      required: ["id", "sql"],
    },
  },
  {
    name: "hfsql_insert",
    description:
      "Insérer un enregistrement dans une table à partir d'un objet JSON. Gère automatiquement les champs calculés et le format des dates HFSQL (YYYYMMDD).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifiant de la connexion" },
        table: { type: "string", description: "Nom de la table" },
        data: {
          type: "object",
          description: "Objet clé-valeur {colonne: valeur} à insérer",
          additionalProperties: true,
        },
      },
      required: ["id", "table", "data"],
    },
  },
  {
    name: "hfsql_schema_summary",
    description:
      "Résumé complet du schéma : toutes les tables avec colonnes, types et row counts. Idéal pour une vue d'ensemble rapide.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifiant de la connexion" },
      },
      required: ["id"],
    },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────────────

function handleConnect({ id, dsn, uid = "admin", pwd = "admin" }) {
  const cs = connStr(dsn, uid, pwd);
  const r = psJson(`
  $c = New-Object System.Data.Odbc.OdbcConnection('${esc(cs)}')
  $c.Open(); $s = $c.State.ToString(); $c.Close()
  $__result = @{ ok = $true; state = $s }
`);
  if (r?.ok) {
    connections.set(id, { dsn, uid, pwd, cs });
    return { content: [{ type: "text", text: `Connecté à "${dsn}" (id: ${id})` }] };
  }
  throw new Error("Échec de connexion");
}

function handleDisconnect({ id }) {
  connections.delete(id);
  return { content: [{ type: "text", text: `Connexion "${id}" supprimée.` }] };
}

function handleListTables({ id, with_row_count = false }) {
  const { cs } = getConn(id);
  const countBlock = with_row_count
    ? `try { $cm = $c.CreateCommand(); $cm.CommandText = "SELECT COUNT(*) FROM [$n]"; $rc = [int]$cm.ExecuteScalar(); $cm.Dispose() } catch { $rc = -1 }`
    : `$rc = $null`;
  const r = psJson(`
  $c = New-Object System.Data.Odbc.OdbcConnection('${esc(cs)}'); $c.Open()
  $ts = $c.GetSchema("Tables"); $res = @()
  foreach ($row in $ts.Rows) {
    $n = $row["TABLE_NAME"]
    ${countBlock}
    try { $cm2 = $c.CreateCommand(); $cm2.CommandText = "SELECT * FROM [$n] WHERE 1=0"
      $rd = $cm2.ExecuteReader([System.Data.CommandBehavior]::SchemaOnly)
      $cc = $rd.GetSchemaTable().Rows.Count; $rd.Close(); $cm2.Dispose()
    } catch { $cc = -1 }
    $res += @{ table = $n; columns = $cc; rows = $rc }
  }
  $c.Close()
  $__result = $res
`);
  const arr = Array.isArray(r) ? r : r ? [r] : [];
  const lines = arr
    .sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))
    .map((t) => `${t.table} (${t.columns} cols${t.rows != null ? `, ${t.rows} rows` : ""})`);
  return { content: [{ type: "text", text: `${arr.length} tables:\n${lines.join("\n")}` }] };
}

function handleDescribeTable({ id, table }) {
  const { cs } = getConn(id);
  const r = psJson(`
  $c = New-Object System.Data.Odbc.OdbcConnection('${esc(cs)}'); $c.Open()
  $cm = $c.CreateCommand(); $cm.CommandText = "SELECT * FROM [${esc(table)}] WHERE 1=0"
  $rd = $cm.ExecuteReader([System.Data.CommandBehavior]::SchemaOnly)
  $st = $rd.GetSchemaTable(); $cols = @()
  foreach ($r in $st.Rows) {
    $cols += @{ name = $r["ColumnName"]; type = $r["DataType"].Name; size = $r["ColumnSize"]; nullable = $r["AllowDBNull"] }
  }
  $rd.Close(); $cm.Dispose()
  try { $cm2 = $c.CreateCommand(); $cm2.CommandText = "SELECT COUNT(*) FROM [${esc(table)}]"
    $cnt = [int]$cm2.ExecuteScalar(); $cm2.Dispose() } catch { $cnt = -1 }
  $c.Close()
  $__result = @{ table = '${esc(table)}'; row_count = $cnt; columns = $cols }
`);
  const cols = r?.columns || [];
  const hdr = `Table: ${r.table} (${cols.length} colonnes, ${r.row_count} lignes)\n`;
  const lines = cols.map((c) => `  ${c.name}  |  ${c.type}  |  ${c.size}${c.nullable ? "  |  NULL" : ""}`);
  return { content: [{ type: "text", text: hdr + lines.join("\n") }] };
}

function handleQuery({ id, sql, limit = 100 }) {
  const { cs } = getConn(id);
  if (!/^\s*SELECT/i.test(sql))
    throw new Error("hfsql_query n'accepte que SELECT. Utilisez hfsql_execute pour INSERT/UPDATE/DELETE.");
  const r = psJson(`
  $c = New-Object System.Data.Odbc.OdbcConnection('${esc(cs)}'); $c.Open()
  $cm = $c.CreateCommand(); $cm.CommandText = '${esc(sql)}'
  $rd = $cm.ExecuteReader()
  $st = $rd.GetSchemaTable(); $cn = @()
  foreach ($r in $st.Rows) { $cn += $r["ColumnName"] }
  $rows = @(); $i = 0
  while ($rd.Read() -and $i -lt ${limit}) {
    $o = [ordered]@{}
    foreach ($col in $cn) {
      $v = $rd[$col]
      if ($v -is [System.DBNull]) { $o[$col] = $null }
      elseif ($v -is [byte[]]) { $o[$col] = "(blob)" }
      else { $o[$col] = $v }
    }
    $rows += $o; $i++
  }
  $rd.Close(); $cm.Dispose(); $c.Close()
  $__result = @{ count = $rows.Count; columns = $cn; rows = $rows }
`);
  if (!r?.rows?.length) return { content: [{ type: "text", text: "Aucun résultat." }] };
  return {
    content: [{ type: "text", text: `${r.count} ligne(s) retournée(s)\n\n${JSON.stringify(r.rows, null, 2)}` }],
  };
}

function handleExecute({ id, sql }) {
  const { cs } = getConn(id);
  if (/^\s*SELECT/i.test(sql))
    throw new Error("Utilisez hfsql_query pour les requêtes SELECT.");
  const r = psJson(`
  $c = New-Object System.Data.Odbc.OdbcConnection('${esc(cs)}'); $c.Open()
  $cm = $c.CreateCommand(); $cm.CommandText = '${esc(sql)}'
  $n = $cm.ExecuteNonQuery(); $cm.Dispose(); $c.Close()
  $__result = @{ affected = $n }
`);
  return { content: [{ type: "text", text: `${r.affected} ligne(s) affectée(s).` }] };
}

function handleInsert({ id, table, data }) {
  const { cs } = getConn(id);
  const jsonData = JSON.stringify(data).replace(/'/g, "''");
  const r = psJson(`
  $c = New-Object System.Data.Odbc.OdbcConnection('${esc(cs)}'); $c.Open()
  # detect calculated/readonly fields
  $skip = @()
  $cm0 = $c.CreateCommand(); $cm0.CommandText = "SELECT * FROM [${esc(table)}] WHERE 1=0"
  $rd0 = $cm0.ExecuteReader([System.Data.CommandBehavior]::SchemaOnly)
  $st0 = $rd0.GetSchemaTable()
  foreach ($r in $st0.Rows) {
    if ($r["IsAutoIncrement"] -eq $true -or $r["IsReadOnly"] -eq $true) { $skip += $r["ColumnName"] }
  }
  $rd0.Close(); $cm0.Dispose()

  $d = '${jsonData}' | ConvertFrom-Json
  $cols = @(); $vals = @(); $skipped = @()
  foreach ($p in $d.PSObject.Properties) {
    if ($skip -contains $p.Name) { $skipped += $p.Name; continue }
    $cols += "[$($p.Name)]"
    $v = $p.Value
    if ($null -eq $v) { $vals += "NULL" }
    elseif ($v -is [string]) {
      if ($v -match '^\\d{4}-\\d{2}-\\d{2}$') { $v = $v -replace '-','' }
      $vals += "'" + ($v -replace "'","''") + "'"
    }
    elseif ($v -is [bool]) { $vals += $(if($v){"1"}else{"0"}) }
    else { $vals += "$v" }
  }
  $sql = "INSERT INTO [${esc(table)}] (" + ($cols -join ", ") + ") VALUES (" + ($vals -join ", ") + ")"
  $cm = $c.CreateCommand(); $cm.CommandText = $sql
  $n = $cm.ExecuteNonQuery(); $cm.Dispose()
  # get last inserted ID
  $lid = $null
  try { $cm2 = $c.CreateCommand(); $cm2.CommandText = "SELECT MAX(ID${esc(table)}) FROM [${esc(table)}]"
    $lid = $cm2.ExecuteScalar(); $cm2.Dispose() } catch {}
  $c.Close()
  $__result = @{ ok = $true; affected = $n; last_id = $lid; skipped = $skipped; sql = $sql }
`);
  if (r?.ok) {
    let msg = `Inséré avec succès (${r.affected} ligne).`;
    if (r.last_id) msg += ` Dernier ID: ${r.last_id}.`;
    if (r.skipped?.length) msg += `\nChamps calculés ignorés: ${r.skipped.join(", ")}`;
    return { content: [{ type: "text", text: msg }] };
  }
  throw new Error(`Échec INSERT: ${JSON.stringify(r)}`);
}

function handleSchemaSummary({ id }) {
  const { cs } = getConn(id);
  const r = psJson(`
  $c = New-Object System.Data.Odbc.OdbcConnection('${esc(cs)}'); $c.Open()
  $ts = $c.GetSchema("Tables"); $res = @()
  foreach ($tRow in $ts.Rows) {
    $n = $tRow["TABLE_NAME"]
    try { $cm = $c.CreateCommand(); $cm.CommandText = "SELECT COUNT(*) FROM [$n]"
      $rc = [int]$cm.ExecuteScalar(); $cm.Dispose() } catch { $rc = -1 }
    try { $cm2 = $c.CreateCommand(); $cm2.CommandText = "SELECT * FROM [$n] WHERE 1=0"
      $rd = $cm2.ExecuteReader([System.Data.CommandBehavior]::SchemaOnly)
      $st = $rd.GetSchemaTable(); $cols = @()
      foreach ($r in $st.Rows) { $cols += @{ n = $r["ColumnName"]; t = $r["DataType"].Name; s = $r["ColumnSize"] } }
      $rd.Close(); $cm2.Dispose()
    } catch { $cols = @() }
    $res += @{ table = $n; rows = $rc; columns = $cols }
  }
  $c.Close()
  $__result = $res
`);
  const arr = Array.isArray(r) ? r : r ? [r] : [];
  const lines = arr
    .sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))
    .map((t) => {
      const cs = (t.columns || []).map((c) => `${c.n}(${c.t})`).join(", ");
      return `### ${t.table} — ${t.rows} rows, ${(t.columns || []).length} cols\n${cs}\n`;
    });
  return { content: [{ type: "text", text: `${arr.length} tables\n\n${lines.join("\n")}` }] };
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────
const handlers = {
  hfsql_connect: handleConnect,
  hfsql_disconnect: handleDisconnect,
  hfsql_list_tables: handleListTables,
  hfsql_describe_table: handleDescribeTable,
  hfsql_query: handleQuery,
  hfsql_execute: handleExecute,
  hfsql_insert: handleInsert,
  hfsql_schema_summary: handleSchemaSummary,
};

// ─── MCP Server ──────────────────────────────────────────────────────────────
const server = new Server(
  { name: "hfsql-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const fn = handlers[name];
  if (!fn) return { content: [{ type: "text", text: `Outil inconnu: ${name}` }], isError: true };
  try {
    return fn(args || {});
  } catch (err) {
    return { content: [{ type: "text", text: `Erreur: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

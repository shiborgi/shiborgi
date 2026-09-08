# Remove Lastro

For each agent group that carries the route, drop it and restart:

```bash
ncl groups config remove-mcp-server --id <group-id> --name lastro
ncl groups restart --id <group-id>
```

Remove the `mcpServers.lastro` entry from `gateway/config/gateway.json`, and
drop `lastro` from every group's `agents` policy — deleting an `agents` entry
outright only when that group was added for Lastro alone. Remove the
`LASTRO_MCP_TOKEN*` keys from `gateway/config/secrets.env`, preserving every
unrelated model and integration credential. The gateway re-reads both files
per request, so it keeps running as it is.

Revoke each credential in Lastro, so a leaked token stays useless:

```bash
container exec <lastro-postgres> psql -U lastro -d lastro \
  -c "UPDATE agent_credentials SET revoked_at = now() WHERE principal = 'agent:<group-id>'"
```

Return the Lastro stack to loopback-only publishing by reinstalling it without
the extra route:

```bash
bun run apple-container install
```

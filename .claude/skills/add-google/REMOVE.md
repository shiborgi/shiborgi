# Remove Google Workspace

For each agent group, remove every Google logical MCP server and restart it:

```bash
ncl groups config remove-mcp-server --id <group-id> --name google-drive
ncl groups config remove-mcp-server --id <group-id> --name google-calendar
ncl groups restart --id <group-id>
```

Remove the corresponding `mcpServers`, `oauthProfiles`, and exact `agents`
policy entries from `gateway/config/gateway.json`. Remove only the Google
keys owned by that profile from `gateway/config/secrets.env`, preserving all
unrelated model and integration credentials. Finally revoke the application
grant in the connected Google account.

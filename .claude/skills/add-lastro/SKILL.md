---
name: add-lastro
description: Give one or more NanoClaw agent groups access to a self-hosted Lastro financial ledger through the install gateway. Use for bookkeeping, expense, revenue, settlement, or cash-flow automation over Lastro's MCP.
---

# Add Lastro

Lastro is a self-hosted double-entry ledger whose write surface is an MCP
server. This skill routes that server through the **install gateway**, so the
agent container holds no Lastro URL and no Lastro credential — it learns only
that a tool called `lastro` exists.

```nc:operator
This workflow needs a Lastro agent credential and a decision about which host address the gateway may reach. Continue in this guided skill; write the credential straight to the gateway secrets file, never into chat.
```

## 1. Choose scope

Ask for the Lastro checkout path, the Book the agents act on, and the agent
groups that may reach it. Mint **one credential per agent group** so the
`audit_events` trail names the group that made each write. Do not use the
wildcard `"*"` in the gateway `agents` policy for the Lastro route.

## 2. Give the gateway a route to the MCP

The gateway container attaches to two networks: the runtime's default bridge
and the install's egress network (`src/gateway-container.ts`). Agent
containers attach only to the egress network, which is created `--internal`
(`src/egress-lockdown.ts`) — they have no route to the host at all. So the
gateway is the one process that can reach a host port, and that is the
property this wiring depends on.

A Lastro stack published on loopback is unreachable from every container.
Publish the **MCP container alone** on an address the gateway can reach,
leaving the dashboard, the API and postgres on loopback:

```bash
container network inspect default   # Apple Container: read `ipv4Gateway`
```

Typical addresses: `192.168.64.1` on Apple Container, `host.docker.internal`
(or the `docker0` address) on Docker. In the Lastro checkout, reinstall the
stack with that address and a port of its own:

```bash
LASTRO_MCP_EXTRA_PUBLISH=192.168.64.1:3013 bun run apple-container install
```

Give the extra route a **different host port** from the loopback one: Apple
Container refuses two publish specs that share a host port even when their
addresses differ (`host ports for different publish port specs may not
overlap`).

Confirm the split before going further — the MCP answers, the rest does not:

```bash
curl -sS http://192.168.64.1:3013/health   # {"status":"ok",...}
curl -sS http://192.168.64.1:3010/         # refused: dashboard stays on loopback
```

## 3. Mint a credential

From the Lastro checkout, once per agent group:

```bash
DATABASE_URL=postgres://lastro:<password>@127.0.0.1:<pg-port>/lastro \
  bun run bootstrap --email <owner-email> --password '<owner-passphrase>' \
  --agent agent:<group-id>
```

It prints `<credentialId>.<secret>` once. A Lastro credential is bound to one
Book, so `Authorization` is the only header the route carries — which is
exactly what a gateway MCP route models.

## 4. Configure the gateway

`gateway/config/gateway.json` and `gateway/config/secrets.env` are created by
the gateway bootstrap if absent. Add the route under `mcpServers`:

```json
"lastro": {
  "url": "http://192.168.64.1:3013/mcp",
  "auth": { "header": "Authorization", "format": "Bearer {value}", "secret": "LASTRO_MCP_TOKEN" }
}
```

Plain HTTP is correct here: the address is a host-only bridge that the LAN
cannot reach, and the URL never leaves the gateway.

Write the token to `gateway/config/secrets.env`, one key per group when the
groups use separate credentials, and keep the file mode `0600`:

```
LASTRO_MCP_TOKEN=<credentialId>.<secret>
```

Add an exact `agents` entry for each permitted group, listing only `lastro`
among its MCP servers. The gateway re-reads both files per request, so the
gateway container keeps running as it is.

## 5. Register the route with each group

```bash
ncl groups config add-mcp-server --id <group-id> --name lastro --gateway-route lastro
ncl groups restart --id <group-id>
```

`--gateway-route` stores the route name and nothing else, so the URL and the
credential stay on the gateway.

## 6. Verify

Confirm the group config holds `type: "gateway"` and the route name, then
prove the three properties that matter:

```bash
# The gateway reaches the MCP.
container exec <gateway-container> bun -e 'console.log((await fetch("http://192.168.64.1:3013/health")).status)'

# An agent container does not — it has no route to the host.
container run --rm --network <egress-network> oven/bun:1-alpine \
  bun -e 'fetch("http://192.168.64.1:3013/health",{signal:AbortSignal.timeout(5000)}).then(()=>console.log("REACHED")).catch(()=>console.log("no route"))'
```

Then ask an agent in a permitted group to list its Lastro tools and read one
Book summary, and confirm the call lands in Lastro's `audit_events` under that
group's principal. An agent in a group with no `agents` entry for `lastro`
must be refused by the gateway.

## Testing

This skill's only functional reach-in is a runtime operator action — an
`ncl` registration plus two gateway config files — with no line in the source
tree whose deletion a test could catch, so it ships no in-tree integration
test. The verification in step 6 is the guard.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `host ports for different publish port specs may not overlap` | The extra publish reuses the loopback port. Give it its own port. |
| Agent reports the tool is missing | The group has no `agents` entry naming `lastro`, or it was registered without `ncl groups restart`. |
| Gateway returns 404 for `lastro` | The route name in `mcpServers` and the `--gateway-route` value differ; they are the join key. |
| Gateway times out reaching Lastro | The MCP is published on loopback only, or on an address the default bridge does not carry. Re-check step 2 with `curl` from the host. |
| Lastro returns 401 | The token in `secrets.env` is revoked, truncated, or missing the `<credentialId>.<secret>` join. |
| A name resolves in a container but never connects | Container DNS maps container names to container IPs on their own network. The gateway is not a member of Lastro's network, so it cannot route there; address the host bridge instead. |

## Removal

See [REMOVE.md](REMOVE.md). Revoke the Lastro credential after removing the
route; deleting the token from `secrets.env` leaves it valid in Lastro.

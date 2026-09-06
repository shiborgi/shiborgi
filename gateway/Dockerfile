# The gateway image: one small Bun service, no build step.
#
# Pinned by digest-free exact tag because this image is rebuilt per install and
# a moving base would mean two clones of the same commit running different
# runtimes. Nothing is compiled — Bun runs the TypeScript directly, the same
# way the agent-runner does.
FROM oven/bun:1.4.0-alpine

WORKDIR /app

# Source only. Config and its secrets arrive as a read-only mount at run time,
# so a built image never contains a credential and can be rebuilt freely.
COPY src ./src
COPY package.json tsconfig.json ./

# No package install: the service uses only Bun's standard library and
# node:crypto. Keeping it dependency-free is what makes the supply-chain
# surface of this container effectively the base image alone.

ENV GATEWAY_PORT=8080
EXPOSE 8080

# Runs unprivileged. The image's `bun` user owns nothing under /app that the
# service writes, because the service writes nothing.
USER bun

ENTRYPOINT ["bun", "run", "/app/src/index.ts"]

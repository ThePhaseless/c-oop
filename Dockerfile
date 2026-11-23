# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
# Only the files the toolchain script imports, so an edit anywhere else keeps this slow layer cached.
COPY tsconfig.json ./
COPY scripts/toolchain.ts scripts/
COPY src/shared/toolchain.ts src/shared/
# The cache mount holds the 124 MB sysroot tarball; it never lands in a layer. Locked: the script names its
# temp paths by process id, which is the same in every build container, so two builds must not share it at once.
RUN --mount=type=cache,target=/app/.cache,sharing=locked bun scripts/toolchain.ts
COPY . .
RUN bun run build
# The server and its one npm package become one file, so the final image carries no node_modules.
RUN bun build src/server/server.ts --target=bun --outfile=server.js

# The server is the one bundled file; dist is served as it is.
FROM oven/bun:1.4.5-distroless@sha256:3a210956422ad81cf7532e1fc1f2eb9275d6ef4c2337a9d25d530f798e80726a
WORKDIR /app
COPY --from=build /app/dist dist
COPY --from=build /app/server.js server.js
USER 65532:65532
ENV PORT=8080
EXPOSE 8080
# Exec form: distroless has no shell. Exits 1 on a refused connection or a non-200 answer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=1s --retries=3 \
  CMD ["/usr/local/bin/bun", "-e", "const r = await fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').catch(() => null); process.exit(r?.ok ? 0 : 1)"]
# The base image's entrypoint is bun.
CMD ["server.js"]

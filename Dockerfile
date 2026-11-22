# syntax=docker/dockerfile:1

FROM oven/bun:1.4.4-alpine AS build
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

# The server imports no npm package, so the final image carries no node_modules.
FROM oven/bun:1.4.4-distroless
WORKDIR /app
COPY --from=build /app/dist dist
COPY --from=build /app/src/server src/server
COPY --from=build /app/src/shared src/shared
USER 65532:65532
ENV PORT=8080
EXPOSE 8080
# Exec form: distroless has no shell. Exits 1 on a refused connection or a non-200 answer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=1s --retries=3 \
  CMD ["/usr/local/bin/bun", "-e", "const r = await fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').catch(() => null); process.exit(r?.ok ? 0 : 1)"]
# The base image's entrypoint is bun.
CMD ["src/server/server.ts"]

// Runs the browser suite against the Docker image: build, start, wait for /healthz, `bun run e2e`, always `down`.
// Extra arguments go to the suite: `bun run e2e:docker -t "01 smoke"`. COOP_PORT picks the host port.
const port = process.env.COOP_PORT ?? '8080'
const compose = ['docker', 'compose', '-p', 'c-oop-e2e']
const base = `http://localhost:${port}`

let child: Bun.Subprocess | undefined
const run = (cmd: string[], env?: Record<string, string>) => {
  child = Bun.spawn(cmd, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } })
  return child.exited
}

// One shared promise: the signal handler and the `finally` below both wait for the same `down`.
let downing: Promise<number> | undefined
const down = () => (downing ??= run([...compose, 'down']))
// A signal sent to this process alone does not reach the suite or a running build; stop it, then remove the container.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (!downing) child?.kill()
    void down().then(() => process.exit(130))
  })
}

/** Why the wait ended: null when healthy, otherwise the reason. Polls every 1 s for at most 60 s. */
async function waitHealthy(): Promise<string | null> {
  const start = Date.now()
  const took = () => `${((Date.now() - start) / 1000).toFixed(1)} s`
  for (;;) {
    const ok = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)
    if (ok) {
      console.log(`[e2e-docker] healthy after ${took()}`)
      return null
    }
    // `restart: unless-stopped` shows a crashed container as "restarting", so anything but "running" counts as exited.
    const state = (await Bun.$`${compose} ps -a --format {{.State}}`.nothrow().text()).trim()
    if (state !== 'running') return `container exited (state: ${state || 'none'}) after ${took()}`
    if (Date.now() - start >= 60_000) return `deadline: ${base}/healthz not ok after ${took()}`
    await Bun.sleep(1000)
  }
}

let code = 1
try {
  if ((await run([...compose, 'build'])) !== 0) throw new Error('docker compose build failed')
  if ((await run([...compose, 'up', '-d'])) !== 0) throw new Error(`docker compose up failed (is port ${port} taken?)`)
  const why = await waitHealthy()
  if (why) {
    await run([...compose, 'logs', '--tail', '50'])
    throw new Error(why)
  }
  code = await run(['bun', 'run', 'e2e', ...process.argv.slice(2)], { BASE_URL: base })
  console.log(`[e2e-docker] suite exited with code ${code}`)
} catch (e) {
  console.error(`[e2e-docker] ${e instanceof Error ? e.message : e}`)
} finally {
  await down()
}
process.exit(code)

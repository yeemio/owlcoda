// 手动跑某日复盘:npm run review -- --date=YYYY-MM-DD
// 复用 server 的 buildDailyDeps 不便(它在 index.ts 内),CLI 直接打 endpoint。
export {}

const arg = process.argv.find((a) => a.startsWith('--date='))
const date = arg ? arg.slice('--date='.length) : new Date(Date.now() + 480 * 60_000).toISOString().slice(0, 10)
const base = process.env.SERVER_BASE ?? 'http://127.0.0.1:8030'

const res = await fetch(`${base}/api/review/run?date=${date}`, { method: 'POST' })
const body = await res.json()
console.log(JSON.stringify(body, null, 2))
if (!res.ok || body.ok === false) process.exit(1)

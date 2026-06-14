// 进程内每日定时器。tzOffsetMin = 目标时区相对 UTC 的分钟数(BJT=+480)。
import { runDailyReview, type DailyDeps } from './daily.js'

export function nextDailyFireDelayMs(now: Date, hhmm: string, tzOffsetMin: number): number {
  const [h, m] = hhmm.split(':').map(Number)
  // 把 now 平移到目标时区,算当天目标时刻,再换回 epoch
  const local = new Date(now.getTime() + tzOffsetMin * 60_000)
  const targetLocal = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m, 0, 0))
  let targetEpoch = targetLocal.getTime() - tzOffsetMin * 60_000
  if (targetEpoch <= now.getTime()) targetEpoch += 24 * 60 * 60 * 1000
  return targetEpoch - now.getTime()
}

export function startDailyScheduler(opts: {
  hhmm: string
  tzOffsetMin: number
  buildDeps: () => DailyDeps
  dateOf: (d: Date) => string
}): () => void {
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    const delay = nextDailyFireDelayMs(new Date(), opts.hhmm, opts.tzOffsetMin)
    timer = setTimeout(async () => {
      try {
        const deps = opts.buildDeps()
        const out = await runDailyReview(opts.dateOf(deps.now), deps)
        console.log(`[review] daily run: graded=${out.graded} proposed=${out.proposed} skipped=${out.skipped}`)
      } catch (err) {
        console.error('[review] daily run failed:', err)
      }
      arm() // 重新武装到次日
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }
  arm()
  return () => clearTimeout(timer)
}

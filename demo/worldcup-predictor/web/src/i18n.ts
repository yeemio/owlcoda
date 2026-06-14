import { useSyncExternalStore } from 'react'

export type Lang = 'zh' | 'en'

const KEY = 'wc26.lang'
let current: Lang = (localStorage.getItem(KEY) as Lang) || 'zh'
const listeners = new Set<() => void>()

export function setLang(lang: Lang) {
  current = lang
  localStorage.setItem(KEY, lang)
  listeners.forEach((l) => l())
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
  )
}

const dict: Record<string, { zh: string; en: string }> = {
  appTitle: { zh: '世界杯 2026 预测工作台', en: 'World Cup 2026 Predictor' },
  navFixtures: { zh: '赛程', en: 'Fixtures' },
  navMatch: { zh: '比赛分析', en: 'Analysis' },
  navTeams: { zh: '球队画像', en: 'Teams' },
  navSettings: { zh: '设置', en: 'Settings' },
  navReviews: { zh: '战绩', en: 'Results' },
  localBadge: { zh: '🔒 全程本地 · 数据不出你的电脑', en: '🔒 Fully local · your data stays home' },
  footer: {
    zh: '你的模型,你的工具,你的数据。分析框架移植自 hermes-football 三角辩论体系;所有结论均为辩论包,非投注建议。',
    en: 'Your models. Your tools. Your data. Debate framework ported from hermes-football; all outputs are debate packets, not betting advice.',
  },
  heroKicker: { zh: 'OWLCODA AGENT INSIDE', en: 'OWLCODA AGENT INSIDE' },
  heroTitle1: { zh: '不是一个模型在预测,', en: "It's not one model predicting —" },
  heroTitle2: { zh: '是一支由 OwlCoda 指挥的模型战队', en: "it's a model squad commanded by OwlCoda" },
  heroSub: {
    zh: '每场比赛,OwlCoda 编排三个角色互相攻防:侦查官立论 → 风控官拆台 → 裁判官裁决。模型怎么选、谁失败了切谁、每一步花了多少 token——全程它调度,全程可审计。',
    en: 'For every match, OwlCoda orchestrates three adversarial roles: a Scout argues, a Risk Auditor attacks, a Judge compiles the verdict. Model routing, failure fallback, per-step token accounting — all scheduled by the agent, all auditable.',
  },
  heroPoint1T: { zh: '角色级智能路由', en: 'Role-level routing' },
  heroPoint1D: { zh: '侦查/风控/裁决各配最合适的模型,本地与云端任意混编', en: 'Best model per role — local and cloud mixed freely' },
  heroPoint2T: { zh: '失败自愈', en: 'Self-healing' },
  heroPoint2D: { zh: '主模型超时熔断,fallback 自动接管,辩论不中断', en: 'Circuit-break on timeout, fallback takes over, debate never stalls' },
  heroPoint3T: { zh: '推理全程可审计', en: 'Auditable reasoning' },
  heroPoint3D: { zh: '每个角色用了谁、多少 token、多久,run manifest 全记录', en: 'Which model, how many tokens, how long — every run manifested' },
  heroPoint4T: { zh: '反编造纪律', en: 'Anti-fabrication discipline' },
  heroPoint4D: { zh: '证据缺失就标 unsupported,agent 被禁止编数据硬推', en: 'Missing evidence is labeled, never invented — pass over bluff' },
  heroModelsOnline: { zh: '个模型在线待命', en: 'models standing by' },
  heroOffline: { zh: 'OwlCoda 未连接 — 运行 owlcoda serve 后战队即刻上线', en: 'OwlCoda offline — run owlcoda serve to bring the squad online' },
  heroCta: { zh: '⚡ 看一场三模型辩论 →', en: '⚡ Watch a 3-model debate →' },
  viewGroups: { zh: '小组赛分组', en: 'Groups' },
  viewSchedule: { zh: '完整赛程', en: 'Schedule' },
  groupWord: { zh: '组', en: 'Group' },
  matchesInGroup: { zh: '组内赛程', en: 'Group fixtures' },
  knockout: { zh: '淘汰赛', en: 'Knockout' },
  tbd: { zh: '对阵未定', en: 'TBD' },
  showcaseBadge: { zh: '示例分析', en: 'Showcase' },
  bjt: { zh: '北京时间', en: 'BJT' },
  stage_all: { zh: '全部', en: 'All' },
  stage_group: { zh: '小组赛', en: 'Group stage' },
  stage_round32: { zh: '32强', en: 'Round of 32' },
  stage_round16: { zh: '16强', en: 'Round of 16' },
  stage_quarter: { zh: '1/4决赛', en: 'Quarter-finals' },
  stage_semi: { zh: '半决赛', en: 'Semi-finals' },
  stage_third: { zh: '季军赛', en: 'Third place' },
  stage_final: { zh: '决赛', en: 'Final' },
  engineTitle: { zh: 'OwlCoda 引擎 · 实时路由', en: 'OwlCoda Engine · Live Routing' },
  battleSeats: { zh: '角色作战席', en: 'Role Battle Seats' },
  modelHealth: { zh: '模型健康(owlcoda /health)', en: 'Model Health (owlcoda /health)' },
  runManifest: { zh: '本次 Run Manifest', en: 'Run Manifest' },
  replayMark: { zh: '历史回放', en: 'REPLAY' },
  totalTime: { zh: '总耗时', en: 'Total' },
  auditHint: { zh: '完整审计见', en: 'full audit via' },
  codeCard: { zh: '接入只需这几行 ▸', en: 'Integration: a few lines ▸' },
  collapse: { zh: '收起', en: 'Collapse' },
  browser: { zh: '浏览器', en: 'Browser' },
  flowFooter: { zh: '🔒 全链路在本机 · 你的模型由 OwlCoda 统一调度', en: '🔒 All on-device · models routed by OwlCoda' },
  fallbackFlash: { zh: '主模型 {from} 失败,OwlCoda 已自动切换 → {to}', en: 'primary {from} failed, OwlCoda auto-switched → {to}' },
  statusIdle: { zh: '待命', en: 'idle' },
  statusRunning: { zh: '推理中…', en: 'thinking…' },
  statusDone: { zh: '完成', en: 'done' },
  statusError: { zh: '失败', en: 'failed' },
  proxyOffline: { zh: '— 离线,请运行 owlcoda serve', en: '— offline, run owlcoda serve' },
}

export function useT() {
  const lang = useLang()
  return (key: string, vars?: Record<string, string>) => {
    let s = dict[key]?.[lang] ?? key
    for (const [k, v] of Object.entries(vars ?? {})) s = s.replace(`{${k}}`, v)
    return s
  }
}

export function teamLabel(name: string, zh: string | undefined, lang: Lang): string {
  return lang === 'zh' && zh ? zh : name
}

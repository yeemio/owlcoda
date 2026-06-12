import { streamMessage } from './owlcoda.js'
import { runWebRecon } from './recon.js'
import { buildEvidence, type Fixture, type TeamProfile } from './framework/evidence.js'
import { proPrompt, antiPrompt, judgePrompt } from './framework/prompts.js'
import { extractJson } from './framework/parse.js'
import type {
  AnalyzeEvent,
  AnalyzeRequest,
  AntiOutput,
  JudgeOutput,
  ProOutput,
  Role,
  RoleManifestEntry,
} from './framework/types.js'

// Dedicated multimodal stage: transcribe uploaded images into structured
// text so ALL debate roles share the same evidence (no vision asymmetry).
async function runVisionExtraction(
  req: AnalyzeRequest,
  emit: (e: AnalyzeEvent) => void,
): Promise<{ text: string; manifest: RoleManifestEntry } | null> {
  const images = req.inputs.images ?? []
  const model = req.visionModel
  if (images.length === 0 || !model) return null
  const baseUrl = req.owlcodaBaseUrl ?? DEFAULT_OWLCODA
  emit({ type: 'role_start', role: 'vision', model })
  try {
    const result = await streamMessage({
      baseUrl,
      model,
      system:
        '你是证据转录员。只转录图片中真实可见的内容(赔率、盘口、水位、阵容、文字等),按图逐一输出结构化文本;看不清就写"不可辨认"。严禁推断、补全或分析。',
      user: `请逐张转录以下 ${images.length} 张图片的全部可读内容。`,
      images,
      onDelta: (text) => emit({ type: 'token_delta', role: 'vision', text }),
    })
    const manifest: RoleManifestEntry = {
      role: 'vision',
      model,
      fallbackUsed: false,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      parsed: true,
    }
    emit({ type: 'role_done', role: 'vision', output: null, raw: result.text, manifest })
    return { text: result.text, manifest }
  } catch (err) {
    emit({ type: 'role_error', role: 'vision', error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

const DEFAULT_OWLCODA = 'http://127.0.0.1:8019'

interface RoleRunResult {
  output: ProOutput | AntiOutput | JudgeOutput | null
  raw: string
  manifest: RoleManifestEntry
}

async function runRole(
  role: Role,
  prompt: { system: string; user: string },
  req: AnalyzeRequest,
  emit: (e: AnalyzeEvent) => void,
): Promise<RoleRunResult> {
  const cfg = req.roles[role]
  const baseUrl = req.owlcodaBaseUrl ?? DEFAULT_OWLCODA
  const candidates = [cfg.model, ...(cfg.fallback && cfg.fallback !== cfg.model ? [cfg.fallback] : [])]
  let lastError = ''
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i]
    if (i > 0) emit({ type: 'role_fallback', role, from: candidates[0], to: model, reason: lastError })
    emit({ type: 'role_start', role, model })
    try {
      let result = await streamMessage({
        baseUrl,
        model,
        system: prompt.system,
        user: prompt.user,
        onDelta: (text) => emit({ type: 'token_delta', role, text }),
      })
      // Reasoning models can burn the whole budget on thinking and emit no
      // text at all — retry once with a doubled budget before giving up.
      if (!result.text.trim() && result.stopReason === 'max_tokens') {
        result = await streamMessage({
          baseUrl,
          model,
          system: `${prompt.system}\n注意:直接给出最终 JSON,压缩思考过程。`,
          user: prompt.user,
          maxTokens: 32768,
          onDelta: (text) => emit({ type: 'token_delta', role, text }),
        })
      }
      // First parse attempt; on failure ask the same model once to repair format.
      let raw = result.text
      let output = extractJson<ProOutput | AntiOutput | JudgeOutput>(raw)
      if (!output && raw.trim().length > 0) {
        const repair = await streamMessage({
          baseUrl,
          model,
          system: '你上一次的输出不是合法 JSON。只返回一个修复后的 JSON 对象,不要任何其他内容。',
          user: raw,
          onDelta: (text) => emit({ type: 'token_delta', role, text }),
        })
        raw = repair.text
        output = extractJson<ProOutput | AntiOutput | JudgeOutput>(raw)
      }
      const manifest: RoleManifestEntry = {
        role,
        model,
        fallbackUsed: i > 0,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        parsed: output != null,
      }
      emit({ type: 'role_done', role, output, raw, manifest })
      return { output, raw, manifest }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  emit({ type: 'role_error', role, error: lastError })
  throw new Error(`role ${role} failed: ${lastError}`)
}

export interface AnalysisArtifacts {
  matchKey: string
  evidenceBrief: string
  vision: string | null
  recon: string | null
  pro: unknown
  anti: unknown
  judge: unknown
  manifests: RoleManifestEntry[]
  totalMs: number
}

export async function runAnalysis(
  req: AnalyzeRequest,
  fixture: Fixture,
  home: TeamProfile | null,
  away: TeamProfile | null,
  emit: (e: AnalyzeEvent) => void,
  onArtifacts?: (a: AnalysisArtifacts) => void,
): Promise<void> {
  const started = Date.now()
  let { brief, dimensions } = buildEvidence(fixture, home, away, req.inputs)
  const matchKey = `${fixture.home_team}::${fixture.away_team}::${fixture.match_datetime_utc ?? 'TBD'}`
  emit({
    type: 'run_start',
    matchKey,
    roles: { pro: req.roles.pro.model, anti: req.roles.anti.model, judge: req.roles.judge.model },
    singleModel: req.singleModel,
    dimensions,
  })
  const manifests: RoleManifestEntry[] = []
  // Stage 0a: owlcoda-agent web reconnaissance (optional, experimental).
  let reconText: string | null = null
  if (req.webRecon && req.reconModel) {
    emit({ type: 'role_start', role: 'recon', model: req.reconModel })
    try {
      const recon = await runWebRecon({
        model: req.reconModel,
        homeTeam: fixture.home_team,
        awayTeam: fixture.away_team,
        kickoff: fixture.match_datetime_utc ?? 'TBD',
      })
      reconText = recon.text
      const reconManifest: RoleManifestEntry = {
        role: 'recon',
        model: recon.model,
        fallbackUsed: false,
        durationMs: recon.durationMs,
        parsed: true,
      }
      manifests.push(reconManifest)
      emit({ type: 'role_done', role: 'recon', output: null, raw: recon.text, manifest: reconManifest })
      emit({ type: 'recon_sources', sources: recon.sources })
      brief += `\n\n## 联网侦查情报(owlcoda agent WebSearch,${recon.model};媒体来源,需与其他证据互证)\n${recon.text}\n\n来源清单:\n${recon.sources.map((s) => `- ${s.title}: ${s.url}`).join('\n')}`
    } catch (err) {
      emit({ type: 'role_error', role: 'recon', error: err instanceof Error ? err.message : String(err) })
      brief += '\n\n## 联网侦查声明\n联网侦查已开启但执行失败,本轮无新闻情报;不得假装检索过网页。'
    }
  }

  // Stage 0b: image transcription — shared by all roles via the brief.
  const vision = await runVisionExtraction(req, emit)
  if (vision) {
    manifests.push(vision.manifest)
    brief += `\n\n## 图片证据转录(由多模态模型 ${vision.manifest.model} 识别;单源,未交叉验证;以下数字视为用户提供的图片证据)\n${vision.text}`
  } else if ((req.inputs.images?.length ?? 0) > 0) {
    brief += '\n\n## 图片证据声明\n用户上传了图片,但未配置可用的多模态识别模型,图片内容未被读取。该缺口必须表述为"图片不可读",不得表述为"用户未提供"。'
  }
  try {
    const pro = await runRole('pro', proPrompt(brief), req, emit)
    manifests.push(pro.manifest)
    const proJson = pro.output ? JSON.stringify(pro.output, null, 1) : pro.raw

    const anti = await runRole('anti', antiPrompt(brief, proJson), req, emit)
    manifests.push(anti.manifest)
    const antiJson = anti.output ? JSON.stringify(anti.output, null, 1) : anti.raw

    const judge = await runRole('judge', judgePrompt(brief, proJson, antiJson), req, emit)
    manifests.push(judge.manifest)

    const totalMs = Date.now() - started
    emit({ type: 'manifest', roles: manifests, totalMs })
    emit({ type: 'done' })
    onArtifacts?.({
      matchKey,
      evidenceBrief: brief,
      vision: vision?.text ?? null,
      recon: reconText,
      pro: pro.output ?? pro.raw,
      anti: anti.output ?? anti.raw,
      judge: judge.output ?? judge.raw,
      manifests,
      totalMs,
    })
  } catch (err) {
    if (manifests.length > 0) emit({ type: 'manifest', roles: manifests, totalMs: Date.now() - started })
    emit({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

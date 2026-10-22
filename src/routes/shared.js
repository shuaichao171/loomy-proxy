/**
 * 路由层共用的小工具：探测响应类型、缓存的 JSON 解析、usage 归一。
 */

import { parseErrorEnvelope } from '../upstream/client.js'

export function isEventStream (response) {
  const type = String(response?.headers?.get?.('content-type') || '').toLowerCase()
  return type.includes('text/event-stream')
}

/**
 * 把上游响应体读成文本并缓存到 response 上，避免多次消费 body。
 * 返回 { raw, json, envelope }；envelope 非空表示这是上游的业务错误信封。
 */
export async function tapJson (response) {
  if (response.__loomyTap) return response.__loomyTap
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    raw = ''
  }
  let json = null
  try { json = raw ? JSON.parse(raw) : null } catch { json = null }
  const envelope = parseErrorEnvelope(json)
  const tapped = { raw, json, envelope, status: response.status, ok: response.ok }
  response.__loomyTap = tapped
  return tapped
}

export function readCachedJson (response) {
  return response.__loomyTap || null
}

/**
 * 归一化 usage。Loomy 在 OpenAI usage 里额外给 points_consumed；
 * Anthropic 侧是 input_tokens / output_tokens。
 */
export function extractUsage (usage) {
  if (!usage || typeof usage !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, points: 0, raw: null }
  }
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens)) || 0
  const points = Number(usage.points_consumed ?? usage.points ?? 0) || 0
  return { promptTokens, completionTokens, totalTokens, points, raw: usage }
}

/** 从 Anthropic 事件流里抓 usage（message_start 与 message_delta 各带一半）。 */
export function createAnthropicUsageCollector () {
  const state = { inputTokens: 0, outputTokens: 0, points: 0, model: '' }
  return {
    observe (event) {
      if (!event || typeof event !== 'object') return
      if (event.type === 'message_start' && event.message) {
        if (event.message.model) state.model = String(event.message.model)
        const usage = event.message.usage || {}
        state.inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0
        state.outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0
        state.points = Number(usage.points_consumed ?? state.points) || 0
      }
      if (event.type === 'message_delta') {
        const usage = event.usage || {}
        if (usage.output_tokens) state.outputTokens = Number(usage.output_tokens) || state.outputTokens
        if (usage.points_consumed) state.points = Number(usage.points_consumed) || state.points
      }
      if (event.type === 'message_stop' && event.usage) {
        const usage = event.usage
        if (usage.points_consumed) state.points = Number(usage.points_consumed) || state.points
      }
    },
    snapshot () {
      return {
        promptTokens: state.inputTokens,
        completionTokens: state.outputTokens,
        totalTokens: state.inputTokens + state.outputTokens,
        points: state.points,
        model: state.model,
      }
    },
  }
}

/**
 * 把上游的失败 body 压成一句可读的错误信息。
 *
 * 上游有两种失败形态：
 *   1. Loomy 网关信封  { code, desc, trace_id }
 *   2. 透传的后端错误  { error: { message, type, code, metadata:{ provider_name } } }
 * 后者常见于模型实际落在第三方（dashscope 等）时，必须把 message 提出来，
 * 否则客户端只能看到一坨 JSON 字符串。
 */
export function describeErrorBody (parsed) {
  if (!parsed) return '上游返回空响应'
  const json = parsed.json
  const nested = json?.error
  if (nested && typeof nested === 'object') {
    const provider = nested.metadata?.provider_name ? ` (${nested.metadata.provider_name})` : ''
    return `${nested.message || nested.type || 'upstream error'}${provider}`
  }
  if (typeof nested === 'string' && nested) return nested
  if (json?.desc) return String(json.desc)
  if (json?.message) return String(json.message)
  return String(parsed.raw || '').slice(0, 300) || `上游返回 HTTP ${parsed.status}`
}

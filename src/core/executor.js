/**
 * 上游请求编排：把下游请求翻译成 Loomy 上游请求，并处理
 * 「HTTP 200 但是业务错误信封」「流式失败可切换账号」这些上游特有的坑。
 */

import { parseErrorEnvelope } from '../upstream/client.js'

export class UpstreamExhaustedError extends Error {
  constructor (message, { lastError = null, attempts = 0 } = {}) {
    super(message)
    this.name = 'UpstreamExhaustedError'
    this.lastError = lastError
    this.attempts = attempts
  }
}

const RETRYABLE_CODES = new Set([
  '429', '100429', '500', '502', '503', '504',
  'TIMEOUT', 'NETWORK', 'ECONNRESET', 'ECONNREFUSED',
])

function isRetryableError (error) {
  if (!error) return false
  if (error.authInvalid) return true
  const code = String(error.code || '')
  if (RETRYABLE_CODES.has(code)) return true
  if (/^HTTP_5/.test(code)) return true
  if (/^HTTP_429$/.test(code)) return true
  return false
}

/**
 * 执行一次上游调用，失败自动换账号重试。
 *
 * @param {object} params
 * @param {import('./scheduler.js').Scheduler} params.scheduler
 * @param {(account: object) => Promise<{ response: Response }>} params.execute
 *        execute 内部只负责「发请求并返回 Response」，抛错表示网络层失败。
 * @param {(response: Response) => Promise<object|null>} [params.inspect]
 *        判断 Response 是否为业务错误（非流式 JSON 时调用）。
 */
export async function withAccountFailover ({
  scheduler,
  execute,
  inspect = null,
  maxRetries = 2,
  affinityKey = '',
  onAttempt = null,
}) {
  const candidates = scheduler.candidates({ affinityKey })
  if (candidates.length === 0) {
    throw new UpstreamExhaustedError('没有可用账号：请先在管理台登录或导入 Loomy 账号', { attempts: 0 })
  }

  const attempts = Math.max(1, Math.min(candidates.length, maxRetries + 1))
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const account = candidates[attempt]
    try {
      const raw = await execute(account)
      // execute 可能直接返回 Response，也可能返回 { response, ...extras }；
      // Response 的属性挂在原型上，直接 {...response} 会得到一个空对象。
      const isWrapped = Boolean(raw) && typeof raw === 'object' && 'response' in raw
      const response = isWrapped ? raw.response : raw
      if (inspect) {
        const envelopeError = await inspect(response)
        if (envelopeError) {
          lastError = envelopeError
          scheduler.failure(account.id, {
            reason: `${envelopeError.code}: ${envelopeError.message}`,
            authInvalid: envelopeError.authInvalid === true,
          })
          onAttempt?.({ account, error: envelopeError, attempt })
          if (!isRetryableError(envelopeError) && !envelopeError.authInvalid) {
            throw new UpstreamExhaustedError(envelopeError.message, { lastError: envelopeError, attempts: attempt + 1 })
          }
          continue
        }
      }
      onAttempt?.({ account, error: null, attempt })
      return { ...(isWrapped ? raw : {}), response, account, attempts: attempt + 1 }
    } catch (error) {
      if (error instanceof UpstreamExhaustedError) throw error
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'upstream timeout'
        : (error?.cause?.message || error?.message || 'network error')
      lastError = { code: 'NETWORK', message: reason, authInvalid: false }
      scheduler.failure(account.id, { reason })
      onAttempt?.({ account, error: lastError, attempt })
    }
  }

  throw new UpstreamExhaustedError(
    lastError ? `所有账号均失败：${lastError.message}` : '所有账号均失败',
    { lastError, attempts },
  )
}

export { parseErrorEnvelope, isRetryableError }

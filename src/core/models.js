/**
 * 模型目录：从上游 GET /models 拉取并缓存（含能力、上下文、协议），
 * 同时投影成 OpenAI 与 Anthropic 客户端认识的形状。
 *
 * 上游条目关键字段（实测）：
 *   { id, name, protocol: 'openai_chat' | 'anthropic_messages', context_length,
 *     max_output_tokens, capabilities:{reasoning,vision,function_calling,...},
 *     reasoning_efforts, default_reasoning_effort, is_default_model, is_default_small_model }
 */

import fs from 'node:fs'
import path from 'node:path'

const PROTOCOL_ALIASES = {
  openai: 'openai',
  openai_chat: 'openai',
  anthropic: 'anthropic',
  anthropic_messages: 'anthropic',
}

export function normalizeProtocol (value) {
  const text = String(value || '').trim().toLowerCase()
  return PROTOCOL_ALIASES[text] || null
}

function toPositiveInt (value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null
}

export function normalizeModel (raw = {}) {
  const id = String(raw.id || '').trim()
  if (!id) return null
  const capabilities = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {}
  const inputModalities = Array.isArray(capabilities.input_modalities)
    ? capabilities.input_modalities.map((item) => String(item).toLowerCase())
    : ['text']
  const outputModalities = Array.isArray(capabilities.output_modalities)
    ? capabilities.output_modalities.map((item) => String(item).toLowerCase())
    : ['text']
  return {
    id,
    name: String(raw.name || raw.displayName || id).trim() || id,
    protocol: normalizeProtocol(raw.protocol) || 'openai',
    created: Number(raw.created) || Math.floor(Date.now() / 1000),
    ownedBy: String(raw.owned_by || 'loomy'),
    type: String(raw.type || 'chat'),
    contextLength: toPositiveInt(raw.context_length ?? raw.context_window ?? raw.limit?.context),
    maxOutputTokens: toPositiveInt(raw.max_output_tokens ?? raw.max_completion_tokens ?? raw.limit?.output),
    inputModalities,
    outputModalities,
    capabilities: {
      reasoning: capabilities.reasoning === true || raw.reasoning === true,
      vision: capabilities.vision === true || inputModalities.includes('image'),
      functionCalling: capabilities.function_calling === true || raw.tool_call === true,
      streaming: capabilities.streaming !== false,
      systemMessage: capabilities.system_message !== false,
    },
    reasoningEfforts: Array.isArray(raw.reasoning_efforts) ? raw.reasoning_efforts.map(String) : [],
    defaultReasoningEffort: String(raw.default_reasoning_effort || ''),
    isDefaultModel: raw.is_default_model === true,
    isDefaultSmallModel: raw.is_default_small_model === true,
    raw,
  }
}

export class ModelCatalog {
  constructor ({ cacheFile, logger = null } = {}) {
    this.cacheFile = cacheFile
    this.logger = logger
    this.models = []
    this.fetchedAt = 0
    this.meta = {}
    this.load()
  }

  load () {
    if (!this.cacheFile) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))
      if (Array.isArray(parsed?.models)) {
        this.models = parsed.models
        this.fetchedAt = Number(parsed.fetchedAt) || 0
        this.meta = parsed.meta || {}
      }
    } catch {
      // 缓存缺失/损坏都不影响启动
    }
  }

  persist () {
    if (!this.cacheFile) return
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      fs.writeFileSync(this.cacheFile, JSON.stringify({
        fetchedAt: this.fetchedAt,
        meta: this.meta,
        models: this.models,
      }, null, 2), 'utf8')
    } catch (error) {
      this.logger?.warn('模型缓存写入失败', { error: error.message })
    }
  }

  update (rawModels, meta = {}) {
    const normalized = []
    const seen = new Set()
    for (const raw of rawsafe(rawModels)) {
      const model = normalizeModel(raw)
      if (!model || seen.has(model.id)) continue
      seen.add(model.id)
      normalized.push(model)
    }
    if (normalized.length > 0) {
      this.models = normalized
      this.meta = meta
      this.fetchedAt = Date.now()
      this.persist()
    }
    return this.models
  }

  get (id) {
    const target = String(id || '').trim()
    if (!target) return null
    return this.models.find((model) => model.id === target) || null
  }

  defaultModelId () {
    const flagged = this.models.find((model) => model.isDefaultModel)
    return flagged?.id || this.models[0]?.id || ''
  }

  isStale (ttlMs = 10 * 60 * 1000) {
    return !this.fetchedAt || Date.now() - this.fetchedAt > ttlMs
  }

  /** OpenAI /v1/models 形状，额外挂上协议与能力，方便客户端识别推理/视觉模型。 */
  toOpenAiList ({ publicBaseUrl = '' } = {}) {
    return {
      object: 'list',
      data: this.models.map((model) => ({
        id: model.id,
        object: 'model',
        created: model.created,
        owned_by: model.ownedBy,
        type: model.type,
        protocol: model.protocol,
        context_length: model.contextLength,
        max_output_tokens: model.maxOutputTokens,
        capabilities: model.capabilities,
        input_modalities: model.inputModalities,
        output_modalities: model.outputModalities,
        reasoning_efforts: model.reasoningEfforts,
        default_reasoning_effort: model.defaultReasoningEffort,
        ...(model.isDefaultModel ? { is_default_model: true } : {}),
        ...(publicBaseUrl ? { owned_by_url: publicBaseUrl } : {}),
      })),
    }
  }

  /** 找一个可用的默认模型：优先 openai 协议，其次第一个。 */
  pickDefault (preferredProtocol = '') {
    if (preferredProtocol) {
      const match = this.models.find((model) => model.protocol === preferredProtocol)
      if (match) return match.id
    }
    return this.defaultModelId()
  }
}

function rawsafe (value) {
  return Array.isArray(value) ? value : []
}

import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import { useSettings } from '../settings.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const defaultMessagesBaseUrl = `${API_ORIGIN}/anthropic/v1`
const messagesBaseUrl = () => useSettings.getState().modelEndpoint || defaultMessagesBaseUrl
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }

    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

export type ConnectorStatus = {
  id: string
  displayName: string
  description: string
  auth: string
  scopes: string[]
  operations: Array<{ id: string; name: string; description: string; readOnly: boolean; permissionClass: string }>
  status: string
  integrationId?: string
  enabled: boolean
}

export const listConnectors = async (signal?: AbortSignal): Promise<ConnectorStatus[]> => {
  const response = await request(`${API_ORIGIN}/connectors`, { method: 'GET', signal })
  const body = await response.json() as { connectors?: ConnectorStatus[] }
  return body.connectors ?? []
}


const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal, endpoint?: string): Promise<void> => {
  const base = endpoint?.trim().replace(/\/+$/, '') || API_ORIGIN
  await request(`${base}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${messagesBaseUrl()}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${messagesBaseUrl()}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {}
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${messagesBaseUrl()}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...extraHeaders,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }

  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

export type RunEvent = {
  id: string
  version: 1
  runId: string
  conversationId: string
  sequence: number
  type: string
  timestamp: string
  payload: Record<string, unknown>
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

export type RunRecord = {
  id: string
  conversationId: string
  status: RunStatus
  updatedAt: string
  error?: string
}

export type ApprovalRecord = {
  id: string
  runId: string
  conversationId: string
  toolId: string
  arguments: unknown
  permissionClass: string
  status: string
  expiresAt: string
  createdAt: string
  error?: string
}

export const listApprovals = async (
  apiKey: string,
  workspace = 'local',
  signal?: AbortSignal
): Promise<ApprovalRecord[]> => {
  const response = await request(`${API_ORIGIN}/approvals`, {
    headers: { ...anthropicHeaders(apiKey, false), 'x-deepseek-ui-workspace': workspace },
    signal,
  })
  const body = (await response.json()) as { approvals?: ApprovalRecord[] }
  return Array.isArray(body.approvals) ? body.approvals : []
}

export const decideApproval = async (
  apiKey: string,
  approvalId: string,
  decision: 'approved' | 'denied',
  workspace = 'local'
): Promise<ApprovalRecord> => {
  const response = await request(`${API_ORIGIN}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST',
    headers: { ...anthropicHeaders(apiKey, false), 'content-type': 'application/json', 'x-deepseek-ui-workspace': workspace },
    body: JSON.stringify({ decision }),
  })
  return ((await response.json()) as { approval: ApprovalRecord }).approval
}

export type RecoveryState = {
  run: RunRecord
  checkpoint?: {
    phase: string
    sequence: number
    pendingToolCalls: Array<{ id: string; function: { name: string; arguments: string } }>
    approvalIds: string[]
  }
  approval?: ApprovalRecord
  recoverable: boolean
}

export const getRecoveryState = async (
  apiKey: string,
  runId: string,
  workspace = 'local',
  signal?: AbortSignal
): Promise<RecoveryState> => {
  const response = await request(`${API_ORIGIN}/runs/${encodeURIComponent(runId)}/recovery`, {
    headers: { ...anthropicHeaders(apiKey, false), 'x-deepseek-ui-workspace': workspace },
    signal,
  })
  return (await response.json()) as RecoveryState
}

export const resumeRun = async (
  apiKey: string,
  runId: string,
  workspace = 'local'
): Promise<RunRecord> => {
  const response = await request(`${API_ORIGIN}/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { ...anthropicHeaders(apiKey, false), 'x-deepseek-ui-workspace': workspace },
  })
  return ((await response.json()) as { run: RunRecord }).run
}

export const listRuns = async (
  apiKey: string,
  workspace = 'local',
  signal?: AbortSignal
): Promise<RunRecord[]> => {
  const response = await request(`${API_ORIGIN}/runs`, {
    method: 'GET',
    headers: {
      ...anthropicHeaders(apiKey, false),
      'x-deepseek-ui-workspace': workspace,
    },
    signal,
  })
  const body = (await response.json()) as { runs?: RunRecord[] }
  return Array.isArray(body.runs) ? body.runs : []
}

/** Replays durable gateway events after a disconnect, de-duplicating event IDs. */
export async function* streamRunEvents(
  apiKey: string,
  runId: string,
  signal: AbortSignal,
  lastEventId?: string,
  extraHeaders: Record<string, string> = {}
): AsyncGenerator<RunEvent> {
  const response = await request(`${API_ORIGIN}/runs/${encodeURIComponent(runId)}/events`, {
    method: 'GET',
    headers: {
      ...anthropicHeaders(apiKey, false),
      Accept: 'text/event-stream',
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      ...extraHeaders,
    },
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', 'Run event stream has no body', response.status)
  }
  const seen = new Set<string>()
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    try {
      const event = JSON.parse(data) as RunEvent
      if (!seen.has(event.id)) {
        seen.add(event.id)
        yield event
      }
    } catch {
      // Ignore malformed replay frames; the normal message stream remains authoritative.
    }
  }
}

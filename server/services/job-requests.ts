import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, getTableColumns, isNull, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { db } from '../db'
import { jobs, jobRequests, projects } from '../db/schema'
import type { JobDetail, JobRequest } from '../../shared/types'

export const jobContext = new AsyncLocalStorage<{ id: string; attempt: number }>()
// Polling never loads potentially large request bodies or result snapshots.
const { input: _input, result: _result, ...columns } = getTableColumns(jobs)
export const jobColumns = columns
const {
  requestHeaders: _requestHeaders,
  requestBody: _requestBody,
  responseHeaders: _responseHeaders,
  responseBody: _responseBody,
  responseEncoding: _responseEncoding,
  responseStatusText: _responseStatusText,
  curl: _curl,
  ...requestColumns
} = getTableColumns(jobRequests)

export async function getJobDetail(id: string): Promise<JobDetail> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id))
  if (!row) throw createError({ statusCode: 404, statusMessage: '任务不存在' })
  const { input, result, ...job } = row
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, job.projectId))
  const requests = await db
    .select(requestColumns)
    .from(jobRequests)
    .where(eq(jobRequests.jobId, id))
    .orderBy(asc(jobRequests.startedAt), asc(jobRequests.id))
  return { job, projectName: project?.name || '项目', input, result, requests }
}

export async function getJobRequest(jobId: string, id: string): Promise<JobRequest> {
  const [request] = await db
    .select()
    .from(jobRequests)
    .where(and(eq(jobRequests.jobId, jobId), eq(jobRequests.id, id)))
  if (!request) throw createError({ statusCode: 404, statusMessage: '请求记录不存在' })
  return request
}

const sensitiveHeader = /^(authorization|proxy-authorization|cookie|set-cookie|.*api[-_]key|.*token.*)$/i
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function requestRedactor(secrets: string[] = []) {
  const values = [
    ...new Set([
      ...secrets,
      ...Object.entries(process.env)
        .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key))
        .map(([, value]) => value || '')
    ])
  ]
    .filter((value) => value.length > 3)
    .sort((a, b) => b.length - a.length)
  return (value: string) => {
    for (const secret of values) value = value.replaceAll(secret, '[已隐藏]')
    return value
  }
}

function safeHeaders(headers: Headers, redact: (value: string) => string) {
  return Object.fromEntries(
    [...headers].map(([name, value]) => [name, sensitiveHeader.test(name) ? '[已隐藏]' : redact(value)])
  )
}

export function requestCurl(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
  credential?: { header: string; env: string; prefix?: string }
) {
  const parts = ['curl', '--request ' + quote(method), '--url ' + quote(url)]
  for (const [name, value] of Object.entries(headers)) {
    const variable =
      credential?.header.toLowerCase() === name.toLowerCase() && /^[A-Z][A-Z0-9_]*$/.test(credential.env)
        ? credential
        : undefined
    parts.push(
      '--header ' +
        (variable
          ? `${quote(`${name}: ${variable.prefix || ''}`)}"\${${variable.env}}"`
          : quote(`${name}: ${value}`))
    )
  }
  if (body !== null) parts.push('--data-binary @-')
  // printf is a shell builtin; a large base64 reference won't exceed exec's argument limit.
  return (body === null ? '' : `printf '%s' ${quote(body)} | \\\n`) + parts.join(' \\\n  ')
}

export interface RequestOptions {
  label: string
  secrets?: string[]
  credential?: { header: string; env: string; prefix?: string }
  binary?: boolean
}

/** Persist before starting I/O; never tie provider lifetime to the browser request. */
export async function jobFetch(url: string, init: RequestInit, options: RequestOptions): Promise<Response> {
  const context = jobContext.getStore()
  if (!context) return fetch(url, init)
  const redact = requestRedactor(options.secrets)
  const method = init.method || 'GET'
  const headers = safeHeaders(new Headers(init.headers), redact)
  const body = typeof init.body === 'string' ? redact(init.body) : null
  const id = randomUUID(),
    startedAt = Date.now()
  await db.insert(jobRequests).values({
    id,
    jobId: context.id,
    attempt: context.attempt,
    label: options.label,
    method,
    url: redact(url),
    requestHeaders: headers,
    requestBody: body,
    curl: requestCurl(method, redact(url), headers, body, options.credential),
    startedAt
  })
  try {
    const response = await fetch(url, init)
    await db
      .update(jobRequests)
      .set({
        responseStatus: response.status,
        responseStatusText: response.statusText,
        responseHeaders: safeHeaders(response.headers, redact)
      })
      .where(eq(jobRequests.id, id))
    const bytes = Buffer.from(await response.clone().arrayBuffer())
    const binary = options.binary && response.ok
    await db
      .update(jobRequests)
      .set({
        responseBody: binary ? bytes.toString('base64') : redact(bytes.toString('utf8')),
        responseEncoding: binary ? 'base64' : 'utf8',
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        error: response.ok ? null : `HTTP ${response.status} ${response.statusText}`
      })
      .where(eq(jobRequests.id, id))
    return response
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error))
    await db
      .update(jobRequests)
      .set({ error: message, finishedAt: Date.now(), durationMs: Date.now() - startedAt })
      .where(eq(jobRequests.id, id))
    throw new Error(message, { cause: error })
  }
}

export async function interruptJobRequests() {
  await db
    .update(jobRequests)
    .set({
      error: '本地服务退出，请求已中断；可在任务详情中重试',
      finishedAt: Date.now(),
      durationMs: sql`${Date.now()} - ${jobRequests.startedAt}`
    })
    .where(isNull(jobRequests.finishedAt))
}

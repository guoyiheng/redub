import { timingSafeEqual } from 'node:crypto'
export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/')) return
  const host = getRequestHeader(event, 'host') || ''
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host))
    throw createError({ statusCode: 403, statusMessage: '仅允许本机访问' })
  const origin = getRequestHeader(event, 'origin')
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`)
    throw createError({ statusCode: 403, statusMessage: '不允许跨站请求' })
  if (getRequestHeader(event, 'sec-fetch-site') === 'cross-site')
    throw createError({ statusCode: 403, statusMessage: '不允许跨站请求' })
  const secret = process.env.REDUB_SESSION_TOKEN
  if (secret) {
    const supplied = getCookie(event, 'redub-session') || ''
    if (supplied.length !== secret.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret)))
      throw createError({ statusCode: 401, statusMessage: '请从桌面应用打开项目' })
  }
})

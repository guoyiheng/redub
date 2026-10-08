import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects, jobs, segments } from '../server/db/schema'
import { enqueue, eligibleJobs, tick } from '../server/services/queue'
import { defaultSettings } from '../shared/settings'
import { jobTransaction } from '../server/services/job-transaction'

beforeAll(initDb)

describe('多项目并发与本地处理', () => {
  it('两个项目同时发起识别台词批量任务，正常入队且不发生数据库锁冲突', async () => {
    const id1 = randomUUID()
    const id2 = randomUUID()

    await db.insert(projects).values([
      {
        id: id1,
        name: '项目 1',
        kind: 'audio',
        duration: 20,
        sourcePath: `${id1}/source.mp3`,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        id: id2,
        name: '项目 2',
        kind: 'audio',
        duration: 30,
        sourcePath: `${id2}/source.mp3`,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ])

    // 同时发起两项目的识别台词（prepare）
    const [p1Jobs, p2Jobs] = await Promise.all([
      enqueue(id1, undefined, undefined, { action: 'prepare', scope: 'missing' }),
      enqueue(id2, undefined, undefined, { action: 'prepare', scope: 'missing' })
    ])

    expect(p1Jobs.map((j) => j.stage)).toEqual(['separate', 'segment', 'transcribe'])
    expect(p2Jobs.map((j) => j.stage)).toEqual(['separate', 'segment', 'transcribe'])

    // 验证数据库中两项目的任务均已成功写入
    const allDbJobs = await db.select().from(jobs)
    const p1InDb = allDbJobs.filter((j) => j.projectId === id1)
    const p2InDb = allDbJobs.filter((j) => j.projectId === id2)
    expect(p1InDb).toHaveLength(3)
    expect(p2InDb).toHaveLength(3)
    expect(p1InDb.every((j) => ['queued', 'running'].includes(j.status))).toBe(true)
    expect(p2InDb.every((j) => ['queued', 'running'].includes(j.status))).toBe(true)
    expect(allDbJobs.some((j) => [id1, id2].includes(j.projectId) && j.status === 'failed')).toBe(false)
  })

  it('两个项目并发执行写事务与进度更新，无 SQLITE_BUSY 报错', async () => {
    const id1 = randomUUID()
    const id2 = randomUUID()

    await db.insert(projects).values([
      { id: id1, name: 'Tx1', kind: 'audio', duration: 10, createdAt: Date.now(), updatedAt: Date.now() },
      { id: id2, name: 'Tx2', kind: 'audio', duration: 10, createdAt: Date.now(), updatedAt: Date.now() }
    ])

    // 模拟两个项目同时完成阶段并触发写事务，同时有进度更新
    const operations = [
      jobTransaction(async (tx) => {
        await tx
          .update(projects)
          .set({ vocalsPath: `${id1}/vocals.wav` })
          .where(eq(projects.id, id1))
        await tx.insert(segments).values([
          { id: `${id1}-s1`, projectId: id1, start: 0, end: 5, text: 'A' },
          { id: `${id1}-s2`, projectId: id1, start: 5, end: 10, text: 'B' }
        ])
      }),
      jobTransaction(async (tx) => {
        await tx
          .update(projects)
          .set({ vocalsPath: `${id2}/vocals.wav` })
          .where(eq(projects.id, id2))
        await tx.insert(segments).values([
          { id: `${id2}-s1`, projectId: id2, start: 0, end: 4, text: 'C' },
          { id: `${id2}-s2`, projectId: id2, start: 4, end: 8, text: 'D' }
        ])
      }),
      db.update(projects).set({ updatedAt: Date.now() }).where(eq(projects.id, id1)),
      db.update(projects).set({ updatedAt: Date.now() }).where(eq(projects.id, id2))
    ]

    await expect(Promise.all(operations)).resolves.not.toThrow()

    const s1 = await db.select().from(segments).where(eq(segments.projectId, id1))
    const s2 = await db.select().from(segments).where(eq(segments.projectId, id2))
    expect(s1).toHaveLength(2)
    expect(s2).toHaveLength(2)
  })
})

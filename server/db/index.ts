import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as schema from './schema'

export const dataDir = resolve(process.env.REDUB_DATA_DIR || '.data')
mkdirSync(dataDir, { recursive: true })
const client = createClient({ url: pathToFileURL(join(dataDir, 'redub.sqlite')).href })
export const db = drizzle(client, { schema })
let ready: Promise<void> | undefined
export function initDb() {
  return (ready ??= (async () => {
    await client.execute('PRAGMA journal_mode=WAL')
    await client.execute('PRAGMA foreign_keys=ON')
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, sourcePath TEXT, duration REAL NOT NULL DEFAULT 0,
        sourceLanguage TEXT NOT NULL DEFAULT 'auto', targetLanguage TEXT NOT NULL DEFAULT '中文',
        channelId TEXT NOT NULL DEFAULT 'volcengine-default', paused INTEGER NOT NULL DEFAULT 0,
        audioPath TEXT, vocalsPath TEXT, backgroundPath TEXT, mixedPath TEXT, outputPath TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS segments (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), start REAL NOT NULL, end REAL NOT NULL,
        text TEXT NOT NULL DEFAULT '', translation TEXT NOT NULL DEFAULT '', speaker TEXT NOT NULL DEFAULT '角色 1',
        enabled INTEGER NOT NULL DEFAULT 1, referencePath TEXT, generatedPath TEXT, generatedHash TEXT,
        generatedDuration REAL, subtitle TEXT
      );
      CREATE INDEX IF NOT EXISTS segments_project ON segments(projectId);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), stage TEXT NOT NULL, segmentId TEXT,
        status TEXT NOT NULL DEFAULT 'queued', progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '等待执行',
        error TEXT, dependsOn TEXT, attempts INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(projectId);
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL,
        keyEnv TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, pitch INTEGER NOT NULL DEFAULT 0,
        speed INTEGER NOT NULL DEFAULT 0, loudness INTEGER NOT NULL DEFAULT 0, apiKey TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;
    `)
    const columns = await client.execute('PRAGMA table_info(channels)')
    if (!columns.rows.some((row) => row.name === 'apiKey'))
      await client.execute('ALTER TABLE channels ADD COLUMN apiKey TEXT')
    await db
      .insert(schema.channels)
      .values([
        {
          id: 'volcengine-default',
          name: '火山 Audio',
          type: 'volcengine',
          endpoint: 'https://openspeech.bytedance.com/api/v3/tts/create',
          model: 'seed-audio-1.0',
          keyEnv: 'VOLCENGINE_API_KEY'
        },
        {
          id: 'translation-default',
          name: '台词翻译',
          type: 'openai',
          endpoint: process.env.TRANSLATION_BASE_URL || 'https://api.openai.com/v1',
          model: process.env.TRANSLATION_MODEL || 'gpt-4o-mini',
          keyEnv: 'TRANSLATION_API_KEY'
        }
      ])
      .onConflictDoNothing()
  })())
}

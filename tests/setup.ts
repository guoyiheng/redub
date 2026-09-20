import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
const dir = mkdtempSync(join(tmpdir(), 'redub-test-'))
process.env.REDUB_DATA_DIR = dir
process.env.VOLCENGINE_API_KEY = 'test-key-not-a-real-secret'
process.env.TRANSLATION_API_KEY = 'test-translation-key'
afterAll(() => rmSync(dir, { recursive: true, force: true }))

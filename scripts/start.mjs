import { existsSync } from 'node:fs'
if (existsSync('.env')) process.loadEnvFile('.env')
process.env.HOST = '127.0.0.1'
process.env.NITRO_HOST = '127.0.0.1'
await import('../.output/server/index.mjs')

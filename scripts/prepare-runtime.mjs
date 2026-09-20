// Nitro cannot statically trace libSQL's platform-dependent require().
import { readdir, cp, access } from 'node:fs/promises'
import { join } from 'node:path'
for (const name of await readdir('node_modules/@libsql')) {
  const source = join('node_modules/@libsql', name)
  try {
    await access(join(source, 'index.node'))
  } catch {
    continue
  }
  await cp(source, join('.output/server/node_modules/@libsql', name), { recursive: true })
}

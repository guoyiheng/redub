export function formatVersionName(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const yy = pad(date.getFullYear() % 100)
  const MM = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())
  return `v_${yy}${MM}${dd}_${hh}:${mm}`
}

export function createVersionName(existing: string[] = [], date = new Date()): string {
  const base = formatVersionName(date)
  if (!existing.includes(base)) return base
  let idx = 2
  while (existing.includes(`${base}_${idx}`)) {
    idx++
  }
  return `${base}_${idx}`
}

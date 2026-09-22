import type { ReferenceVoice } from '../../shared/types'

export function useReferenceVoices() {
  const voices = useState<ReferenceVoice[]>('reference-voices', () => [])
  async function load() {
    voices.value = await $fetch<ReferenceVoice[]>('/api/reference-voices')
  }
  async function add(file: File, name: string) {
    const body = new FormData()
    body.set('file', file)
    if (name.trim()) body.set('name', name.trim())
    const voice = await $fetch<ReferenceVoice>('/api/reference-voices', { method: 'POST', body })
    voices.value = [voice, ...voices.value]
    return voice
  }
  async function rename(id: string, name: string) {
    const voice = await $fetch<ReferenceVoice>(`/api/reference-voices/${id}`, {
      method: 'PATCH',
      body: { name }
    })
    voices.value = voices.value.map((item) => (item.id === id ? voice : item))
  }
  return { voices, load, add, rename }
}

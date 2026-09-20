import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, initDb } from '../server/db'
import { projects, segments } from '../server/db/schema'
import { projectDir, ffmpeg, probe, assetPath } from '../server/services/media'
import { getProject, getSegments, getChannel } from '../server/services/store'
import { executeJob } from '../server/services/pipeline'
import { synthesizeSpeech, translateLines } from '../server/services/providers'
import type { Job, Stage } from '../shared/types'

let id: string, dir: string, voice: Buffer
const progress = async () => {}
const run = (stage: Stage) => executeJob({ id: randomUUID(), projectId: id, stage, segmentId: null } as Job, progress)
beforeAll(async () => {
  await initDb(); id=randomUUID(); dir=await projectDir(id)
  await ffmpeg(['-f','lavfi','-i','color=c=0x30302e:s=320x180:r=24:d=4','-f','lavfi','-i','sine=frequency=220:duration=4:sample_rate=48000','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',join(dir,'source.mp4')])
  await ffmpeg(['-f','lavfi','-i','sine=frequency=880:duration=0.7:sample_rate=48000','-c:a','libmp3lame',join(dir,'fixture.mp3')])
  voice=await readFile(join(dir,'fixture.mp3'))
  await db.insert(projects).values({id,name:'真实音视频验证',kind:'video',sourcePath:`${id}/source.mp4`,duration:4,createdAt:Date.now(),updatedAt:Date.now()})
})
afterEach(()=>vi.unstubAllGlobals())
describe.sequential('媒体处理与服务协议',()=>{
  it('提取真实视频音轨并保留全长',async()=>{ await run('extract'); const p=await getProject(id); expect((await probe(assetPath(p.audioPath!))).duration).toBeCloseTo(4,1) })
  it('参考原音色发送火山规定的请求，落盘音频及字幕',async()=>{
    await copyFile(join(dir,'original.wav'),join(dir,'reference.wav'))
    await db.insert(segments).values([{id:'line-1',projectId:id,start:1,end:2,text:'Hello',translation:'你好',referencePath:`${id}/reference.wav`},{id:'line-2',projectId:id,start:2.5,end:3,text:'Keep this',enabled:false}])
    const fetcher=vi.fn(async(_url, options)=>{
      const body=JSON.parse(options.body)
      expect(options.headers['X-Api-Key']).toBe('test-key-not-a-real-secret')
      expect(body.model).toBe('seed-audio-1.0'); expect(body.text_prompt).toContain('@音频1'); expect(body.references[0].audio_data).toBeTruthy(); expect(body.audio_config.sample_rate).toBe(48000)
      return new Response(JSON.stringify({audio:voice.toString('base64'),duration:.7,subtitle:{text:'你好',sentences:[]}}))
    })
    vi.stubGlobal('fetch',fetcher)
    await run('synthesize'); const lines=await getSegments(id)
    expect(lines[0]!.generatedPath).toBeTruthy(); expect(lines[1]!.generatedPath).toBeNull()
    await run('synthesize'); expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('合并仅替换启用片段，未替换原始 PCM 保持一致',async()=>{
    await ffmpeg(['-f','lavfi','-i','sine=frequency=110:duration=4:sample_rate=48000','-ac','2',join(dir,'background.wav')])
    await db.update(projects).set({backgroundPath:`${id}/background.wav`}).where(eq(projects.id,id))
    await run('mix'); const p=await getProject(id)
    expect((await probe(assetPath(p.mixedPath!))).duration).toBeCloseTo(4,2)
    for (const [name,path] of [['original',p.audioPath!],['mixed',p.mixedPath!]]) await ffmpeg(['-i',assetPath(path),'-f','s16le','-acodec','pcm_s16le',join(dir,`${name}.pcm`)])
    const before=await readFile(join(dir,'original.pcm')), after=await readFile(join(dir,'mixed.pcm'))
    const bytesPerSecond=48000*2*2
    expect(after.subarray(0,bytesPerSecond).equals(before.subarray(0,bytesPerSecond))).toBe(true)
    expect(after.subarray(2*bytesPerSecond,4*bytesPerSecond).equals(before.subarray(2*bytesPerSecond,4*bytesPerSecond))).toBe(true)
    expect(after.subarray(bytesPerSecond,2*bytesPerSecond).equals(before.subarray(bytesPerSecond,2*bytesPerSecond))).toBe(false)
    // Both the known background tone and generated tone must survive inside replacement.
    const amplitude=(hz:number)=>{let re=0,im=0;for(let n=0;n<48000;n++){const sample=after.readInt16LE(bytesPerSecond+n*4)/32768;re+=sample*Math.cos(2*Math.PI*hz*n/48000);im+=sample*Math.sin(2*Math.PI*hz*n/48000)}return Math.hypot(re,im)/48000}
    expect(amplitude(110)).toBeGreaterThan(.02); expect(amplitude(880)).toBeGreaterThan(.02)
  })
  it('导出含视频与新音轨的 MP4，以及时间轴字幕',async()=>{ await run('preview'); const p=await getProject(id); const info=await probe(assetPath(p.outputPath!)); expect(info.video).toBe(true); expect(info.duration).toBeCloseTo(4,1); expect(await readFile(join(dir,'subtitles.srt'),'utf8')).toContain('你好') })
  it('翻译缺少台词时拒绝部分结果',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{"translations":[]}'}}]}))))
    await expect(translateLines(await getSegments(id),'中文',await getChannel('translation-default'))).rejects.toThrow('不完整')
  })
  it('上游错误不能被当成有效配音',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({code:400,message:'invalid reference'}))))
    await expect(synthesizeSpeech((await getSegments(id))[0]!,await getChannel('volcengine-default'),join(dir,'invalid.mp3'))).rejects.toThrow('invalid reference')
  })
})

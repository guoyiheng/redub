module.exports = {
  appId: 'run.yiheng.redub',
  productName: 'ReDub',
  icon: 'build/icon.png',
  artifactName: 'ReDub-${version}-${os}-${arch}.${ext}',
  directories: { output: 'release' },
  files: ['electron/**/*', 'package.json'],
  extraResources: [
    { from: '.output', to: '.output' },
    { from: 'scripts', to: 'scripts', filter: ['audio.py', 'requirements.txt', 'install-models.sh'] },
    { from: require('ffmpeg-static'), to: `bin/${process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}` },
    {
      from: require('ffprobe-static').path,
      to: `bin/${process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'}`
    }
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.video',
    hardenedRuntime: true,
    icon: 'build/icon.icns'
  },
  dmg: {
    contents: [
      { x: 145, y: 160 },
      { x: 415, y: 160, type: 'link', path: '/Applications' }
    ]
  },
  win: { target: ['nsis'], icon: 'build/icon.ico' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: { target: ['AppImage'], category: 'AudioVideo' },
  ...(process.env.REDUB_UPDATE_URL
    ? { publish: { provider: 'generic', url: process.env.REDUB_UPDATE_URL } }
    : {})
}

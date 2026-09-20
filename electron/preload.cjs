const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld(
  'redub',
  Object.freeze({
    update: (action) => {
      if (!['check', 'download', 'install', 'web', 'config', 'models'].includes(action))
        return Promise.reject(new Error('无效操作'))
      return ipcRenderer.invoke('redub:update', action)
    }
  })
)

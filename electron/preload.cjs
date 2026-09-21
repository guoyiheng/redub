const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld(
  'redub',
  Object.freeze({
    update: (action) => {
      if (!['status', 'check', 'download', 'install', 'web', 'models'].includes(action))
        return Promise.reject(new Error('无效操作'))
      return ipcRenderer.invoke('redub:update', action)
    },
    onUpdateStatus: (callback) => {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('redub:update-status', listener)
      return () => ipcRenderer.removeListener('redub:update-status', listener)
    }
  })
)

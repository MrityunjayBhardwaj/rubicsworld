import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Watch public/diorama.glb for changes and emit a custom HMR event. Vite
 * normally hot-reloads JS modules, but files in `public/` are served as
 * static assets — they don't go through the module graph, so a glb
 * overwrite (from the Blender addon's Live Mode) doesn't trigger anything
 * client-side. This plugin wires the gap: on file change, push a
 * `diorama:changed` event with a timestamp over the HMR socket. TileGrid
 * listens for it and re-fetches the glb with a cache-busting query, then
 * swaps the scene in place — no page reload, Leva knob state preserved.
 */
function dioramaHotReload(): Plugin {
  const watchPath = path.resolve(__dirname, 'public/diorama.glb')
  return {
    name: 'diorama-hot-reload',
    configureServer(server) {
      server.watcher.add(watchPath)
      server.watcher.on('change', (file) => {
        if (path.resolve(file) === watchPath) {
          server.ws.send({
            type: 'custom',
            event: 'diorama:changed',
            data: { ts: Date.now() },
          })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), dioramaHotReload()],
})

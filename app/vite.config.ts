import vue from '@vitejs/plugin-vue'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { env } from 'node:process'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'

const host = env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // No application feature consumes arbitrary local VITE_* configuration.
  envDir: false,
  envPrefix: [],
  plugins: [vue(), UnoCSS(), {
    name: 'reviewed-public-assets',
    apply: 'build',
    generateBundle() {
      const directory = resolve(__dirname, 'public')
      const logo = resolve(directory, 'logo.png')
      if (lstatSync(directory).isSymbolicLink() || lstatSync(logo).isSymbolicLink()) {
        throw new Error('Public assets must be ordinary source files.')
      }
      this.emitFile({ type: 'asset', fileName: 'logo.png', source: readFileSync(logo) })
    },
  }],
  build: {
    // Vite otherwise copies ignored and untracked public files into the installer.
    copyPublicDir: false,
    sourcemap: false,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}))

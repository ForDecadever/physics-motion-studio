import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const host = '127.0.0.1'
const port = '4173'
const baseUrl = `http://${host}:${port}`
const viteEntry = resolve('node_modules/vite/bin/vite.js')
const playwrightEntry = resolve('node_modules/@playwright/test/cli.js')

function waitForExit(child) {
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
}

async function waitForServer(server) {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`预览服务器提前退出，退出码为 ${server.exitCode}。`)
    }

    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {
      // 启动阶段连接失败是正常现象，短暂等待后重试。
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }

  throw new Error('预览服务器在 20 秒内没有准备完成。')
}

let exitCode = 1
let server = null

try {
  const build = spawn(process.execPath, [viteEntry, 'build'], {
    stdio: 'inherit',
    windowsHide: true,
  })
  const buildResult = await waitForExit(build)
  if (buildResult.code !== 0) {
    throw new Error(`生产构建失败，退出码为 ${buildResult.code ?? 'unknown'}。`)
  }

  server = spawn(
    process.execPath,
    [viteEntry, 'preview', '--host', host, '--port', port, '--strictPort'],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  await waitForServer(server)

  const testRunner = spawn(process.execPath, [playwrightEntry, 'test', ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
  })
  const testResult = await waitForExit(testRunner)
  exitCode = testResult.code ?? 1
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
} finally {
  if (server?.exitCode === null) {
    server.kill()
    await Promise.race([
      waitForExit(server),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
    ])
  }
}

process.exitCode = exitCode

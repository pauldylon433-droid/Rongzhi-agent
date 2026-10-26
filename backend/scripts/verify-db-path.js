// init-db.js 路径回归：显式 DB_PATH 必须被使用；空值 / 空白必须失败；默认开发库不得被创建或修改。
// 只读核对默认库的文件元数据（存在性 / 大小 / mtime），不读取、不写入业务内容。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { DEFAULT_DB_PATH } from '../src/db/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND = resolve(HERE, '..')
const SCRIPT = join(HERE, 'init-db.js')

let failures = 0
const check = (name, cond, detail = '') => {
  const ok = Boolean(cond)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`)
  if (!ok) failures += 1
}

function snapshot(path) {
  const out = {}
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const st = statSync(p)
      out[p] = { exists: true, size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      out[p] = { exists: false }
    }
  }
  return out
}

function runInit(dbPathValue) {
  const env = { ...process.env }
  if (dbPathValue === undefined) delete env.DB_PATH
  else env.DB_PATH = dbPathValue
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: BACKEND, env, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const before = snapshot(DEFAULT_DB_PATH)
const work = mkdtempSync(join(tmpdir(), 'rongzhi-db-path-test-'))
const tempDb = join(work, 'isolated', 'temp-seed.db')

try {
  // 1) 显式临时路径：使用该路径、正常种子；默认库文件元数据不变（不存在则仍不存在）
  const r1 = runInit(tempDb)
  check('显式 DB_PATH：命令成功', r1.code === 0, r1.stderr.slice(0, 200))
  check('显式 DB_PATH：输出声明的是指定路径',
    r1.stdout.includes(`数据库文件：${resolve(tempDb)}`), r1.stdout.split('\n')[0])
  check('显式 DB_PATH：临时库已创建并写入种子', existsSync(tempDb))
  if (existsSync(tempDb)) {
    const db = new Database(tempDb, { readonly: true })
    const users = db.prepare('SELECT count(*) n FROM users').get().n
    const accounts = db.prepare('SELECT count(*) n FROM accounts').get().n
    db.close()
    check('显式 DB_PATH：临时库内容可读（1 用户 / 1 账户）', users === 1 && accounts === 1,
      JSON.stringify({ users, accounts }))
  }
  const after1 = snapshot(DEFAULT_DB_PATH)
  check('显式 DB_PATH：默认库未被创建或修改（存在性 / 大小 / mtime 不变）',
    JSON.stringify(after1) === JSON.stringify(before),
    JSON.stringify({ before, after1 }))

  // 2) 空 DB_PATH：必须失败，且不得回退默认库
  const r2 = runInit('')
  check('空 DB_PATH：拒绝执行并明确提示', r2.code !== 0 && /DB_PATH 已设置但为空/.test(r2.stderr), r2.stderr.slice(0, 160))
  const after2 = snapshot(DEFAULT_DB_PATH)
  check('空 DB_PATH：默认库未被创建或修改',
    JSON.stringify(after2) === JSON.stringify(before), JSON.stringify({ before, after2 }))

  // 3) 仅空白的 DB_PATH：同样拒绝
  const r3 = runInit('   ')
  check('空白 DB_PATH：拒绝执行', r3.code !== 0 && /DB_PATH 已设置但为空/.test(r3.stderr), r3.stderr.slice(0, 160))
  const after3 = snapshot(DEFAULT_DB_PATH)
  check('空白 DB_PATH：默认库未被创建或修改',
    JSON.stringify(after3) === JSON.stringify(before), JSON.stringify({ before, after3 }))
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n== init-db 路径回归：${failures === 0 ? '全部通过 ✅' : '存在失败 ❌'} ==`)
process.exit(failures ? 1 : 0)

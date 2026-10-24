// 单用户演示模式：在服务端固定演示用户，不接受客户端通过 user_id 切换用户。
// 当前尚未实现正式登录认证，接口文档见 docs/api.md。
export const DEMO_USER_NAME = '张三'

export function resolveDemoUser(db) {
  const row = db.prepare('SELECT id, name FROM users WHERE name = ?').get(DEMO_USER_NAME)
  if (!row) {
    throw new Error(`未找到演示用户「${DEMO_USER_NAME}」，请先运行 npm run db:init 初始化数据`)
  }
  return row
}

// 异步竞态防护：同一 key 的多次回读并发时，仅「最新发起」的那次响应可生效，
// 丢弃更早发起的迟到响应（例如：旧 pending 晚于 completed 返回、切换会话后又重开同一 key）。
// 纯函数、无 Vue 依赖，便于独立验证。调用方仍需自行判断该 key 是否仍属于当前视图
// （会话 / 业务事件的归属），本守卫只负责「同一 key 内只认最新请求」。
export function createRequestGuard() {
  const seq = new Map()
  return {
    // 发起一次请求：返回本次请求的令牌（严格递增）
    next(key) {
      const n = (seq.get(key) || 0) + 1
      seq.set(key, n)
      return n
    },
    // 响应到达时：本次令牌是否仍为该 key 的最新令牌
    isLatest(key, token) {
      return seq.get(key) === token
    },
  }
}

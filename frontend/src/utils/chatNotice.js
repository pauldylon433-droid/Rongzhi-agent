// 服务端回复已包含“本轮回答未完成”类提示时，前端不再追加同义提示，避免重复。
const INCOMPLETE_NOTICE_RE = /本轮回答未完成|已达到本轮(?:模型调用|工具执行)上限/

export function hasIncompleteNotice(text) {
  return INCOMPLETE_NOTICE_RE.test(String(text || ''))
}

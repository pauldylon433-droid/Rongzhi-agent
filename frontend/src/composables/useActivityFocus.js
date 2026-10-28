import { ref } from 'vue'

// 「最近任务」聚焦单例：AI 工作区左侧点击某条业务记录后，独立「最近任务」页据此自动展开对应详情。
// 模块级单例 ref，跨视图切换保持不变；TasksView 挂载时读取并消费后即清除。
const focusKey = ref(null)

export function useActivityFocus() {
  function focus(key) {
    if (typeof key === 'string' && key) focusKey.value = key
  }
  function clear() {
    focusKey.value = null
  }
  return { focusKey, focus, clear }
}

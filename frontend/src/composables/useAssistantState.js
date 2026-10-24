import { ref } from 'vue'

// 总览右侧 AI 侧栏的展开 / 收起状态单例：App 外壳据此切换三栏 / 两栏网格，
// 总览页头部的「展开 AI 助手」按钮据此显隐，避免两处各持一份状态导致不同步。
const open = ref(true)

export function useAssistantState() {
  function expand() {
    open.value = true
  }
  function collapse() {
    open.value = false
  }
  function toggle() {
    open.value = !open.value
  }
  return { open, expand, collapse, toggle }
}

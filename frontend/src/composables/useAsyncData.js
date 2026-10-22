import { ref } from 'vue'

// 简单的异步数据状态封装：供「加载 → 成功/失败」的一次性只读请求使用。
// 交易流水需要月份筛选 + 分页 + 竞态防护，逻辑更复杂，单独在其组件内实现。
export function useAsyncData(fetcher) {
  const data = ref(null)
  const loading = ref(false)
  const error = ref('')

  async function load() {
    loading.value = true
    error.value = ''
    try {
      data.value = await fetcher()
    } catch (e) {
      error.value = e && e.message ? e.message : '加载失败'
    } finally {
      loading.value = false
    }
  }

  return { data, loading, error, load }
}

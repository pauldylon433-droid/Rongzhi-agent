<script setup>
import { computed, ref } from 'vue'

// 订阅商户 Logo：优先使用本地静态品牌资源；没有准确品牌 Logo 时统一回退到「商户首字标识」，
// 不冒用其他品牌 Logo。图片加载失败时同样回退到首字标识。
// 本地暂无授权品牌 Logo 资源，故 LOGOS 暂为空——后续接入官方授权静态资源时在此登记
// 商户名 → 资源路径 即可自动启用 <img> 分支。
const props = defineProps({
  merchant: { type: String, default: '' },
  size: { type: Number, default: 24 },
})

const LOGOS = {}

const PALETTE = [
  { bg: '#fee2e2', fg: '#b91c1c' },
  { bg: '#dbeafe', fg: '#1d4ed8' },
  { bg: '#dcfce7', fg: '#15803d' },
  { bg: '#fef3c7', fg: '#b45309' },
  { bg: '#ede9fe', fg: '#6d28d9' },
  { bg: '#cffafe', fg: '#0e7490' },
  { bg: '#ffe4e6', fg: '#be185d' },
  { bg: '#f1f5f9', fg: '#475569' },
]

function hash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h
}

const src = computed(() => LOGOS[props.merchant] || '')
const failed = ref(false)
const initial = computed(() => (props.merchant || '').trim().charAt(0) || '商')
const color = computed(() => PALETTE[hash(props.merchant || '') % PALETTE.length])
</script>

<template>
  <span class="merchant-logo" :style="{ width: size + 'px', height: size + 'px' }">
    <img v-if="src && !failed" :src="src" :alt="merchant" class="merchant-img" @error="failed = true" />
    <span
      v-else
      class="merchant-initial"
      :style="{ background: color.bg, color: color.fg, fontSize: Math.round(size * 0.5) + 'px' }"
    >{{ initial }}</span>
  </span>
</template>

<style scoped>
.merchant-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  flex-shrink: 0;
  overflow: hidden;
}
.merchant-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.merchant-initial {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
</style>

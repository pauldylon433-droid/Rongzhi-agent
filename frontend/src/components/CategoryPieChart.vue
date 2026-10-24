<script setup>
// 分类占比环形图：按后端已入账分类数据渲染。颜色稳定（按分类名确定性取色），
// 中心默认展示该区块总额，悬停切片 / 图例联动高亮并在中心展示该分类金额与占比；
// 图例仅保留「色点 + 分类名」（金额 / 占比由左侧明细表与悬停提示承载，不重复展示）。
// 纯 SVG + viewBox 自适应，事件由 Vue 托管，卸载即清理，无需销毁第三方图表实例。
import { ref, computed, onUnmounted } from 'vue'
import { formatMoney } from '../utils/format.js'
import { categoryColor } from '../utils/categoryColor.js'

const props = defineProps({
  slices: { type: Array, default: () => [] }, // [{ category, amount_cents, count }]，按金额倒序
  totalCents: { type: Number, default: 0 },   // 占比分母（已入账收入 / 支出总额）
  centerLabel: { type: String, default: '' }, // 未悬停时中心主标题
})

const R = 100   // 外半径（viewBox 0 0 220 220，外径约 200px）
const CX = 110
const CY = 110

const hoverIndex = ref(null)

function polar(angle, r) {
  return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)]
}

function arcPath(a0, a1) {
  const [x1, y1] = polar(a0, R)
  const [x2, y2] = polar(a1, R)
  const largeArc = a1 - a0 > Math.PI ? 1 : 0
  return `M ${CX} ${CY} L ${x1.toFixed(3)} ${y1.toFixed(3)} A ${R} ${R} 0 ${largeArc} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`
}

const items = computed(() => {
  const total = props.totalCents || 0
  const list = (props.slices || []).map((s) => ({
    category: s.category,
    amount_cents: s.amount_cents,
    count: s.count,
    color: categoryColor(s.category),
    pct: total > 0 ? ((s.amount_cents / total) * 100).toFixed(1) : '0.0',
  }))
  if (list.length === 0) return list
  if (list.length === 1) {
    list[0].full = true // 单一切片：真实 100% 圆环
    return list
  }
  let cum = 0
  for (const s of list) {
    const a0 = -Math.PI / 2 + cum * 2 * Math.PI
    cum += s.amount_cents / total
    const a1 = -Math.PI / 2 + cum * 2 * Math.PI
    s.d = arcPath(a0, a1)
  }
  return list
})

const centerTitle = computed(() => {
  const i = hoverIndex.value
  const s = i != null ? items.value[i] : null
  return s ? `${s.category} · ${s.pct}%` : props.centerLabel
})
const centerAmount = computed(() => {
  const i = hoverIndex.value
  const s = i != null ? items.value[i] : null
  return formatMoney(s ? s.amount_cents : props.totalCents || 0, 'CNY')
})
const ariaLabel = computed(() => `${props.centerLabel || '分类'}占比`)

onUnmounted(() => {
  hoverIndex.value = null
})
</script>

<template>
  <div class="pie">
    <div v-if="items.length" class="pie-body">
      <div class="pie-visual">
        <svg class="pie-svg" viewBox="0 0 220 220" role="img" :aria-label="ariaLabel">
          <template v-for="(s, i) in items" :key="s.category">
            <circle
              v-if="s.full"
              :cx="CX"
              :cy="CY"
              :r="R"
              :fill="s.color"
              class="pie-slice"
              :class="{ 'is-dim': hoverIndex != null && hoverIndex !== i }"
              @mouseenter="hoverIndex = i"
              @mouseleave="hoverIndex = null"
            />
            <path
              v-else
              :d="s.d"
              :fill="s.color"
              stroke="#ffffff"
              stroke-width="1"
              class="pie-slice"
              :class="{ 'is-dim': hoverIndex != null && hoverIndex !== i }"
              @mouseenter="hoverIndex = i"
              @mouseleave="hoverIndex = null"
            />
          </template>
        </svg>
        <div class="pie-center">
          <span class="pie-center-title">{{ centerTitle }}</span>
          <span class="pie-center-amount">{{ centerAmount }}</span>
        </div>
      </div>
      <ul class="pie-legend">
        <li
          v-for="(s, i) in items"
          :key="s.category"
          class="pie-legend-item"
          :class="{ 'is-active': hoverIndex === i }"
          @mouseenter="hoverIndex = i"
          @mouseleave="hoverIndex = null"
        >
          <span class="pie-dot" :style="{ background: s.color }"></span>
          <span class="pie-legend-name">{{ s.category }}</span>
        </li>
      </ul>
    </div>
    <p v-else class="pie-empty">暂无数据</p>
  </div>
</template>

<style scoped>
.pie {
  width: 100%;
}
/* 图表 + 图例作为一个居中的紧凑整体，不横向铺满右侧 */
.pie-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 420px;
  margin: 0 auto;
}
.pie-visual {
  position: relative;
  width: 220px;
  max-width: 100%;
}
.pie-svg {
  width: 100%;
  height: auto;
  display: block;
}
.pie-slice {
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.pie-slice.is-dim {
  opacity: 0.35;
}
.pie-center {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 52%;
  height: 52%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  text-align: center;
  pointer-events: none;
}
.pie-center-title {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.3;
  max-width: 86%;
}
.pie-center-amount {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  white-space: nowrap;
}
/* 图例：色点 + 分类名，紧凑换行，不含金额 / 占比 */
.pie-legend {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 16px;
}
.pie-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text);
  cursor: default;
}
.pie-legend-item.is-active {
  background: var(--blue-light);
}
.pie-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.pie-legend-name {
  white-space: nowrap;
}
.pie-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
</style>

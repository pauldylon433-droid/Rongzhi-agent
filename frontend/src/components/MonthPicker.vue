<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import AppIcon from './AppIcon.vue'

// 日历式月份选择器：顶部按钮显示当前选中「YYYY 年 M 月」（或「全部月份」），
// 点击弹出年份切换 + 12 宫格月份面板。可选月份严格来自 monthOptionsFor(year)，
// 由 useMonthRange 依据「开户月份 → 当前月份」生成，不在本组件内推断范围。
const props = defineProps({
  year: { type: String, default: '' },
  month: { type: Number, default: 0 },
  yearOptions: { type: Array, default: () => [] },
  monthOptionsFor: { type: Function, required: true },
  allowAll: { type: Boolean, default: false },
})
const emit = defineEmits(['select'])

const open = ref(false)
const viewYear = ref(null)
const root = ref(null)

const label = computed(() => {
  if (props.allowAll && props.year === '') return '全部月份'
  if (!props.year) return '选择月份'
  return `${props.year} 年 ${props.month} 月`
})

function latestYear() {
  const ys = props.yearOptions
  return ys && ys.length ? ys[ys.length - 1] : new Date().getFullYear()
}

function openPicker() {
  viewYear.value = props.year ? Number(props.year) : latestYear()
  open.value = true
}

const yearIndex = computed(() => (viewYear.value == null ? -1 : props.yearOptions.indexOf(viewYear.value)))
const canPrev = computed(() => yearIndex.value > 0)
const canNext = computed(() => yearIndex.value >= 0 && yearIndex.value < props.yearOptions.length - 1)

function prevYear() {
  if (canPrev.value) viewYear.value = props.yearOptions[yearIndex.value - 1]
}
function nextYear() {
  if (canNext.value) viewYear.value = props.yearOptions[yearIndex.value + 1]
}

const months = computed(() => {
  const y = viewYear.value
  const available = y == null ? [] : props.monthOptionsFor(y) || []
  return Array.from({ length: 12 }, (_, i) => {
    const m = i + 1
    return {
      m,
      enabled: available.includes(m),
      selected: props.year === String(y) && props.month === m,
    }
  })
})

function chooseMonth(m) {
  emit('select', { year: String(viewYear.value), month: m })
  open.value = false
}
function chooseAll() {
  emit('select', { year: '', month: 0 })
  open.value = false
}

function onDocClick(e) {
  if (root.value && !root.value.contains(e.target)) open.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="root" class="month-picker">
    <button type="button" class="mp-trigger" :aria-expanded="open" @click="openPicker">
      <AppIcon name="calendar" :size="16" />
      <span>{{ label }}</span>
      <AppIcon name="chevronRight" :size="14" class="mp-caret" :class="{ 'is-open': open }" />
    </button>

    <div v-if="open" class="mp-popover">
      <div class="mp-year-row">
        <button type="button" class="mp-nav" :disabled="!canPrev" aria-label="上一年" @click="prevYear">
          <AppIcon name="chevronLeft" :size="16" />
        </button>
        <span class="mp-year">{{ viewYear }} 年</span>
        <button type="button" class="mp-nav" :disabled="!canNext" aria-label="下一年" @click="nextYear">
          <AppIcon name="chevronRight" :size="16" />
        </button>
      </div>

      <button v-if="allowAll" type="button" class="mp-all" :class="{ 'is-active': year === '' }" @click="chooseAll">
        全部月份
      </button>

      <div class="mp-grid">
        <button
          v-for="c in months"
          :key="c.m"
          type="button"
          class="mp-cell"
          :class="{ 'is-selected': c.selected, 'is-disabled': !c.enabled }"
          :disabled="!c.enabled"
          @click="chooseMonth(c.m)"
        >
          {{ c.m }} 月
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.month-picker {
  position: relative;
}
.mp-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  color: var(--text);
  font-size: var(--fs-md);
  cursor: pointer;
  white-space: nowrap;
}
.mp-trigger:hover {
  border-color: var(--blue);
}
.mp-caret {
  transform: rotate(90deg);
  transition: transform 0.15s ease;
  color: var(--muted);
}
.mp-caret.is-open {
  transform: rotate(-90deg);
}

.mp-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 30;
  min-width: 248px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
  padding: 12px;
}
.mp-year-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.mp-year {
  font-size: 15px;
  font-weight: 600;
  color: var(--navy);
}
.mp-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: #fff;
  color: var(--text);
  cursor: pointer;
}
.mp-nav:hover:not(:disabled) {
  border-color: var(--blue);
  color: var(--blue);
}
.mp-nav:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mp-all {
  width: 100%;
  padding: 7px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
}
.mp-all:hover {
  border-color: var(--blue);
}
.mp-all.is-active {
  background: var(--blue-light);
  border-color: var(--blue);
  color: var(--blue);
  font-weight: 600;
}
.mp-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.mp-cell {
  padding: 8px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
}
.mp-cell:hover:not(:disabled):not(.is-selected) {
  border-color: var(--blue);
  background: var(--blue-light);
}
.mp-cell.is-selected {
  background: var(--blue);
  border-color: var(--blue);
  color: #fff;
  font-weight: 600;
}
.mp-cell.is-disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>

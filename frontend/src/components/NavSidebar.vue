<script setup>
import { useNavigation } from '../composables/useNavigation.js'
import AppIcon from './AppIcon.vue'
import BrandMark from './BrandMark.vue'

defineProps({
  collapsed: { type: Boolean, default: false },
  mobileOpen: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle-collapse', 'navigate'])

const { currentView, navigate } = useNavigation()

const NAV_ITEMS = [
  { key: 'overview', label: '总览', icon: 'overview' },
  { key: 'assistant', label: 'AI助手', icon: 'assistant' },
  { key: 'accounts', label: '账户与流水', icon: 'accounts' },
  { key: 'bill', label: '月度账单', icon: 'bill' },
  { key: 'cards', label: '银行卡', icon: 'cards' },
  { key: 'subscriptions', label: '订阅与代扣', icon: 'subscriptions' },
  { key: 'tasks', label: '最近任务', icon: 'tasks' },
]

function onClick(item) {
  navigate(item.key)
  emit('navigate')
}
</script>

<template>
  <nav class="nav-side" :class="{ 'is-collapsed': collapsed, 'is-open': mobileOpen }">
    <div class="nav-brand">
      <BrandMark :size="34" />
      <span class="nav-brand-name">融智 Agent</span>
    </div>

    <div class="nav-items">
      <button
        v-for="item in NAV_ITEMS"
        :key="item.key"
        class="nav-item"
        :class="{ 'is-active': currentView === item.key }"
        :title="item.label"
        @click="onClick(item)"
      >
        <AppIcon :name="item.icon" :size="22" class="nav-icon" />
        <span class="nav-label">{{ item.label }}</span>
      </button>
    </div>

    <div class="nav-foot">
      <div class="nav-user">
        <span class="nav-user-avatar">张</span>
        <span class="nav-user-text">
          <span class="nav-user-name">演示用户</span>
          <span class="nav-user-sub">张三 · 模拟银行环境</span>
        </span>
      </div>
      <button class="nav-collapse" :title="collapsed ? '展开导航' : '收起导航'" @click="emit('toggle-collapse')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path v-if="collapsed" d="M13 5l7 7-7 7M6 5l7 7-7 7" />
          <path v-else d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
        </svg>
        <span class="nav-label">收起导航</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.nav-side {
  height: 100%;
  min-width: 0;
  background: var(--navy);
  color: #cbd5e1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.nav-side.is-collapsed {
  width: 64px;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 16px;
  color: #fff;
  white-space: nowrap;
  flex-shrink: 0;
}
.nav-brand-name {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.is-collapsed .nav-brand-name {
  display: none;
}
.is-collapsed .nav-brand {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}

.nav-items {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  overflow-y: auto;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 10px 14px;
  border: none;
  background: transparent;
  color: #cbd5e1;
  border-radius: 8px;
  cursor: pointer;
  font-size: 16px;
  text-align: left;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}
.nav-item.is-active {
  background: var(--blue);
  color: #fff;
}
.nav-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}
.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.is-collapsed .nav-label {
  display: none;
}
.is-collapsed .nav-item {
  justify-content: center;
  padding: 12px;
}

.nav-foot {
  padding: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex-shrink: 0;
}
.nav-user {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  white-space: nowrap;
}
.nav-user-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--blue);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  flex-shrink: 0;
}
.nav-user-text {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.nav-user-name {
  font-size: 14px;
  color: #fff;
}
.nav-user-sub {
  font-size: 12px;
  color: #94a3b8;
}
.is-collapsed .nav-user-text {
  display: none;
}
.is-collapsed .nav-user {
  justify-content: center;
  padding: 4px 0;
}

.nav-collapse {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: transparent;
  color: #cbd5e1;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
}
.nav-collapse:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}
.nav-collapse svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.is-collapsed .nav-collapse {
  justify-content: center;
  padding: 8px;
}

/* 手机（<768px）：抽屉导航 */
@media (max-width: 767px) {
  .nav-side {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 50;
    width: 240px;
    height: 100%;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .nav-side.is-open {
    transform: translateX(0);
  }
  .nav-side .nav-label,
  .nav-side .nav-brand-name,
  .nav-side .nav-user-text {
    display: initial;
  }
  .nav-side .nav-item {
    justify-content: flex-start;
    padding: 10px 14px;
  }
  .nav-side .nav-brand {
    justify-content: flex-start;
    padding: 18px 16px;
  }
}
</style>

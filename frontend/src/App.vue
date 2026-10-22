<script setup>
import AccountOverview from './components/AccountOverview.vue'
import TransferPanel from './components/TransferPanel.vue'
import AssistantPanel from './components/AssistantPanel.vue'
import MonthlyAnalytics from './components/MonthlyAnalytics.vue'
import TransactionList from './components/TransactionList.vue'
import CardList from './components/CardList.vue'
import SubscriptionList from './components/SubscriptionList.vue'

const scenarios = [
  { name: '智能转账', desc: '对话式发起转账', state: '模拟转账已实现' },
  { name: '账单分析', desc: '账单洞察与可视化', state: '数据展示已实现' },
  { name: '卡片管理', desc: '卡片状态统一管理', state: '数据展示已实现' },
  { name: '订阅与代扣', desc: '订阅与自动扣款管理', state: '数据展示已实现' },
  { name: '跨场景联动', desc: '多场景任务协同', state: '规划中' },
]
</script>

<template>
  <div class="page">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <span class="brand-mark">融智</span>
          <span class="brand-name">融智 Agent</span>
        </div>
        <span class="env-badge">模拟银行环境 · 数据仅供演示</span>
      </div>
    </header>

    <main class="container">
      <section class="hero">
        <h1 class="title">融智 Agent</h1>
        <p class="subtitle">银行 AI 智能体</p>
        <p class="hero-note">以下账户、交易、卡片与订阅均为模拟数据，不接入真实银行账户</p>
      </section>

      <AccountOverview />
      <TransferPanel />
      <AssistantPanel />
      <MonthlyAnalytics />
      <TransactionList />
      <CardList />
      <SubscriptionList />

      <section class="section scenarios">
        <h2 class="section-title">业务场景规划</h2>
        <p class="scenarios-note">当前已实现只读数据展示与模拟小额转账；其余管理操作与跨场景联动仍在规划中。</p>
        <div class="grid">
          <div v-for="(s, i) in scenarios" :key="s.name" class="card">
            <div class="card-top">
              <span class="card-index">{{ i + 1 }}</span>
              <span class="card-state" :class="s.state === '规划中' ? 'is-pending' : 'is-done'">
                {{ s.state }}
              </span>
            </div>
            <span class="card-name">{{ s.name }}</span>
            <span class="card-desc">{{ s.desc }}</span>
          </div>
        </div>
      </section>
    </main>

    <footer class="footer">
      融智 Agent · 银行 AI 智能体竞赛项目 · 所有业务均为模拟数据，不接入真实银行账户
    </footer>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.topbar {
  background: #0b2545;
  color: #fff;
}
.topbar-inner {
  max-width: 1080px;
  margin: 0 auto;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.brand-mark {
  background: #2563eb;
  padding: 4px 10px;
  border-radius: 6px;
  font-weight: 600;
  font-size: 14px;
}
.brand-name {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.env-badge {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fde68a;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.container {
  flex: 1;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: 40px 24px 24px;
}
.hero {
  text-align: center;
  margin-bottom: 32px;
}
.title {
  margin: 0;
  font-size: 40px;
  font-weight: 700;
  color: #0b2545;
  letter-spacing: 1px;
}
.subtitle {
  margin: 8px 0 0;
  font-size: 20px;
  color: #475569;
}
.hero-note {
  margin: 12px 0 0;
  font-size: 13px;
  color: #94a3b8;
}
.scenarios {
  margin-bottom: 0;
}
.scenarios-note {
  margin: 0 0 16px;
  font-size: 13px;
  color: #64748b;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
}
.card {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.card-index {
  font-size: 12px;
  color: #2563eb;
  font-weight: 600;
}
.card-state {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
}
.card-state.is-done {
  background: #dcfce7;
  color: #15803d;
}
.card-state.is-pending {
  background: #f1f5f9;
  color: #64748b;
}
.card-name {
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
}
.card-desc {
  font-size: 13px;
  color: #64748b;
}
.footer {
  text-align: center;
  padding: 20px;
  font-size: 13px;
  color: #94a3b8;
  border-top: 1px solid #e2e8f0;
}

@media (max-width: 640px) {
  .title {
    font-size: 32px;
  }
}
</style>

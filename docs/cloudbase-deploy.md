# 腾讯云 CloudBase 云托管部署准备

本文件说明容器构建与控制台配置。添加配置不代表已部署、已获得免费运行保障或已实现数据库持久化。

## 当前可用与未完成部分

- 根目录 Dockerfile 构建 Vue 前端，安装 Express 后端依赖，用一个 Node 服务提供页面和 API。
- 使用 Node 22；better-sqlite3 安装阶段准备了原生编译工具；运行阶段使用非 root 用户。
- 默认 PUBLIC_DEMO=1、PUBLIC_AI_ENABLED=0。必须自行在云端设置访问口令，否则程序拒绝启动。
- 容器不包含本地数据库、验证器绑定、.env 或加密主密钥。首次启动创建独立的模拟演示数据库。
- **数据库持久化尚未解决**：默认 DB_PATH 位于实例临时文件系统。实例回收、重建或重新部署可能清除聊天、模拟交易、操作单与验证绑定等数据，随后从初始样例重新开始。
- 只有明确接受数据重置的临时演示才可使用临时 SQLite，且最多一个实例。固定网址不等于数据持久化；不能声称此配置已满足长期保存历史与交易记录的要求。
- 若需要重启后保存记录，须先完成兼容的持久化方案并验证重启、并发、事务和恢复；不能仅把数据库文件上传后就视为完成迁移。云托管的通用文件挂载选项也不等于已验证适配本项目的 SQLite/WAL。

## 控制台设置

| 配置项 | 值 |
| --- | --- |
| 仓库 | pauldylon433-droid/Rongzhi-agent |
| 分支 | main |
| 自动部署 | 关闭 |
| 服务名称 | rongzhi-agent（新服务，不覆盖 huiyan-demo 原服务） |
| 服务端口 | 3000 |
| 目标目录 / 构建上下文 | 仓库根目录（若可留空则留空） |
| Dockerfile 文件 | 有 |
| Dockerfile 名称 | Dockerfile |
| 健康检查路径（若有） | /api/health |
| 实例数 | 使用临时 SQLite 演示时最多 1 个；不能扩为多实例 |

## 环境变量

| 名称 | 初次部署值 |
| --- | --- |
| PUBLIC_DEMO | 1 |
| PUBLIC_AI_ENABLED | 0 |
| PORT | 3000 |
| DEMO_ACCESS_PASSWORD | 用户自行设置的强口令，只填云端，不提交源码或聊天 |

不要注入本地开发库、开发 .env 或开发验证主密钥。CloudBase 的「API Key 设置」不是 DeepSeek 密钥；当前应用不依赖它，保持关闭。
网页访问用户名固定为 demo，密码为 DEMO_ACCESS_PASSWORD。所有持有口令的访客共享一份模拟数据，不是多用户系统。

首次上线先验证页面、Basic Auth、/api/health 和只读接口，不调用模型、不执行转账或还款。
AI 关闭时助手聊天返回 503 属预期；红色操作未配置公网独立验证绑定前保持阻断。不得把这两种情况描述为完整业务链路已验收。

后续启用真实 AI 必须由用户配置 DEEPSEEK_API_KEY，并同时设置 PUBLIC_AI_ENABLED=1、PUBLIC_AI_RATE_LIMIT_PER_MIN、PUBLIC_AI_DAILY_CALL_QUOTA、PUBLIC_AI_MAX_CONCURRENCY。
云托管免费额度不包含对外部 DeepSeek API 的免费承诺；应用配额为进程内计数，重启会重置，并非人民币费用硬上限。

## 费用与验收边界

使用当前账号实际显示的免费套餐与资源余额；不自动升级，不开启超额按量付费，不购买磁盘或其他云资源。
首次构建可能涉及镜像拉取、系统包与 npm 依赖下载，必须以实际云端构建日志判断结果，不能把静态检查当作镜像构建成功。
本次准备环境没有 Docker，尚未执行镜像构建、容器运行、CloudBase 部署或网络验收。

## 官方资料

- Git 仓库部署：https://docs.cloudbase.net/run/deploy/deploy/deploying-git
- Dockerfile 构建：https://docs.cloudbase.net/run/develop/builds/dockerfile
- 临时存储：https://docs.cloudbase.net/run/deploy/configuring/storage/local
- 服务迁移与无状态要求：https://docs.cloudbase.net/run/best-practice/migration

上述规则与平台免费权益可能调整，操作时以控制台与官方文档为准。

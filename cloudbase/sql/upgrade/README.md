# 升级脚本约定

当前基线为 **v1**：

- `001_schema_v1.sql`
- `002_functions_v1.sql`
- `003_seed_v1.sql`

后续升级按顺序新增文件，不修改已执行过的历史脚本：

| 文件模式 | 用途 | 要求 |
| ---- | ---- | ---- |
| `NNN_schema_vX.sql` | 增量建表 / 列 / 索引 | 幂等、非破坏性；不 `DROP` 业务数据 |
| `NNN_functions_vX.sql` | 更新 RPC / 权限 | `CREATE OR REPLACE`；权限与函数同一事务 |
| `NNN_migration_vX.sql` | 数据回填 / 修正 | 幂等；先备份；明确回退方案 |
| `NNN_seed_vX.sql` | 新增独立演示数据 | 只在缺失时插入，不重置已有数据 |

执行任何升级前：

1. 在 CloudBase 侧做一致性备份；
2. 先在隔离测试库（或本地 PGlite）跑 `backend/npm run cloud:verify:sql` 对应的新脚本；
3. 逐文件执行并记录版本；
4. 不执行未审阅的 `DROP TABLE` / `DROP SCHEMA` / `CASCADE`。

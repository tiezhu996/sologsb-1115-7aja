# 昆虫标本采集记录台（gbinsectlog）

面向野外昆虫调查队与标本馆技术员，把「标本采集 → 采集地与生境 → 鉴定状态 → 保藏位置」串成一条可追溯的编目链路，解决采集标签手写易错、鉴定进度无人跟踪、标本入柜后找不到位置的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21815>

常用命令：

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地，不受影响）
```

端口与项目名可在 `.env` 中调整：

```
COMPOSE_PROJECT_NAME=gbinsectlog
FRONTEND_PORT=21815
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 |
| 语言 | TypeScript（`tsc --noEmit` 类型检查零错误） |
| 样式 | Tailwind CSS 3 |
| 状态管理 | Zustand |
| 路由 | React Router 6（nginx `try_files` 回落，支持直接刷新子路由） |
| 构建 | Vite 5 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 单元测试 | Vitest + fake-indexeddb（`npm test`，覆盖借还事务/幂等/失败补偿） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21815
npm run build      # 类型检查 + 生产构建
npm test           # 借还流程单元测试（fake-indexeddb）
```

> 本地开发无需任何后端服务或环境变量。

## 四、目录结构

```
sologsb-1115/
├── docker-compose.yml          # 顶层 name: gbinsectlog，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── tailwind.config.js / postcss.config.js
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # specimen.ts / site.ts / storage.ts / determination.ts / loan.ts
│       ├── stores/             # specimenStore / siteStore / storageStore / determinationStore / loanStore（Zustand）
│       ├── components/common/  # SpecimenCard / StatusTag / CustodyTag / CabinetGrid / SitePicker
│       ├── hooks/              # usePersistentStore / useSpecimenFilter
│       ├── utils/              # codec.ts / custody.ts / export.ts / id.ts
│       ├── pages/              # SpecimensPage / SitesPage / CollectPage / DeterminationPage / StoragePage
│       ├── router/index.tsx
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Specimen 标本 | 编号、目/科/属/种、暂定名、采集日期与人、性别虫态、体长、采集方式、数量、鉴定状态 | `specimens` |
| CollectSite 采集地 | 代码、名称、行政区、经纬度海拔、生境类型、小生境、微气候、采集日期区间 | `sites` |
| Storage 保藏位置 | 保藏方式、柜/抽屉/盒/插位序号、入柜日期、经手人；外借时删除记录释放柜位，归还回原柜时按确定性 ID 重建 | `storages` |
| Determination 鉴定记录 | 鉴定人、日期、结论（学名）、依据文献、置信度、是否需复核 | `determinations` |
| Loan 外借记录 | 批次号、借用人、借出/应还/归还日期、原柜位快照、状态（外借中/待归位/已归位）、实际归位 | `loans` |

- 数据库名 `gbinsectlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史标本补齐默认采集方式（扫网）；
- `version(3)` 新增 `loans` 表：**旧数据没有借还记录，保管状态由 storages 左连接 loans 派生，历史标本自动按「在库 / 未入柜」兼容，无需回填**；
- 借还记录 ID 为 `${batchId}__${specimenId}` 的确定性 ID，整批外借失败后沿用同一批次号重试只会覆盖、不会多出记录；
- 标本编号规则：`采集地代码-年份-流水号`（如 `QLB-2026-0007`），提交时自动分配并查重；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

### 保管状态口径

统一由 `utils/custody.ts` 的 `buildCustodyBundle` 派生，柜位图、标本清单、鉴定页三处完全一致：

| 保管状态 | 判定 |
| --- | --- |
| 在库 | 有在柜记录且无进行中的借还 |
| 外借中 | 有 `state=外借中` 的借还记录（柜位已释放，原柜位图上保留归属标记） |
| 待归位 | 已登记归还，但原柜位已被其他标本占用（保留原柜位，标本在待归位区） |
| 未入柜 | 无在柜记录、也无进行中的借还 |

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/specimens` | 标本清单：按目/科、鉴定/保管状态、采集地、采集日期区间与关键字组合筛选，多选批量推进鉴定状态，保管状态与柜位图同口径，导出命中清单 |
| `/collect` | 采集登记：选择采集地后自动带出生境/小生境/微气候，一次提交多条同批次标本，编号自动生成并查重 |
| `/sites` | 采集地管理：经纬度格式校验、各地采集次数统计、50 米内邻近采集地提示与一键合并 |
| `/determination` | 鉴定工作流：外借中标本自动移出待鉴定队列且禁止新增鉴定；其余逐条落鉴定记录并推进状态 |
| `/storage` | 保藏柜位图：多选整批外借（记借用人/期限/原柜位并释放柜位）、登记归还（原柜空则放回、被占进待归位区）、待归位标本归位 |

## 七、业务约定

- 采集地代码是标本编号前缀，代码重复会被拒绝；
- 坐标 50 米内视为同一采集地，页面上给出合并提示，合并会把原采集地标本自动改挂；
- 鉴定记录提交后自动把标本状态推进为「已鉴定」，勾选「需复核」则置为「待复核」；
- 同一柜位（柜-屉-盒-位）只允许一份标本，冲突时列出已有标本编号；
- **外借**：只能勾选在库标本，整批确认后在同一 Dexie 事务中删除原柜位记录并写入借还记录；外借期间不能入柜、鉴定页不能新增鉴定、标本清单不能批量推进鉴定状态；
- **归还**：原柜位仍空 → 自动放回原柜并置「已归位」；原柜位已被占用 → 进「待归位」区且保留原柜位快照，不挤掉现有标本；待归位标本可一键放回原柜（空位时）或拖到其他空插位；
- **写入失败**：借还写入先快照受影响记录再执行原子事务；事务失败自动回滚，事务外异常按快照恢复原柜位、借出状态与待归还清单，配合确定性记录 ID，重试不会多出任何柜位/借还记录；
- **旧数据兼容**：v3 升级不做数据回填，没有借还记录的标本统一按在库/未入柜处理，柜位图、标本清单、鉴定页显示同一保管状态。

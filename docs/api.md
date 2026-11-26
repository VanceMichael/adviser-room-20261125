# 业务服务接口与本地操作手册

本服务只处理虚构机构、合成人员和合成文件。默认业务端口为 `4318`，电子签署替身端口为 `4317`。没有第三方 npm 依赖。

## 1. 启动与验证

```bash
npm ci --ignore-scripts   # 如 node_modules 已就绪可跳过
npm run verify           # 语法检查 + 全部自动化测试
npm run dev              # 同时启动业务服务和电子签署替身
```

另开终端检查：

```bash
curl -sS http://127.0.0.1:4318/health
curl -sS http://127.0.0.1:4317/health
```

业务状态默认写入 `.local/app-state.json`，实际上传/生成的合成文件写入 `.local/objects/`；电子签署替身状态写入 `.local/partner.json`。停止后用同一状态文件启动会保留流水。

也可以分别启动：

```bash
npm run start:partner    # :4317
npm start                # :4318，需 PARTNER_URL 指向签署服务
```

Docker 可使用同一镜像执行 `npm run dev`，容器内设置 `HOST=0.0.0.0` 并暴露 `4317`、`4318`。

## 2. 本地角色头

本地不接真实身份系统，使用 `X-Actor-Id` 选择合成角色；也可传 `Authorization: Bearer <actor-id>`。该机制只用于本机验证，不是生产认证。

| X-Actor-Id | 角色 | 说明 |
| --- | --- | --- |
| `client` | 企业 `ORG-A` | 提交事项、同意披露、确认委托、验收/交接 |
| `secretary` | 秘书处 | 征询、保管冲突对应关系、记录人工核查和书面豁免编号 |
| `adviser-a` | `USER-A` / `ADV-A` | 初始干净顾问成员 |
| `adviser-b` | `USER-B` / `ADV-A` | 与 `ORG-B` 有合成关联，会命中人工核查 |
| `adviser-c` | `USER-C` / `ADV-A` | 后加入/替换成员示例 |
| `adviser-successor` | `USER-S` / `ADV-B` | 接任顾问 |
| `counterparty-b` | `ORG-B` | 对手方书面豁免接口 |

所有列表和详情都在服务端按角色过滤。顾问访问无关事项得到 `404`，不会通过详情接口探测事项是否存在。

## 3. 接口总览

### 3.1 事项、看板与征询

| 方法与路径 | 角色 | 作用 |
| --- | --- | --- |
| `POST /api/engagements` | 企业 | 提交咨询事项、对手方、关联主体、专业领域和资料范围 |
| `GET /api/engagements` | 任意业务角色 | 按角色返回可见事项 |
| `GET /api/engagements/:id` | 相关方 | 秘书处全量、企业自有全量、顾问脱敏视图 |
| `GET /api/secretary/engagements` | 秘书处 | 全部事项及 `bottleneck.code`：`screening` / `signing` / `client_consent` / `delivery` / `handoff` / `closed` |
| `GET /api/client/engagements` | 企业 | 本企业披露版本、委托、成果、费用争议、交接完成情况 |
| `GET /api/adviser/engagements` | 顾问 | 仅本机构/本人相关范围 |
| `GET /api/adviser/inquiries` | 顾问 | 不包含主体名称的盲征询 |
| `POST /api/engagements/:id/inquiries` | 秘书处 | 向候选机构发出盲征询 |
| `GET /api/secretary/conflict-index` | 秘书处 | 秘书处保管的对应关系和其他保密名册 |
| `GET /api/source-changes` | 秘书处 | 原始 `sourceChanges`；只作来源申请，不会自动变成决定 |
| `GET /api/consent-drafts` | 企业/秘书处 | 同意草稿列表；草稿不是生效授权 |

企业建项示例：

```bash
curl -sS -X POST http://127.0.0.1:4318/api/engagements \
  -H 'X-Actor-Id: client' -H 'Content-Type: application/json' \
  -d '{
    "id":"ENG-DEMO",
    "counterparties":["ORG-B"],
    "relatedParties":[],
    "areas":["legal","tax"],
    "materialScope":[{"category":"commercial-contract","description":"合成合同范围说明，不含正文"}]
  }'
```

顾问盲征询只看到专业领域和资料范围类别，不返回企业、对手方或关联主体名称。

### 3.2 利益冲突、豁免与拒绝接单

| 方法与路径 | 角色 | 作用 |
| --- | --- | --- |
| `POST /api/engagements/:id/screenings` | 顾问/秘书处 | 对实际参与人员筛查；自动匹配秘书处保管关系 |
| `GET /api/screenings/:id` | 相关方 | 顾问只见 `reviewRequired` / `actionRequired`，秘书处和企业可见匹配详情 |
| `POST /api/screenings/:id/review` | 秘书处 | 人工核查结论：`clear` 或 `conflict_confirmed` |
| `POST /api/screenings/:id/waivers` | 企业/对手方/秘书处留痕 | 登记有权双方的书面豁免编号 |
| `POST /api/screenings/:id/decline` | 顾问 | 拒绝接单，仅保留有限依据 |
| `POST /api/conflicts` | 秘书处/顾问 | 报告新关联冲突；新增访问立即被阻断 |

顾问提交人员：

```bash
curl -sS -X POST http://127.0.0.1:4318/api/engagements/ENG-1/screenings \
  -H 'X-Actor-Id: adviser-b' -H 'Content-Type: application/json' \
  -d '{"memberIds":["USER-B"]}'
```

返回中的关键字段是：

```json
{ "memberId": "USER-B", "reviewRequired": true, "actionRequired": true }
```

顾问响应和拒绝留痕不包含 `ORG-B`、`ORG-D`、其他客户/事项编号或秘书处完整名册。拒绝后保留的 `retainedBasis` 只有筛查编号、是否需要人工核查、代码和时间。

冲突确认后，需要企业和对手方两份书面豁免：

```bash
curl -sS -X POST http://127.0.0.1:4318/api/screenings/SCR-x/waivers \
  -H 'X-Actor-Id: client' -H 'Content-Type: application/json' \
  -d '{"party":"client","writingRef":"CLIENT-WAIVER-001"}'

curl -sS -X POST http://127.0.0.1:4318/api/screenings/SCR-x/waivers \
  -H 'X-Actor-Id: counterparty-b' -H 'Content-Type: application/json' \
  -d '{"party":"counterparty","writingRef":"COUNTER-WAIVER-001"}'
```

只有一方豁免时，文件、NDA 和委托仍会被拒绝。

### 3.3 成员更换

| 方法与路径 | 角色 | 作用 |
| --- | --- | --- |
| `GET /api/engagements/:id/team` | 相关方 | 当前/移除/替换成员 |
| `POST /api/engagements/:id/team-members` | 秘书处/顾问机构 | 加入实际人员；可同时申报关联 |
| `POST /api/engagements/:id/team-members/:memberId/remove` | 秘书处/顾问/企业 | 移除人员 |
| `POST /api/engagements/:id/replace-member` | 秘书处/顾问 | 一个串行写事务内完成旧人停用和新人加入 |

机构筛查、机构 NDA 或旧授权都不会自动覆盖新成员。新成员必须重新满足：当前事项成员身份、冲突清除/豁免、本人在生效 NDA 名单内、企业明确授权该人员和范围。

### 3.4 电子保密承诺

业务服务调用现有电子签署替身 `support/peer.mjs`。合作方的 `accepted` / `pending` 只表示受理或处理中；只有逐项查询到 `confirmed`，业务 NDA 才变成 `effective`。

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/engagements/:id/ndas` | 顾问为明确的 `memberIds` 创建签署信封并调用合作方 |
| `GET /api/ndas/:id` | 查询业务 NDA 状态和合作方流水 |
| `POST /api/ndas/:id/reconcile` | 向合作方逐项查询终态 |
| `POST /api/ndas/:id/notifications` | 接收/模拟合作方通知并对账；通知体中的人员名单不会扩张原 NDA |

本地用控制接口把某个签署项置为 `confirmed`：

```bash
curl -sS -X PUT http://127.0.0.1:4317/control/rules \
  -H 'Content-Type: application/json' \
  -d '{"id":"NDA-101-USER-A","mode":"accepted"}'

curl -sS -X POST http://127.0.0.1:4317/control/settle \
  -H 'Content-Type: application/json' \
  -d '{"id":"NDA-101-USER-A","status":"confirmed","details":{"receipt":"synthetic"}}'

curl -sS -X POST http://127.0.0.1:4318/api/ndas/NDA-101/notifications \
  -H 'X-Actor-Id: secretary' -H 'Content-Type: application/json' \
  -d '{"memberIds":["USER-NOT-IN-ORIGINAL-NDA"]}'
```

响应会有 `"scopeExpanded":false`，额外人员只出现在 `ignoredExtraMemberIds`，不会写入 `nda.memberIds`。

### 3.5 企业披露授权

| 方法与路径 | 角色 | 作用 |
| --- | --- | --- |
| `POST /api/engagements/:id/disclosures` | 企业 | 按机构、人员、文件版本、章节、用途授权 |
| `POST /api/consent-drafts/SH-1/approve` | 企业 | 明确批准合成同意草稿；草稿本身不是生效授权 |
| `GET /api/disclosures` / `GET /api/disclosures/:id` | 企业/顾问 | 查询授权和实际发送进度 |
| `POST /api/disclosures/:id/revoke` | 企业 | 全部撤权，或用 `sections` / `purposes` 部分缩权 |
| `POST /api/engagements/:id/revoke-materials` | 企业 | 按文件/人员批量撤回原始资料 |
| `GET /api/disclosures/:id/delivery` | 企业/授权顾问 | 查询已实际发出的字节区间和字节数 |

授权体示例：

```json
{
  "firmId": "ADV-A",
  "memberIds": ["USER-A"],
  "items": [
    {
      "documentId": "DOC-1",
      "sections": ["commercial"],
      "purposes": ["quote"],
      "allowSubcontracting": false
    }
  ]
}
```

用途语义：

- `quote`：仅可在授权章节内为报价阅读；不包含 `perform`，不代表可开展业务。
- `perform`：还必须存在覆盖该人员的有效企业委托。
- `allowSubcontracting:false`：即使机构内可见，也不能给其他机构/分包方；分包还需单独批准和人员级 NDA/冲突条件。
- 授权固定到解析后的文件 `id + version + sha256`。`DOC-1` 的授权不能访问被 `DOC-2` 替代的新版本，除非企业另行授权新版本。

秘书处调用披露接口会得到 `403 CLIENT_ONLY`，不能替企业同意正文。

### 3.6 实际文件路径、Range 和分段续传

以下路径不是目录列表隐藏，而是每次请求都重新执行服务端授权：

```text
GET /api/documents/:documentId/content?engagementId=...&purpose=quote[&section=commercial][&version=2]
GET /api/files/:documentId/raw?engagementId=...&purpose=quote
GET /api/engagements/:engagementId/documents/:documentId/segments?purpose=quote&section=commercial
GET /api/engagements/:engagementId/documents/:documentId/segments/:index/content?purpose=quote&section=commercial
GET /api/documents/:documentId/segments/:index/content?engagementId=...&purpose=quote
```

也支持标准 `Range: bytes=start-end`、`bytes=start-` 和后缀范围。跨未授权章节的范围会被拒绝；例如只授权 `commercial` 时，`bytes=9000-9300` 跨越到 `technical`，返回 `403`。

分段下载示例：

```bash
curl -sS -H 'X-Actor-Id: adviser-a' \
  'http://127.0.0.1:4318/api/engagements/ENG-1/documents/DOC-1/segments?purpose=quote&section=commercial' | jq

curl -sS -H 'X-Actor-Id: adviser-a' \
  'http://127.0.0.1:4318/api/engagements/ENG-1/documents/DOC-1/segments/0/content?purpose=quote&section=commercial' \
  --output part-0.bin

# 断点续传：撤权后此请求必须是 403，而不是继续给字节
curl -i -H 'X-Actor-Id: adviser-a' \
  -H 'Range: bytes=1024-2047' \
  'http://127.0.0.1:4318/api/documents/DOC-1/content?engagementId=ENG-1&purpose=quote&section=commercial'
```

边界语义：

1. 撤权/移除前已经完整发出的字节保存在接收方本地，服务端不能声称远程收回。
2. 撤权后的新分段、断点续传、新版本、新用途请求都会按当前状态重新判断并返回 `403`。
3. 对同一个长响应，服务端在每个分块写出前再次鉴权；若下载期间撤权，后续内存块不再写出并销毁响应流。已经写入 socket 缓冲的少量字节可能已离开进程，这属于“旧字节无法远程收回”的一部分。
4. `GET /api/disclosures/:grantId/delivery` 只统计服务端确认发出的区间，并合并成 `downloadedRanges`。

服务启动时会生成 `DOC-LARGE-SYNTH`：512 KiB 的纯合成文件，分为 `general` 和 `appendix` 两章，默认 64 KiB 一段，可用于手工验证大量分段。

### 3.7 委托、成果、补正和结束

| 方法与路径 | 角色 | 作用 |
| --- | --- | --- |
| `POST /api/engagements/:id/commission` | 企业 | 确认实际机构/人员的委托；`perform` 文件访问以此为条件 |
| `POST /api/engagements/:id/work-products` | 顾问 | 提交成果、引用资料 `{documentId, version, sections}` 和转交条件 |
| `GET /api/engagements/:id/work-products` | 相关方 | 成果列表 |
| `GET /api/work-products/:id` / `/content` | 相关方 | 元数据/实际成果文件，执行来源机构或交接授权判断 |
| `POST /api/work-products/:id/accept` | 企业 | 全部接受；`partial:true` + `acceptedParts` 表示接受部分 |
| `POST /api/work-products/:id/supplement` | 企业 | 要求补充，事项进入 `supplement_required` |
| `POST /api/engagements/:id/complete` | 企业 | 完成委托 |
| `POST /api/engagements/:id/terminate` | 企业 | 结束委托，可选择撤回资料 |
| `POST /api/engagements/:id/disputes` | 顾问/企业 | 登记未结费用或争议；不产生文件访问优先权 |

引用会快照文件版本和 SHA-256，避免后来说不清成果依据的是哪一版资料。

### 3.8 交接与费用争议边界

| 方法与路径 | 角色 | 作用 |
| --- | --- | --- |
| `POST /api/engagements/:id/handoffs` | 秘书处/前任/企业 | 建立交接清单；清单状态仅为 `listed_only` |
| `POST /api/handoffs/:id/client-approval` | 企业 | 逐项批准可转交成果，并给接任人员创建新的文件版本/章节/用途授权 |
| `POST /api/handoffs/:id/release` | 前任机构 | 对要求“前任放行”的专有知识成果逐项放行 |
| `POST /api/engagements/:id/commission` | 企业 | 确认接任顾问委托 |
| `POST /api/handoffs/:id/accept` | 接任顾问 | 逐项实际鉴权通过后才能签收 |
| `POST /api/handoffs/:id/complete` | 企业/秘书处 | 签收后完成交接 |
| `POST /api/handoffs/:id/exclude-items` | 企业/秘书处 | 明确排除不能/不应交接的项目 |

关键判断：

- 交接清单中出现某个 `workProductId` 不产生读取权。
- `transfer.successorTransfer = "client-approval"` 的成果，需要企业逐项批准。
- 默认前任知识成果策略要求企业批准 **和** 前任机构逐项放行。
- 企业原始资料不是前任成果；前任不能用清单转交，只能由企业向接任者作出新的明确授权。
- 接任者还必须是当前成员、冲突已清除/豁免、本人 NDA 已生效；`perform` 用途还需要有效委托。
- 费用争议可通过 `/disputes` 留痕，但鉴权器不读取“欠费可继续访问”的例外。企业撤回原始资料后，前任对该资料的后续下载仍为 `403`。前任对自己的成果按来源机构权限和当前成员状态访问。

## 4. 推荐本地核对剧本

自动化测试已经覆盖以下高风险交叉点：

```bash
npm test
```

覆盖项包括：

1. 顾问 B 命中冲突但响应不泄露秘书处其他企业名册；拒绝后只保留有限依据。
2. 冲突仅一方书面豁免时仍阻断，双方豁免后才可继续。
3. 秘书处不能调用企业披露接口。
4. 电子签署 `accepted` 不生效；控制接口置为 `confirmed` 并收到重复通知后才生效。
5. 通知体附加 `USER-INTRUDER` 不扩张 NDA 人员范围。
6. 文件版本、章节、用途、Range 跨界、委托用途和撤权后续传均实时鉴权。
7. 分段 0 成功、撤权后分段 1 和 `Range` 续传均 `403`；交付进度可查到已发字节。
8. 成员替换后旧成员后续分段立即 `403`，新成员在 NDA/授权前也 `403`。
9. `Promise.allSettled` 并发执行成员替换、续传和交接创建，不出现 `500`，状态可重新查询。
10. 交接清单阶段接任者不能读成果；企业逐项批准、前任逐项放行、接任委托和签收完成后才可读。
11. 费用争议存在且企业撤回资料后，前任不能继续下载原始资料。

## 5. 主要错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 401 | `AUTH_REQUIRED` | 缺少或无法识别本地角色 |
| 403 | `TEAM_MEMBER_INACTIVE` | 人员已移除/替换 |
| 403 | `CONFLICT_NOT_CLEARED` | 待人工核查或缺少双方豁免 |
| 403 | `NDA_NOT_EFFECTIVE` | 电子签署未有全部 `confirmed` 终态 |
| 403 | `DISCLOSURE_SCOPE_DENIED` | 文件版本、章节、用途或人员不覆盖请求 |
| 403 | `SECTION_NOT_AUTHORIZED` | 请求范围超出授权章节 |
| 403 | `COMMISSION_REQUIRED` | `perform` 但没有有效委托 |
| 403 | `SUBCONTRACT_FORBIDDEN` | 报价阅读权不包含分包/转授权 |
| 403 | `WORK_TRANSFER_NOT_AUTHORIZED` | 只有交接清单，缺少逐项批准/放行 |
| 404 | `ENGAGEMENT_NOT_FOUND` / `DOCUMENT_NOT_FOUND` | 对无权角色也以不存在处理 |
| 409 | `HANDOFF_ITEMS_NOT_READY` | 交接签收时仍有项目未通过实际鉴权 |
| 416 | `RANGE_NOT_SATISFIABLE` | Range 不合法或与授权范围无交集 |

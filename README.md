# 考場抽題登錄、補印與歷史統計系統

本系統採用「當日 JSON 作業 + MariaDB 歷史歸檔」的混合架構。

- 當日登錄、即時顯示與補印均以 `data/today.json` 為主要來源。
- MariaDB 只負責歷史歸檔、跨天查詢、過往資料補登與出題機率統計。
- 即使 MariaDB 暫時無法連線，現場仍可繼續登錄、顯示及補印。
- DB 恢復後，可在 `/summary` 手動將目前 JSON 快照重新寫入資料庫。
- 若需要補登以前未匯入的抽題紀錄，可使用 `/backfill` 直接寫入 MariaDB。

## 主要功能

- 每天 6 個場次，每場 3 個崗位。
- 題號預設為第 1 題至第 15 題，可由 `server.js` 的 `QUESTION_COUNT` 調整。
- 支援缺席與棄考，兩者不可同時成立。
- 缺席不列入補印及出題統計。
- 棄考代表題目已使用，因此仍列入補印及出題統計。
- `/display` 透過 WebSocket 即時顯示目前場次資料。
- `/summary` 顯示補印清單、MariaDB 狀態及手動歸檔按鈕。
- `/history` 可依日期區間查詢整體、每日、崗位及場次出題機率。
- `/backfill` 可補登過往日期的 6 場次、3 崗位抽題紀錄。
- 同一日期可重複歸檔或補登，後一次會以目前送出的完整資料更新原資料。

## 頁面

- `/input`：當日抽題登錄。
- `/display`：樓上即時顯示。
- `/summary`：補印結算、DB 狀態及手動歸檔。
- `/history`：跨天歷史紀錄與出題機率。
- `/backfill`：補登過往日期的歷史抽題資料。

## 混合資料架構

```text
/input
   ↓
today.json
   ↓
WebSocket → /display
   ↓
/summary 當日補印
   ↓
手動歸檔或第 6 場自動歸檔
   ↓
MariaDB → /history
```

補登過往資料流程：

```text
/backfill
   ↓
POST /api/history/backfill
   ↓
MariaDB
   ↓
/history 統計查詢
```

程式設計原則：

1. 所有當日現場異動先寫入 JSON。
2. DB 寫入失敗不得中斷 JSON 寫入及 WebSocket 推播。
3. MariaDB 歸檔使用交易，避免只寫入部分場次。
4. 同一天再次歸檔或補登時，先清除該日舊場次，再依本次資料重建完整快照。
5. 歷史統計只讀取已成功歸檔或補登的 MariaDB 資料。
6. `/backfill` 直接寫入 MariaDB，不會覆蓋或修改當天作業用的 `today.json`。

## MariaDB 資料表

系統啟動時會自動建立：

- `exam_days`：每日歸檔主檔、歸檔時間及 JSON 內容雜湊。
- `exam_sessions`：每日 6 個場次。
- `exam_records`：各場次 3 個崗位的題號、缺席及棄考狀態。

外鍵使用 `ON DELETE CASCADE`，同一天重新歸檔或補登時可安全重建場次與崗位資料。

## Docker Compose 設定

`docker-compose.yml` 已包含應用程式及 MariaDB 範例服務。

重要環境變數：

```yaml
- DB_ENABLED=false
- DB_HOST=mariadb
- DB_PORT=3306
- DB_NAME=exam_system
- DB_USER=exam_user
- DB_PASSWORD=change_me
- DB_CONNECTION_LIMIT=5
- AUTO_ARCHIVE_ON_FINAL_SESSION=true
```

說明：

- `DB_ENABLED=true`：啟用歸檔、補登與歷史查詢。
- `DB_HOST`：MariaDB 主機名稱；同一份 Compose 預設為 `mariadb`。
- `DB_PORT`：MariaDB 連接埠。
- `DB_NAME`：資料庫名稱。
- `DB_USER`、`DB_PASSWORD`：應用程式使用者帳密。
- `DB_CONNECTION_LIMIT`：連線池上限。
- `AUTO_ARCHIVE_ON_FINAL_SESSION=true`：第 6 場儲存後自動嘗試歸檔。

正式部署前，請修改：

```yaml
- MARIADB_ROOT_PASSWORD=change_root_password
- MARIADB_PASSWORD=change_me
- DB_PASSWORD=change_me
```

其中 `MARIADB_PASSWORD` 與 `DB_PASSWORD` 必須一致。

## 啟動

```bash
docker compose up -d --build
```

開啟：

```text
http://主機IP:3000/input
http://主機IP:3000/display
http://主機IP:3000/summary
http://主機IP:3000/history
http://主機IP:3000/backfill
```

## 手動歸檔

1. 進入 `/summary`。
2. 確認 MariaDB 顯示「已啟用、已連線」。
3. 按下「強制將目前抽題結果寫入 DB」。
4. 系統會讀取目前 `today.json`，在交易中寫入三張資料表。
5. 若同一天已歸檔，系統會更新覆蓋，不會新增重複日期。

若 DB 寫入失敗，畫面會顯示錯誤，但 `today.json` 不會被清除。

## 補登過往資料

使用情境：過去某一天的抽題資料沒有匯入 DB，或需要補上較早以前的紙本紀錄。

操作流程：

1. 進入 `/backfill`。
2. 選擇要補登的考試日期。
3. 依序輸入第 1 場至第 6 場、每場 3 個崗位的題號。
4. 若該崗位缺席，勾選「缺席」。
5. 若該崗位棄考，勾選「棄考」。
6. 按下「寫入 MariaDB」。

注意事項：

- 補登資料直接寫入 MariaDB，不會改到 `data/today.json`。
- 同一日期若已存在歷史資料，會以本次補登內容覆蓋該日期原資料。
- 缺席與棄考不能同時勾選。
- 缺席不列入統計；棄考會列入統計。

## 自動歸檔

當 `AUTO_ARCHIVE_ON_FINAL_SESSION=true` 且 `DB_ENABLED=true` 時，第 6 場按下儲存後會自動嘗試歸檔。

自動歸檔失敗只會寫入伺服器錯誤紀錄，不會讓 `/api/update-session` 失敗，也不影響當日考試。

## 歷史統計口徑

統計分母為日期區間內「實際使用的題目數」。

```text
一般到考：計入
缺席：不計入
棄考：計入
未登錄題號：不計入
```

`/history` 提供：

- 日期區間整體出題機率。
- 每日各題出題機率。
- 崗位 1～3 的各題出題機率。
- 第 1～6 場的各題出題機率。
- 缺席與棄考數量。
- 歷史原始紀錄表。

## API

```text
GET  /api/archive-status
POST /api/archive-today
POST /api/history/backfill
GET  /api/history/statistics?start=YYYY-MM-DD&end=YYYY-MM-DD
```

- `/api/archive-status`：回傳 DB 啟用、連線、今日是否歸檔及 JSON 是否與 DB 一致。
- `/api/archive-today`：手動將目前 JSON 完整快照寫入 DB。
- `/api/history/backfill`：補登指定日期的歷史抽題資料到 DB。
- `/api/history/statistics`：查詢指定日期區間的歷史統計。

## Nginx Proxy Manager

- Scheme：`http`
- Forward Hostname/IP：Docker 主機 IP
- Forward Port：`3000`
- Websockets Support：開啟
- Block Common Exploits：可開啟

## 資料保存

當日 JSON：

```text
./data/today.json
```

MariaDB Volume：

```text
./db
```

容器重建或重啟不會遺失上述掛載資料。

# 考場抽題登錄與補印統計系統

## 功能

- 樓下登錄本場次 3 位考生抽到的題號
- 題號範圍由系統設定統一管理，目前預設為第 1 題至第 15 題(server.js/QUESTION_COUNT 變數設定題數)
- 可標記考生缺席
- 樓上顯示頁即時更新，並顯示目前時間
- 下午結算今日到考考生使用題號，產生補印清單
- 使用 JSON 檔保存當日資料，不需資料庫
- 可於結算後清除今日資料

## 頁面

- `/input`：樓下登錄頁
- `/display`：樓上即時顯示頁
- `/summary`：結算與補印清單頁

## Docker 執行

```bash
docker compose up -d --build
```

開啟：

```text
http://你的主機IP:3000/input
http://你的主機IP:3000/display
http://你的主機IP:3000/summary
```

## Nginx Proxy Manager 設定

- Scheme：`http`
- Forward Hostname/IP：Docker 主機 IP
- Forward Port：`3000`
- Websockets Support：開啟
- Block Common Exploits：可開啟

## 資料保存

當日資料保存在：

```text
./data/today.json
```

容器重建或重啟不會遺失資料。

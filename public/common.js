function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}

function connectStateSocket(onState, onStatus) {
  let ws;
  let reconnectTimer;

  function setStatus(text, ok) {
    if (typeof onStatus === 'function') onStatus(text, ok);
  }

  function connect() {
    ws = new WebSocket(wsUrl());

    ws.addEventListener('open', () => {
      setStatus('已連線', true);
    });

    ws.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state') {
          onState(message.data, message.summary);
        }
      } catch (error) {
        console.error('WebSocket 訊息解析失敗', error);
      }
    });

    ws.addEventListener('close', () => {
      setStatus('連線中斷，嘗試重新連線中', false);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    });

    ws.addEventListener('error', () => {
      setStatus('連線異常', false);
    });
  }

  connect();

  return {
    close() {
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    }
  };
}

async function apiGetState() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('讀取資料失敗');
  return response.json();
}

async function apiPost(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失敗');
  return data;
}

function questionOptions(selectedValue) {
  let html = '<option value="">請選擇</option>';
  for (let i = 1; i <= 12; i++) {
    html += `<option value="${i}" ${Number(selectedValue) === i ? 'selected' : ''}>第 ${i} 題</option>`;
  }
  return html;
}

function formatQuestion(questionNo) {
  const n = Number(questionNo);
  return n >= 1 && n <= 12 ? `第 ${n} 題` : '未登錄';
}

function nowParts() {
  const now = new Date();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return {
    date: `${yyyy}/${mm}/${dd}（週${weekdays[now.getDay()]}）`,
    time: `${hh}:${mi}:${ss}`
  };
}

function wsUrl() {
  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + location.host;
}

function shouldUseLiveState() {
  if (typeof window === 'undefined' || !window.APP_CONFIG || !window.APP_CONFIG.useLiveState) return false;
  return location.pathname === '/display' || location.pathname === '/summary';
}

function connectStateSocket(onState, onStatus) {
  var ws;
  var reconnectTimer;
  var pollingTimer;
  var lastPayloadJson = null;
  var isManualClose = false;

  function setStatus(text, ok) {
    if (typeof onStatus === 'function') onStatus(text, ok);
  }

  function stopPolling() {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  function startPolling(interval) {
    if (typeof interval !== 'number') interval = 1500;
    stopPolling();
    function pollOnce() {
      apiGetState().then(function(res) {
        var payload = res;
        var json = JSON.stringify(payload);
        if (json !== lastPayloadJson) {
          lastPayloadJson = json;
          if (typeof onState === 'function') onState(payload.data, payload.summary);
        }
        setStatus('已連線（輪詢）', true);
      }).catch(function() {
        setStatus('輪詢讀取失敗', false);
      });
    }
    pollOnce();
    pollingTimer = setInterval(pollOnce, interval);
  }

  function connectWebSocket() {
    if (typeof WebSocket === 'undefined') throw new Error('WebSocket not supported');
    ws = new WebSocket(wsUrl());

    ws.addEventListener('open', function() {
      setStatus('已連線', true);
    });

    ws.addEventListener('message', function(event) {
      try {
        var message = JSON.parse(event.data);
        if (message.type === 'state') {
          lastPayloadJson = JSON.stringify({ data: message.data, summary: message.summary });
          if (typeof onState === 'function') onState(message.data, message.summary);
        }
      } catch (error) {
        console.error('WebSocket 訊息解析失敗', error);
      }
    });

    ws.addEventListener('close', function() {
      if (isManualClose) {
        setStatus('已中斷', false);
        return;
      }
      setStatus('WebSocket 連線中斷，改用輪詢', false);
      clearTimeout(reconnectTimer);
      ws = null;
      startPolling();
    });

    ws.addEventListener('error', function() {
      if (isManualClose) return;
      setStatus('WebSocket 連線異常，改用輪詢', false);
      try { if (ws) ws.close(); } catch (e) {}
      ws = null;
      startPolling();
    });
  }

  try {
    if (shouldUseLiveState()) {
      startPolling();
      return {
        close() {
          isManualClose = true;
          clearTimeout(reconnectTimer);
          stopPolling();
        }
      };
    }
    connectWebSocket();
  } catch (e) {
    startPolling();
  }

  return {
    close() {
      isManualClose = true;
      clearTimeout(reconnectTimer);
      try { if (ws) ws.close(); } catch (e) {}
      stopPolling();
    }
  };
}

function apiGetState() {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', shouldUseLiveState() ? '/api/live-state' : '/api/state', true);
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var data = JSON.parse(xhr.responseText);
          resolve(data);
        } catch (e) {
          reject(new Error('解析回應失敗'));
        }
      } else {
        reject(new Error('讀取資料失敗'));
      }
    };
    xhr.onerror = function() { reject(new Error('網路錯誤')); };
    try { xhr.send(); } catch (e) { reject(e); }
  });
}

function apiPost(url, body) {
  if (body === undefined) body = {};
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      try {
        var data = JSON.parse(xhr.responseText || '{}');
      } catch (e) {
        return reject(new Error('解析回應失敗'));
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error((data && data.error) ? data.error : '操作失敗'));
      }
    };
    xhr.onerror = function() { reject(new Error('網路錯誤')); };
    try { xhr.send(JSON.stringify(body)); } catch (e) { reject(e); }
  });
}

function apiGetText(url) {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText || '');
      } else {
        reject(new Error('讀取資料失敗'));
      }
    };
    xhr.onerror = function() { reject(new Error('網路錯誤')); };
    try { xhr.send(); } catch (e) { reject(e); }
  });
}

function apiRefreshDisplayPassword(invalidateExistingCookies) {
  return apiPost('/api/refresh-display-password', {
    invalidateExistingCookies: Boolean(invalidateExistingCookies)
  });
}

function getQuestionCount() {
  var count = 15;
  if (typeof window !== 'undefined' && window.APP_CONFIG && window.APP_CONFIG.questionCount !== undefined) {
    count = Number(window.APP_CONFIG.questionCount);
  }
  return Number.isInteger(count) && count > 0 ? count : 15;
}

function questionOptions(selectedValue) {
  var html = '<option value="">請選擇</option>';
  var questionCount = getQuestionCount();
  for (var i = 1; i <= questionCount; i++) {
    html += '<option value="' + i + '" ' + (Number(selectedValue) === i ? 'selected' : '') + '>第 ' + i + ' 題</option>';
  }
  return html;
}

function formatQuestion(questionNo) {
  var n = Number(questionNo);
  return n >= 1 && n <= getQuestionCount() ? '第 ' + n + ' 題' : '未登錄';
}

function nowParts() {
  var now = new Date();
  var weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  var yyyy = now.getFullYear();
  var mm = ('0' + (now.getMonth() + 1)).slice(-2);
  var dd = ('0' + now.getDate()).slice(-2);
  var hh = ('0' + now.getHours()).slice(-2);
  var mi = ('0' + now.getMinutes()).slice(-2);
  var ss = ('0' + now.getSeconds()).slice(-2);
  return {
    date: yyyy + '/' + mm + '/' + dd + '（週' + weekdays[now.getDay()] + '）',
    time: hh + ':' + mi + ':' + ss
  };
}

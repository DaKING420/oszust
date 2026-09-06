const $ = id => document.getElementById(id);

let ws = null;
let me = null;
let roomId = null;
let selected = new Set();
let state = null;
let reconnectTimer = null;
let intentionalClose = false;

const screens = ['home', 'lobby', 'game'];

function show(id) {
  screens.forEach(x => $(x).classList.toggle('hidden', x !== id));
}

function setConnectionStatus(text, isError = false) {
  let el = $('connectionStatus');
  if (!el) {
    el = document.createElement('div');
    el.id = 'connectionStatus';
    el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;padding:10px 14px;border-radius:12px;background:#181e19;border:1px solid #303a31;color:#f2f0e8;font-size:13px;box-shadow:0 10px 30px #0008;max-width:90%;text-align:center;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
  el.style.borderColor = isError ? '#bd5b54' : '#303a31';
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setConnectionStatus('🔴 Brak połączenia z serwerem.', true);
    return false;
  }

  // Nie nadpisujemy roomId przekazanego przy JOIN.
  const message = { ...payload };
  if (!message.roomId && roomId) message.roomId = roomId;

  ws.send(JSON.stringify(message));
  return true;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  intentionalClose = false;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}`;

  setConnectionStatus('🟡 Łączenie z serwerem…');
  console.log('WebSocket:', url);

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('🟢 WebSocket połączony');
    setConnectionStatus('🟢 Połączono');
    setTimeout(() => setConnectionStatus(''), 1200);
  };

  ws.onmessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'joined') {
      me = message.playerId;
      roomId = message.roomId;
      $('roomTitle').textContent = roomId;
      $('gameRoom').textContent = roomId;
      $('room').value = roomId;
      show('lobby');
      return;
    }

    if (message.type === 'state') {
      state = message;
      render();
      return;
    }

    if (message.type === 'error') {
      alert(message.message);
      return;
    }
  };

  ws.onerror = () => {
    console.error('🔴 WebSocket error');
    setConnectionStatus('🔴 Błąd połączenia z serwerem.', true);
  };

  ws.onclose = () => {
    console.warn('WebSocket zamknięty');
    if (!intentionalClose) {
      setConnectionStatus('🟠 Połączenie przerwane. Próba ponownego połączenia…', true);
      scheduleReconnect();
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function boot() {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve();

  connect();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout połączenia'));
    }, 8000);

    const check = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws?.removeEventListener('open', check);
    };

    ws?.addEventListener('open', check);
    check();
  });
}

$('create').onclick = async () => {
  try {
    await boot();
    const name = $('name').value.trim() || 'Gracz';
    send({ type: 'create', name });
  } catch {
    alert('Nie udało się połączyć z serwerem. Odśwież stronę i spróbuj ponownie.');
  }
};

$('join').onclick = async () => {
  try {
    const code = $('room').value.trim().toUpperCase();
    if (!code) return alert('Wpisz kod pokoju.');

    await boot();
    const name = $('name').value.trim() || 'Gracz';

    // Kluczowa poprawka: roomId jest przekazywane z pola formularza
    // i nie może zostać nadpisane przez globalne roomId.
    send({ type: 'join', roomId: code, name });
  } catch {
    alert('Nie udało się połączyć z serwerem. Odśwież stronę i spróbuj ponownie.');
  }
};

$('start').onclick = () => {
  send({
    type: 'start',
    minRank: $('min').value,
    maxRank: $('max').value
  });
};

$('knock').onclick = () => send({ type: 'knock' });

$('play').onclick = () => {
  if (![1, 3, 4].includes(selected.size)) {
    return alert('Wybierz dokładnie 1, 3 albo 4 karty.');
  }

  send({
    type: 'play',
    cardIds: [...selected],
    claimedRank: $('claimRank').value
  });
};

function render() {
  if (!state) return;

  const room = state.room;
  const game = state.game;

  if (!game) {
    show('lobby');
    $('roomTitle').textContent = room.id;
    $('players').innerHTML = room.players.map(player => `
      <div class="player">
        <span>${esc(player.name)}</span>
        <b>${player.connected ? '🟢' : '⚪'}</b>
      </div>
    `).join('');
    return;
  }

  show('game');
  $('gameRoom').textContent = room.id;

  $('gamePlayers').innerHTML = room.players.map((player, index) => `
    <div class="player">
      <span>${esc(player.name)}${game.turn === index ? ' ◀' : ''} ${player.connected ? '🟢' : '⚪'}</span>
      <b>${player.cardCount}</b>
    </div>
  `).join('');

  $('pileCount').textContent = game.pileCount;

  const target = game.pendingClaim
    ? room.players.find(player => player.id === game.pendingClaim.playerId)
    : null;
  const myIndex = room.players.findIndex(player => player.id === me);
  const isMyTurn = game.turn === myIndex;

  // Nigdy nie pokazuj rangi o jeden niższej niż zakres (np. 8 przy grze od 9).
  $('tableRank').textContent = game.pendingClaim?.claimedRank || rankName(
    Math.max(game.currentRank, rankValue(game.minRank))
  );

  $('claim').textContent = game.pendingClaim
    ? `${target ? esc(target.name) : 'Gracz'} deklaruje ${game.pendingClaim.claimedRank} (${game.pendingClaim.count} kart)`
    : (isMyTurn ? 'Twoja tura — wybierz 1, 3 lub 4 karty' : 'Czekaj na swoją turę lub zapukaj, aby sprawdzić poprzedni ruch');

  $('status').textContent = game.winner
    ? `🏆 Wygrał ${game.winner}`
    : (isMyTurn ? '🎴 TWOJA TURA' : '⏳ Czekaj na ruch');

  $('knock').disabled = !game.pendingClaim || game.pendingClaim.playerId === me || !!game.winner;
  $('play').disabled = !isMyTurn || !!game.pendingClaim || !!game.winner;
  $('claimRank').disabled = !isMyTurn || !!game.pendingClaim || !!game.winner;

  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const a = ranks.indexOf(game.minRank);
  const b = ranks.indexOf(game.maxRank);
  const allowedRanks = ranks.slice(a, b + 1);
  const oldClaim = $('claimRank').value;
  $('claimRank').innerHTML = allowedRanks.map(rank => `<option value="${rank}">${rank}</option>`).join('');
  if (allowedRanks.includes(oldClaim)) $('claimRank').value = oldClaim;

  $('hand').innerHTML = game.hand.map(card => `
    <button class="card ${card.suit === '♥' ? 'heart' : card.suit === '♦' ? 'diamond' : ''} ${selected.has(card.id) ? 'selected' : ''}" onclick="toggle('${card.id}')">
      <span>${card.rank}</span>
      <small>${card.suit}</small>
    </button>
  `).join('');

  $('log').innerHTML = game.log.map(text => `<div>${esc(text)}</div>`).join('<br>');
}

function rankName(value) {
  return ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'][value] || '—';
}

window.toggle = id => {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

connect();

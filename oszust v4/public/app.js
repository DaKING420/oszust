const $ = id => document.getElementById(id);

let ws = null;
let me = null;
let roomId = null;
let selected = new Set();
let state = null;
let reconnectTimer = null;
let ytPlayer = null;
let ytReady = false;
let musicEnabled = false;
let lastMusicKey = '';
let suppressMusicEvent = false;

const screens = ['home', 'lobby', 'game'];

function show(id) {
  screens.forEach(x => $(x).classList.toggle('hidden', x !== id));
}

function status(text, error = false) {
  let el = $('connectionStatus');
  if (!el) {
    el = document.createElement('div');
    el.id = 'connectionStatus';
    el.style.cssText =
      'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;padding:10px 14px;border-radius:12px;background:#181e19;border:1px solid #303a31;color:#f2f0e8;font-size:13px;max-width:90%;text-align:center;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
  el.style.borderColor = error ? '#bd5b54' : '#303a31';
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    status('🔴 Brak połączenia z serwerem.', true);
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}


window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (state?.game?.music?.videoId) syncMusic(state.game.music);
};

function ensureYouTubePlayer() {
  if (!ytReady || ytPlayer || !musicEnabled) return;
  ytPlayer = new YT.Player('youtubePlayer', {
    width: '240', height: '135',
    videoId: state?.game?.music?.videoId || '',
    playerVars: { playsinline: 1, controls: 1, rel: 0 },
    events: {
      onReady: () => { if (state?.game?.music) syncMusic(state.game.music, true); },
      onStateChange: e => {
        if (e.data === YT.PlayerState.ENDED && !suppressMusicEvent) send({ type: 'music_ended' });
        if (e.data === YT.PlayerState.PLAYING) lastMusicKey = state?.game?.music?.videoId || lastMusicKey;
      }
    }
  });
}

function currentPlayerTime() {
  try { return ytPlayer?.getCurrentTime ? ytPlayer.getCurrentTime() : (state?.game?.music?.position || 0); }
  catch { return state?.game?.music?.position || 0; }
}

function syncMusic(music, force = false) {
  const box = $('musicBox');
  if (!box) return;
  if (!music?.videoId) {
    $('musicTitle').textContent = 'Muzyka wyłączona';
    $('musicStatus').textContent = 'Wpisz /play nazwa utworu';
    return;
  }
  $('musicTitle').textContent = `🎵 ${music.title}`;
  $('musicStatus').textContent = music.playing ? '▶️ Gra' : '⏸️ Pauza';
  $('musicVolume').value = String(music.volume ?? 60);
  ensureYouTubePlayer();
  if (!ytPlayer || !musicEnabled) return;
  const key = `${music.videoId}:${music.playing ? '1' : '0'}`;
  try {
    if (force || music.videoId !== lastMusicKey) {
      suppressMusicEvent = true;
      ytPlayer.loadVideoById({ videoId: music.videoId, startSeconds: music.position || 0 });
      lastMusicKey = music.videoId;
      setTimeout(() => { suppressMusicEvent = false; }, 300);
      return;
    }
    const local = ytPlayer.getCurrentTime();
    if (Math.abs(local - (music.position || 0)) > 2.5) ytPlayer.seekTo(music.position || 0, true);
    if (music.playing && ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING) ytPlayer.playVideo();
    if (!music.playing && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) ytPlayer.pauseVideo();
    ytPlayer.setVolume(Number(music.volume ?? 60));
  } catch {}
}

function enableMusic() {
  musicEnabled = true;
  $('musicEnable').textContent = '🔊 Muzyka włączona';
  ensureYouTubePlayer();
  if (state?.game?.music) syncMusic(state.game.music, true);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  status('🟡 Łączenie…');

  ws.onopen = () => {
    status('🟢 Połączono');
    setTimeout(() => status(''), 1000);
  };

  ws.onmessage = event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'joined') {
      me = msg.playerId;
      roomId = msg.roomId;
      $('roomTitle').textContent = roomId;
      $('gameRoom').textContent = roomId;
      $('room').value = roomId;
      show('lobby');
      return;
    }

    if (msg.type === 'state') {
      state = msg;
      render();
      if (state.game) syncMusic(state.game.music);
      return;
    }

    if (msg.type === 'error') {
      alert(msg.message);
    }
  };

  ws.onerror = () => status('🔴 Błąd połączenia z serwerem.', true);

  ws.onclose = () => {
    status('🟠 Połączenie przerwane. Próba ponownego połączenia…', true);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };
}

function waitForSocket() {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve();

  connect();

  return new Promise((resolve, reject) => {
    const started = Date.now();

    const check = () => {
      if (ws?.readyState === WebSocket.OPEN) return resolve();
      if (Date.now() - started > 8000) return reject(new Error('timeout'));
      setTimeout(check, 50);
    };

    check();
  });
}


$('musicEnable').onclick = enableMusic;
$('musicPause').onclick = () => send({ type: 'music_pause', position: currentPlayerTime() });
$('musicResume').onclick = () => send({ type: 'music_resume', position: currentPlayerTime() });
$('musicSkip').onclick = () => send({ type: 'chat', text: '/skip' });
$('musicStop').onclick = () => send({ type: 'chat', text: '/stop' });
$('musicVolume').onchange = e => send({ type: 'chat', text: `/volume ${e.target.value}` });

$('create').onclick = async () => {
  try {
    await waitForSocket();
    const name = $('name').value.trim() || 'Gracz';
    send({ type: 'create', name });
  } catch {
    alert('Nie udało się połączyć z serwerem.');
  }
};

$('join').onclick = async () => {
  const code = $('room').value.trim().toUpperCase();
  if (!code) return alert('Wpisz kod pokoju.');

  try {
    await waitForSocket();
    const name = $('name').value.trim() || 'Gracz';
    send({ type: 'join', roomId: code, name });
  } catch {
    alert('Nie udało się połączyć z serwerem.');
  }
};

$('start').onclick = () => {
  send({
    type: 'start',
    minRank: $('min').value,
    maxRank: $('max').value
  });
};

$('play').onclick = () => {
  if (![1, 3, 4].includes(selected.size))
    return alert('Wybierz dokładnie 1, 3 albo 4 karty.');

  send({
    type: 'play',
    cardIds: [...selected],
    claimedRank: $('claimRank').value
  });
};

$('knock').onclick = () => send({ type: 'knock' });
$('draw3').onclick = () => send({ type: 'draw3' });
$('replay').onclick = () => send({ type: 'replay' });
$('chatForm').onsubmit = event => {
  event.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (send({ type: 'chat', text })) input.value = '';
};

function render() {
  if (!state) return;

  const room = state.room;
  const game = state.game;

  if (!game) {
    show('lobby');
    $('finalPanel').classList.add('hidden');
    $('roomTitle').textContent = room.id;
    $('players').innerHTML = room.players.map(p => `
      <div class="player">
        <span>${esc(p.name)}</span>
        <b>${p.connected ? '🟢' : '⚪'}</b>
      </div>
    `).join('');
    return;
  }

  show('game');

  const myIndex = room.players.findIndex(p => p.id === me);
  const isMyTurn = game.turn === myIndex;

  // Po rozpoczęciu gry zawsze ustawiamy select zgodnie z zakresem.
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const a = ranks.indexOf(game.minRank);
  const b = ranks.indexOf(game.maxRank);
  // Deklaracja musi być co najmniej tak wysoka jak karta/ranga na stole.
  // Dzięki temu np. na 10 nie da się zadeklarować 9.
  const minimumClaimIndex = Math.max(a, game.currentRank);
  const allowed = ranks.slice(minimumClaimIndex, b + 1);
  const old = $('claimRank').value;

  $('claimRank').innerHTML = allowed
    .map(r => `<option value="${r}">${r}</option>`)
    .join('');

  if (allowed.includes(old)) $('claimRank').value = old;
  else if (allowed.length) $('claimRank').value = allowed[0];

  $('gameRoom').textContent = room.id;
  $('pileCount').textContent = game.pileCount;
  $('drawCount').textContent = game.drawPileCount ?? 0;

  const target = game.pendingClaim
    ? room.players.find(p => p.id === game.pendingClaim.playerId)
    : null;

  const shownCard = game.visibleCard || game.baseCard;
  $('tableRank').textContent =
    game.pendingClaim?.claimedRank ||
    (shownCard ? `${shownCard.rank}${shownCard.suit}` : ranks[Math.max(game.currentRank, a)]) ||
    game.minRank;
  $('tableRank').className = (shownCard && ['♥','♦'].includes(shownCard.suit)) ? 'red-suit' : '';

  $('claim').textContent = game.pendingClaim
    ? `${target ? esc(target.name) : 'Gracz'} deklaruje ${game.pendingClaim.claimedRank} (${game.pendingClaim.count} kart)`
    : isMyTurn
      ? `Twoja tura — wybierz 1, 3 lub 4 karty i deklarację od ${ranks[Math.max(game.currentRank, a)]}`
      : 'Czekaj na swoją turę';

  $('status').textContent = game.winner
    ? `🏆 Wygrał ${game.winner}`
    : isMyTurn
      ? '🎴 TWOJA TURA'
      : '⏳ Czekaj na ruch';

  // Pukanie może wykonać każdy gracz poza autorem ostatniej deklaracji,
  // niezależnie od tego, czy jest jego kolej. Kolejka po pukaniu się nie zmienia.
  $('knock').disabled =
    !game.pendingClaim ||
    game.pendingClaim.playerId === me ||
    !!game.winner;

  // Pukanie jest opcjonalne. Nawet gdy istnieje pendingClaim po poprzednim ruchu,
  // aktualny gracz może go zignorować i normalnie zagrać albo dobrać 3.
  $('draw3').disabled =
    !isMyTurn ||
    !!game.winner ||
    game.drawPileCount < 3;

  // Można zagrać bez pukania w poprzednią deklarację.
  // Wysłanie PLAY automatycznie kończy możliwość sprawdzenia poprzedniego ruchu.
  $('play').disabled =
    !isMyTurn ||
    !!game.winner;

  $('claimRank').disabled =
    !isMyTurn ||
    !!game.winner;

  const finalPanel = $('finalPanel');
  if (game.finished) {
    finalPanel.classList.remove('hidden');
    const rows = (game.placements || []).map(x => {
      const medal = x.place === 1 ? '🥇' : x.place === 2 ? '🥈' : x.place === 3 ? '🥉' : '🏅';
      return `<div class="finalrow"><span class="place">${medal} ${x.place}.</span><span class="finalname">${esc(x.name)}</span><span class="bluffs">Oszustwa: ${x.bluffCount || 0}</span></div>`;
    }).join('');
    $('finalTable').innerHTML = rows;
  } else {
    finalPanel.classList.add('hidden');
  }

  $('gamePlayers').innerHTML = room.players.map((p, i) => `
    <div class="player">
      <span>${esc(p.name)}${game.turn === i ? ' ◀' : ''} ${p.connected ? '🟢' : '⚪'}</span>
      <b>${p.cardCount}</b>
    </div>
  `).join('');

  // Kluczowe: ręka jest pobierana z game.hand dla konkretnego gracza.
  // Po starcie powinna zawierać wszystkie przydzielone karty.
  const hand = Array.isArray(game.hand) ? game.hand : [];

  $('hand').innerHTML = hand.map(card => `
    <button class="card ${card.suit === '♥' ? 'heart' : card.suit === '♦' ? 'diamond' : ''} ${selected.has(card.id) ? 'selected' : ''}"
      onclick="toggleCard('${card.id}')">
      <span>${card.rank}</span>
      <small>${card.suit}</small>
    </button>
  `).join('');

  $('log').innerHTML = (game.log || []).map(t => `<div>${esc(t)}</div>`).join('<br>');
  $('log').scrollTop = $('log').scrollHeight;

  const chat = Array.isArray(game.chat) ? game.chat : [];
  $('chatMessages').innerHTML = chat.map(m =>
    `<div class="chatMsg"><b>${esc(m.name)}</b><span>${esc(m.text)}</span></div>`
  ).join('');
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;

  // Jeśli karta została zagrana/przejęta, usuń nieistniejące ID z zaznaczenia.
  const ids = new Set(hand.map(c => c.id));
  selected = new Set([...selected].filter(id => ids.has(id)));
}

window.toggleCard = id => {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

connect();

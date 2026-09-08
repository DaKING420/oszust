import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => {
  let players = 0;
  for (const room of rooms.values()) players += room.players.length;
  res.json({ status: 'ok', rooms: rooms.size, players });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const SUITS = ['♥', '♦', '♣', '♠'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankValue = rank => RANKS.indexOf(rank);

function makeDeck(minRank, maxRank) {
  const a = rankValue(minRank);
  const b = rankValue(maxRank);
  if (a < 0 || b < 0 || a > b) throw new Error('Nieprawidłowy zakres kart.');
  return RANKS.slice(a, b + 1).flatMap(rank =>
    SUITS.map(suit => ({ id: crypto.randomUUID(), rank, suit }))
  );
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function send(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function error(ws, message) {
  console.log(`⚠️ ERROR player=${ws?.pid || '-'} room=${ws?.roomId || '-'}: ${message}`);
  send(ws, { type: 'error', message });
}

function nextIndex(room, index) {
  return (index + 1) % room.players.length;
}

function addLog(game, text) {
  game.log.push(text);
  if (game.log.length > 100) game.log.shift();
}

/*
  Bardzo ważne: stan ręki jest tworzony na serwerze i wysyłany
  osobno dla każdego gracza. Dzięki temu każdy telefon dostaje
  wyłącznie własne karty.
*/
function publicState(room, viewerId) {
  const viewer = room.players.find(p => p.id === viewerId);
  const game = room.game;

  return {
    type: 'state',
    room: {
      id: room.id,
      hostId: room.hostId,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        connected: !!p.ws
      }))
    },
    game: game ? {
      started: true,
      turn: game.turn,
      starterId: game.starterId,
      currentRank: game.currentRank,
      minRank: game.minRank,
      maxRank: game.maxRank,
      pileCount: game.pile.length,
      baseCard: game.baseCard || null,
      visibleCard: game.visibleCard || null,
      // 'Dobierz 3' korzysta z głównego stosu zagranych kart. Stały spód
      // (9♥) nigdy nie jest dobierany.
      drawPileCount: Math.max(0, game.pile.length - 1),
      canDraw: !game.winner && game.turn === room.players.findIndex(p => p.id === viewerId) && game.pile.length - 1 >= 3,
      lastPlayer: game.lastPlayer,
      pendingClaim: game.pendingClaim ? {
        playerId: game.pendingClaim.playerId,
        claimedRank: game.pendingClaim.claimedRank,
        count: game.pendingClaim.cards.length
      } : null,
      winner: game.winner,
      hand: viewer ? viewer.hand : [],
      log: game.log.slice(-30)
    } : null
  };
}

function broadcast(room) {
  for (const player of room.players) {
    send(player.ws, publicState(room, player.id));
  }
}

function startGame(room, minRank, maxRank) {
  const deck = shuffle(makeDeck(minRank, maxRank));

  for (const player of room.players) player.hand = [];

  // Cała talia jest rozdawana graczom. 9♥ również trafia losowo do jednego
  // z graczy, a dopiero potem jest odkładane odkryte jako stały spód gry.
  const starterCard = deck.find(card => card.rank === minRank && card.suit === '♥');
  if (!starterCard) throw new Error(`Brak ${minRank}♥ w talii.`);

  deck.forEach((card, index) => {
    room.players[index % room.players.length].hand.push(card);
  });

  const starter = room.players.findIndex(player =>
    player.hand.some(card => card.rank === minRank && card.suit === '♥')
  );
  if (starter < 0) throw new Error(`Brak ${minRank}♥ w rozdanej talii.`);

  const starterPlayer = room.players[starter];
  const baseCardIndex = starterPlayer.hand.findIndex(
    card => card.rank === minRank && card.suit === '♥'
  );
  const baseCard = starterPlayer.hand.splice(baseCardIndex, 1)[0];

  room.game = {
    turn: nextIndex(room, starter),
    starterId: starterPlayer.id,
    currentRank: rankValue(minRank),
    minRank,
    maxRank,
    baseCard,
    // Nie ma osobnej talii dobierania. Wszystkie karty są rozdane, a
    // DOBIERZ 3 zabiera trzy karty z GÓRY stosu zagranych kart.
    pile: [baseCard],
    visibleCard: null,
    lastPlayer: null,
    pendingClaim: null,
    winner: null,
    log: []
  };

  const counts = room.players.map(p => `${p.name}:${p.hand.length}`).join(', ');
  addLog(room.game, `Rozdano całą talię (${counts}).`);
  addLog(room.game, `Zaczyna ${room.players[starter].name}, ponieważ ma ${minRank}♥.`);

  console.log(`🎮 START ${room.id}: ${minRank}-${maxRank}`);
  console.log(`🃏 HANDS ${room.players.map(p => `${p.name}=${p.hand.length}`).join(' ')}`);
  console.log(`⭐ STARTER ${room.players[starter].name} (${minRank}♥)`);
}

function roomFor(ws) {
  return ws.roomId ? rooms.get(ws.roomId) : null;
}

function disconnectPlayer(ws, reason) {
  const room = roomFor(ws);
  if (!room) return;

  const player = room.players.find(p => p.id === ws.pid);
  if (!player) return;

  player.ws = null;
  console.log(`🔌 DISCONNECT ${player.name} room=${room.id} reason=${reason}`);
  broadcast(room);

  if (!room.players.some(p => p.ws)) {
    rooms.delete(room.id);
    console.log(`🗑️ DELETE EMPTY ROOM ${room.id}`);
  }
}

wss.on('connection', ws => {
  console.log('🔌 CONNECT WebSocket');

  ws.on('message', raw => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return error(ws, 'Nieprawidłowa wiadomość.');
    }

    console.log(`📨 ${data.type || '-'} room=${data.roomId || ws.roomId || '-'} player=${ws.pid || '-'}`);

    if (data.type === 'create') {
      let id = String(data.roomId || '').trim().toUpperCase();
      if (!id) id = Math.random().toString(36).slice(2, 8).toUpperCase();

      if (!/^[A-Z0-9]{4,10}$/.test(id))
        return error(ws, 'Kod pokoju może mieć 4–10 znaków.');
      if (rooms.has(id))
        return error(ws, 'Taki pokój już istnieje.');

      const pid = crypto.randomUUID();
      const room = {
        id,
        hostId: pid,
        players: [{
          id: pid,
          name: String(data.name || 'Gracz').trim().slice(0, 20) || 'Gracz',
          hand: [],
          ws
        }],
        game: null
      };

      rooms.set(id, room);
      ws.pid = pid;
      ws.roomId = id;

      console.log(`🟢 CREATE room=${id} player=${room.players[0].name}`);
      send(ws, { type: 'joined', roomId: id, playerId: pid });
      broadcast(room);
      return;
    }

    if (data.type === 'join') {
      const id = String(data.roomId || '').trim().toUpperCase();
      const room = rooms.get(id);

      if (!room) return error(ws, `Nie znaleziono pokoju ${id}.`);
      if (room.game) return error(ws, 'Gra już trwa. Nie można dołączyć.');
      if (room.players.length >= 8) return error(ws, 'Pokój jest pełny.');

      const pid = crypto.randomUUID();
      const player = {
        id: pid,
        name: String(data.name || 'Gracz').trim().slice(0, 20) || 'Gracz',
        hand: [],
        ws
      };

      room.players.push(player);
      ws.pid = pid;
      ws.roomId = id;

      console.log(`🟢 JOIN room=${id} player=${player.name}`);
      send(ws, { type: 'joined', roomId: id, playerId: pid });
      broadcast(room);
      return;
    }

    const room = roomFor(ws);
    if (!room) return error(ws, 'Najpierw utwórz lub dołącz do pokoju.');

    const me = room.players.find(p => p.id === ws.pid);
    if (!me) return error(ws, 'Nie znaleziono gracza.');

    if (data.type === 'start') {
      if (room.hostId !== me.id) return error(ws, 'Tylko host może rozpocząć grę.');
      if (room.players.length < 2) return error(ws, 'Potrzeba co najmniej 2 graczy.');
      if (room.game) return error(ws, 'Gra już trwa.');

      const minRank = String(data.minRank || '9');
      const maxRank = String(data.maxRank || 'A');

      try {
        startGame(room, minRank, maxRank);
      } catch (e) {
        console.error('❌ START ERROR', e);
        return error(ws, 'Nie udało się rozdać kart.');
      }

      // Dwa broadcasty nie są potrzebne; jeden wystarcza i zawiera
      // rękę każdego gracza zależnie od odbiorcy.
      broadcast(room);
      return;
    }

    if (!room.game) return error(ws, 'Gra jeszcze się nie rozpoczęła.');

    const game = room.game;
    const myIndex = room.players.findIndex(p => p.id === me.id);

    if (data.type === 'play') {
      if (game.winner) return error(ws, 'Gra jest już zakończona.');
      if (game.turn !== myIndex) return error(ws, 'To nie jest Twoja tura.');

      const ids = Array.isArray(data.cardIds) ? data.cardIds.map(String) : [];
      if (![1, 3, 4].includes(ids.length))
        return error(ws, 'Możesz położyć tylko 1, 3 albo 4 karty.');
      if (new Set(ids).size !== ids.length)
        return error(ws, 'Nieprawidłowy wybór kart.');

      const cards = ids.map(id => me.hand.find(card => card.id === id));
      if (cards.some(card => !card))
        return error(ws, 'Wybrane karty nie należą do Twojej ręki.');

      const claimedRank = String(data.claimedRank || '');
      const min = rankValue(game.minRank);
      const max = rankValue(game.maxRank);

      // Deklaracja nie może być niższa od aktualnej rangi na stole.
      // Np. gdy na stole jest 10, można zadeklarować tylko 10, J, Q, K lub A.
      const minimumClaim = Math.max(min, game.currentRank);
      if (rankValue(claimedRank) < minimumClaim || rankValue(claimedRank) > max)
        return error(ws, `Nie możesz zadeklarować niższej rangi niż ${RANKS[minimumClaim]}.`);

      // Faktyczna karta może być dowolnej rangi. To właśnie jest sedno blefu:
      // np. na damę można położyć 9 i zadeklarować króla. Ograniczenie dotyczy
      // WYŁĄCZNIE deklarowanej rangi — nie może ona być niższa od aktualnej.

      // Pukanie jest opcjonalne: kolejny gracz może normalnie zagrać.
      // Wtedy poprzednia deklaracja przestaje być możliwa do sprawdzenia.
      game.pendingClaim = null;

      me.hand = me.hand.filter(card => !ids.includes(card.id));
      game.pile.push(...cards);
      game.currentRank = rankValue(claimedRank);
      game.visibleCard = null;
      game.lastPlayer = me.id;
      game.pendingClaim = {
        playerId: me.id,
        claimedRank,
        cards
      };

      addLog(game, `${me.name}: ${cards.length} karta/y, deklaracja ${claimedRank}.`);

      // Kluczowa zasada: po położeniu kart kolejka zawsze idzie dalej.
      game.turn = nextIndex(room, myIndex);

      if (me.hand.length === 0) {
        game.winner = me.name;
        addLog(game, `🏆 ${me.name} pozbył(a) się wszystkich kart!`);
      }

      console.log(`🃏 PLAY room=${room.id} player=${me.name} next=${room.players[game.turn].name}`);
      broadcast(room);
      return;
    }

    if (data.type === 'draw3') {
      if (game.winner) return error(ws, 'Gra jest już zakończona.');
      if (game.turn !== myIndex) return error(ws, 'To nie jest Twoja tura.');

      // Dobieranie korzysta z GŁÓWNEGO stosu zagranych kart.
      // Nie istnieje osobna kupka dobierania i nie ma limitu użyć w grze.
      // Nie wolno jednak zabrać stałego spodu (9♥).
      const playablePileCount = game.pile.length - 1;
      if (playablePileCount < 3) {
        return error(ws, 'Na stosie nie ma jeszcze 3 kart do dobrania.');
      }

      // Rezygnacja ze sprawdzania poprzedniej deklaracji.
      game.pendingClaim = null;

      // Góra stosu to ostatni element tablicy. Zabieramy dokładnie 3 ostatnie
      // karty, a następna karta pozostająca na stosie staje się odkrytą kartą.
      const drawn = game.pile.splice(game.pile.length - 3, 3);
      me.hand.push(...drawn);

      const newTop = game.pile[game.pile.length - 1];
      if (newTop && newTop.id !== game.baseCard.id) {
        game.visibleCard = newTop;
        game.currentRank = rankValue(newTop.rank);
        addLog(game, `👁️ Odkryto ${newTop.rank}${newTop.suit} — od tej rangi gramy dalej.`);
      } else {
        game.visibleCard = null;
        game.currentRank = rankValue(game.minRank);
        addLog(game, `👁️ Na stosie został tylko spód ${game.minRank}♥.`);
      }

      // DOBIERZ 3 zużywa całą kolejkę gracza — tak jakby wykonał swój ruch.
      // Po dobraniu nie może już w tej samej turze wykładać kart.
      game.lastPlayer = me.id;
      game.turn = nextIndex(room, myIndex);

      addLog(game, `${me.name}: dobrał(a) 3 karty z góry stosu. Wykorzystał(a) swoją kolejkę — teraz jedzie ${room.players[game.turn]?.name || '-'}.`);
      console.log(`🃏 DRAW3 room=${room.id} player=${me.name} next=${room.players[game.turn]?.name || '-'} remaining=${Math.max(0, game.pile.length - 1)} visible=${game.visibleCard ? game.visibleCard.rank + game.visibleCard.suit : '-'}`);
      broadcast(room);
      return;
    }

    if (data.type === 'knock') {
      if (game.winner) return error(ws, 'Gra jest zakończona.');
      if (!game.pendingClaim) return error(ws, 'Nie ma czego sprawdzać.');
      if (game.pendingClaim.playerId === me.id)
        return error(ws, 'Nie możesz zapukać na własną deklarację.');

      // PUKAĆ MOŻE KAŻDY gracz poza autorem ostatniej deklaracji.
      // Pukanie jest niezależne od kolejki: jeżeli A zagrał, B jest następny,
      // to również C może zapukać. Niezależnie od wyniku kolejka nadal należy
      // do B.

      const claim = game.pendingClaim;
      const target = room.players.find(p => p.id === claim.playerId);
      if (!target) return error(ws, 'Nie znaleziono gracza.');

      // Jeśli deklaracja była kłamstwem, OSZUST zbiera stos.
      // Jeśli deklaracja była prawdziwa, pukający zbiera stos.
      const truth = claim.cards.every(card => card.rank === claim.claimedRank);
      const collector = truth ? me : target;

      // Stały odkryty spód (np. 9♥) zostaje na stole.
      const playedPile = game.pile.filter(card => card.id !== game.baseCard.id);
      collector.hand.push(...playedPile);
      game.pile = [game.baseCard];
      game.pendingClaim = null;
      game.currentRank = rankValue(game.minRank);

      // Pukanie nie jest ruchem w kolejce samo w sobie. Zapamiętujemy osobę,
      // której naprawdę przypada kolej, oraz osobę pukającą.
      const turnPlayerId = room.players[game.turn]?.id;
      const wasTurnPlayer = turnPlayerId === me.id;
      const currentTurnIndex = game.turn;

      // Zasada kolejki — kolejka należy do GRACZA, nie do osoby pukającej:
      // 1) Puka osoba NIEBĘDĄCA na kolejce -> kolejka pozostaje bez zmian.
      // 2) Puka aktualny gracz i trafia -> zachowuje swoją kolejkę.
      // 3) Puka aktualny gracz i pudłuje -> aktualny gracz traci kolejkę,
      //    więc kolejka przechodzi dokładnie na następnego gracza:
      //    A -> B -> C -> A.
      // Używamy game.turn bezpośrednio zamiast indeksu pukającego, żeby
      // pukanie z innego urządzenia nie mogło przypadkiem ustawić kolejki
      // na tę samą osobę.
      let nextTurn = currentTurnIndex;
      if (wasTurnPlayer && !truth) {
        nextTurn = nextIndex(room, currentTurnIndex);
      }

      game.turn = nextTurn;
      const nextPlayerName = room.players[nextTurn]?.name || '-';

      // truth === false: deklaracja była kłamstwem -> PUKANIE TRAFIONE.
      // truth === true: deklaracja była prawdziwa -> PUKANIE PUDŁO.
      if (!truth) {
        addLog(game, `🔔 ${me.name}: PUKANIE TRAFIONE — ${target.name} oszukał(a). ${target.name} zbiera stos. ${wasTurnPlayer ? `${me.name} zachowuje swoją kolejkę.` : `Kolejka nadal: ${nextPlayerName}.`}`);
      } else {
        addLog(game, `🔔 ${me.name}: PUKANIE PUDŁO — ${target.name} mówił(a) prawdę. ${me.name} zbiera stos. ${wasTurnPlayer ? `Pukanie kosztuje ${me.name} kolejkę — teraz jedzie ${nextPlayerName}.` : `Kolejka nadal: ${nextPlayerName}.`}`);
      }

      console.log(`🔔 KNOCK room=${room.id} player=${me.name} target=${target.name} truth=${truth} wasTurn=${wasTurnPlayer} next=${nextPlayerName}`);
      broadcast(room);
      return;
    }

    return error(ws, 'Nieznana akcja.');
  });

  ws.on('error', e => console.error('❌ WS ERROR', e.message));
  ws.on('close', () => disconnectPlayer(ws, 'close'));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Oszust działa na porcie ${port}`);
});

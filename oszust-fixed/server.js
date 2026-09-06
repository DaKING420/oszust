import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  let players = 0;
  for (const room of rooms.values()) players += room.players.length;
  res.json({ status: 'ok', rooms: rooms.size, players });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

const SUITS = ['♥', '♦', '♣', '♠'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankValue = rank => RANKS.indexOf(rank);

function makeDeck(minRank = '9', maxRank = 'A') {
  const a = rankValue(minRank);
  const b = rankValue(maxRank);
  if (a < 0 || b < 0 || a > b) throw new Error('Nieprawidłowy zakres kart.');
  const ranks = RANKS.slice(a, b + 1);
  return ranks.flatMap(rank => SUITS.map(suit => ({
    id: crypto.randomUUID(),
    rank,
    suit
  })));
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function send(ws, payload) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
}

function err(ws, message) {
  send(ws, { type: 'error', message });
}

function broadcast(room) {
  for (const player of room.players) {
    send(player.ws, publicState(room, player.id));
  }
}

function publicState(room, viewerId) {
  return {
    type: 'state',
    room: {
      id: room.id,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        connected: !!p.ws
      })),
      hostId: room.hostId
    },
    game: room.game ? {
      started: true,
      turn: room.game.turn,
      currentRank: room.game.currentRank,
      pileCount: room.game.pile.length,
      pileOwner: room.game.lastPlayer,
      pendingClaim: room.game.pendingClaim ? {
        playerId: room.game.pendingClaim.playerId,
        claimedRank: room.game.pendingClaim.claimedRank,
        count: room.game.pendingClaim.cards.length
      } : null,
      winner: room.game.winner,
      minRank: room.game.minRank,
      maxRank: room.game.maxRank,
      hand: room.players.find(p => p.id === viewerId)?.hand || [],
      log: room.game.log.slice(-30)
    } : null
  };
}

function addLog(game, text) {
  game.log.push(text);
  if (game.log.length > 100) game.log.shift();
}

function nextIndex(room, index) {
  return (index + 1) % room.players.length;
}

function startGame(room, minRank, maxRank) {
  const deck = shuffle(makeDeck(minRank, maxRank));
  room.players.forEach(player => { player.hand = []; });

  deck.forEach((card, index) => {
    room.players[index % room.players.length].hand.push(card);
  });

  const starterCard = room.players
    .flatMap(player => player.hand)
    .find(card => card.rank === minRank && card.suit === '♥');

  if (!starterCard) throw new Error('Nie udało się znaleźć karty rozpoczynającej.');

  const starter = room.players.findIndex(player =>
    player.hand.some(card => card.id === starterCard.id)
  );

  room.game = {
    turn: starter,
    currentRank: rankValue(minRank) - 1,
    pile: [],
    lastPlayer: null,
    pendingClaim: null,
    winner: null,
    minRank,
    maxRank,
    log: []
  };

  addLog(room.game, `Gra rozpoczęta. Zaczyna ${room.players[starter].name} (${minRank}♥).`);
}

function getRoomForSocket(ws) {
  return ws.roomId ? rooms.get(ws.roomId) : null;
}

function cleanupEmptyRoom(room) {
  if (!room) return;
  const hasConnected = room.players.some(player => player.ws);
  if (!hasConnected) {
    rooms.delete(room.id);
    console.log(`🗑️ Usunięto pusty pokój ${room.id}`);
  }
}

wss.on('connection', ws => {
  console.log('🔌 Nowe połączenie WebSocket');

  ws.on('message', raw => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return err(ws, 'Nieprawidłowa wiadomość.');
    }

    console.log(`📨 ${data.type || 'brak typu'} room=${data.roomId || ws.roomId || '-'} player=${ws.pid || '-'}`);

    if (data.type === 'create') {
      let id = String(data.roomId || '').trim().toUpperCase();
      if (!id) id = Math.random().toString(36).slice(2, 8).toUpperCase();

      if (!/^[A-Z0-9]{4,10}$/.test(id)) {
        return err(ws, 'Kod pokoju może mieć 4–10 znaków (litery/cyfry).');
      }
      if (rooms.has(id)) return err(ws, 'Taki pokój już istnieje.');

      const pid = crypto.randomUUID();
      const room = {
        id,
        hostId: pid,
        players: [],
        game: null
      };

      room.players.push({
        id: pid,
        name: String(data.name || 'Gracz').trim().slice(0, 20) || 'Gracz',
        hand: [],
        ws
      });

      rooms.set(id, room);
      ws.pid = pid;
      ws.roomId = id;

      console.log(`🟢 UTWORZONO pokój ${id} przez ${room.players[0].name}`);
      send(ws, { type: 'joined', roomId: id, playerId: pid });
      broadcast(room);
      return;
    }

    if (data.type === 'join') {
      const id = String(data.roomId || '').trim().toUpperCase();
      const room = rooms.get(id);

      if (!room) {
        console.log(`❌ JOIN nie znaleziono pokoju ${id}`);
        return err(ws, 'Nie znaleziono pokoju. Sprawdź kod.');
      }
      if (room.game) return err(ws, 'Gra już trwa. Nie można dołączyć.');
      if (room.players.length >= 8) return err(ws, 'Pokój jest pełny (maks. 8 graczy).');

      const pid = crypto.randomUUID();
      const player = {
        id: pid,
        name: String(data.name || 'Gracz').trim().slice(0, 20) || 'Gracz',
        hand: [],
        ws
      };

      room.players.push(player);
      ws.pid = pid;
      ws.roomId = room.id;

      console.log(`🟢 DOŁĄCZYŁ ${player.name} do pokoju ${room.id}`);
      send(ws, { type: 'joined', roomId: room.id, playerId: pid });
      broadcast(room);
      return;
    }

    const room = getRoomForSocket(ws);
    if (!room) return err(ws, 'Najpierw utwórz lub dołącz do pokoju.');

    const me = room.players.find(player => player.id === ws.pid);
    if (!me) return err(ws, 'Nie znaleziono gracza. Odśwież stronę.');

    if (data.type === 'start') {
      if (room.hostId !== me.id) return err(ws, 'Tylko host może rozpocząć grę.');
      if (room.players.length < 2) return err(ws, 'Potrzeba co najmniej 2 graczy.');
      if (room.game) return err(ws, 'Gra już została rozpoczęta.');

      const minRank = String(data.minRank || '9');
      const maxRank = String(data.maxRank || 'A');
      if (rankValue(minRank) < 0 || rankValue(maxRank) < 0 || rankValue(minRank) > rankValue(maxRank)) {
        return err(ws, 'Nieprawidłowy zakres kart.');
      }

      try {
        startGame(room, minRank, maxRank);
      } catch (e) {
        console.error('❌ Błąd startu gry:', e);
        return err(ws, 'Nie udało się rozpocząć gry.');
      }

      console.log(`🎮 START pokoju ${room.id}: ${minRank}-${maxRank}`);
      broadcast(room);
      return;
    }

    if (!room.game) return err(ws, 'Gra jeszcze się nie rozpoczęła.');

    const game = room.game;
    const myIndex = room.players.findIndex(player => player.id === me.id);

    if (data.type === 'play') {
      if (game.winner) return err(ws, 'Gra jest już zakończona.');
      if (game.pendingClaim) return err(ws, 'Najpierw ktoś musi rozstrzygnąć pukanie.');
      if (game.turn !== myIndex) return err(ws, 'To nie jest Twoja tura.');

      const ids = Array.isArray(data.cardIds) ? data.cardIds.map(String) : [];
      if (![1, 3, 4].includes(ids.length)) {
        return err(ws, 'Możesz położyć tylko 1, 3 albo 4 karty.');
      }
      if (new Set(ids).size !== ids.length) return err(ws, 'Nieprawidłowy wybór kart.');

      const cards = ids.map(id => me.hand.find(card => card.id === id));
      if (cards.some(card => !card)) return err(ws, 'Nieprawidłowe karty.');

      const claimedRank = String(data.claimedRank || '');
      if (rankValue(claimedRank) < rankValue(game.minRank) || rankValue(claimedRank) > rankValue(game.maxRank)) {
        return err(ws, 'Nieprawidłowa deklarowana ranga.');
      }

      // Zagrywane karty muszą być co najmniej tak wysokie jak poprzednia deklaracja.
      // Na pierwszym ruchu obowiązuje najniższa ranga z talii.
      const minimum = Math.max(rankValue(game.minRank), game.currentRank);
      if (cards.some(card => rankValue(card.rank) < minimum)) {
        return err(ws, `Każda zagrana karta musi mieć rangę co najmniej ${RANKS[minimum]}.`);
      }

      me.hand = me.hand.filter(card => !ids.includes(card.id));
      game.pile.push(...cards);
      game.currentRank = rankValue(claimedRank);
      game.lastPlayer = me.id;
      game.pendingClaim = {
        playerId: me.id,
        claimedRank,
        cards
      };

      addLog(game, `${me.name} położył(a) ${cards.length} kart(y) i zadeklarował(a): ${claimedRank}.`);
      console.log(`🃏 PLAY ${me.name}: ${cards.length}x ${claimedRank}, pokój ${room.id}`);
      broadcast(room);
      return;
    }

    if (data.type === 'knock') {
      if (game.winner) return err(ws, 'Gra jest już zakończona.');
      if (!game.pendingClaim) return err(ws, 'Nie ma czego sprawdzać.');
      if (game.pendingClaim.playerId === me.id) return err(ws, 'Nie możesz zapukać na własny ruch.');

      const claim = game.pendingClaim;
      const target = room.players.find(player => player.id === claim.playerId);
      if (!target) return err(ws, 'Nie znaleziono gracza.');

      const truth = claim.cards.every(card => card.rank === claim.claimedRank);
      const collector = truth ? target : me;

      collector.hand.push(...game.pile);
      game.pile = [];
      game.pendingClaim = null;
      game.currentRank = rankValue(game.minRank) - 1;

      // Jeśli pukający zrobił to w swojej turze, błędne pukanie zużywa jego turę.
      // W tej wersji po każdym rozstrzygnięciu następny ruch przypada osobie
      // po pukającym — zgodnie z ruchem wskazówek zegara.
      game.turn = nextIndex(room, myIndex);

      if (truth) {
        addLog(game, `${me.name} zapukał(a) — miał(a) rację. ${target.name} zbiera stos.`);
      } else {
        addLog(game, `${me.name} zapukał(a) — pudło. ${me.name} zbiera stos.`);
      }

      console.log(`🔔 KNOCK ${me.name}: ${truth ? 'TRAFIONE' : 'PUDŁO'}, pokój ${room.id}`);
      broadcast(room);
      return;
    }

    if (data.type === 'leave') {
      disconnectPlayer(ws, 'leave');
      return;
    }

    err(ws, 'Nieznana akcja.');
  });

  ws.on('error', error => {
    console.error('❌ WebSocket error:', error.message);
  });

  ws.on('close', () => {
    disconnectPlayer(ws, 'close');
  });
});

function disconnectPlayer(ws, reason) {
  const room = getRoomForSocket(ws);
  if (!room) return;

  const player = room.players.find(p => p.id === ws.pid);
  if (!player) return;

  player.ws = null;
  console.log(`🔌 ROZŁĄCZONO ${player.name} z ${room.id} (${reason})`);
  broadcast(room);
  cleanupEmptyRoom(room);
}

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Oszust działa na porcie ${port}`);
});

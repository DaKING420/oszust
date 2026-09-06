import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

const SUITS = ['♥','♦','♣','♠'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const rankValue = r => RANKS.indexOf(r);
function makeDeck(minRank='9', maxRank='A') {
  const a=rankValue(minRank), b=rankValue(maxRank);
  const ranks=RANKS.slice(Math.min(a,b), Math.max(a,b)+1);
  return ranks.flatMap(rank=>SUITS.map(suit=>({id:crypto.randomUUID(),rank,suit})));
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function broadcast(room){
  for(const p of room.players){ if(p.ws?.readyState===1) p.ws.send(JSON.stringify(publicState(room,p.id))); }
}
function publicState(room, viewerId){
  return {type:'state', room:{id:room.id, players:room.players.map(p=>({id:p.id,name:p.name,cardCount:p.hand.length,connected:!!p.ws})), hostId:room.hostId}, game:room.game ? {
    started:true, turn:room.game.turn, currentRank:room.game.currentRank, pileCount:room.game.pile.length,
    pileOwner:room.game.lastPlayer, pendingClaim:room.game.pendingClaim ? {playerId:room.game.pendingClaim.playerId, claimedRank:room.game.pendingClaim.claimedRank, count:room.game.pendingClaim.cards.length} : null,
    winner:room.game.winner, minRank:room.game.minRank, maxRank:room.game.maxRank,
    hand: room.players.find(p=>p.id===viewerId)?.hand || [], log:room.game.log.slice(-20)
  } : null};
}
function addLog(g,text){ g.log.push(text); }
function nextIndex(room, idx){ return (idx+1)%room.players.length; }
function startGame(room, minRank, maxRank){
  const deck=shuffle(makeDeck(minRank,maxRank));
  room.players.forEach(p=>p.hand=[]);
  deck.forEach((c,i)=>room.players[i%room.players.length].hand.push(c));
  const starterCard = room.players.flatMap(p=>p.hand).find(c=>c.rank===minRank && c.suit==='♥');
  const starter=room.players.findIndex(p=>p.hand.some(c=>c.id===starterCard?.id));
  room.game={turn:starter,currentRank:rankValue(minRank)-1,pile:[],lastPlayer:null,pendingClaim:null,winner:null,minRank,maxRank,log:[]};
  addLog(room.game,`Gra rozpoczęta. Zaczyna ${room.players[starter].name} (${minRank}♥).`);
}
function err(ws,msg){ws.send(JSON.stringify({type:'error',message:msg}));}
function getRoom(data){ return rooms.get(data.roomId); }

wss.on('connection', ws=>{
  ws.on('message', raw=>{
    let data; try{data=JSON.parse(raw)}catch{return}
    if(data.type==='create'){ const id=(data.roomId||Math.random().toString(36).slice(2,8)).toUpperCase(); const pid=crypto.randomUUID(); const room={id,hostId:pid,players:[],game:null}; rooms.set(id,room); room.players.push({id,name:(data.name||'Gracz').slice(0,20),hand:[],ws}); ws.pid=pid; ws.roomId=id; ws.send(JSON.stringify({type:'joined',roomId:id,playerId:pid})); broadcast(room); return; }
    if(data.type==='join'){ const room=rooms.get(String(data.roomId||'').toUpperCase()); if(!room)return err(ws,'Nie znaleziono pokoju.'); if(room.game)return err(ws,'Gra już trwa.'); if(room.players.length>=8)return err(ws,'Pokój jest pełny.'); const pid=crypto.randomUUID(); room.players.push({id:pid,name:(data.name||'Gracz').slice(0,20),hand:[],ws}); ws.pid=pid; ws.roomId=room.id; ws.send(JSON.stringify({type:'joined',roomId:room.id,playerId:pid})); broadcast(room); return; }
    const room=getRoom({...data,roomId:ws.roomId}); if(!room)return err(ws,'Najpierw dołącz do pokoju.');
    const me=room.players.find(p=>p.id===ws.pid); if(!me)return;
    if(data.type==='start'){ if(room.hostId!==me.id)return err(ws,'Tylko host może rozpocząć.'); if(room.players.length<2)return err(ws,'Potrzeba co najmniej 2 graczy.'); startGame(room,data.minRank||'9',data.maxRank||'A'); broadcast(room); return; }
    if(!room.game)return err(ws,'Gra jeszcze się nie rozpoczęła.');
    const g=room.game, myIndex=room.players.findIndex(p=>p.id===me.id);
    if(data.type==='play'){
      if(g.winner)return; if(g.pendingClaim)return err(ws,'Najpierw ktoś musi rozstrzygnąć pukanie.'); if(g.turn!==myIndex)return err(ws,'To nie jest Twoja tura.');
      const ids=data.cardIds||[]; if(![1,3,4].includes(ids.length))return err(ws,'Możesz położyć tylko 1, 3 albo 4 karty.');
      const cards=ids.map(id=>me.hand.find(c=>c.id===id)).filter(Boolean); if(cards.length!==ids.length)return err(ws,'Nieprawidłowe karty.');
      if(g.currentRank>=0 && cards.some(c=>rankValue(c.rank)<g.currentRank))return err(ws,'Każda zagrana karta musi mieć rangę taką samą lub wyższą niż aktualna.');
      me.hand=me.hand.filter(c=>!ids.includes(c.id)); g.pile.push(...cards); g.currentRank=rankValue(data.claimedRank); g.lastPlayer=me.id; g.pendingClaim={playerId:me.id,claimedRank:data.claimedRank,cards};
      addLog(g,`${me.name} położył(a) ${cards.length} kart(y) i zadeklarował(a): ${data.claimedRank}.`); broadcast(room); return;
    }
    if(data.type==='knock'){
      if(!g.pendingClaim)return err(ws,'Nie ma czego sprawdzać.');
      const claim=g.pendingClaim; const target=room.players.find(p=>p.id===claim.playerId); const truth=claim.cards.every(c=>c.rank===claim.claimedRank);
      const collector=truth?me:target;
      collector.hand.push(...g.pile); g.pile=[]; g.pendingClaim=null; g.currentRank=rankValue(g.minRank)-1;
      if(truth){ g.turn=nextIndex(room,myIndex); addLog(g,`${me.name} zapukał(a) — miał(a) rację. ${target.name} zbiera stos.`); }
      else { g.turn=nextIndex(room,myIndex); addLog(g,`${me.name} zapukał(a) — pudło. ${me.name} zbiera stos i traci swoją turę.`); }
      broadcast(room); return;
    }
    if(data.type==='pass'){ return err(ws,'W tej wersji nie ma pasowania — trzeba zagrać 1, 3 albo 4 karty.'); }
  });
  ws.on('close',()=>{ const room=rooms.get(ws.roomId); if(!room)return; const p=room.players.find(p=>p.id===ws.pid); if(p)p.ws=null; broadcast(room); });
});

server.listen(process.env.PORT||3000,()=>console.log('Oszust działa na porcie '+(process.env.PORT||3000)));

import csv
import json
import random
import string
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

# -----------------------------
# Config
# -----------------------------
QUESTIONS_CSV_PATH = "questions.csv"
MAX_QUESTIONS = 30
QUESTION_TIME_SECONDS = 120
POINTS_PER_QUESTION = 1

AVATARS = ["🦊", "🐼", "🐸", "🐵", "🐯", "🐙", "🐧", "🦄"]
OFFLINE_GRACE_SECONDS = 120  # Spieler "offline" behalten

app = FastAPI(title="Quiz Multiplayer (FastAPI + WebSockets)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Data Models
# -----------------------------
@dataclass
class Question:
    text: str
    correct: str
    wrong: List[str]


@dataclass
class Player:
    token: str
    name: str
    avatar: str
    score: int = 0
    ws: Optional[WebSocket] = None
    connected: bool = False
    last_seen: float = field(default_factory=lambda: time.time())

    # Joker pro Spiel (je 1x)
    joker_5050: bool = True
    joker_spy: bool = True
    joker_risk: bool = True

    # pro Frage transient
    selected_choice: Optional[int] = None  # 0..3
    used_risk_this_q: bool = False
    used_spy_this_q: bool = False


@dataclass
class RoomState:
    code: str
    host_token: str
    created_at: float = field(default_factory=lambda: time.time())
    players: Dict[str, Player] = field(default_factory=dict)

    phase: str = "lobby"  # lobby | question | reveal | finished
    question_index: int = -1
    question_order: List[int] = field(default_factory=list)

    current_q: Optional[Dict] = None  # {text, choices[4], correct_index}
    q_deadline_ts: Optional[float] = None

    joker_used_this_q: bool = False
    live_picks: Dict[str, Optional[int]] = field(default_factory=dict)

    question_closed: bool = False     # keine Antworten/Joker mehr
    reveal_data: Optional[Dict] = None  # {correct_index, picks_by_choice}


rooms: Dict[str, RoomState] = {}
questions: List[Question] = []


# -----------------------------
# Helpers
# -----------------------------
def load_questions_from_csv(path: str) -> List[Question]:
    out: List[Question] = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter=";")
        header = next(reader, None)
        if not header:
            raise RuntimeError("CSV is empty")
        for row in reader:
            if len(row) < 5:
                continue
            out.append(
                Question(
                    text=row[0].strip(),
                    correct=row[1].strip(),
                    wrong=[row[2].strip(), row[3].strip(), row[4].strip()],
                )
            )
    return out[:MAX_QUESTIONS]


def make_room_code() -> str:
    return "".join(random.choice(string.ascii_uppercase + string.digits) for _ in range(5))


def build_question_payload(q: Question) -> Dict:
    choices = q.wrong[:] + [q.correct]
    random.shuffle(choices)
    correct_index = choices.index(q.correct)
    return {"text": q.text, "choices": choices, "correct_index": correct_index}


def public_player_view(p: Player) -> Dict:
    return {
        "token": p.token,
        "name": p.name,
        "avatar": p.avatar,
        "score": p.score,
        "connected": p.connected,
        "answered": p.selected_choice is not None,
    }


def room_snapshot(room: RoomState) -> Dict:
    players_sorted = sorted(room.players.values(), key=lambda x: x.score, reverse=True)
    return {
        "code": room.code,
        "phase": room.phase,
        "host_token": room.host_token,
        "question_index": room.question_index,
        "q_deadline_ts": room.q_deadline_ts,
        "joker_used_this_q": room.joker_used_this_q,
        "question_closed": room.question_closed,
        "reveal_data": room.reveal_data,
        "players": [public_player_view(p) for p in players_sorted],
        "current_q_public": {
            "text": room.current_q["text"],
            "choices": room.current_q["choices"],
        } if room.current_q and room.phase in ("question", "reveal") else None,
        "avatars": AVATARS,
    }


async def ws_send_safe(ws: Optional[WebSocket], payload: Dict):
    if ws is None:
        return
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


async def broadcast_room(room: RoomState, payload: Dict, only_tokens: Optional[Set[str]] = None):
    for token, p in list(room.players.items()):
        if only_tokens is not None and token not in only_tokens:
            continue
        await ws_send_safe(p.ws, payload)


def cleanup_offline_players(room: RoomState):
    now = time.time()
    to_remove = []
    for token, p in room.players.items():
        if not p.connected and (now - p.last_seen) > OFFLINE_GRACE_SECONDS:
            to_remove.append(token)
    for token in to_remove:
        room.players.pop(token, None)
        room.live_picks.pop(token, None)


async def sleep_ms(ms: int):
    import asyncio
    await asyncio.sleep(ms / 1000.0)


async def push_spy_updates(room: RoomState, only_to: Optional[Set[str]] = None):
    def fmt_choice(i: Optional[int]) -> str:
        if i is None:
            return "—"
        return chr(ord("A") + i)

    lines = []
    for p in room.players.values():
        pick = room.live_picks.get(p.token)
        lines.append(f"{p.avatar} {p.name} → {fmt_choice(pick)}")

    spy_tokens = {p.token for p in room.players.values() if p.used_spy_this_q}
    if only_to is not None:
        spy_tokens = spy_tokens.intersection(only_to)
    if not spy_tokens:
        return

    await broadcast_room(room, {"type": "spy:update", "lines": lines}, only_tokens=spy_tokens)


# -----------------------------
# Game Flow
# -----------------------------
async def start_game(room: RoomState):
    room.phase = "question"
    room.question_order = list(range(min(len(questions), MAX_QUESTIONS)))
    random.shuffle(room.question_order)
    room.question_index = -1

    # Reset game-wide state
    for p in room.players.values():
        p.score = 0
        p.joker_5050 = True
        p.joker_spy = True
        p.joker_risk = True

    await next_question(room)


async def next_question(room: RoomState):
    room.question_index += 1
    room.joker_used_this_q = False
    room.question_closed = False
    room.reveal_data = None

    room.current_q = None
    room.q_deadline_ts = None
    room.live_picks = {}

    for p in room.players.values():
        p.selected_choice = None
        p.used_risk_this_q = False
        p.used_spy_this_q = False
        room.live_picks[p.token] = None

    if room.question_index >= min(len(room.question_order), MAX_QUESTIONS):
        room.phase = "finished"
        await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
        return

    q_idx = room.question_order[room.question_index]
    q = questions[q_idx]
    room.current_q = build_question_payload(q)
    room.phase = "question"
    room.q_deadline_ts = time.time() + QUESTION_TIME_SECONDS

    await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})

    # Timer loop: schließen wenn alle geantwortet ODER Zeit um
    while True:
        if room.phase != "question":
            return

        now = time.time()
        all_answered = all(p.selected_choice is not None for p in room.players.values()) if room.players else False

        if all_answered or (room.q_deadline_ts is not None and now >= room.q_deadline_ts):
            room.question_closed = True
            await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
            return

        await broadcast_room(room, {"type": "tick", "now": now, "deadline": room.q_deadline_ts})
        await sleep_ms(350)


# -----------------------------
# Web UI (Dark Mode permanent)
# -----------------------------
INDEX_HTML = """
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Quiz Multiplayer</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      margin: 20px;
      background:#0f1115;
      color:#e6e6e6;
    }
    .row { display:flex; gap:16px; flex-wrap:wrap; }
    .card {
      border:1px solid #2a2f3a;
      background:#151924;
      border-radius: 12px;
      padding: 12px;
      min-width: 280px;
    }
    .btn {
      padding: 8px 10px;
      border-radius: 10px;
      border:1px solid #3a4252;
      background:#1c2230;
      color:#e6e6e6;
      cursor:pointer;
    }
    .btn:hover { filter: brightness(1.08); }
    .btn:disabled { opacity: 0.5; cursor:not-allowed; }
    .muted { color:#aab0bf; font-size: 13px; }
    .small { font-size: 12px; }
    input, select {
      padding: 6px;
      border-radius: 8px;
      border:1px solid #3a4252;
      background:#0f1115;
      color:#e6e6e6;
    }
    .pill {
      display:inline-block;
      padding:2px 8px;
      border-radius: 999px;
      border:1px solid #3a4252;
      font-size:12px;
    }
    .ok { border-color: #3ddc84; }
    .bad { border-color: #ff5c5c; }
    .choices button { display:block; width:100%; margin:6px 0; text-align:left; }
    .correct { border-color:#3ddc84 !important; box-shadow: 0 0 0 1px rgba(61,220,132,0.25) inset; }
    .closed { color:#ffd166; margin-top: 8px; }
  </style>
</head>
<body>
  <h2>Quiz Multiplayer</h2>

  <div class="row">
    <div class="card">
      <div><b>Verbinden</b></div>
      <div style="margin-top:10px">
        <div class="small muted">Name</div>
        <input id="name" placeholder="Name" />
      </div>
      <div style="margin-top:10px">
        <div class="small muted">Avatar</div>
        <select id="avatar"></select>
      </div>
      <div style="margin-top:10px">
        <div class="small muted">Room Code</div>
        <input id="code" placeholder="z.B. ABC12" />
      </div>
      <div style="margin-top:12px" class="row">
        <button class="btn" id="create">Room erstellen</button>
        <button class="btn" id="join">Join</button>
      </div>
      <div class="muted" style="margin-top:10px" id="status">nicht verbunden</div>
      <div class="muted small" style="margin-top:8px">Reconnect: Token wird im Browser gespeichert.</div>
    </div>

    <div class="card" style="flex:1; min-width: 340px;">
      <div class="row" style="align-items:center; justify-content: space-between;">
        <b>Spiel</b>
        <span class="pill" id="phase">lobby</span>
      </div>

      <div id="question" style="margin-top:10px"></div>
      <div class="choices" id="choices"></div>

      <div id="closedInfo" class="closed"></div>

      <div style="margin-top:10px" class="row">
        <button class="btn" id="j5050">50/50</button>
        <button class="btn" id="jspy">Spy</button>
        <button class="btn" id="jrisk">Risk</button>
      </div>
      <div class="muted small" id="jokerInfo" style="margin-top:8px"></div>

      <div style="margin-top:12px" class="row">
        <button class="btn" id="start">Start (Host)</button>
        <button class="btn" id="reveal">Auswerten (Host)</button>
        <button class="btn" id="next">Nächste Frage (Host)</button>
        <button class="btn" id="kick">Kick (Host)</button>
      </div>

      <div class="muted small" style="margin-top:8px">
        Kick: Spieler im Scoreboard anklicken.
      </div>

      <div class="muted" id="timer" style="margin-top:8px"></div>

      <div style="margin-top:12px">
        <b>Spy View</b>
        <div class="muted small">Live Picks anderer Spieler (nur wenn Spy aktiv)</div>
        <div id="spyview" class="small"></div>
      </div>
    </div>

    <div class="card" style="min-width: 320px;">
      <div><b>Scoreboard</b></div>
      <ul class="scoreboard" id="scoreboard"></ul>
    </div>
  </div>

<script>
let ws = null;
let room = null;
let myToken = localStorage.getItem("player_token") || "";
let selectedKickToken = null;
let hiddenIndices = new Set();
let spyActive = false;
let lastRoomCode = "";
let lastQuestionIndex = -999;

function qs(id) { return document.getElementById(id); }
function setStatus(s) { qs("status").textContent = s; }

function wsUrl(code) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/${code}`;
}

function connect(code, isCreate) {
  lastRoomCode = code;
  if (ws) { try { ws.close(); } catch(e) {} }
  setStatus("verbinde...");
  ws = new WebSocket(wsUrl(code));

  ws.onopen = () => {
    setStatus("verbunden");
    const name = (qs("name").value.trim() || (isCreate ? "Host" : "Player"));
    const avatar = qs("avatar").value;
    ws.send(JSON.stringify({
      type: "hello",
      token: myToken,
      name, avatar,
      create: !!isCreate
    }));
  };

  ws.onclose = () => {
    setStatus("getrennt – reconnect...");
    setTimeout(() => {
      if (lastRoomCode) connect(lastRoomCode, false);
    }, 1200);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "hello:ok") {
      myToken = msg.token;
      localStorage.setItem("player_token", myToken);
      qs("code").value = msg.room_code;
      lastRoomCode = msg.room_code; // wichtig nach create
    }

    if (msg.type === "room:update") {
      room = msg.room;

      if (room && room.question_index !== lastQuestionIndex) {
        lastQuestionIndex = room.question_index;
        hiddenIndices = new Set();
        spyActive = false;
        qs("spyview").textContent = "";
        qs("timer").textContent = "";
        qs("closedInfo").textContent = "";
      }

      render(room);
    }

    if (msg.type === "tick") {
      if (msg.deadline) {
        const left = Math.max(0, Math.ceil(msg.deadline - msg.now));
        qs("timer").textContent = "Zeit: " + left + "s";
      }
    }

    if (msg.type === "joker:5050") {
      hiddenIndices = new Set(msg.hide_indices);
      render(room);
    }

    if (msg.type === "spy:update") {
      if (spyActive) {
        qs("spyview").innerHTML = msg.lines.map(x => `<div>${x}</div>`).join("");
      }
    }

    if (msg.type === "error") {
      alert(msg.message);
    }
  };
}

function send(type, payload={}) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(Object.assign({type}, payload)));
}

function choose(i) { send("answer:submit", { choice: i }); }

function selectKick(token) {
  selectedKickToken = token;
  qs("kick").textContent = "Kick (Host) → " + token.slice(0,8);
}

function render(r) {
  if (!r) return;

  qs("phase").textContent = r.phase;

  qs("jokerInfo").textContent =
    r.joker_used_this_q ? "Joker wurde diese Frage bereits genutzt." : "Diese Frage ist noch kein Joker genutzt.";

  if (r.phase === "question" && r.question_closed) {
    qs("closedInfo").textContent = "Antworten geschlossen – Host muss auswerten.";
  } else {
    qs("closedInfo").textContent = "";
  }

  const amHost = (r.host_token === myToken);

  qs("start").disabled = !amHost;
  qs("reveal").disabled = !(amHost && r.phase === "question" && r.question_closed);
  qs("next").disabled = !(amHost && r.phase === "reveal");
  qs("kick").disabled = !amHost || !selectedKickToken;

  const canUseJokers = (r.phase === "question" && !r.question_closed && !r.joker_used_this_q);
  qs("j5050").disabled = !canUseJokers;
  qs("jspy").disabled = !canUseJokers;
  qs("jrisk").disabled = !canUseJokers;

  if (r.current_q_public) {
    qs("question").innerHTML = `<b>Q${r.question_index+1}:</b> ${r.current_q_public.text}`;
    const choices = r.current_q_public.choices;

    const reveal = r.reveal_data; // correct_index + picks_by_choice
    const correctIndex = (reveal && typeof reveal.correct_index === "number") ? reveal.correct_index : null;

    const html = choices.map((c, i) => {
      const hidden = hiddenIndices.has(i);
      const disabled = (r.phase !== "question") || r.question_closed || hidden;

      const isCorrect = (r.phase === "reveal" && correctIndex === i);
      const cls = isCorrect ? "btn correct" : "btn";

      let picksHtml = "";
      if (r.phase === "reveal" && reveal && reveal.picks_by_choice) {
        const picks = reveal.picks_by_choice[i] || [];
        if (picks.length) {
          picksHtml =
            "<div class='muted small' style='margin-top:6px'>" +
            picks.map(p => `${p.avatar} ${p.name}`).join(" • ") +
            "</div>";
        }
      }

      const label = hidden ? "—" : (String.fromCharCode(65+i)+": "+c);
      return `<button class="${cls}" ${disabled ? "disabled":""} onclick="choose(${i})">${label}${picksHtml}</button>`;
    }).join("");

    qs("choices").innerHTML = html;
  } else {
    qs("question").innerHTML = "<span class='muted'>Keine Frage (Lobby oder beendet)</span>";
    qs("choices").innerHTML = "";
    qs("timer").textContent = "";
  }

  const sb = r.players.map(p => {
    const pill = p.connected ? "ok" : "bad";
    const ans = p.answered ? " • ✅" : "";
    const me = (p.token === myToken) ? " <span class='pill'>du</span>" : "";
    return `<li style="margin:6px 0">
      <span style="cursor:pointer" onclick="selectKick('${p.token}')">
        <span class="pill ${pill}">${p.avatar}</span>
        <b>${p.name}</b> — ${p.score}${ans}${me}
        <span class="muted small">(${p.token.slice(0,8)})</span>
      </span>
    </li>`;
  }).join("");

  qs("scoreboard").innerHTML = sb;
}

qs("create").onclick = () => connect("NEW", true);
qs("join").onclick = () => {
  const code = (qs("code").value.trim() || "").toUpperCase();
  if (!code) return alert("Room Code fehlt");
  connect(code, false);
};

qs("start").onclick = () => send("game:start", {});
qs("reveal").onclick = () => send("host:reveal", {});
qs("next").onclick = () => send("host:next", {});
qs("kick").onclick = () => {
  if (!selectedKickToken) return;
  send("player:kick", { target_token: selectedKickToken });
};

qs("j5050").onclick = () => send("joker:5050", {});
qs("jspy").onclick = () => { spyActive = true; send("joker:spy", {}); };
qs("jrisk").onclick = () => send("joker:risk", {});

// avatars injected below
const sel = qs("avatar");
const AVATARS = __AVATARS__;
AVATARS.forEach(a => {
  const opt = document.createElement("option");
  opt.value = a; opt.textContent = a;
  sel.appendChild(opt);
});
sel.value = sel.options[0].value;
</script>
</body>
</html>
""".replace("__AVATARS__", json.dumps(AVATARS, ensure_ascii=False))



@app.get("/", response_class=HTMLResponse)
def index():
    return INDEX_HTML


# -----------------------------
# WebSocket Protocol
# -----------------------------
@app.websocket("/ws/{room_code}")
async def ws_room(ws: WebSocket, room_code: str):
    await ws.accept()

    current_room: Optional[RoomState] = None
    me: Optional[Player] = None

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")

            # HELLO / CONNECT / RECONNECT
            if mtype == "hello":
                create = bool(msg.get("create", False))
                name = (msg.get("name") or "Player").strip()[:24]
                avatar = msg.get("avatar") or AVATARS[0]
                if avatar not in AVATARS:
                    avatar = AVATARS[0]

                token = (msg.get("token") or "").strip()

                # Create new room
                if create:
                    code = make_room_code()
                    host_token = token or str(uuid.uuid4())
                    room = RoomState(code=code, host_token=host_token)
                    rooms[code] = room
                    current_room = room

                    p = room.players.get(host_token)
                    if not p:
                        p = Player(token=host_token, name=name, avatar=avatar)
                        room.players[host_token] = p

                    p.ws = ws
                    p.connected = True
                    p.last_seen = time.time()
                    me = p

                    await ws_send_safe(ws, {"type": "hello:ok", "token": host_token, "room_code": code})
                    await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
                    continue

                # Join existing room
                code = room_code.upper()
                if code == "NEW":
                    await ws_send_safe(ws, {"type": "error", "message": "Zum Join bitte einen echten Room Code eingeben."})
                    continue

                room = rooms.get(code)
                if not room:
                    await ws_send_safe(ws, {"type": "error", "message": "Room nicht gefunden."})
                    continue
                current_room = room

                # Reconnect or new player
                if token and token in room.players:
                    p = room.players[token]
                    p.name = name
                    p.avatar = avatar
                else:
                    token = str(uuid.uuid4())
                    p = Player(token=token, name=name, avatar=avatar)
                    room.players[token] = p

                p.ws = ws
                p.connected = True
                p.last_seen = time.time()
                me = p

                await ws_send_safe(ws, {"type": "hello:ok", "token": token, "room_code": code})
                await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
                continue

            # needs room + me
            if current_room is None or me is None:
                await ws_send_safe(ws, {"type": "error", "message": "Nicht initialisiert. Sende zuerst hello."})
                continue

            room = current_room

            # keepalive (optional)
            if mtype == "ping":
                me.last_seen = time.time()
                await ws_send_safe(ws, {"type": "pong"})
                continue

            # HOST: start game
            if mtype == "game:start":
                if me.token != room.host_token:
                    await ws_send_safe(ws, {"type": "error", "message": "Nur der Host kann starten."})
                    continue
                if not room.players:
                    await ws_send_safe(ws, {"type": "error", "message": "Keine Spieler im Room."})
                    continue
                import asyncio
                asyncio.create_task(start_game(room))
                continue

            # HOST: kick
            if mtype == "player:kick":
                if me.token != room.host_token:
                    await ws_send_safe(ws, {"type": "error", "message": "Nur der Host kann kicken."})
                    continue
                target = msg.get("target_token")
                if not target or target not in room.players:
                    await ws_send_safe(ws, {"type": "error", "message": "Ziel nicht gefunden."})
                    continue
                if target == room.host_token:
                    await ws_send_safe(ws, {"type": "error", "message": "Host kann nicht gekickt werden."})
                    continue

                target_p = room.players[target]
                await ws_send_safe(target_p.ws, {"type": "error", "message": "Du wurdest vom Host gekickt."})
                try:
                    if target_p.ws:
                        await target_p.ws.close()
                except Exception:
                    pass

                room.players.pop(target, None)
                room.live_picks.pop(target, None)
                await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
                continue

            # HOST: reveal (Auswertung anzeigen + scoring)
            if mtype == "host:reveal":
                if me.token != room.host_token:
                    await ws_send_safe(ws, {"type": "error", "message": "Nur der Host kann auswerten."})
                    continue
                if room.phase != "question" or not room.current_q:
                    await ws_send_safe(ws, {"type": "error", "message": "Gerade keine aktive Frage."})
                    continue
                if not room.question_closed:
                    await ws_send_safe(ws, {"type": "error", "message": "Warte bis alle geantwortet haben oder Zeit abgelaufen ist."})
                    continue

                picks_by_choice = {0: [], 1: [], 2: [], 3: []}
                for p in room.players.values():
                    if p.selected_choice is not None:
                        picks_by_choice[p.selected_choice].append({
                            "name": p.name,
                            "avatar": p.avatar,
                            "token": p.token,
                        })

                correct_index = room.current_q["correct_index"]

                # scoring happens once, here
                for p in room.players.values():
                    if p.selected_choice is None:
                        continue
                    is_correct = (p.selected_choice == correct_index)

                    if p.used_risk_this_q:
                        if is_correct:
                            p.score += 2 * POINTS_PER_QUESTION
                        else:
                            p.score -= POINTS_PER_QUESTION
                    else:
                        if is_correct:
                            p.score += POINTS_PER_QUESTION

                room.phase = "reveal"
                room.reveal_data = {
                    "correct_index": correct_index,
                    "picks_by_choice": picks_by_choice
                }

                await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
                continue

            # HOST: next question
            if mtype == "host:next":
                if me.token != room.host_token:
                    await ws_send_safe(ws, {"type": "error", "message": "Nur der Host kann fortfahren."})
                    continue
                if room.phase != "reveal":
                    await ws_send_safe(ws, {"type": "error", "message": "Erst auswerten, dann nächste Frage."})
                    continue
                import asyncio
                asyncio.create_task(next_question(room))
                continue

            # Answer submit
            if mtype == "answer:submit":
                if room.phase != "question" or not room.current_q:
                    await ws_send_safe(ws, {"type": "error", "message": "Gerade keine aktive Frage."})
                    continue
                if room.question_closed:
                    await ws_send_safe(ws, {"type": "error", "message": "Antworten sind geschlossen."})
                    continue

                choice = msg.get("choice")
                if not isinstance(choice, int) or choice < 0 or choice > 3:
                    await ws_send_safe(ws, {"type": "error", "message": "Ungültige Antwort."})
                    continue

                # accept first answer only
                if me.selected_choice is None:
                    me.selected_choice = choice
                    room.live_picks[me.token] = choice

                    await push_spy_updates(room)
                    await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
                continue

            # Jokers
            if isinstance(mtype, str) and mtype.startswith("joker:"):
                if room.phase != "question" or not room.current_q:
                    await ws_send_safe(ws, {"type": "error", "message": "Joker nur während einer Frage."})
                    continue
                if room.question_closed:
                    await ws_send_safe(ws, {"type": "error", "message": "Joker sind geschlossen."})
                    continue
                if room.joker_used_this_q:
                    await ws_send_safe(ws, {"type": "error", "message": "Diese Frage wurde bereits ein Joker genutzt."})
                    continue

                # 50/50
                if mtype == "joker:5050":
                    if not me.joker_5050:
                        await ws_send_safe(ws, {"type": "error", "message": "50/50 Joker bereits verbraucht."})
                        continue
                    correct_index = room.current_q["correct_index"]
                    wrong_indices = [i for i in range(4) if i != correct_index]
                    hide = random.sample(wrong_indices, 2)

                    me.joker_5050 = False
                    room.joker_used_this_q = True
                    await ws_send_safe(ws, {"type": "joker:5050", "hide_indices": hide})
                    await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
                    continue

                # Spy
                if mtype == "joker:spy":
                    if not me.joker_spy:
                        await ws_send_safe(ws, {"type": "error", "message": "Spy Joker bereits verbraucht."})
                        continue
                    me.joker_spy = False
                    me.used_spy_this_q = True
                    room.joker_used_this_q = True

                    await push_spy_updates(room, only_to={me.token})
                    await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
                    continue

                # Risk
                if mtype == "joker:risk":
                    if not me.joker_risk:
                        await ws_send_safe(ws, {"type": "error", "message": "Risk Joker bereits verbraucht."})
                        continue
                    me.joker_risk = False
                    me.used_risk_this_q = True
                    room.joker_used_this_q = True

                    await ws_send_safe(ws, {"type": "info", "message": f"Risk aktiv: richtig = +{2*POINTS_PER_QUESTION}, falsch = -{POINTS_PER_QUESTION}"})
                    await broadcast_room(room, {"type": "room:update", "room": room_snapshot(room)})
                    continue

                await ws_send_safe(ws, {"type": "error", "message": "Unbekannter Joker."})
                continue

            # unknown
            await ws_send_safe(ws, {"type": "error", "message": f"Unbekannter Nachrichtentyp: {mtype}"})

    except WebSocketDisconnect:
        pass
    finally:
        if current_room and me:
            me.connected = False
            me.ws = None
            me.last_seen = time.time()
            cleanup_offline_players(current_room)
            try:
                await broadcast_room(current_room, {"type": "room:update", "room": room_snapshot(current_room)})
            except Exception:
                pass


# -----------------------------
# Startup
# -----------------------------
@app.on_event("startup")
def on_startup():
    global questions
    questions = load_questions_from_csv(QUESTIONS_CSV_PATH)
    if len(questions) < 1:
        raise RuntimeError("No questions loaded from CSV (questions.csv missing or empty?)")

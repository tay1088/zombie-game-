"use strict";

// ---------- elements ----------
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const UI = {
  health: document.getElementById("healthLabel"),
  healthBar: document.getElementById("healthBar"),
  ammo: document.getElementById("ammoLabel"),
  score: document.getElementById("scoreLabel"),
  weapon: document.getElementById("weaponLabel"),
  wood: document.getElementById("woodLabel"),
  metal: document.getElementById("metalLabel"),
  barricade: document.getElementById("inventoryLabel"),
  message: document.getElementById("messageBox"),
  loading: document.getElementById("loading"),
  loadingText: document.getElementById("loadingText"),
};

const DEFAULT_MESSAGE = "Explore the town, loot buildings, craft upgrades";
const MAX_HEALTH = 100;
const ZOMBIE_MAX_HP = 60;
const DROP_COLORS = { ammo: "#f4d35e", med: "#67e09c", wood: "#fca311", metal: "#b9c6f2" };
const DROP_GLYPHS = { ammo: "A", med: "+", wood: "W", metal: "M" };

// ---------- state ----------
const view = { width: window.innerWidth, height: window.innerHeight, dpr: 1 };
const keys = { up: false, down: false, left: false, right: false, shoot: false };
const pointer = { x: 0, y: 0, down: false, active: false };
const aim = { x: 0, y: 0 };
const facing = { x: 1, y: 0 };

let socket = null;
let connected = false;
let reconnectTimer = null;
let myId = null;

let world = { width: 1800, height: 1400 };
let buildings = [];
let players = [];
let zombies = [];
let drops = [];
let bullets = [];

const decor = { patches: [], specks: [], roads: [] };
const smoothPlayers = new Map();
const smoothZombies = new Map();
const zombieHp = new Map();

const camera = { x: 0, y: 0 };
let cameraReady = false;
let effects = [];
let prevMe = null;
let shake = 0;
let damageFlash = 0;
let messageUntil = 0;
let lastInputAt = 0;
let lastFrameAt = 0;
let clock = 0;

// ---------- helpers ----------
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function findMe() {
  return players.find((p) => p.id === myId);
}

function meSmooth() {
  const me = findMe();
  if (!me) return null;
  return smoothPlayers.get(me.id) || me;
}

function seedRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRectPath(x, y, width, height, radius) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

// ---------- connection ----------
function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let next;
  try {
    next = new WebSocket(`${protocol}//${location.host}`);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  socket = next;

  socket.addEventListener("open", () => {
    if (socket !== next) return;
    connected = true;
  });

  socket.addEventListener("message", (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (!data || typeof data !== "object") return;

    if (data.type === "welcome") {
      myId = data.id;
      if (data.world) world = data.world;
      buildings = Array.isArray(data.buildings) ? data.buildings : [];
      buildDecor();
      cameraReady = false;
      UI.loading.classList.add("hidden");
      flashMessage("Stay alive out there", 2000);
      return;
    }

    if (data.type === "state") {
      applyState(data);
      if (UI.loading && !UI.loading.classList.contains("hidden")) UI.loading.classList.add("hidden");
    }
  });

  socket.addEventListener("close", () => {
    if (socket !== next) return;
    connected = false;
    UI.loading.classList.remove("hidden");
    UI.loadingText.textContent = "Connection lost — reconnecting…";
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    if (socket === next) socket.close();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 1200);
}

function sendAction(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "input", ...payload }));
}

// ---------- state messages ----------
function syncSmooth(map, entity) {
  let smooth = map.get(entity.id);
  if (!smooth) {
    smooth = { x: entity.x, y: entity.y, px: entity.x, py: entity.y, tx: entity.x, ty: entity.y, angle: 0 };
    map.set(entity.id, smooth);
    return;
  }
  smooth.tx = entity.x;
  smooth.ty = entity.y;
}

function pruneMap(map, list) {
  const ids = new Set(list.map((item) => item.id));
  for (const id of map.keys()) {
    if (!ids.has(id)) map.delete(id);
  }
}

function applyState(data) {
  players = Array.isArray(data.players) ? data.players : [];
  zombies = Array.isArray(data.zombies) ? data.zombies : [];
  drops = Array.isArray(data.drops) ? data.drops : [];
  bullets = Array.isArray(data.bullets) ? data.bullets : [];

  for (const player of players) syncSmooth(smoothPlayers, player);
  for (const zombie of zombies) syncSmooth(smoothZombies, zombie);
  pruneMap(smoothPlayers, players);
  pruneMap(smoothZombies, zombies);

  const seen = new Set();
  for (const zombie of zombies) {
    seen.add(zombie.id);
    const previous = zombieHp.get(zombie.id);
    if (previous !== undefined && zombie.hp < previous) addSparks(zombie.x, zombie.y, "#9be36b", 5);
    zombieHp.set(zombie.id, zombie.hp);
  }
  for (const id of zombieHp.keys()) {
    if (!seen.has(id)) zombieHp.delete(id);
  }

  updateHud();
  trackMe();
}

function updateHud() {
  const me = findMe();
  if (!me) return;

  UI.health.textContent = String(Math.max(0, Math.round(me.hp)));
  UI.healthBar.style.width = `${clamp(me.hp / MAX_HEALTH, 0, 1) * 100}%`;
  UI.healthBar.dataset.low = me.hp <= 35 ? "1" : "0";
  UI.ammo.textContent = String(Math.max(0, Math.round(me.ammo)));
  UI.score.textContent = String(Math.round(me.score));
  UI.weapon.textContent = me.weapon;
  UI.wood.textContent = String(Math.round(me.wood));
  UI.metal.textContent = String(Math.round(me.metal));
  UI.barricade.textContent = String(Math.round((me.inventory && me.inventory.barricadeLevel) || 1));
}

function trackMe() {
  const me = findMe();
  if (!me) return;
  const level = (me.inventory && me.inventory.barricadeLevel) || 1;

  if (!prevMe) {
    prevMe = { hp: me.hp, ammo: me.ammo, wood: me.wood, metal: me.metal, weapon: me.weapon, level };
    return;
  }

  if (me.ammo > prevMe.ammo) flashMessage(`+${me.ammo - prevMe.ammo} ammo`);
  if (me.wood > prevMe.wood) flashMessage(`+${me.wood - prevMe.wood} wood`);
  if (me.metal > prevMe.metal) flashMessage(`+${me.metal - prevMe.metal} metal`);
  if (level > prevMe.level) flashMessage(`Barricade upgraded — level ${level}`, 2200);
  if (me.hp > prevMe.hp + 0.5) flashMessage("Health restored");
  if (me.hp < prevMe.hp - 0.5) {
    damageFlash = Math.min(0.9, damageFlash + (prevMe.hp - me.hp) / 30);
    shake = Math.max(shake, 7);
  }
  if (me.weapon !== prevMe.weapon) flashMessage(me.weapon, 1400);
  if (me.ammo < prevMe.ammo && me.weapon === prevMe.weapon) {
    addMuzzle(me.x, me.y, Math.atan2(aim.y - me.y, aim.x - me.x));
  }

  prevMe = { hp: me.hp, ammo: me.ammo, wood: me.wood, metal: me.metal, weapon: me.weapon, level };
}

// ---------- effects ----------
function addMuzzle(x, y, angle) {
  effects.push({ kind: "flash", x, y, angle, life: 0.09, ttl: 0.09 });
}

function addSparks(x, y, color, count) {
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 120;
    effects.push({
      kind: "spark",
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color,
      life: 0.35,
      ttl: 0.35,
    });
  }
}

// ---------- messages ----------
function flashMessage(text, duration = 1700) {
  UI.message.textContent = text;
  messageUntil = performance.now() + duration;
}

function nearestDoor(me) {
  let best = Infinity;
  for (const building of buildings) {
    const distance = Math.hypot(building.doorX - me.x, building.doorY - me.y);
    if (distance < best) best = distance;
  }
  return best;
}

function updateMessage(me) {
  if (performance.now() < messageUntil) return;
  let hint = DEFAULT_MESSAGE;
  if (!me) {
    hint = "Connecting to the outpost…";
  } else if (me.hp <= 0) {
    hint = "You went down — respawning…";
  } else if (nearestDoor(me) < 90) {
    hint = "Press E or tap LOOT to search this building";
  } else if (me.ammo <= 0) {
    hint = "Out of ammo — search buildings for supplies";
  } else if (drops.some((drop) => Math.hypot(drop.x - me.x, drop.y - me.y) < 70)) {
    hint = "Walk over supplies to pick them up";
  }
  if (UI.message.textContent !== hint) UI.message.textContent = hint;
}

// ---------- decor ----------
function buildDecor() {
  const random = seedRandom(20260101);
  decor.patches.length = 0;
  decor.specks.length = 0;
  decor.roads.length = 0;

  for (let i = 0; i < 70; i += 1) {
    decor.patches.push({
      x: random() * world.width,
      y: random() * world.height,
      r: 26 + random() * 80,
    });
  }
  for (let i = 0; i < 170; i += 1) {
    decor.specks.push({
      x: random() * world.width,
      y: random() * world.height,
      s: 1 + random() * 2.2,
      a: 0.03 + random() * 0.06,
    });
  }
  decor.roads.push(
    { x: 600, y: 0, w: 110, h: world.height },
    { x: 0, y: 555, w: world.width, h: 100 },
    { x: 0, y: 1225, w: world.width, h: 90 }
  );
}

// ---------- simulation smoothing ----------
function updateSmoothing(dt) {
  const k = 1 - Math.exp(-20 * dt);
  for (const smooth of smoothPlayers.values()) {
    smooth.px = smooth.x;
    smooth.py = smooth.y;
    smooth.x += (smooth.tx - smooth.x) * k;
    smooth.y += (smooth.ty - smooth.y) * k;
    const dx = smooth.x - smooth.px;
    const dy = smooth.y - smooth.py;
    if (Math.hypot(dx, dy) > 0.25) smooth.angle = Math.atan2(dy, dx);
  }
  for (const smooth of smoothZombies.values()) {
    smooth.px = smooth.x;
    smooth.py = smooth.y;
    smooth.x += (smooth.tx - smooth.x) * k;
    smooth.y += (smooth.ty - smooth.y) * k;
    const dx = smooth.x - smooth.px;
    const dy = smooth.y - smooth.py;
    if (Math.hypot(dx, dy) > 0.2) smooth.angle = Math.atan2(dy, dx);
  }
}

// ---------- input ----------
function updatePointer(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = clamp(event.clientX - rect.left, 0, view.width);
  pointer.y = clamp(event.clientY - rect.top, 0, view.height);
  pointer.active = true;
}

function pressKey(key, state) {
  if (key === "up") keys.up = state;
  if (key === "down") keys.down = state;
  if (key === "left") keys.left = state;
  if (key === "right") keys.right = state;
  if (key === "shoot") pointer.down = state;
  if (key === "enter" && state) sendAction({ enterBuilding: true });
  if (key === "craft" && state) sendAction({ craft: true });
  if (key === "swap" && state) sendAction({ weaponSwap: true });
}

function setupInput() {
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (key === "w" || key === "arrowup") keys.up = true;
    if (key === "s" || key === "arrowdown") keys.down = true;
    if (key === "a" || key === "arrowleft") keys.left = true;
    if (key === "d" || key === "arrowright") keys.right = true;
    if (event.code === "Space") {
      event.preventDefault();
      keys.shoot = true;
    }
    if (event.repeat) return;
    if (key === "e") sendAction({ enterBuilding: true });
    if (key === "c") sendAction({ craft: true });
    if (key === "q") sendAction({ weaponSwap: true });
  });

  document.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    if (key === "w" || key === "arrowup") keys.up = false;
    if (key === "s" || key === "arrowdown") keys.down = false;
    if (key === "a" || key === "arrowleft") keys.left = false;
    if (key === "d" || key === "arrowright") keys.right = false;
    if (event.code === "Space") keys.shoot = false;
  });

  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" && !pointer.down) return;
    updatePointer(event);
  });
  canvas.addEventListener("pointerdown", (event) => {
    updatePointer(event);
    pointer.down = true;
    if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
  });
  window.addEventListener("pointerup", () => {
    pointer.down = false;
  });
  window.addEventListener("pointercancel", () => {
    pointer.down = false;
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  document.querySelectorAll("[data-key]").forEach((button) => {
    const key = button.dataset.key;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      pressKey(key, true);
    });
    button.addEventListener("pointerup", (event) => {
      event.preventDefault();
      pressKey(key, false);
    });
    button.addEventListener("pointerleave", () => pressKey(key, false));
    button.addEventListener("pointercancel", () => pressKey(key, false));
  });

  window.addEventListener("blur", () => {
    keys.up = false;
    keys.down = false;
    keys.left = false;
    keys.right = false;
    keys.shoot = false;
    pointer.down = false;
  });
}

function sendInput(time) {
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (time - lastInputAt < 32) return;
  lastInputAt = time;
  socket.send(
    JSON.stringify({
      type: "input",
      left: keys.left,
      right: keys.right,
      up: keys.up,
      down: keys.down,
      shoot: pointer.down || keys.shoot,
      aimX: Math.round(aim.x),
      aimY: Math.round(aim.y),
    })
  );
}

// ---------- update ----------
function update(dt) {
  updateSmoothing(dt);

  const me = findMe();
  const smoothMe = meSmooth();

  const moving = keys.left || keys.right || keys.up || keys.down;
  if (moving) {
    facing.x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    facing.y = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    const length = Math.hypot(facing.x, facing.y) || 1;
    facing.x /= length;
    facing.y /= length;
  }

  if (smoothMe) {
    if (pointer.active) {
      aim.x = pointer.x + camera.x;
      aim.y = pointer.y + camera.y;
    } else {
      aim.x = smoothMe.x + facing.x * 240;
      aim.y = smoothMe.y + facing.y * 240;
    }
  }

  if (smoothMe) {
    const targetX = clamp(smoothMe.x - view.width / 2, 0, Math.max(0, world.width - view.width));
    const targetY = clamp(smoothMe.y - view.height / 2, 0, Math.max(0, world.height - view.height));
    if (!cameraReady) {
      camera.x = targetX;
      camera.y = targetY;
      cameraReady = true;
    } else {
      const k = 1 - Math.exp(-12 * dt);
      camera.x += (targetX - camera.x) * k;
      camera.y += (targetY - camera.y) * k;
    }
  }

  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const effect = effects[i];
    effect.life -= dt;
    if (effect.kind === "spark") {
      effect.x += effect.vx * dt;
      effect.y += effect.vy * dt;
      effect.vx *= 0.9;
      effect.vy *= 0.9;
    }
    if (effect.life <= 0) effects.splice(i, 1);
  }

  shake = Math.max(0, shake - dt * 40);
  damageFlash = Math.max(0, damageFlash - dt * 2.2);

  sendInput(performance.now());
  updateMessage(me);
}

// ---------- rendering ----------
function resizeCanvas() {
  view.width = window.innerWidth;
  view.height = window.innerHeight;
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(view.width * view.dpr);
  canvas.height = Math.floor(view.height * view.dpr);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
}

function drawGround() {
  ctx.fillStyle = "#15201e";
  ctx.fillRect(0, 0, world.width, world.height);

  for (const patch of decor.patches) {
    ctx.fillStyle = "rgba(78, 112, 74, 0.13)";
    ctx.beginPath();
    ctx.arc(patch.x, patch.y, patch.r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const road of decor.roads) {
    ctx.fillStyle = "#1b2628";
    ctx.fillRect(road.x, road.y, road.w, road.h);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    ctx.lineWidth = 2;
    ctx.setLineDash([16, 18]);
    ctx.beginPath();
    if (road.w < road.h) {
      ctx.moveTo(road.x + road.w / 2, road.y);
      ctx.lineTo(road.x + road.w / 2, road.y + road.h);
    } else {
      ctx.moveTo(road.x, road.y + road.h / 2);
      ctx.lineTo(road.x + road.w, road.y + road.h / 2);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const speck of decor.specks) {
    ctx.fillStyle = `rgba(255, 255, 255, ${speck.a})`;
    ctx.fillRect(speck.x, speck.y, speck.s, speck.s);
  }

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, world.width - 6, world.height - 6);
}

function drawBuildings(smoothMe) {
  for (const building of buildings) {
    const { x, y, w, h } = building;

    ctx.fillStyle = "rgba(0, 0, 0, 0.38)";
    ctx.fillRect(x + 10, y + 12, w, h);

    ctx.fillStyle = "#3b4a45";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#2a3734";
    ctx.fillRect(x + 10, y + 10, w - 20, h - 20);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 11, y + 11, w - 22, h - 22);

    const count = Math.max(2, Math.round(w / 80));
    const step = (w - 80) / (count - 1);
    for (let i = 0; i < count; i += 1) {
      const wx = x + 40 + step * i - 9;
      const lit = (i + Math.floor(x / 60) + Math.floor(y / 80)) % 3 !== 0;
      ctx.fillStyle = lit ? "rgba(244, 201, 93, 0.55)" : "rgba(14, 26, 25, 0.9)";
      ctx.fillRect(wx, y + 26, 18, 12);
    }

    const doorX = building.doorX;
    const doorY = building.doorY;
    ctx.fillStyle = "#08110f";
    ctx.fillRect(doorX - 22, doorY - 10, 44, 20);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(doorX - 22, doorY - 10, 44, 20);

    if (smoothMe && Math.hypot(smoothMe.x - doorX, smoothMe.y - doorY) < 130) {
      const pulse = 0.55 + 0.45 * Math.sin(clock * 5);
      ctx.fillStyle = "rgba(125, 240, 143, 0.10)";
      ctx.beginPath();
      ctx.arc(doorX, doorY, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(125, 240, 143, ${0.3 + 0.45 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(doorX, doorY, 26 + pulse * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawDrops() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";

  for (const drop of drops) {
    const color = DROP_COLORS[drop.type] || "#ffffff";
    const pulse = 1 + Math.sin(clock * 4 + drop.x * 0.05) * 0.15;

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(drop.x, drop.y, drop.radius * 0.8 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(drop.x, drop.y, drop.radius + 5 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#08110f";
    ctx.fillText(DROP_GLYPHS[drop.type] || "", drop.x, drop.y + 0.5);
  }
}

function drawBullets() {
  ctx.save();
  ctx.shadowColor = "#ffe08a";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#ffe9a3";
  for (const bullet of bullets) {
    ctx.beginPath();
    ctx.arc(bullet.x, bullet.y, bullet.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawZombies() {
  for (const zombie of zombies) {
    const smooth = smoothZombies.get(zombie.id) || zombie;
    const wobble = Math.sin(clock * 5 + (zombie.x + zombie.y) * 0.02) * 0.22;

    ctx.save();
    ctx.translate(smooth.x, smooth.y);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.beginPath();
    ctx.ellipse(0, 9, 17, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate((smooth.angle || 0) + wobble);
    ctx.strokeStyle = "#6f9a5f";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(4, -10);
    ctx.lineTo(19, -7);
    ctx.moveTo(4, 10);
    ctx.lineTo(19, 7);
    ctx.stroke();

    ctx.fillStyle = "#6f9a5f";
    ctx.beginPath();
    ctx.arc(0, 0, zombie.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2c4527";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#ff5d4f";
    ctx.beginPath();
    ctx.arc(8, -5, 2.4, 0, Math.PI * 2);
    ctx.arc(8, 5, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (zombie.hp < ZOMBIE_MAX_HP) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(smooth.x - 16, smooth.y - 30, 32, 4);
      ctx.fillStyle = zombie.hp > 30 ? "#8ee88a" : "#ff8a5c";
      ctx.fillRect(smooth.x - 16, smooth.y - 30, 32 * clamp(zombie.hp / ZOMBIE_MAX_HP, 0, 1), 4);
    }
  }
}

function drawPlayers() {
  for (const player of players) {
    const smooth = smoothPlayers.get(player.id) || player;
    const isMe = player.id === myId;
    const angle = isMe ? Math.atan2(aim.y - smooth.y, aim.x - smooth.x) : smooth.angle || 0;

    ctx.save();
    ctx.translate(smooth.x, smooth.y);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.beginPath();
    ctx.ellipse(0, 10, 18, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(angle);
    ctx.fillStyle = "#20292c";
    ctx.fillRect(10, -3.5, 20, 7);
    ctx.fillStyle = "#3c4c50";
    ctx.fillRect(26, -2.5, 6, 5);

    ctx.fillStyle = player.color;
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(10, 20, 20, 0.75)";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = "rgba(8, 18, 18, 0.85)";
    ctx.beginPath();
    ctx.arc(7, -4, 2.4, 0, Math.PI * 2);
    ctx.arc(7, 4, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (isMe) {
      const ring = 22 + Math.sin(clock * 3) * 1.6;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.arc(smooth.x, smooth.y, ring, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (player.hp < MAX_HEALTH) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.fillRect(smooth.x - 18, smooth.y - 30, 36, 4);
      ctx.fillStyle = player.color;
      ctx.fillRect(smooth.x - 18, smooth.y - 30, 36 * clamp(player.hp / MAX_HEALTH, 0, 1), 4);
    }
  }
}

function drawEffects() {
  for (const effect of effects) {
    const k = clamp(effect.life / effect.ttl, 0, 1);
    if (effect.kind === "flash") {
      ctx.save();
      ctx.translate(effect.x, effect.y);
      ctx.rotate(effect.angle);
      ctx.globalAlpha = k;
      const gradient = ctx.createLinearGradient(18, 0, 46, 0);
      gradient.addColorStop(0, "rgba(255, 236, 160, 0.95)");
      gradient.addColorStop(1, "rgba(255, 158, 60, 0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(18, 0);
      ctx.lineTo(46, -9);
      ctx.lineTo(46, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else if (effect.kind === "spark") {
      ctx.globalAlpha = k;
      ctx.fillStyle = effect.color;
      ctx.beginPath();
      ctx.arc(effect.x, effect.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function drawDarkness(smoothMe) {
  const sx = smoothMe.x - camera.x;
  const sy = smoothMe.y - camera.y;
  const gradient = ctx.createRadialGradient(sx, sy, 100, sx, sy, Math.max(view.width, view.height) * 0.8);
  gradient.addColorStop(0, "rgba(4, 10, 12, 0)");
  gradient.addColorStop(0.55, "rgba(4, 10, 12, 0.25)");
  gradient.addColorStop(1, "rgba(4, 10, 12, 0.62)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, view.width, view.height);
}

function drawMinimap(smoothMe) {
  const size = view.width < 680 ? 96 : 148;
  const pad = 14;
  const x = view.width - size - pad;
  const y = pad;
  const sx = size / world.width;
  const sy = size / world.height;

  ctx.fillStyle = "rgba(6, 16, 19, 0.78)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = 1;
  roundRectPath(x, y, size, size, 10);
  ctx.fill();
  ctx.stroke();

  for (const building of buildings) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    ctx.fillRect(x + building.x * sx, y + building.y * sy, Math.max(2, building.w * sx), Math.max(2, building.h * sy));
  }

  for (const drop of drops) {
    ctx.fillStyle = DROP_COLORS[drop.type] || "#ffffff";
    ctx.fillRect(x + drop.x * sx - 1, y + drop.y * sy - 1, 2.5, 2.5);
  }

  for (const zombie of zombies) {
    ctx.fillStyle = "#a7e56b";
    ctx.fillRect(x + zombie.x * sx - 1.5, y + zombie.y * sy - 1.5, 3, 3);
  }

  for (const player of players) {
    ctx.fillStyle = player.id === myId ? "#ffffff" : player.color;
    ctx.beginPath();
    ctx.arc(x + player.x * sx, y + player.y * sy, player.id === myId ? 3 : 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (smoothMe) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + smoothMe.x * sx, y + smoothMe.y * sy, 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawCrosshair(me, smoothMe) {
  if (!me || me.hp <= 0) return;
  const cx = pointer.active ? pointer.x : view.width / 2;
  const cy = pointer.active ? pointer.y : view.height / 2;

  if (smoothMe) {
    ctx.strokeStyle = "rgba(244, 201, 93, 0.18)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 10]);
    ctx.beginPath();
    ctx.moveTo(smoothMe.x - camera.x, smoothMe.y - camera.y);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const spread = pointer.down || keys.shoot ? 12 : 9;
  ctx.strokeStyle = pointer.down || keys.shoot ? "rgba(255, 170, 90, 0.95)" : "rgba(255, 255, 255, 0.75)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(cx - spread, cy);
  ctx.lineTo(cx - 3, cy);
  ctx.moveTo(cx + 3, cy);
  ctx.lineTo(cx + spread, cy);
  ctx.moveTo(cx, cy - spread);
  ctx.lineTo(cx, cy - 3);
  ctx.moveTo(cx, cy + 3);
  ctx.lineTo(cx, cy + spread);
  ctx.stroke();

  ctx.fillStyle = "rgba(244, 201, 93, 0.9)";
  ctx.beginPath();
  ctx.arc(cx, cy, 1.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawOverlays(me) {
  if (damageFlash > 0.01) {
    ctx.fillStyle = `rgba(190, 34, 28, ${damageFlash * 0.35})`;
    ctx.fillRect(0, 0, view.width, view.height);
  }

  const hurt = me ? clamp(1 - me.hp / 40, 0, 1) : 0;
  if (hurt > 0.01) {
    const gradient = ctx.createRadialGradient(
      view.width / 2,
      view.height / 2,
      Math.min(view.width, view.height) * 0.28,
      view.width / 2,
      view.height / 2,
      Math.max(view.width, view.height) * 0.72
    );
    gradient.addColorStop(0, "rgba(150, 20, 16, 0)");
    gradient.addColorStop(1, `rgba(150, 20, 16, ${0.38 * hurt})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, view.width, view.height);
  }

  if (me && me.hp <= 0) {
    ctx.fillStyle = "rgba(20, 2, 2, 0.55)";
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffd9d3";
    ctx.font = "700 34px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("YOU WENT DOWN", view.width / 2, view.height / 2 - 12);
    ctx.fillStyle = "rgba(255, 217, 211, 0.75)";
    ctx.font = "500 14px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("Respawning at the outpost…", view.width / 2, view.height / 2 + 24);
  }
}

function render() {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = "#070f11";
  ctx.fillRect(0, 0, view.width, view.height);

  const me = findMe();
  const smoothMe = meSmooth();

  if (!smoothMe) {
    return;
  }

  const shakeX = (Math.random() - 0.5) * shake;
  const shakeY = (Math.random() - 0.5) * shake;

  ctx.save();
  ctx.translate(-camera.x + shakeX, -camera.y + shakeY);
  drawGround();
  drawBuildings(smoothMe);
  drawDrops();
  drawBullets();
  drawZombies();
  drawPlayers();
  drawEffects();
  ctx.restore();

  drawDarkness(smoothMe);
  drawMinimap(smoothMe);
  drawCrosshair(me, smoothMe);
  drawOverlays(me);
}

function frame(time) {
  const dt = Math.min(0.05, Math.max(0.001, (time - lastFrameAt) / 1000));
  lastFrameAt = time;
  clock += dt;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

// ---------- boot ----------
resizeCanvas();
setupInput();
window.addEventListener("resize", resizeCanvas);
window.addEventListener("pagehide", () => {
  if (socket) socket.close();
});
connect();
requestAnimationFrame(frame);

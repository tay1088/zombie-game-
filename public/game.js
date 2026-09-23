const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const healthLabel = document.getElementById("healthLabel");
const ammoLabel = document.getElementById("ammoLabel");
const scoreLabel = document.getElementById("scoreLabel");
const weaponLabel = document.getElementById("weaponLabel");
const woodLabel = document.getElementById("woodLabel");
const metalLabel = document.getElementById("metalLabel");
const inventoryLabel = document.getElementById("inventoryLabel");
const messageBox = document.getElementById("messageBox");

const keys = {
  up: false,
  down: false,
  left: false,
  right: false
};

let socket;
let myId = null;
let world = { width: 1800, height: 1400 };
let buildings = [];
let players = [];
let zombies = [];
let drops = [];
let bullets = [];
let camera = { x: 0, y: 0 };
let pointer = { x: 0, y: 0, down: false };

function resizeCanvas() {
  canvas.width = Math.floor(window.innerWidth * window.devicePixelRatio);
  canvas.height = Math.floor(window.innerHeight * window.devicePixelRatio);
  ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function connect() {
  socket = new WebSocket(`ws://${location.hostname}:3000`);

  socket.onopen = () => {
    messageBox.textContent = "Connected to survival server";
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "welcome") {
        myId = data.id;
        world = data.world;
        buildings = data.buildings;
        return;
      }

      if (data.type === "state") {
        players = data.players;
        zombies = data.zombies;
        drops = data.drops;
        bullets = data.bullets;
        updateHud();
      }
    } catch (err) {
      // ignore
    }
  };

  socket.onclose = () => {
    messageBox.textContent = "Disconnected — reconnecting...";
    setTimeout(connect, 1000);
  };
}

function updateHud() {
  const me = players.find((p) => p.id === myId);
  if (!me) return;

  healthLabel.textContent = `Health: ${Math.round(me.hp)}`;
  ammoLabel.textContent = `Ammo: ${Math.round(me.ammo)}`;
  scoreLabel.textContent = `Score: ${Math.round(me.score)}`;
  weaponLabel.textContent = `Weapon: ${me.weapon}`;
  woodLabel.textContent = `Wood: ${Math.round(me.wood)}`;
  metalLabel.textContent = `Metal: ${Math.round(me.metal)}`;
  inventoryLabel.textContent = `Barricades: ${Math.round(me.inventory.barricadeLevel || 1)}`;
}

function sendInput() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const me = players.find((p) => p.id === myId);
  if (!me) return;

  const payload = {
    type: "input",
    left: keys.left,
    right: keys.right,
    up: keys.up,
    down: keys.down,
    shoot: pointer.down,
    aimX: pointer.x,
    aimY: pointer.y,
    enterBuilding: false,
    craft: false,
    weaponSwap: false
  };

  socket.send(JSON.stringify(payload));
}

function drawWorld() {
  const me = players.find((p) => p.id === myId);
  if (!me) return;

  camera.x = clamp(me.x - window.innerWidth / 2, 0, world.width - window.innerWidth);
  camera.y = clamp(me.y - window.innerHeight / 2, 0, world.height - window.innerHeight);

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.fillStyle = "#2d4b57";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  for (let x = 0; x < world.width; x += 100) {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(x - camera.x, 0);
    ctx.lineTo(x - camera.x, world.height);
    ctx.stroke();
  }

  for (let y = 0; y < world.height; y += 100) {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, y - camera.y);
    ctx.lineTo(world.width, y - camera.y);
    ctx.stroke();
  }

  for (const building of buildings) {
    const x = building.x - camera.x;
    const y = building.y - camera.y;
    ctx.fillStyle = "#d8b89d";
    ctx.fillRect(x, y, building.w, building.h);
    ctx.fillStyle = "#9a7a5c";
    ctx.fillRect(x + 18, y + 18, building.w - 36, building.h - 36);
    ctx.fillStyle = "#2f2f2f";
    ctx.fillRect(building.doorX - camera.x - 16, building.doorY - camera.y - 16, 32, 32);
  }

  for (const drop of drops) {
    const x = drop.x - camera.x;
    const y = drop.y - camera.y;
    const color = drop.type === "ammo" ? "#f4d35e" : drop.type === "med" ? "#67e09c" : drop.type === "wood" ? "#fca311" : "#ccd5ff";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, drop.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const bullet of bullets) {
    const x = bullet.x - camera.x;
    const y = bullet.y - camera.y;
    ctx.fillStyle = "#ffca3a";
    ctx.beginPath();
    ctx.arc(x, y, bullet.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const z of zombies) {
    const x = z.x - camera.x;
    const y = z.y - camera.y;
    ctx.fillStyle = "#73ef78";
    ctx.beginPath();
    ctx.arc(x, y, z.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#1d2a2f";
    ctx.fillRect(x - 18, y - 26, 36, 6);
    ctx.fillStyle = "#d9f99d";
    ctx.fillRect(x - 18, y - 26, 36 * (z.hp / 60), 6);
  }

  for (const p of players) {
    const x = p.x - camera.x;
    const y = p.y - camera.y;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();

    if (p.id === myId) {
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 18, y);
      ctx.stroke();
    }
  }

  drawMinimap(me);
  drawCrosshair();
}

function drawMinimap(me) {
  const size = 140;
  const pad = 14;
  const x = window.innerWidth - size - pad;
  const y = pad;

  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(x, y, size, size);

  const sx = size / world.width;
  const sy = size / world.height;

  for (const building of buildings) {
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(x + building.x * sx, y + building.y * sy, building.w * sx, building.h * sy);
  }

  for (const z of zombies) {
    ctx.fillStyle = "#7efaa0";
    ctx.fillRect(x + z.x * sx - 2, y + z.y * sy - 2, 4, 4);
  }

  for (const p of players) {
    ctx.fillStyle = p.id === myId ? "#fff" : p.color;
    ctx.fillRect(x + p.x * sx - 3, y + p.y * sy - 3, 6, 6);
  }

  ctx.strokeStyle = "#ffffff";
  ctx.strokeRect(x, y, size, size);
}

function drawCrosshair() {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.moveTo(cx - 8, cy);
  ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8);
  ctx.lineTo(cx, cy + 8);
  ctx.stroke();
}

function sendAction(action) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const payload = { type: "input", ...action };
  socket.send(JSON.stringify(payload));
}

function handleMouseMove(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = event.clientX - rect.left + camera.x;
  pointer.y = event.clientY - rect.top + camera.y;
}

function setupInput() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "w" || event.key === "W") keys.up = true;
    if (event.key === "s" || event.key === "S") keys.down = true;
    if (event.key === "a" || event.key === "A") keys.left = true;
    if (event.key === "d" || event.key === "D") keys.right = true;

    if (event.key === "e" || event.key === "E") {
      sendAction({ enterBuilding: true });
    }

    if (event.key === "c" || event.key === "C") {
      sendAction({ craft: true });
    }

    if (event.key === "q" || event.key === "Q") {
      sendAction({ weaponSwap: true });
    }

    if (event.code === "Space") {
      event.preventDefault();
      pointer.down = true;
    }
  });

  document.addEventListener("keyup", (event) => {
    if (event.key === "w" || event.key === "W") keys.up = false;
    if (event.key === "s" || event.key === "S") keys.down = false;
    if (event.key === "a" || event.key === "A") keys.left = false;
    if (event.key === "d" || event.key === "D") keys.right = false;

    if (event.code === "Space") pointer.down = false;
  });

  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mousedown", (event) => {
    handleMouseMove(event);
    pointer.down = true;
  });
  window.addEventListener("mouseup", () => {
    pointer.down = false;
  });

  document.querySelectorAll("[data-key]").forEach((button) => {
    const key = button.dataset.key;

    const setState = (state) => {
      if (key === "up") keys.up = state;
      if (key === "down") keys.down = state;
      if (key === "left") keys.left = state;
      if (key === "right") keys.right = state;
      if (key === "shoot") pointer.down = state;
      if (key === "enter" && state) sendAction({ enterBuilding: true });
      if (key === "craft" && state) sendAction({ craft: true });
      if (key === "swap" && state) sendAction({ weaponSwap: true });
    };

    button.addEventListener("pointerdown", () => setState(true));
    button.addEventListener("pointerup", () => setState(false));
    button.addEventListener("pointerleave", () => setState(false));
  });
}

function loop() {
  sendInput();
  drawWorld();
  requestAnimationFrame(loop);
}

window.addEventListener("resize", resizeCanvas);
window.addEventListener("load", () => {
  resizeCanvas();
  setupInput();
  connect();
  requestAnimationFrame(loop);
});

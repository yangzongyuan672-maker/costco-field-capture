const $ = (id) => document.getElementById(id);

const els = {
  video: $("camera"),
  canvas: $("snapshot"),
  emptyCamera: $("emptyCamera"),
  productFrame: $("productFrame"),
  priceFrame: $("priceFrame"),
  stepTitle: $("stepTitle"),
  pairCount: $("pairCount"),
  productMode: $("productMode"),
  priceMode: $("priceMode"),
  zoomRow: $("zoomRow"),
  zoomNote: $("zoomNote"),
  startBtn: $("startBtn"),
  captureBtn: $("captureBtn"),
  fileInput: $("fileInput"),
  undoBtn: $("undoBtn"),
  exportBtn: $("exportBtn"),
  clearBtn: $("clearBtn"),
  pairList: $("pairList"),
  storageStatus: $("storageStatus"),
  pairTemplate: $("pairTemplate")
};

const DB_NAME = "costco-field-capture-v1";
const STORE = "captures";
const JPEG_QUALITY = 0.96;

let db;
let stream;
let mode = "product";
let currentZoom = 1;
let captures = [];
let objectUrls = [];

init();

async function init() {
  db = await openDb();
  captures = await loadCaptures();
  bindEvents();
  await render();
}

function bindEvents() {
  els.startBtn.addEventListener("click", startCamera);
  els.captureBtn.addEventListener("click", captureFromVideo);
  els.fileInput.addEventListener("change", captureFromFile);
  els.productMode.addEventListener("click", () => setMode("product"));
  els.priceMode.addEventListener("click", () => setMode("price"));
  els.undoBtn.addEventListener("click", undoLast);
  els.exportBtn.addEventListener("click", exportZip);
  els.clearBtn.addEventListener("click", clearAll);
  els.zoomRow.addEventListener("click", (event) => {
    const button = event.target.closest("[data-zoom]");
    if (button) setZoom(Number(button.dataset.zoom));
  });
}

async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 3840 },
        height: { ideal: 2160 }
      },
      audio: false
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.emptyCamera.classList.add("is-hidden");
    await setZoom(currentZoom);
  } catch (error) {
    alert(`相机启动失败：${error.message || error}`);
  }
}

function stopCamera() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
}

async function setZoom(value) {
  currentZoom = value;
  for (const button of els.zoomRow.querySelectorAll("[data-zoom]")) {
    button.classList.toggle("is-active", Number(button.dataset.zoom) === value);
  }
  els.zoomNote.textContent = value === 1 ? "1x 原始画面" : `${value}x，优先使用相机光学/系统变焦`;

  const track = stream?.getVideoTracks?.()[0];
  const caps = track?.getCapabilities?.();
  if (!track || !caps?.zoom) return;

  const zoom = Math.min(Math.max(value, caps.zoom.min), caps.zoom.max);
  try {
    await track.applyConstraints({ advanced: [{ zoom }] });
  } catch {
    els.zoomNote.textContent = `${value}x 当前浏览器不支持硬件变焦，会保持原始画面`;
  }
}

async function captureFromVideo() {
  if (!stream || els.video.readyState < 2) {
    await startCamera();
    if (!stream) return;
  }

  const width = els.video.videoWidth;
  const height = els.video.videoHeight;
  if (!width || !height) return;

  els.canvas.width = width;
  els.canvas.height = height;
  const ctx = els.canvas.getContext("2d", { alpha: false });
  ctx.drawImage(els.video, 0, 0, width, height);
  const blob = await canvasToBlob(els.canvas, "image/jpeg", JPEG_QUALITY);
  await saveCapture(blob, {
    source: "web-camera",
    width,
    height,
    zoom: currentZoom
  });
}

async function captureFromFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  let blob = file;
  let width = null;
  let height = null;
  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close?.();
  } catch {
    width = null;
  }

  if (file.type && file.type !== "image/jpeg") {
    blob = await convertImageToJpeg(file);
  }

  await saveCapture(blob, {
    source: "system-camera",
    width,
    height,
    zoom: currentZoom,
    originalName: file.name
  });
}

async function saveCapture(blob, meta) {
  const next = getNextSlot();
  const capture = {
    id: crypto.randomUUID(),
    pairNo: next.pairNo,
    kind: mode,
    createdAt: new Date().toISOString(),
    meta,
    blob
  };

  await putCapture(capture);
  captures.push(capture);
  setMode(mode === "product" ? "price" : "product");
  await render();
}

function getNextSlot() {
  const pairs = groupCaptures();
  const last = pairs[pairs.length - 1];
  if (!last) return { pairNo: 1 };
  if (mode === "price" && last.product && !last.price) return { pairNo: last.pairNo };
  if (mode === "product" && !last.product) return { pairNo: last.pairNo };
  return { pairNo: last.pairNo + 1 };
}

function setMode(nextMode) {
  mode = nextMode;
  els.productMode.classList.toggle("is-active", mode === "product");
  els.priceMode.classList.toggle("is-active", mode === "price");
  els.productFrame.classList.toggle("is-hidden", mode !== "product");
  els.priceFrame.classList.toggle("is-hidden", mode !== "price");
  updateStepTitle();
}

async function undoLast() {
  const last = captures[captures.length - 1];
  if (!last) return;
  await deleteCapture(last.id);
  captures = captures.slice(0, -1);
  setMode(last.kind);
  await render();
}

async function clearAll() {
  if (!captures.length) return;
  const ok = confirm("清空今天所有采集？这个操作不能撤回。");
  if (!ok) return;
  await clearStore();
  captures = [];
  setMode("product");
  await render();
}

async function exportZip() {
  const pairs = groupCaptures();
  const completePairs = pairs.filter((pair) => pair.product && pair.price);
  if (!completePairs.length) {
    alert("还没有完整的商品 + 价格牌组合。");
    return;
  }

  const files = [];
  const data = {
    exportedAt: new Date().toISOString(),
    app: "costco-field-capture",
    version: 1,
    count: completePairs.length,
    items: []
  };

  for (const pair of completePairs) {
    const no = String(pair.pairNo).padStart(3, "0");
    const productName = `${no}_product.jpg`;
    const priceName = `${no}_price.jpg`;
    files.push({ name: productName, data: await pair.product.blob.arrayBuffer() });
    files.push({ name: priceName, data: await pair.price.blob.arrayBuffer() });
    data.items.push({
      id: no,
      productImage: productName,
      priceImage: priceName,
      productCapturedAt: pair.product.createdAt,
      priceCapturedAt: pair.price.createdAt,
      productMeta: pair.product.meta,
      priceMeta: pair.price.meta
    });
  }

  files.push({
    name: "data.json",
    data: new TextEncoder().encode(JSON.stringify(data, null, 2)).buffer
  });

  const zipBlob = buildZip(files);
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  downloadBlob(zipBlob, `costco_capture_${date}_${completePairs.length}items.zip`);
}

async function render() {
  updateStepTitle();
  const pairs = groupCaptures();
  els.pairCount.textContent = pairs.filter((pair) => pair.product || pair.price).length;
  els.storageStatus.textContent = captures.length ? "已保存到本机浏览器" : "等待采集";

  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  els.pairList.replaceChildren();

  if (!pairs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "还没有照片。";
    els.pairList.append(empty);
    return;
  }

  for (const pair of [...pairs].reverse()) {
    const card = els.pairTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".pair-head strong").textContent = `第 ${pair.pairNo} 组`;
    const state = pair.product && pair.price ? "完整" : pair.product ? "缺价格牌" : "缺商品";
    card.querySelector(".pair-head span").textContent = state;
    const imgs = card.querySelectorAll("img");
    if (pair.product) setThumb(imgs[0], pair.product.blob);
    if (pair.price) setThumb(imgs[1], pair.price.blob);
    els.pairList.append(card);
  }
}

function setThumb(img, blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  img.src = url;
}

function updateStepTitle() {
  const pairNo = getNextSlot().pairNo;
  els.stepTitle.textContent = `第 ${pairNo} 组 · 拍${mode === "product" ? "商品" : "价格牌"}`;
}

function groupCaptures() {
  const map = new Map();
  for (const capture of captures) {
    if (!map.has(capture.pairNo)) map.set(capture.pairNo, { pairNo: capture.pairNo });
    map.get(capture.pairNo)[capture.kind] = capture;
  }
  return [...map.values()].sort((a, b) => a.pairNo - b.pairNo);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("生成照片失败"))), type, quality);
  });
}

async function convertImageToJpeg(file) {
  const bitmap = await createImageBitmap(file);
  els.canvas.width = bitmap.width;
  els.canvas.height = bitmap.height;
  els.canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvasToBlob(els.canvas, "image/jpeg", JPEG_QUALITY);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(modeName) {
  return db.transaction(STORE, modeName).objectStore(STORE);
}

function putCapture(capture) {
  return requestDone(tx("readwrite").put(capture));
}

function deleteCapture(id) {
  return requestDone(tx("readwrite").delete(id));
}

function clearStore() {
  return requestDone(tx("readwrite").clear());
}

function loadCaptures() {
  return new Promise((resolve, reject) => {
    const request = tx("readonly").getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    request.onerror = () => reject(request.error);
  });
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = new Uint8Array(file.data);
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data
    ]);
    chunks.push(local);

    central.push(
      concatBytes([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name
      ])
    );
    offset += local.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(offset),
    u16(0)
  ]);

  return new Blob([...chunks, ...central, end], { type: "application/zip" });
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let j = 0; j < 8; j += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

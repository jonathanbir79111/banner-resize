const { app, core, constants, action } = require("photoshop");
const { localFileSystem, formats } = require("uxp").storage;

const TEXT_COLOR_HEX = "555555";
const TEXT_WIDTH_RATIO = 0.7;
const TEXT_FONT_PS_NAME = "Verdana";
const ARTBOARD_GAP = 80;
const ARTBOARD_ROW_MAX_WIDTH = 6000;

function parsePositiveInt(value) {
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function unitNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value.value === "number") {
    return value.value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function makeSolidColor(hex) {
  const color = new app.SolidColor();
  color.rgb.hexValue = hex;
  return color;
}

function parseHexColor(raw) {
  let hex = String(raw || "")
    .trim()
    .replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    hex = hex
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  return hex.toUpperCase();
}

function parseSizeCell(cell) {
  const match = String(cell || "")
    .trim()
    .match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  if (!match) {
    return null;
  }
  const width = parsePositiveInt(match[1]);
  const height = parsePositiveInt(match[2]);
  if (!width || !height) {
    return null;
  }
  return { width, height };
}

function parseCsvRows(text) {
  const src = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n") {
      row.push(field.trim());
      field = "";
      if (row.some((cell) => cell !== "")) {
        rows.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }

  row.push(field.trim());
  if (row.some((cell) => cell !== "")) {
    rows.push(row);
  }
  return rows;
}

function parseCsvJobs(text) {
  const jobs = [];
  for (const cols of parseCsvRows(text)) {
    const size = parseSizeCell(cols[0]);
    if (!size) {
      continue;
    }
    jobs.push({
      width: size.width,
      height: size.height,
      fillHex: parseHexColor(cols[1]) || "FFFFFF",
      label: cols[2] || "",
    });
  }
  return jobs;
}

function parseCsvSizes(text) {
  const sizes = [];
  const seen = new Set();
  for (const cols of parseCsvRows(text)) {
    for (const cell of cols) {
      const size = parseSizeCell(cell);
      if (!size) {
        continue;
      }
      const key = `${size.width}x${size.height}`;
      if (!seen.has(key)) {
        seen.add(key);
        sizes.push(size);
      }
    }
  }
  return sizes;
}

function readLayerBounds(layer) {
  // boundsNoEffects 排除陰影／外框等圖層效果，避免縮放與置中被視覺外的像素污染。
  const bounds = layer.boundsNoEffects || layer.bounds;
  return {
    left: unitNumber(bounds.left),
    top: unitNumber(bounds.top),
    right: unitNumber(bounds.right),
    bottom: unitNumber(bounds.bottom),
  };
}

function hexToRgbChannels(hex) {
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function uniqueArtboardName(width, height, used) {
  const base = `${width}x${height}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  let name = `${base} (${n})`;
  while (used.has(name)) {
    n += 1;
    name = `${base} (${n})`;
  }
  used.add(name);
  return name;
}

async function batchPlaySync(commands) {
  return action.batchPlay(commands, { synchronousExecution: true });
}

function pixelRect(left, top, width, height) {
  return {
    _obj: "rectangle",
    top: { _unit: "pixelsUnit", _value: top },
    left: { _unit: "pixelsUnit", _value: left },
    bottom: { _unit: "pixelsUnit", _value: top + height },
    right: { _unit: "pixelsUnit", _value: left + width },
  };
}

function extractLayerId(batchResult) {
  const item = Array.isArray(batchResult) ? batchResult[0] : batchResult;
  if (!item) {
    return null;
  }
  if (typeof item.layerID === "number") {
    return item.layerID;
  }
  if (Array.isArray(item.layerID) && item.layerID.length) {
    return item.layerID[0];
  }
  if (typeof item.ID === "number") {
    return item.ID;
  }
  return null;
}

function findTopLayerById(container, id) {
  if (!container) {
    return null;
  }
  const layers = container.layers;
  if (!layers) {
    return null;
  }
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].id === id) {
      return layers[i];
    }
  }
  return null;
}

function findTopLayerByName(container, name) {
  if (!container) {
    return null;
  }
  const layers = container.layers;
  if (!layers) {
    return null;
  }
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].name === name) {
      return layers[i];
    }
  }
  return null;
}

function listArtboards(doc) {
  if (!doc) {
    return [];
  }
  if (doc.artboards && doc.artboards.length) {
    const boards = [];
    for (let i = 0; i < doc.artboards.length; i++) {
      boards.push(doc.artboards[i]);
    }
    return boards;
  }
  return listLayers(doc).filter((layer) => layer && layer.isArtboard);
}

function findFirstArtboard(container) {
  const boards = listArtboards(container);
  if (boards.length) {
    return boards[0];
  }
  if (!container) {
    return null;
  }
  const layers = container.layers;
  if (!layers || !layers.length) {
    return null;
  }
  return layers[0];
}

async function clearArtboardChildren(artboard) {
  const children = listLayers(artboard);
  for (let i = children.length - 1; i >= 0; i--) {
    try {
      await children[i].delete();
    } catch (_error) {
      // 背景或鎖定圖層略過
    }
  }
}

async function setArtboardGeometryAndFill(
  layerId,
  left,
  top,
  width,
  height,
  fillHex,
) {
  const rgb = hexToRgbChannels(fillHex);
  await batchPlaySync([
    {
      _obj: "editArtboardEvent",
      _target: [{ _ref: "layer", _id: layerId }],
      artboard: {
        _obj: "artboard",
        artboardRect: pixelRect(left, top, width, height),
        artboardBackgroundType: 4,
        color: {
          _obj: "RGBColor",
          red: rgb.r,
          grain: rgb.g,
          blue: rgb.b,
        },
      },
      changeBackground: 1,
    },
  ]);
}

async function moveLayerIntoArtboard(layer, artboard) {
  try {
    await layer.move(artboard, constants.ElementPlacement.PLACEINSIDE);
    return;
  } catch (_error) {
    // 改走 batchPlay
  }
  await batchPlaySync([
    {
      _obj: "move",
      _target: [{ _ref: "layer", _id: layer.id }],
      to: {
        _ref: [
          { _enum: "ordinal", _value: "inside" },
          { _ref: "layer", _id: artboard.id },
        ],
      },
    },
  ]);
}

async function createArtboardDocument(firstJob) {
  const doc = await app.createDocument({
    width: firstJob.width,
    height: firstJob.height,
    resolution: 72,
    mode: constants.NewDocumentMode.RGB,
    fill: constants.DocumentFill.WHITE,
    name: "CSV Artboards",
  });
  if (!doc) {
    throw new Error("無法建立 PSD 文件。");
  }
  app.activeDocument = doc;
  return doc;
}

async function setupFirstArtboard(doc, name, job) {
  let artboard = findFirstArtboard(doc);
  if (!artboard || !artboard.isArtboard) {
    await batchPlaySync([
      {
        _obj: "make",
        _target: [{ _ref: "artboardSection" }],
        name,
        artboardRect: pixelRect(0, 0, job.width, job.height),
        layerSectionStart: 1,
        layerSectionEnd: 1,
      },
    ]);
    artboard = findTopLayerByName(doc, name) || findFirstArtboard(doc);
  }
  if (!artboard) {
    throw new Error("找不到第一個工作區域。");
  }
  artboard.name = name;
  await setArtboardGeometryAndFill(
    artboard.id,
    0,
    0,
    job.width,
    job.height,
    job.fillHex,
  );
  return findTopLayerByName(doc, name) || artboard;
}

async function addArtboardAt(doc, name, left, top, job, templateArtboard) {
  if (!templateArtboard) {
    throw new Error(`無法建立工作區域 ${name}：沒有可複製的母版工作區域。`);
  }

  const beforeIds = new Set(listArtboards(doc).map((board) => board.id));
  await selectOnlyLayer(templateArtboard);
  let artboard = null;

  try {
    const copies = await doc.duplicateLayers([templateArtboard]);
    artboard = copies && copies[0] ? copies[0] : null;
  } catch (_error) {
    artboard = null;
  }

  if (!artboard) {
    const after = listArtboards(doc);
    artboard = after.find((board) => !beforeIds.has(board.id)) || null;
  }
  if (!artboard) {
    throw new Error(`無法建立工作區域 ${name}。`);
  }

  artboard.name = name;
  await clearArtboardChildren(artboard);
  await selectOnlyLayer(artboard);
  await setArtboardGeometryAndFill(
    artboard.id,
    left,
    top,
    job.width,
    job.height,
    job.fillHex,
  );
  return findTopLayerById(doc, artboard.id) || artboard;
}

async function fitCenteredTextLayer(
  layer,
  boxWidth,
  boxHeight,
  originX = 0,
  originY = 0,
) {
  await selectOnlyLayer(layer);
  const bounds = readLayerBounds(layer);
  const textWidth = Math.max(bounds.right - bounds.left, 1);
  const percent = ((boxWidth * TEXT_WIDTH_RATIO) / textWidth) * 100;
  await layer.scale(percent, percent, constants.AnchorPosition.MIDDLECENTER);

  const fitted = readLayerBounds(layer);
  const dx = originX + boxWidth / 2 - (fitted.left + fitted.right) / 2;
  const dy = originY + boxHeight / 2 - (fitted.top + fitted.bottom) / 2;
  if (dx !== 0 || dy !== 0) {
    await layer.translate(dx, dy);
  }
}

async function addCenteredLabelOnArtboard(
  doc,
  job,
  artboard,
  originX,
  originY,
) {
  const label = String(job.label || "").trim();
  if (!label) {
    return;
  }

  await selectOnlyLayer(artboard);
  const textLayer = await doc.createTextLayer({
    name: label,
    contents: label,
    fontName: TEXT_FONT_PS_NAME,
    fontSize: 36,
    textColor: makeSolidColor(TEXT_COLOR_HEX),
    position: {
      x: originX + job.width / 2,
      y: originY + job.height / 2,
    },
  });

  const parentIsArtboard =
    textLayer.parent && textLayer.parent.id === artboard.id;
  if (!parentIsArtboard) {
    await moveLayerIntoArtboard(textLayer, artboard);
  }

  await fitCenteredTextLayer(
    textLayer,
    job.width,
    job.height,
    originX,
    originY,
  );
}

async function readCsvText(inputId = "input-file") {
  const input = document.getElementById(inputId);
  const selected = input && input.files && input.files[0];

  if (selected) {
    if (typeof selected.text === "function") {
      return selected.text();
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("無法讀取 CSV"));
      reader.readAsText(selected);
    });
  }

  const file = await localFileSystem.getFileForOpening({ types: ["csv"] });
  if (!file) {
    return null;
  }
  return file.read();
}

async function createArtboardDocumentFromCsvJobs(jobs) {
  await core.executeAsModal(
    async () => {
      const first = jobs[0];
      const doc = await createArtboardDocument(first);
      if (!doc) {
        throw new Error("無法建立 PSD 文件。");
      }
      const usedNames = new Set();

      let firstArtboard = null;
      let cursorX = 0;
      let cursorY = 0;
      let rowHeight = 0;

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (
          i > 0 &&
          cursorX > 0 &&
          cursorX + job.width > ARTBOARD_ROW_MAX_WIDTH
        ) {
          cursorX = 0;
          cursorY += rowHeight + ARTBOARD_GAP;
          rowHeight = 0;
        }

        const name = uniqueArtboardName(job.width, job.height, usedNames);
        const artboard =
          i === 0
            ? await setupFirstArtboard(doc, name, job)
            : await addArtboardAt(
                doc,
                name,
                cursorX,
                cursorY,
                job,
                firstArtboard,
              );

        if (i === 0) {
          firstArtboard = artboard;
        }

        await addCenteredLabelOnArtboard(doc, job, artboard, cursorX, cursorY);

        cursorX += job.width + ARTBOARD_GAP;
        rowHeight = Math.max(rowHeight, job.height);
      }
    },
    { commandName: "依 CSV 建立工作區域" },
  );
}

function isSmartObject(layer) {
  return Boolean(layer && layer.kind === constants.LayerKind.SMARTOBJECT);
}

function listLayers(container) {
  if (!container) {
    return [];
  }
  const layers = container.layers;
  if (!layers) {
    return [];
  }

  const result = [];
  for (let i = 0; i < layers.length; i++) {
    result.push(layers[i]);
  }
  return result;
}

function isLayerGroup(layer) {
  return Boolean(layer && layer.kind === constants.LayerKind.GROUP);
}

function canSearchChildren(layer) {
  if (!layer) {
    return false;
  }
  if (layer.isArtboard || isLayerGroup(layer)) {
    return true;
  }
  const kids = layer.layers;
  return Boolean(kids && kids.length);
}

function findLayerByName(container, name) {
  for (const layer of listLayers(container)) {
    if (layer.name === name) {
      return layer;
    }
    if (canSearchChildren(layer)) {
      const nested = findLayerByName(layer, name);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

async function selectOnlyLayer(layer) {
  await action.batchPlay(
    [
      {
        _obj: "select",
        _target: [{ _ref: "layer", _id: layer.id }],
        makeVisible: false,
        layerID: [layer.id],
      },
    ],
    { synchronousExecution: true },
  );
}

const BANNER_LAYER_NAMES = ["$BG", "$PRODUCT", "$HEADLINE", "$CTA"];

// 相對框（安全區）：以畫布比例 0~1 定義每個元件可佔用的區域。
// x,y = 框左上角比例；w,h = 框寬高比例。三個框上下不重疊，避免元件互相壓到。
//   HEADLINE 6%~26%（頂部文案帶）
//   PRODUCT  30%~72%（中央產品帶）
//   CTA      80%~92%（底部按鈕帶）
const HEADLINE_FRAME = { x: 0.1, y: 0.06, w: 0.8, h: 0.2 };
const PRODUCT_FRAME = { x: 0.1, y: 0.3, w: 0.8, h: 0.42 };
const CTA_FRAME = { x: 0.28, y: 0.8, w: 0.44, h: 0.12 };

// 相對畫布的寬／高佔比夾制：k 算出的目標尺寸會落在此區間，再與相對框取較小值。
const HEADLINE_SCALE_LIMIT = {
  minWidthRatio: 0.35,
  maxWidthRatio: 0.8,
  minHeightRatio: 0.05,
  maxHeightRatio: 0.2,
};
const PRODUCT_SCALE_LIMIT = {
  minWidthRatio: 0.28,
  maxWidthRatio: 0.7,
  minHeightRatio: 0.18,
  maxHeightRatio: 0.42,
};
const CTA_SCALE_LIMIT = {
  minWidthRatio: 0.15,
  maxWidthRatio: 0.45,
  minHeightRatio: 0.05,
  maxHeightRatio: 0.12,
};

const HEADLINE_MAX_LINES = 2;
const HEADLINE_MAX_WIDTH_RATIO = 0.8;
const HEADLINE_LINE_HEIGHT_EM = 1.2;
const HEADLINE_MIN_FONT_CANVAS_RATIO = 0.02;

function clampNumber(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * 全域縮放係數 k：以面積比開根號，讓元件隨畫布「呼吸」，
 * 而不是只跟單軸寬或高走（避免長條 banner 把元件拉得過扁或過巨）。
 *
 *   k = sqrt( (targetW × targetH) / (masterW × masterH) )
 *
 * 例：1000×1000 → 300×300，k = 0.3；1000×1000 → 1920×1080，k ≈ 1.44。
 */
function areaScaleK(masterWidth, masterHeight, targetWidth, targetHeight) {
  const masterArea = Math.max(masterWidth * masterHeight, 1);
  const targetArea = Math.max(targetWidth * targetHeight, 1);
  return Math.sqrt(targetArea / masterArea);
}

/**
 * 目標縮放 = clamp(k, min佔比, max佔比)，且不得大於相對框的 contain 上限。
 * min 與框衝突時以框為準（寧可略小，也不壓到隔壁元件）。
 */
function resolveBreathingScale(
  src,
  frameW,
  frameH,
  k,
  limits,
  canvasWidth,
  canvasHeight,
) {
  const frameScale = Math.min(frameW / src.width, frameH / src.height);
  let minScale = 0;
  let maxScale = Number.POSITIVE_INFINITY;

  if (limits) {
    if (limits.minWidthRatio != null) {
      minScale = Math.max(
        minScale,
        (limits.minWidthRatio * canvasWidth) / src.width,
      );
    }
    if (limits.minHeightRatio != null) {
      minScale = Math.max(
        minScale,
        (limits.minHeightRatio * canvasHeight) / src.height,
      );
    }
    if (limits.maxWidthRatio != null) {
      maxScale = Math.min(
        maxScale,
        (limits.maxWidthRatio * canvasWidth) / src.width,
      );
    }
    if (limits.maxHeightRatio != null) {
      maxScale = Math.min(
        maxScale,
        (limits.maxHeightRatio * canvasHeight) / src.height,
      );
    }
  }

  let scale = k;
  if (minScale <= maxScale) {
    scale = clampNumber(scale, minScale, maxScale);
  }
  scale = Math.min(scale, frameScale);
  return Math.max(scale, 0.01);
}

function boundsBox(layer) {
  const b = readLayerBounds(layer);
  return {
    left: b.left,
    top: b.top,
    right: b.right,
    bottom: b.bottom,
    width: Math.max(b.right - b.left, 1),
    height: Math.max(b.bottom - b.top, 1),
    centerX: (b.left + b.right) / 2,
    centerY: (b.top + b.bottom) / 2,
  };
}

function collectTextLayers(container, out = []) {
  for (const layer of listLayers(container)) {
    if (layer.kind === constants.LayerKind.TEXT) {
      out.push(layer);
    }
    if (isLayerGroup(layer)) {
      collectTextLayers(layer, out);
    }
  }
  return out;
}

function getTextFontSize(layer) {
  try {
    if (layer.textItem && layer.textItem.characterStyle) {
      return unitNumber(layer.textItem.characterStyle.size);
    }
    if (layer.textItem) {
      return unitNumber(layer.textItem.size);
    }
  } catch (_error) {
    return 0;
  }
  return 0;
}

function setTextFontSize(layer, size) {
  if (layer.textItem && layer.textItem.characterStyle) {
    layer.textItem.characterStyle.size = size;
    return;
  }
  if (layer.textItem) {
    layer.textItem.size = size;
  }
}

async function prepareLayerForTransform(layer) {
  try {
    layer.visible = true;
    layer.locked = false;
  } catch (_error) {
    // 部分圖層鎖屬性為唯讀，改由 batchPlay 指定 _id
  }
  await selectOnlyLayer(layer);
}

async function scaleLayerUniform(layer, scale) {
  await prepareLayerForTransform(layer);
  const percent = scale * 100;
  // 智慧型物件 / 群組都用 batchPlay transform，DOM scale() 常無效
  await action.batchPlay(
    [
      {
        _obj: "transform",
        _target: [{ _ref: "layer", _id: layer.id }],
        freeTransformCenterState: {
          _enum: "quadCenterState",
          _value: "QCSAverage",
        },
        width: { _unit: "percentUnit", _value: percent },
        height: { _unit: "percentUnit", _value: percent },
        linked: true,
      },
    ],
    { synchronousExecution: true },
  );
}

async function translateLayer(layer, dx, dy) {
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    return;
  }
  await prepareLayerForTransform(layer);
  await action.batchPlay(
    [
      {
        _obj: "transform",
        _target: [{ _ref: "layer", _id: layer.id }],
        freeTransformCenterState: {
          _enum: "quadCenterState",
          _value: "QCSAverage",
        },
        offset: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: dx },
          vertical: { _unit: "pixelsUnit", _value: dy },
        },
      },
    ],
    { synchronousExecution: true },
  );
}

/**
 * object-fit: cover（允許裁切、不留白）
 *
 * coverX = srcWidth  / canvasWidth    → 圖層寬目前覆蓋畫布寬的比例
 * coverY = srcHeight / canvasHeight   → 圖層高目前覆蓋畫布高的比例
 * scale  = 1 / min(coverX, coverY)    → 較短的那一軸至少拉到 100%
 *
 * 例：coverX=0.5、coverY=0.8 → min=0.5 → scale=2
 *     新寬=2·srcW ≥ canvasW，新高=2·srcH ≥ canvasH
 *
 * 錨點 (0.5, 0.5)：
 *   dx = canvasWidth  * 0.5 - (left+right)/2
 *   dy = canvasHeight * 0.5 - (top+bottom)/2
 * 超出畫布的部分即為裁切。
 */
async function layoutObjectFitCover(layer, canvasWidth, canvasHeight) {
  const src = boundsBox(layer);
  const coverX = src.width / canvasWidth;
  const coverY = src.height / canvasHeight;
  const scale = 1 / Math.min(coverX, coverY);
  await scaleLayerUniform(layer, scale);

  const fitted = boundsBox(layer);
  await translateLayer(
    layer,
    canvasWidth * 0.5 - fitted.centerX,
    canvasHeight * 0.5 - fitted.centerY,
  );
}

/**
 * 通用：等比縮放圖層以 contain 進「相對框」，再於框內依垂直錨點對齊、水平置中。
 * 這是本次修正的核心——元件不再各自對整張畫布排版，而是各自對自己的安全區排版，
 * 框與框不重疊，因此不會互相壓到。
 *
 * frame 各值為畫布比例 (0~1)：
 *   frameLeft = canvasWidth  * frame.x
 *   frameTop  = canvasHeight * frame.y
 *   frameW    = canvasWidth  * frame.w
 *   frameH    = canvasHeight * frame.h
 *
 * 縮放：
 *   1. k = 面積比開根號（元件隨畫布呼吸）
 *   2. clamp 到該元件的 min/max 畫布佔比
 *   3. 再與相對框 contain 上限取 min（永不溢出安全區）
 *
 * 對齊：
 *   水平：圖層中線對齊框水平中線
 *   垂直：verticalAnchor = "top" | "middle" | "bottom" → 對齊框頂 / 框中 / 框底
 */
async function layoutContainInFrame(
  layer,
  canvasWidth,
  canvasHeight,
  frame,
  verticalAnchor,
  k,
  limits,
) {
  const frameLeft = canvasWidth * frame.x;
  const frameTop = canvasHeight * frame.y;
  const frameW = canvasWidth * frame.w;
  const frameH = canvasHeight * frame.h;

  const src = boundsBox(layer);
  const scale = resolveBreathingScale(
    src,
    frameW,
    frameH,
    k,
    limits,
    canvasWidth,
    canvasHeight,
  );
  await scaleLayerUniform(layer, scale);

  const fitted = boundsBox(layer);
  const dx = frameLeft + frameW / 2 - fitted.centerX;

  let dy;
  if (verticalAnchor === "top") {
    dy = frameTop - fitted.top;
  } else if (verticalAnchor === "bottom") {
    dy = frameTop + frameH - fitted.bottom;
  } else {
    dy = frameTop + frameH / 2 - fitted.centerY;
  }

  await translateLayer(layer, dx, dy);
}

/**
 * 標題：智慧型物件直接 contain 進 HEADLINE_FRAME（錨點框頂）；
 * 若仍是文字圖層則先縮字級再放進框。
 */
async function layoutHeadlineComponent(
  headlineLayer,
  canvasWidth,
  canvasHeight,
  k,
) {
  const textLayers = isSmartObject(headlineLayer)
    ? []
    : collectTextLayers(headlineLayer);
  if (textLayers.length) {
    await shrinkHeadlineToFit(headlineLayer, canvasWidth, canvasHeight);
  }
  await layoutContainInFrame(
    headlineLayer,
    canvasWidth,
    canvasHeight,
    HEADLINE_FRAME,
    "top",
    k,
    HEADLINE_SCALE_LIMIT,
  );
}

/**
 * 標題防呆（文字圖層）：寬度不得超過畫布 HEADLINE_MAX_WIDTH_RATIO，
 * 高度不得超過 maxLines * fontSize * lineHeight（相對字級）。
 */
async function shrinkHeadlineToFit(headlineLayer, canvasWidth, canvasHeight) {
  const textLayers = collectTextLayers(headlineLayer);
  if (!textLayers.length) {
    return;
  }

  const maxWidth = canvasWidth * HEADLINE_MAX_WIDTH_RATIO;
  const minFont = canvasHeight * HEADLINE_MIN_FONT_CANVAS_RATIO;

  for (const textLayer of textLayers) {
    await selectOnlyLayer(textLayer);
    for (let i = 0; i < 20; i++) {
      const box = boundsBox(textLayer);
      const fontSize = getTextFontSize(textLayer) || box.height;
      const maxHeight = HEADLINE_MAX_LINES * fontSize * HEADLINE_LINE_HEIGHT_EM;
      const withinWidth = box.width <= maxWidth;
      const withinLines = box.height <= maxHeight;
      if (withinWidth && withinLines) {
        break;
      }
      if (fontSize <= minFont) {
        break;
      }
      setTextFontSize(textLayer, Math.max(minFont, fontSize * 0.9));
    }
  }
}

function findBannerLayer(doc, name) {
  return (
    findLayerByName(doc, name) ||
    findLayerByName(doc, `${name} copy`) ||
    findLayerByName(doc, `${name} 拷貝`)
  );
}

function requireBannerLayers(doc) {
  const layers = {};
  const missing = [];
  for (const name of BANNER_LAYER_NAMES) {
    const layer = findBannerLayer(doc, name);
    if (!layer) {
      missing.push(name);
    } else {
      layers[name] = layer;
    }
  }
  if (missing.length) {
    throw new Error(`母版缺少圖層（智慧型物件）：${missing.join(", ")}`);
  }
  return layers;
}

async function applyBannerLayout(doc, targetWidth, targetHeight, masterSize) {
  if (!doc) {
    throw new Error("沒有作用中的文件可排版。");
  }

  app.activeDocument = doc;

  const canvasWidth = unitNumber(doc.width);
  const canvasHeight = unitNumber(doc.height);
  if (
    Math.round(canvasWidth) !== targetWidth ||
    Math.round(canvasHeight) !== targetHeight
  ) {
    await doc.resizeCanvas(
      targetWidth,
      targetHeight,
      constants.AnchorPosition.MIDDLECENTER,
    );
  }

  const masterWidth =
    masterSize && masterSize.width ? masterSize.width : targetWidth;
  const masterHeight =
    masterSize && masterSize.height ? masterSize.height : targetHeight;
  const k = areaScaleK(masterWidth, masterHeight, targetWidth, targetHeight);

  const layers = requireBannerLayers(doc);

  // $BG：cover 填滿整張畫布，不套 k（必須鋪滿）
  await layoutObjectFitCover(layers.$BG, targetWidth, targetHeight);
  await layoutContainInFrame(
    layers.$PRODUCT,
    targetWidth,
    targetHeight,
    PRODUCT_FRAME,
    "middle",
    k,
    PRODUCT_SCALE_LIMIT,
  );
  await layoutHeadlineComponent(layers.$HEADLINE, targetWidth, targetHeight, k);
  await layoutContainInFrame(
    layers.$CTA,
    targetWidth,
    targetHeight,
    CTA_FRAME,
    "bottom",
    k,
    CTA_SCALE_LIMIT,
  );
}

/**
 * 對目前作用文件做響應式 Banner 重排。
 * 排版規則只用相對比例與錨點；像素僅在呼叫 PS Transform API 時由「比例 × 畫布」換算。
 */
async function bannerResizer1(targetWidth, targetHeight, masterSize) {
  await core.executeAsModal(
    async () => {
      await applyBannerLayout(
        app.activeDocument,
        targetWidth,
        targetHeight,
        masterSize,
      );
    },
    { commandName: "Banner 重新排版" },
  );
}

function listBannerLayersBottomToTop(master, sourceLayers) {
  const wantedIds = new Set(
    BANNER_LAYER_NAMES.map((name) => sourceLayers[name].id),
  );
  const topToBottom = [];
  for (const layer of listLayers(master)) {
    if (wantedIds.has(layer.id)) {
      topToBottom.push(layer);
    }
  }

  const foundIds = new Set(topToBottom.map((layer) => layer.id));
  for (const name of BANNER_LAYER_NAMES) {
    if (!foundIds.has(sourceLayers[name].id)) {
      topToBottom.push(sourceLayers[name]);
    }
  }

  // UXP layers[0] 為堆疊最上層；複製到新檔時後貼上的會在更上面，故改由下而上
  return topToBottom.slice().reverse();
}

async function createBannerCanvasFromMaster(
  master,
  sourceLayers,
  width,
  height,
) {
  const newDoc = await app.createDocument({
    width,
    height,
    resolution: 72,
    mode: constants.NewDocumentMode.RGB,
    fill: constants.DocumentFill.WHITE,
    name: `${width}x${height}`,
  });

  const bottomToTop = listBannerLayersBottomToTop(master, sourceLayers);
  for (const layer of bottomToTop) {
    await master.duplicateLayers([layer], newDoc);
  }

  app.activeDocument = newDoc;
  return newDoc;
}

const MCD_SMART_LAYER_NAMES = ["$BG", "$PROD", "$HEAD", "$LOGO", "$SM", "$CTA"];
const MCD_POSITION_ELEMENT_NAMES = ["$LOGO", "$HEAD", "$PROD", "$SM", "$CTA"];
// 面板可選取的圖層；$BG 沒有設定值時自動 cover 鋪滿，拖拉或縮放後才記錄數值
const EDITABLE_ELEMENT_NAMES = [...MCD_POSITION_ELEMENT_NAMES, "$BG"];
const SPEC_KEYS = ["leftPercent", "topPercent", "widthPercent"];
// 面板欄位：高度% 可留空（不限高度，高度隨圖層比例）
const FIELD_KEYS = [...SPEC_KEYS, "heightPercent"];
const ALIGN_X = { left: 0, center: 0.5, right: 1 };
const ALIGN_Y = { top: 0, middle: 0.5, bottom: 1 };

// 內建樣板：module.json 第一次建立時會以此當第 0 筆模組（builtin: true）。
const BUILTIN_RESIZE_VALUES = {
  width: 1200,
  height: 629,
  variants: [
    {
      outputDocument: "左字右圖.psd",
      elements: {
        $LOGO: {
          leftPercent: 4.0,
          topPercent: 4.45,
          widthPercent: 18.33,
        },
        $HEAD: {
          leftPercent: 3.33,
          topPercent: 16.69,
          widthPercent: 50.83,
        },
        $PROD: {
          leftPercent: 48.75,
          topPercent: 13.51,
          widthPercent: 49.17,
        },
        $SM: {
          leftPercent: 3.75,
          topPercent: 69.95,
          widthPercent: 35.83,
        },
        $CTA: {
          leftPercent: 3.75,
          topPercent: 83.47,
          widthPercent: 43.33,
        },
      },
    },
    {
      outputDocument: "全部置中.psd",
      elements: {
        $LOGO: {
          leftPercent: 3.33,
          topPercent: 4.45,
          widthPercent: 17.5,
        },
        $HEAD: {
          leftPercent: 21.67,
          topPercent: 11.13,
          widthPercent: 56.67,
        },
        $PROD: {
          leftPercent: 22.5,
          topPercent: 41.34,
          widthPercent: 54.92,
        },
        $SM: {
          leftPercent: 2.92,
          topPercent: 79.49,
          widthPercent: 25.0,
        },
        $CTA: {
          leftPercent: 60.83,
          topPercent: 87.44,
          widthPercent: 37.5,
        },
      },
    },
    {
      outputDocument: "左圖右字.psd",
      elements: {
        $LOGO: {
          leftPercent: 76.67,
          topPercent: 4.45,
          widthPercent: 18.33,
        },
        $HEAD: {
          leftPercent: 48.75,
          topPercent: 15.1,
          widthPercent: 48.75,
        },
        $PROD: {
          leftPercent: 0.83,
          topPercent: 21.46,
          widthPercent: 54.17,
        },
        $SM: {
          leftPercent: 57.5,
          topPercent: 62.0,
          widthPercent: 37.08,
        },
        $CTA: {
          leftPercent: 56.67,
          topPercent: 78.7,
          widthPercent: 40.0,
        },
      },
    },
  ],
};

// 新增版型時各圖層的預設值（全部置中）
const DEFAULT_VARIANT_ELEMENTS = {
  $LOGO: { leftPercent: 3.33, topPercent: 4.45, widthPercent: 17.5 },
  $HEAD: { leftPercent: 21.67, topPercent: 11.13, widthPercent: 56.67 },
  $PROD: { leftPercent: 22.5, topPercent: 41.34, widthPercent: 54.92 },
  $SM: { leftPercent: 2.92, topPercent: 79.49, widthPercent: 25.0 },
  $CTA: { leftPercent: 60.83, topPercent: 87.44, widthPercent: 37.5 },
};

const DEFAULT_TEMPLATE_NAME = "預設";
// 舊版設定檔：第一次建立 module.json 時會套進內建樣板，避免使用者調過的數值遺失
const LEGACY_SETTINGS_FILE = "resize-1200x629-settings.json";
const MODULE_FILE_NAME = "module.json";
const MODULE_FOLDER_TOKEN_KEY = "bannerResizer.moduleFolderToken";

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function roundTo(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

function stripExtension(fileName) {
  return String(fileName || "").replace(/\.[^.]+$/, "");
}

function toPsdFileName(name) {
  return /\.psd$/i.test(name) ? name : `${name}.psd`;
}

function isSameVariantName(a, b) {
  return toPsdFileName(a).toLowerCase() === toPsdFileName(b).toLowerCase();
}

// ---------- module.json：各 PSD 模組的排版狀態 ----------
//
// {
//   "templates": [
//     {
//       "name": "mcd-coupon-202609281410",
//       "source": { "fileName": "mcd-coupon.psd", "path": "..." },
//       "values": {
//         "width": 1200, "height": 629,
//         "variants": [{ "outputDocument": "上圖下字", "elements": { "$LOGO": {...}, ... } }]
//       }
//     }
//   ]
// }

function normalizeFrameOptions(src, out) {
  const h = Number(src.heightPercent);
  if (src.heightPercent != null && Number.isFinite(h) && h > 0) {
    out.heightPercent = h;
  }
  return out;
}

function normalizeElements(raw) {
  const out = {};
  for (const name of MCD_POSITION_ELEMENT_NAMES) {
    const src = raw && raw[name] ? raw[name] : {};
    out[name] = {};
    for (const key of SPEC_KEYS) {
      const n = Number(src[key]);
      out[name][key] = Number.isFinite(n)
        ? n
        : DEFAULT_VARIANT_ELEMENTS[name][key];
    }
    normalizeFrameOptions(src, out[name]);
  }
  const bg = raw && raw.$BG;
  if (bg && SPEC_KEYS.every((key) => Number.isFinite(Number(bg[key])))) {
    out.$BG = {};
    for (const key of SPEC_KEYS) {
      out.$BG[key] = Number(bg[key]);
    }
    normalizeFrameOptions(bg, out.$BG);
  }
  return out;
}

// ---------- 框 + 等比放入 ----------
//
// 每個圖層的設定是一個「框」：靠左% / 靠上% / 寬度% / 高度%（可不限）。
// 圖層等比縮放到剛好放進框內（contain），再依對齊方式放在框內。
// 高度% 不限時，圖層寬度等於框寬、高度隨圖層比例（與舊版行為相同）。

function hasFrameHeight(spec) {
  return Number.isFinite(spec.heightPercent) && spec.heightPercent > 0;
}

// 圖層在框內的位置自動決定（只有設定了高度% 且圖層被縮小時才看得出來）：
// 框中心偏左靠左、偏右靠右、其餘置中；產品與背景垂直置中，其他靠上
function resolveAlign(name, spec) {
  const center = spec.leftPercent + spec.widthPercent / 2;
  return {
    alignX: center < 40 ? "left" : center > 60 ? "right" : "center",
    alignY: name === "$PROD" || name === "$BG" ? "middle" : "top",
  };
}

/**
 * 算出圖層放進框後的實際位置（皆為畫布百分比）。
 * aspectPercent = 圖層高% ÷ 圖層寬%（已含畫布寬高比）。
 *   自然高度 = 寬度% × aspectPercent
 *   縮放     = 有框高且自然高度超過框高 ? 框高 ÷ 自然高度 : 1
 *   位置     = 框起點 + (框尺寸 − 圖層尺寸) × 對齊比例（0 / 0.5 / 1）
 */
function fitInFrame(name, spec, aspectPercent) {
  const isBackground = name === "$BG";
  const framed = !isBackground && hasFrameHeight(spec);
  const naturalHeight = spec.widthPercent * aspectPercent;
  const limited = framed && naturalHeight > spec.heightPercent;
  const scale = limited ? spec.heightPercent / naturalHeight : 1;
  const width = spec.widthPercent * scale;
  const height = naturalHeight * scale;
  const frameHeight = framed ? spec.heightPercent : height;
  const { alignX, alignY } = resolveAlign(name, spec);
  const rect = {
    left: spec.leftPercent + (spec.widthPercent - width) * ALIGN_X[alignX],
    top: spec.topPercent + (frameHeight - height) * ALIGN_Y[alignY],
    width,
    height,
  };
  return isBackground ? coverBackgroundRect(rect) : rect;
}

/**
 * $BG 永遠滿版，不露出白邊：
 *   1. 太小就以中心等比放大到蓋滿畫布：倍率 = max(1, 100 ÷ 寬%, 100 ÷ 高%)
 *   2. 位置夾在 [100 − 寬%, 0]、[100 − 高%, 0] 之間
 */
function coverBackgroundRect(rect) {
  if (!(rect.width > 0 && rect.height > 0)) {
    return rect;
  }
  const factor = Math.max(1, 100 / rect.width, 100 / rect.height);
  const width = rect.width * factor;
  const height = rect.height * factor;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  return {
    left: clampNumber(centerX - width / 2, 100 - width, 0),
    top: clampNumber(centerY - height / 2, 100 - height, 0),
    width,
    height,
  };
}

// 圖層前後順序（由下往上，不含固定在最底的 $BG）；需剛好是五個元件各一次，否則視為未設定
function normalizeLayerOrder(raw) {
  if (!Array.isArray(raw) || raw.length !== MCD_POSITION_ELEMENT_NAMES.length) {
    return null;
  }
  const names = new Set(raw);
  const valid =
    names.size === raw.length &&
    MCD_POSITION_ELEMENT_NAMES.every((name) => names.has(name));
  return valid ? raw.slice() : null;
}

function normalizeTemplate(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const values = raw.values && typeof raw.values === "object" ? raw.values : {};
  const variants = Array.isArray(values.variants) ? values.variants : [];
  return {
    ...raw,
    name: String(raw.name || "").trim(),
    values: {
      width: parsePositiveInt(values.width) || BUILTIN_RESIZE_VALUES.width,
      height: parsePositiveInt(values.height) || BUILTIN_RESIZE_VALUES.height,
      variants: variants.map((variant) => {
        const out = {
          outputDocument: String((variant && variant.outputDocument) || "").trim(),
          elements: normalizeElements(variant && variant.elements),
        };
        const order = normalizeLayerOrder(variant && variant.order);
        if (order) {
          out.order = order;
        }
        return out;
      }),
    },
  };
}

function newDraftVariant() {
  return { outputDocument: "", elements: deepClone(DEFAULT_VARIANT_ELEMENTS) };
}

async function readLegacyResizeSettings() {
  try {
    const folder = await localFileSystem.getDataFolder();
    const file = await folder.getEntry(LEGACY_SETTINGS_FILE);
    return JSON.parse(await file.read());
  } catch (_error) {
    return null;
  }
}

function applyLegacyResizeSettings(values, saved) {
  if (!saved || typeof saved !== "object") {
    return;
  }
  for (const variant of values.variants) {
    const savedVariant = saved[variant.outputDocument];
    if (!savedVariant) {
      continue;
    }
    for (const name of MCD_POSITION_ELEMENT_NAMES) {
      const savedSpec = savedVariant[name];
      if (!savedSpec) {
        continue;
      }
      for (const key of SPEC_KEYS) {
        if (Number.isFinite(savedSpec[key])) {
          variant.elements[name][key] = savedSpec[key];
        }
      }
    }
  }
}

async function createBuiltinTemplate() {
  const values = deepClone(BUILTIN_RESIZE_VALUES);
  applyLegacyResizeSettings(values, await readLegacyResizeSettings());
  return { name: DEFAULT_TEMPLATE_NAME, builtin: true, values };
}

const moduleStore = {
  ready: false,
  folder: null,
  templates: [],
  // 套圖分頁的模組，與 Resize 的 templates 分開
  applyTemplates: [],
  // 套圖時 PSD 必須有的圖層（「必選」視窗）；未設定時六個都必須
  applyRequiredLayers: MCD_SMART_LAYER_NAMES.slice(),
  reference: null,
  listeners: [],
};

function onModuleStoreChanged(listener) {
  moduleStore.listeners.push(listener);
}

function notifyModuleStoreChanged(source) {
  for (const listener of moduleStore.listeners) {
    listener(source);
  }
}

function readStoredFolderToken() {
  try {
    return localStorage.getItem(MODULE_FOLDER_TOKEN_KEY);
  } catch (_error) {
    return null;
  }
}

function writeStoredFolderToken(token) {
  try {
    localStorage.setItem(MODULE_FOLDER_TOKEN_KEY, token);
  } catch (_error) {
    // 無法記住資料夾，下次開啟再詢問
  }
}

async function restoreModuleFolder() {
  const token = readStoredFolderToken();
  if (!token) {
    return null;
  }
  try {
    return await localFileSystem.getEntryForPersistentToken(token);
  } catch (_error) {
    return null;
  }
}

async function pickModuleFolder() {
  const folder = await localFileSystem.getFolder();
  if (!folder) {
    return null;
  }
  try {
    writeStoredFolderToken(await localFileSystem.createPersistentToken(folder));
  } catch (_error) {
    // 同上
  }
  return folder;
}

async function readModuleFile(folder) {
  let file;
  try {
    file = await folder.getEntry(MODULE_FILE_NAME);
  } catch (_error) {
    return null;
  }
  // 解析失敗直接丟錯，不以預設值覆寫使用者的檔案
  const data = JSON.parse(await file.read());
  return {
    templates: Array.isArray(data && data.templates) ? data.templates : [],
    applyTemplates: Array.isArray(data && data.applyTemplates) ? data.applyTemplates : [],
    applyRequiredLayers: normalizeRequiredLayers(data && data.applyRequiredLayers),
    reference: normalizeReference(data && data.reference),
  };
}

function moduleFileContent() {
  const content = {
    templates: moduleStore.templates,
    applyTemplates: moduleStore.applyTemplates,
    applyRequiredLayers: moduleStore.applyRequiredLayers,
  };
  if (moduleStore.reference) {
    content.reference = moduleStore.reference;
  }
  return content;
}

function normalizeReference(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const out = { fileName: String(raw.fileName || DEFAULT_REFERENCE_FILE) };
  const widths = raw.widths;
  if (widths && MCD_POSITION_ELEMENT_NAMES.every((name) => Number(widths[name]) > 0)) {
    out.widths = {};
    MCD_POSITION_ELEMENT_NAMES.forEach((name) => {
      out.widths[name] = Number(widths[name]);
    });
  }
  return out;
}

async function saveModuleStore() {
  if (!moduleStore.folder) {
    const folder = await pickModuleFolder();
    if (!folder) {
      throw new Error("未選擇 module.json 存放資料夾。");
    }
    moduleStore.folder = folder;
  }
  const file = await moduleStore.folder.createFile(MODULE_FILE_NAME, {
    overwrite: true,
  });
  await file.write(JSON.stringify(moduleFileContent(), null, 2));
}

async function loadModuleStore(folder) {
  const raw = await readModuleFile(folder);
  moduleStore.folder = folder;
  moduleStore.templates = ((raw && raw.templates) || []).map(normalizeTemplate).filter(Boolean);
  moduleStore.reference = raw ? raw.reference : null;
  moduleStore.applyTemplates = ((raw && raw.applyTemplates) || [])
    .map(normalizeApplyTemplate)
    .filter((template) => template && template.name);
  moduleStore.applyRequiredLayers = raw
    ? raw.applyRequiredLayers
    : MCD_SMART_LAYER_NAMES.slice();
  if (!moduleStore.templates.length) {
    moduleStore.templates.push(await createBuiltinTemplate());
    await saveModuleStore();
  }
  moduleStore.ready = true;
  notifyModuleStoreChanged(null);
}

async function useInMemoryModuleStore() {
  // 沒有可用的 module.json：先用記憶體內的內建模組，儲存時會再詢問資料夾
  moduleStore.folder = null;
  moduleStore.templates = [await createBuiltinTemplate()];
  moduleStore.applyTemplates = [];
  moduleStore.ready = true;
  notifyModuleStoreChanged(null);
}

async function ensureModuleStore() {
  if (moduleStore.ready) {
    return;
  }
  let folder = await restoreModuleFolder();
  if (!folder) {
    await app.showAlert(
      "請選擇 module.json 的存放資料夾（可選團隊共用資料夾）。",
    );
    folder = await pickModuleFolder();
  }
  if (!folder) {
    await useInMemoryModuleStore();
    return;
  }
  try {
    await loadModuleStore(folder);
  } catch (error) {
    await app.showAlert(`module.json 讀取失敗：${error.message || error}`);
    await useInMemoryModuleStore();
  }
}

async function changeModuleFolder() {
  const folder = await pickModuleFolder();
  if (!folder) {
    return;
  }
  try {
    await loadModuleStore(folder);
  } catch (error) {
    await app.showAlert(`module.json 讀取失敗：${error.message || error}`);
  }
}

// ---------- 母版 ----------

function findNamedLayer(container, name) {
  return (
    findLayerByName(container, name) ||
    findLayerByName(container, `${name} copy`) ||
    findLayerByName(container, `${name} 拷貝`)
  );
}

// 回傳找得到的 $ 圖層；required 內的圖層缺少時丟錯（Resize 需要全部六個，套圖依「必選」設定）
function requireMcdSmartLayers(container, required = MCD_SMART_LAYER_NAMES) {
  const layers = {};
  const missing = [];
  for (const name of MCD_SMART_LAYER_NAMES) {
    const layer = findNamedLayer(container, name);
    if (layer) {
      layers[name] = layer;
    } else if (required.includes(name)) {
      missing.push(name);
    }
  }
  if (missing.length) {
    throw new Error(`母版缺少圖層（智慧型物件）：${missing.join(", ")}`);
  }
  return layers;
}

function getMcdSourceContainer(doc, required = MCD_SMART_LAYER_NAMES) {
  const boards = listArtboards(doc);
  for (const board of boards) {
    try {
      requireMcdSmartLayers(board, required);
      return board;
    } catch (_error) {
      // 不完整的工作區域略過，改找下一層或整份文件
    }
  }
  return doc;
}

function listMcdLayersBottomToTop(container, sourceLayers) {
  const names = Object.keys(sourceLayers);
  const wantedIds = new Set(names.map((name) => sourceLayers[name].id));
  const topToBottom = [];

  function walk(node) {
    for (const layer of listLayers(node)) {
      if (wantedIds.has(layer.id)) {
        topToBottom.push(layer);
      }
      if (canSearchChildren(layer)) {
        walk(layer);
      }
    }
  }

  walk(container);

  const foundIds = new Set(topToBottom.map((layer) => layer.id));
  for (const name of names) {
    if (!foundIds.has(sourceLayers[name].id)) {
      topToBottom.push(sourceLayers[name]);
    }
  }

  return topToBottom.slice().reverse();
}

async function createMcdDocumentFromMaster(
  master,
  sourceLayers,
  name,
  width,
  height,
  layerOrder,
) {
  const newDoc = await app.createDocument({
    width,
    height,
    resolution: 72,
    mode: constants.NewDocumentMode.RGB,
    fill: constants.DocumentFill.WHITE,
    name,
  });

  // 後複製的圖層會疊在上面：有指定層級就照「$BG + 樣板順序」由下往上複製，否則沿用母版順序
  const bottomToTop = layerOrder
    ? ["$BG", ...layerOrder].map((layerName) => sourceLayers[layerName])
    : listMcdLayersBottomToTop(getMcdSourceContainer(master), sourceLayers);
  for (const layer of bottomToTop) {
    await master.duplicateLayers([layer], newDoc);
  }

  app.activeDocument = newDoc;
  return newDoc;
}

async function layoutSmartByPercents(layer, canvasW, canvasH, spec, name) {
  // 等比放進框內（見 fitInFrame），框外不會超出
  const src = boundsBox(layer);
  const aspectPercent = (src.height / src.width) * (canvasW / canvasH);
  const rect = fitInFrame(name, spec, aspectPercent);
  const scale = (canvasW * rect.width) / 100 / src.width;
  await scaleLayerUniform(layer, Math.max(scale, 0.01));

  const fitted = boundsBox(layer);
  await translateLayer(
    layer,
    (canvasW * rect.left) / 100 - fitted.left,
    (canvasH * rect.top) / 100 - fitted.top,
  );
}

async function applyResizeVariantLayout(doc, variant, canvasW, canvasH) {
  const layers = requireMcdSmartLayers(doc);

  if (variant.elements.$BG) {
    await layoutSmartByPercents(
      layers.$BG,
      canvasW,
      canvasH,
      variant.elements.$BG,
      "$BG",
    );
  } else {
    await layoutObjectFitCover(layers.$BG, canvasW, canvasH);
  }

  for (const name of MCD_POSITION_ELEMENT_NAMES) {
    await layoutSmartByPercents(
      layers[name],
      canvasW,
      canvasH,
      variant.elements[name],
      name,
    );
  }
}

async function saveDocumentAsPsd(doc, file) {
  if (!doc.saveAs || typeof doc.saveAs.psd !== "function") {
    throw new Error("此版本 Photoshop 無法另存 PSD。");
  }
  await doc.saveAs.psd(file, {
    embedColorProfile: true,
    maximizeCompatibility: true,
  });
}

function isDocumentOpen(doc) {
  if (!doc) {
    return false;
  }
  for (let i = 0; i < app.documents.length; i++) {
    if (app.documents[i].id === doc.id) {
      return true;
    }
  }
  return false;
}

function readDocumentPath(doc) {
  try {
    return doc && doc.path ? String(doc.path) : "";
  } catch (_error) {
    return "";
  }
}

function findOpenDocumentForTemplate(template) {
  const source = template && template.source;
  if (!source) {
    return null;
  }
  const byPath = findOpenDocumentByPath(source.path);
  if (byPath) {
    return byPath;
  }
  for (let i = 0; i < app.documents.length; i++) {
    if (app.documents[i].name === source.fileName) {
      return app.documents[i];
    }
  }
  return null;
}

function findOpenDocumentByPath(path) {
  if (!path) {
    return null;
  }
  for (let i = 0; i < app.documents.length; i++) {
    if (readDocumentPath(app.documents[i]) === path) {
      return app.documents[i];
    }
  }
  return null;
}

function findTemplateIndexIn(list, doc) {
  const path = readDocumentPath(doc);
  const byPath = path
    ? list.findIndex((template) => template.source && template.source.path === path)
    : -1;
  if (byPath >= 0 || !doc) {
    return byPath;
  }
  return list.findIndex((template) => template.source && template.source.fileName === doc.name);
}

function findTemplateIndexForDocument(doc) {
  return findTemplateIndexIn(moduleStore.templates, doc);
}

function suggestTemplateName(doc) {
  return `${stripExtension(doc.name)}-${formatTimestamp()}`;
}

// ---------- 比例基準：內建樣板是依 MCD-SMART.psd 設計的 ----------
//
// 其他 PSD 的圖層寬度依「和基準 PSD 同名圖層的相對大小」換算：
//   新寬度% = 內建寬度% × (新 PSD 圖層寬 ÷ 新 PSD 畫布寬) ÷ (基準圖層寬 ÷ 基準畫布寬)
// 基準 PSD 自己換算倍率為 1，數值與內建完全相同；位置（靠左%、靠上%）一律沿用內建。
// 基準的量測結果存在 module.json 的 "reference"，可用「編輯」改 fileName 換基準。
const DEFAULT_REFERENCE_FILE = "MCD-SMART.psd";

// 各圖層寬度佔原稿畫布寬的比例（畫布＝含齊圖層的工作區域，或整份文件）
function measureRelativeWidths(master) {
  const container = getMcdSourceContainer(master);
  const layers = requireMcdSmartLayers(container);
  const frame =
    container === master
      ? { left: 0, right: unitNumber(master.width) }
      : readLayerBounds(container);
  const frameW = Math.max(frame.right - frame.left, 1);
  const out = {};
  for (const name of MCD_POSITION_ELEMENT_NAMES) {
    const b = readLayerBounds(layers[name]);
    out[name] = Math.max(b.right - b.left, 1) / frameW;
  }
  return out;
}

function referenceFileName() {
  return (moduleStore.reference && moduleStore.reference.fileName) || DEFAULT_REFERENCE_FILE;
}

function isReferenceDocument(doc) {
  return Boolean(doc) && stripExtension(doc.name) === stripExtension(referenceFileName());
}

// 基準 PSD 開啟時量一次並存起來（之後不必再開基準 PSD 也能換算）
async function captureReferenceIfNeeded(doc) {
  const reference = moduleStore.reference;
  if (!isReferenceDocument(doc) || (reference && reference.widths)) {
    return;
  }
  try {
    moduleStore.reference = { fileName: referenceFileName(), widths: measureRelativeWidths(doc) };
    await saveModuleStore();
  } catch (_error) {
    // 量不到就維持沒有基準，換算時退回內建數值
  }
}

// 依基準換算元件寬度；沒有基準或本身就是基準 PSD 時原樣回傳
function scaleElementsForDocument(elements, doc) {
  const reference = moduleStore.reference;
  if (!doc || !reference || !reference.widths || isReferenceDocument(doc)) {
    return elements;
  }
  let widths;
  try {
    widths = measureRelativeWidths(doc);
  } catch (_error) {
    return elements;
  }
  for (const name of MCD_POSITION_ELEMENT_NAMES) {
    const base = reference.widths[name];
    if (elements[name] && base > 0) {
      elements[name].widthPercent = roundTo(
        Math.min(elements[name].widthPercent * (widths[name] / base), 100),
        2,
      );
      delete elements[name].heightPercent;
    }
  }
  return elements;
}

// 新模組（或草稿）的數值：內建樣板，寬度依基準換算
function initialValuesForDocument(doc) {
  const values = deepClone(BUILTIN_RESIZE_VALUES);
  values.variants.forEach((variant) => scaleElementsForDocument(variant.elements, doc));
  return values;
}

function validMasterOrNull(doc) {
  if (!doc) {
    return null;
  }
  try {
    requireMcdSmartLayers(getMcdSourceContainer(doc));
    return doc;
  } catch (_error) {
    return null;
  }
}

// ---------- Photoshop modal 佇列 ----------
//
// executeAsModal 同一時間只能有一個；切換文件、擷取預覽、產圖若同時發生，
// 後到的會失敗（預覽空白、preview-temp 沒被關掉）。所有 modal 工作一律排隊依序執行。
let photoshopBusy = 0;
let modalQueue = Promise.resolve();

function runModal(task, commandName) {
  photoshopBusy += 1;
  const run = () => core.executeAsModal(task, { commandName });
  const result = modalQueue.then(run, run);
  modalQueue = result.catch(() => {});
  return result.finally(() => {
    photoshopBusy -= 1;
  });
}

// Photoshop 正在使用者操作中（例如正在輸入文字）時會拒絕外掛的 modal 指令
function describeModalError(error) {
  const message = String((error && error.message) || error || "");
  if (/modal/i.test(message)) {
    return "Photoshop 正在編輯中（例如文字游標還在閃），請按 Enter 或 Esc 結束編輯後，再按「重新擷取圖層」。";
  }
  return message;
}

// 切換作用中文件會觸發 select 事件，必須在 modal 範圍內執行
async function activateDocument(doc) {
  if (!doc) {
    return;
  }
  await runModal(async () => {
    // 排隊期間作用中文件可能已變，實際執行時再判斷一次
    if (isDocumentOpen(doc) && (!app.activeDocument || app.activeDocument.id !== doc.id)) {
      app.activeDocument = doc;
    }
  }, "切換文件");
}

async function openPsdAsMaster(file) {
  const opened = findOpenDocumentByPath(file.nativePath);
  if (opened) {
    await activateDocument(opened);
    return opened;
  }
  let doc = null;
  await runModal(async () => {
    doc = await app.open(file);
  }, "開啟 PSD 母版");
  return doc || app.activeDocument;
}

/**
 * 依模組的各版型，從母版複製六個智慧物件，各另存一份 PSD。
 * 母版須含 $BG $PROD $HEAD $LOGO $SM $CTA；不修改母版、不使用工作區域。
 * 尚未命名的版型（outputDocument 為空）會略過。
 */
async function generateResizeDocuments(master, values) {
  if (!isDocumentOpen(master)) {
    throw new Error("母版已關閉，請重新開啟或上傳母版。");
  }
  const variants = values.variants.filter((variant) => variant.outputDocument);
  if (!variants.length) {
    throw new Error("此模組還沒有已命名的版型，請先輸入版型名稱並按「新增」。");
  }

  const sourceContainer = getMcdSourceContainer(master);
  const sourceLayers = requireMcdSmartLayers(sourceContainer);

  const folder = await localFileSystem.getFolder();
  if (!folder) {
    return;
  }

  const jobs = [];
  for (const variant of variants) {
    const fileName = toPsdFileName(variant.outputDocument);
    const file = await folder.createFile(fileName, { overwrite: true });
    jobs.push({ variant, fileName, file });
  }

  const errors = [];
  const canvasW = values.width;
  const canvasH = values.height;

  for (const job of jobs) {
    const docName = stripExtension(job.fileName);
    try {
      await runModal(
        async () => {
          app.activeDocument = master;
          const newDoc = await createMcdDocumentFromMaster(
            master,
            sourceLayers,
            docName,
            canvasW,
            canvasH,
            job.variant.order,
          );
          await applyResizeVariantLayout(newDoc, job.variant, canvasW, canvasH);
          await saveDocumentAsPsd(newDoc, job.file);
        },
        `產製 ${docName}`,
      );
    } catch (error) {
      errors.push(`${job.fileName}：${error.message || error}`);
    }
  }

  try {
    await activateDocument(master);
  } catch (_error) {
    // 母版可能已被關閉
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
}

// ---------- 預覽：把母版六個圖層各自匯出成 PNG，在面板內用 CSS 定位模擬排版 ----------

const PREVIEW_MAX_LAYER_WIDTH = 800;
const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_CHARS[(triple >> 18) & 63];
    out += BASE64_CHARS[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_CHARS[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64_CHARS[triple & 63] : "=";
  }
  return out;
}

async function readLayerBoundsByIds(docId, layerId) {
  try {
    const [result] = await action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _property: "boundsNoEffects" },
            { _ref: "layer", _id: layerId },
            { _ref: "document", _id: docId },
          ],
        },
      ],
      { synchronousExecution: true },
    );
    const bounds = result && (result.boundsNoEffects || result.bounds);
    if (!bounds) {
      return null;
    }
    return {
      left: unitNumber(bounds.left && bounds.left._value != null ? bounds.left._value : bounds.left),
      top: unitNumber(bounds.top && bounds.top._value != null ? bounds.top._value : bounds.top),
      right: unitNumber(bounds.right && bounds.right._value != null ? bounds.right._value : bounds.right),
      bottom: unitNumber(bounds.bottom && bounds.bottom._value != null ? bounds.bottom._value : bounds.bottom),
    };
  } catch (_error) {
    return null;
  }
}

async function exportLayerPreviewPng(master, layer, file, name) {
  const temp = await app.createDocument({
    width: unitNumber(master.width),
    height: unitNumber(master.height),
    resolution: 72,
    mode: constants.NewDocumentMode.RGB,
    fill: constants.DocumentFill.TRANSPARENT,
    name: PREVIEW_TEMP_NAME,
  });

  try {
    const baseIds = new Set(listLayers(temp).map((item) => item.id));
    await master.duplicateLayers([layer], temp);
    app.activeDocument = temp;
    // 跨文件複製時 duplicateLayers 的回傳值可能指向錯的文件／圖層（讀到的邊界會是 0），
    // 所以不用回傳值，直接到暫存文件裡重新找：先依名稱，再找「不是原本空白圖層」的那個
    const copy =
      findLayerByName(temp, layer.name) ||
      listLayers(temp).find((item) => !baseIds.has(item.id)) ||
      null;
    if (!copy) {
      throw new Error(`${name} 複製失敗（若正在編輯文字，請先按 Enter 或 Esc 結束編輯）`);
    }
    try {
      copy.visible = true;
    } catch (_error) {
      // 唯讀屬性略過
    }

    // 與排版邏輯同用 boundsNoEffects：把圖層拉到 (0,0) 再把畫布縮成圖層大小
    let b = readLayerBounds(copy);
    if (!(b.right - b.left >= 1 && b.bottom - b.top >= 1)) {
      // DOM 讀不到時改用 batchPlay 直接向 Photoshop 查詢
      b = (await readLayerBoundsByIds(temp.id, copy.id)) || b;
    }
    const rawWidth = b.right - b.left;
    const rawHeight = b.bottom - b.top;
    if (!(rawWidth >= 1 && rawHeight >= 1)) {
      throw new Error(`${name} 讀不到圖層範圍，無法產生預覽`);
    }
    const width = Math.round(rawWidth);
    const height = Math.round(rawHeight);
    await translateLayer(copy, -b.left, -b.top);
    await temp.resizeCanvas(width, height, constants.AnchorPosition.TOPLEFT);

    if (width > PREVIEW_MAX_LAYER_WIDTH) {
      await temp.resizeImage(
        PREVIEW_MAX_LAYER_WIDTH,
        Math.max(Math.round((height * PREVIEW_MAX_LAYER_WIDTH) / width), 1),
      );
    }

    await temp.saveAs.png(file, { compression: 6 }, true);
    return { width, height };
  } finally {
    try {
      await temp.closeWithoutSaving();
    } catch (_error) {
      // 已關閉
    }
  }
}

const PREVIEW_TEMP_NAME = "preview-temp";

// UXP 的 closeWithoutSaving() 不一定回傳 Promise，不能直接接 .catch()
async function closeDocumentQuietly(doc) {
  try {
    await doc.closeWithoutSaving();
  } catch (_error) {
    // 已關閉
  }
}

// 之前被中斷而殘留的暫存文件一併關掉
function closeLeftoverPreviewDocuments() {
  const leftovers = [];
  for (let i = 0; i < app.documents.length; i++) {
    if (String(app.documents[i].name).startsWith(PREVIEW_TEMP_NAME)) {
      leftovers.push(app.documents[i]);
    }
  }
  return Promise.all(
    leftovers.map((doc) => closeDocumentQuietly(doc)),
  );
}

async function buildPreviewCache(master, required = MCD_SMART_LAYER_NAMES) {
  const sourceContainer = getMcdSourceContainer(master, required);
  const sourceLayers = requireMcdSmartLayers(sourceContainer, required);
  const presentNames = Object.keys(sourceLayers);
  const order = listMcdLayersBottomToTop(sourceContainer, sourceLayers).map((layer) =>
    presentNames.find((name) => sourceLayers[name].id === layer.id),
  );

  const tempFolder = await localFileSystem.getTemporaryFolder();
  const images = {};
  // 單一圖層匯出失敗只略過那一層，其他圖層照常預覽
  const failed = [];
  let firstError = null;

  await runModal(
    async () => {
      await closeLeftoverPreviewDocuments();
      for (const name of presentNames) {
        try {
          // 檔名帶母版 id，避免兩份母版同時擷取時互相覆寫
          const file = await tempFolder.createFile(
            `preview-${master.id}-${name.replace("$", "")}.png`,
            { overwrite: true },
          );
          const size = await exportLayerPreviewPng(master, sourceLayers[name], file, name);
          const buffer = await file.read({ format: formats.binary });
          images[name] = {
            ...size,
            dataUrl: `data:image/png;base64,${arrayBufferToBase64(buffer)}`,
          };
        } catch (error) {
          firstError = firstError || error;
          failed.push(`${name}：${error.message || error}`);
        }
      }
      app.activeDocument = master;
    },
    "擷取預覽圖層",
  );

  if (!Object.keys(images).length) {
    throw firstError || new Error("沒有可預覽的圖層");
  }
  return {
    masterId: master.id,
    order: order.filter((name) => images[name]),
    images,
    failed,
  };
}

// 外掛自己建立暫存文件、切換文件時（擷取預覽、產圖）不跟隨作用中文件
async function whilePhotoshopBusy(task) {
  photoshopBusy += 1;
  try {
    return await task();
  } finally {
    photoshopBusy -= 1;
  }
}

// 兩個分頁共用同一份擷取結果，避免同一份母版重複匯出
const previewCacheByMaster = new Map();

function getPreviewCache(master, force, required) {
  if (!force && previewCacheByMaster.has(master.id)) {
    return previewCacheByMaster.get(master.id);
  }
  const pending = whilePhotoshopBusy(() => buildPreviewCache(master, required)).catch((error) => {
    previewCacheByMaster.delete(master.id);
    throw error;
  });
  previewCacheByMaster.set(master.id, pending);
  return pending;
}

// ---------- 下拉選單 ----------

function fillPicker(picker, labels) {
  const menu = picker.querySelector("sp-menu");
  menu.innerHTML = "";
  labels.forEach((label, index) => {
    const item = document.createElement("sp-menu-item");
    item.textContent = label;
    item.setAttribute("value", String(index));
    if (index === 0) {
      item.setAttribute("selected", "");
    }
    menu.appendChild(item);
  });
  if (labels.length) {
    picker.selectedIndex = 0;
  }
}

function setPickerIndex(picker, index) {
  picker.querySelectorAll("sp-menu-item").forEach((item, i) => {
    if (i === index) {
      item.setAttribute("selected", "");
    } else {
      item.removeAttribute("selected");
    }
  });
  picker.selectedIndex = index;
}

function readPickerIndex(event) {
  const picker = event.target;
  if (typeof picker.selectedIndex === "number" && picker.selectedIndex >= 0) {
    return picker.selectedIndex;
  }
  const n = parseInt(picker.value, 10);
  return Number.isFinite(n) ? n : 0;
}

const TOAST_DURATION_MS = 1000;

// 1 秒後自動關閉的提示視窗
async function showToast(message) {
  const dialog = document.getElementById("toast-dialog");
  document.getElementById("toast-text").textContent = message;
  const shown = dialog.uxpShowModal
    ? dialog.uxpShowModal({ title: "", resize: "none" })
    : dialog.showModal();
  setTimeout(() => {
    try {
      dialog.close();
    } catch (_error) {
      // 已關閉
    }
  }, TOAST_DURATION_MS);
  try {
    await shown;
  } catch (_error) {
    // 關閉時的 reject 略過
  }
}

function showDialog(dialog, title, options = {}) {
  const show = dialog.uxpShowModal
    ? dialog.uxpShowModal({ title, resize: "none", ...options })
    : dialog.showModal();
  return Promise.resolve(show).then((result) => result === "confirm");
}

// ---------- 工作面板：Resize／套圖 兩個分頁各一份，各自保存選取狀態 ----------

const SETTING_STEP = 0.1;
const MIN_WIDTH_PERCENT = 1;
const RESIZE_CORNERS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_SIZE = 10;

function roundPercent(value) {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

// ----- 管理視窗（樣板／模組共用）：勾選後才能編輯（改名）或刪除 -----
//
// config:
//   prefix       HTML data-role 前綴，例如 "variant-manager"
//   title        視窗標題
//   emptyLabel   名稱空白時顯示的文字
//   listItems()  目前的項目陣列
//   getName(item) / setName(item, name)
//   isSameName(a, b)
//   canDelete(item) 可省略
//   remove(item) 從資料中移除並調整選取
//   afterChange() 資料變動後重畫面板
//   deletedMessage(item)
// ctx: { el(role) 找面板元素, beforeOpen() 開視窗前先寫回欄位, persist(message, toast) 存檔 }
function createListManager(config, ctx) {
  const role = (suffix) => ctx.el(`${config.prefix}${suffix}`);
  const ui = {
    dialog: role(""),
    list: role("-list"),
    listView: role("-list-view"),
    confirmView: role("-confirm-view"),
  };
  let rows = [];
  let pendingDelete = null;

  function showView(confirm) {
    ui.listView.style.display = confirm ? "none" : "block";
    ui.confirmView.style.display = confirm ? "block" : "none";
  }

  function makeButton(label, disabled, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-btn";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderList() {
    ui.list.innerHTML = "";
    rows.forEach((row) => {
      const line = document.createElement("div");
      line.className = "manager-row";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = row.checked;
      check.addEventListener("change", () => {
        row.checked = check.checked;
        if (!row.checked) {
          row.editing = false;
        }
        renderList();
      });
      line.appendChild(check);

      if (row.editing) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "text-input manager-name";
        input.value = row.name;
        input.classList.toggle("is-invalid", row.invalid);
        input.addEventListener("input", () => {
          row.name = input.value;
          row.invalid = false;
          input.classList.remove("is-invalid");
        });
        line.appendChild(input);
      } else {
        const label = document.createElement("span");
        label.className = "manager-name";
        label.textContent = row.name || config.emptyLabel;
        line.appendChild(label);
      }

      line.appendChild(
        makeButton("編輯", !row.checked, () => {
          row.editing = true;
          renderList();
        }),
      );
      const deletable = !config.canDelete || config.canDelete(row.item);
      line.appendChild(
        makeButton("刪除", !row.checked || !deletable, () => {
          pendingDelete = row;
          showView(true);
        }),
      );

      ui.list.appendChild(line);
    });
  }

  function open() {
    ctx.beforeOpen();
    rows = config.listItems().map((item) => ({
      item,
      name: config.getName(item),
      checked: false,
      editing: false,
      invalid: false,
    }));
    pendingDelete = null;
    renderList();
    showView(false);
    showDialog(ui.dialog, config.title, {
      resize: "both",
      size: { width: 460, height: 320 },
    });
  }

  async function confirmDelete() {
    const row = pendingDelete;
    pendingDelete = null;
    showView(false);
    if (!row) {
      return;
    }
    config.remove(row.item);
    rows = rows.filter((item) => item !== row);
    config.afterChange();
    renderList();
    await ctx.persist(config.deletedMessage(row.item));
  }

  async function save() {
    // 名稱不可空白、不可重複
    let valid = true;
    rows.forEach((row, i) => {
      const name = row.name.trim();
      const duplicate = rows.some(
        (other, j) => j !== i && config.isSameName(other.name.trim(), name),
      );
      row.invalid = row.editing && (!name || duplicate);
      if (row.invalid) {
        valid = false;
      }
    });
    if (!valid) {
      renderList();
      return;
    }

    rows.forEach((row) => {
      if (row.editing) {
        config.setName(row.item, row.name.trim());
      }
    });
    ui.dialog.close("save");
    config.afterChange();
    await ctx.persist("已儲存改動", "已儲存改動");
  }

  role("-save").addEventListener("click", save);
  role("-close").addEventListener("click", () => {
    ui.dialog.close("cancel");
  });
  role("-delete-confirm").addEventListener("click", confirmDelete);
  role("-delete-cancel").addEventListener("click", () => {
    pendingDelete = null;
    showView(false);
  });

  return { open };
}

function createResizeWorkspace(root) {
  const el = (role) => root.querySelector(`[data-role="${role}"]`);
  const fields = {
    leftPercent: el("field-leftPercent"),
    topPercent: el("field-topPercent"),
    widthPercent: el("field-widthPercent"),
    heightPercent: el("field-heightPercent"),
  };
  const stage = el("preview-stage");
  const templatePicker = el("template-picker");
  const variantPicker = el("variant-picker");
  const elementPicker = el("element-picker");
  const templateNameInput = el("template-name");
  const variantNameInput = el("variant-name");

  const state = {
    master: null,
    templateIndex: 0,
    variantIndex: 0,
    elementName: MCD_POSITION_ELEMENT_NAMES[0],
    previewCache: null,
    drag: null,
    images: {},
    selection: null,
  };

  const workspace = { root, open, show, commit: commitFields };

  // ----- 目前選取 -----

  // templateIndex = -1 代表「尚未新增」的草稿模組（還沒按「新增」的 PSD）
  function currentTemplate() {
    if (state.templateIndex < 0) {
      return state.draft;
    }
    return moduleStore.templates[state.templateIndex] || null;
  }

  function isDraftSelected() {
    return state.templateIndex < 0 && Boolean(state.draft);
  }

  function currentVariant() {
    const template = currentTemplate();
    return template ? template.values.variants[state.variantIndex] || null : null;
  }

  function coverSpec() {
    // 與 layoutObjectFitCover 相同：等比放大到鋪滿畫布並置中，換算成百分比
    const info = state.previewCache && state.previewCache.images.$BG;
    if (!info) {
      return { leftPercent: 0, topPercent: 0, widthPercent: 100 };
    }
    const canvas = canvasSize();
    const scale = Math.max(canvas.width / info.width, canvas.height / info.height);
    const w = info.width * scale;
    const h = info.height * scale;
    return {
      leftPercent: roundTo(((canvas.width - w) / 2 / canvas.width) * 100, 2),
      topPercent: roundTo(((canvas.height - h) / 2 / canvas.height) * 100, 2),
      widthPercent: roundTo((w / canvas.width) * 100, 2),
    };
  }

  function elementSpec(variant, name) {
    if (!variant) {
      return name === "$BG" ? coverSpec() : DEFAULT_VARIANT_ELEMENTS[name];
    }
    if (name === "$BG" && !variant.elements.$BG) {
      return coverSpec();
    }
    return variant.elements[name];
  }

  function currentSpec() {
    const variant = currentVariant();
    return variant ? elementSpec(variant, state.elementName) : null;
  }

  function canvasSize() {
    const template = currentTemplate();
    return template ? template.values : BUILTIN_RESIZE_VALUES;
  }

  function variantLabel(variant) {
    return variant && variant.outputDocument
      ? variant.outputDocument
      : "（未命名版型）";
  }

  function clampSelection() {
    const count = moduleStore.templates.length;
    if (!(state.templateIndex < 0 && state.draft)) {
      state.templateIndex = count
        ? Math.min(Math.max(state.templateIndex, 0), count - 1)
        : 0;
    }
    const template = currentTemplate();
    if (template && !template.values.variants.length) {
      // 沒有任何版型時先放一個未命名草稿，讓使用者可以直接拖拉再命名
      template.values.variants.push(newDraftVariant());
    }
    const variants = template ? template.values.variants.length : 0;
    state.variantIndex = variants
      ? Math.min(Math.max(state.variantIndex, 0), variants - 1)
      : 0;
  }

  function setStatus(text) {
    el("preview-status").textContent = text;
  }

  // ----- 欄位 -----

  function readFieldsAsSpec() {
    const spec = currentSpec() || elementSpec(null, state.elementName);
    const out = {};
    for (const key of SPEC_KEYS) {
      const n = parseFloat(fields[key].value);
      out[key] = Number.isFinite(n) ? n : spec[key];
    }
    const h = parseFloat(fields.heightPercent.value);
    if (state.elementName !== "$BG" && Number.isFinite(h) && h > 0) {
      out.heightPercent = h;
    }
    return out;
  }

  function writeFields(spec) {
    for (const key of SPEC_KEYS) {
      fields[key].value = roundTo(spec[key], 2);
    }
    fields.heightPercent.value = hasFrameHeight(spec)
      ? roundTo(spec.heightPercent, 2)
      : "";
  }

  // $BG 欄位顯示實際滿版後的位置與大小（舊資料若會露白邊，存檔時一併修正）
  function coveredBackgroundSpec(spec) {
    const ratio = heightRatio("$BG");
    if (!ratio) {
      return { leftPercent: spec.leftPercent, topPercent: spec.topPercent, widthPercent: spec.widthPercent };
    }
    const rect = fitInFrame("$BG", spec, ratio);
    return {
      leftPercent: roundTo(rect.left, 2),
      topPercent: roundTo(rect.top, 2),
      widthPercent: roundTo(rect.width, 2),
    };
  }

  function loadFields() {
    const rawSpec = currentSpec();
    const spec =
      rawSpec && state.elementName === "$BG" ? coveredBackgroundSpec(rawSpec) : rawSpec;
    if (!spec) {
      for (const key of FIELD_KEYS) {
        fields[key].value = "";
      }
      return;
    }
    writeFields(spec);
  }

  function commitFields() {
    const variant = currentVariant();
    if (!variant) {
      return;
    }
    const next = readFieldsAsSpec();
    if (state.elementName === "$BG" && !variant.elements.$BG) {
      // 沒動過就維持自動 cover，換母版時仍會鋪滿
      const cover = coverSpec();
      const changed =
        hasFrameHeight(next) ||
        SPEC_KEYS.some((key) => Math.abs(next[key] - cover[key]) > 0.005);
      if (changed) {
        variant.elements.$BG = next;
      }
      return;
    }
    const target = variant.elements[state.elementName];
    delete target.heightPercent;
    delete target.alignX;
    delete target.alignY;
    Object.assign(target, next);
  }

  function naturalHeightPercent(name, spec) {
    return spec.widthPercent * heightRatio(name);
  }

  function stepField(key, direction) {
    const input = fields[key];
    const current = parseFloat(input.value);
    let base = Number.isFinite(current) ? current : 0;
    if (key === "heightPercent" && !Number.isFinite(current)) {
      // 不限高度時從圖層目前的高度開始調
      base = naturalHeightPercent(state.elementName, readFieldsAsSpec());
    }
    const next = Math.min(100, Math.max(0, base + direction * SETTING_STEP));
    input.value = roundTo(next, 2);
  }

  // ----- 下拉選單 -----

  // 有草稿時下拉第 0 項是「（未新增）」草稿，其後才是各模組
  function pickerOffset() {
    return state.draft ? 1 : 0;
  }

  function renderTemplatePicker() {
    const names = moduleStore.templates.map((template) => template.name || "（未命名模組）");
    const labels = state.draft ? [state.draft.label, ...names] : names;
    fillPicker(templatePicker, labels);
    if (labels.length) {
      setPickerIndex(templatePicker, state.templateIndex + pickerOffset());
    }
    updateTemplateHint();
  }

  function renderVariantPicker() {
    const template = currentTemplate();
    const variants = template ? template.values.variants : [];
    fillPicker(variantPicker, variants.map(variantLabel));
    if (variants.length) {
      setPickerIndex(variantPicker, state.variantIndex);
    }
    updateVariantNameValidity();
  }

  function renderElementPicker() {
    fillPicker(elementPicker, EDITABLE_ELEMENT_NAMES);
    setPickerIndex(elementPicker, EDITABLE_ELEMENT_NAMES.indexOf(state.elementName));
  }

  function updateVariantNameValidity() {
    // 目前版型還沒命名時，版型名稱欄位顯示紅框提醒
    const variant = currentVariant();
    const needsName =
      Boolean(variant) &&
      !variant.outputDocument &&
      !variantNameInput.value.trim();
    variantNameInput.classList.toggle("is-invalid", needsName);
  }

  function renderAll() {
    clampSelection();
    renderTemplatePicker();
    renderVariantPicker();
    renderElementPicker();
    loadFields();
    renderPreview();
  }

  // ----- 預覽 -----

  function heightRatio(name) {
    // 高度% ÷ 寬度%：圖層長寬比 × 畫布寬高比
    const info = state.previewCache && state.previewCache.images[name];
    if (!info) {
      return 0;
    }
    const canvas = canvasSize();
    return (info.height / info.width) * (canvas.width / canvas.height);
  }

  function specForPreview(name) {
    if (name === state.elementName) {
      return readFieldsAsSpec();
    }
    return elementSpec(currentVariant(), name);
  }

  function applyElementStyle(name, spec) {
    const img = state.images[name];
    if (!img) {
      return;
    }
    const rect = fitInFrame(name, spec, heightRatio(name));
    img.style.left = `${rect.left}%`;
    img.style.top = `${rect.top}%`;
    img.style.width = `${rect.width}%`;
  }

  function frameHeightPercent(name, spec) {
    return hasFrameHeight(spec) ? spec.heightPercent : naturalHeightPercent(name, spec);
  }

  function updateSelectionBox() {
    const sel = state.selection;
    if (!sel) {
      return;
    }
    const ratio = heightRatio(state.elementName);
    const hidden = !ratio;
    sel.box.style.display = hidden ? "none" : "block";
    sel.handles.forEach(({ node }) => {
      node.style.display = hidden ? "none" : "block";
    });
    if (hidden) {
      return;
    }
    const spec = readFieldsAsSpec();
    const heightPercent = frameHeightPercent(state.elementName, spec);
    sel.box.classList.toggle("is-limited", hasFrameHeight(spec));
    sel.box.style.left = `${spec.leftPercent}%`;
    sel.box.style.top = `${spec.topPercent}%`;
    sel.box.style.width = `${spec.widthPercent}%`;
    sel.box.style.height = `${heightPercent}%`;

    // 控制點夾在預覽範圍內：$BG 等超出畫布的圖層也拉得到角落
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    const half = HANDLE_SIZE / 2;
    sel.handles.forEach(({ corner, node }) => {
      const fx = corner.includes("e") ? 1 : corner.includes("w") ? 0 : 0.5;
      const fy = corner.includes("s") ? 1 : corner.includes("n") ? 0 : 0.5;
      const xPercent = spec.leftPercent + spec.widthPercent * fx;
      const yPercent = spec.topPercent + heightPercent * fy;
      const x = clampNumber((xPercent / 100) * stageW, half, stageW - half);
      const y = clampNumber((yPercent / 100) * stageH, half, stageH - half);
      node.style.left = `${x - half}px`;
      node.style.top = `${y - half}px`;
    });
  }

  function updateHighlight() {
    updateSelectionBox();
    updateLayerButtons();
  }

  function resizeStage() {
    const canvas = canvasSize();
    stage.style.height = `${(stage.clientWidth * canvas.height) / canvas.width}px`;
  }

  function createSelection(zIndex) {
    const box = document.createElement("div");
    box.className = "preview-selection";
    box.style.zIndex = String(zIndex);
    stage.appendChild(box);
    const handles = RESIZE_CORNERS.map((corner) => {
      const node = document.createElement("div");
      node.className = `preview-handle is-${corner}`;
      node.style.zIndex = String(zIndex + 1);
      node.addEventListener("mousedown", (event) => {
        startResize(corner, event);
      });
      stage.appendChild(node);
      return { corner, node };
    });
    return { box, handles };
  }

  // ----- 圖層前後順序 -----

  function effectiveLayerOrder() {
    const variant = currentVariant();
    if (variant && variant.order) {
      return variant.order;
    }
    // 未設定時沿用母版的堆疊順序
    const fromMaster = state.previewCache
      ? state.previewCache.order.filter((name) => name !== "$BG")
      : [];
    return fromMaster.length === MCD_POSITION_ELEMENT_NAMES.length
      ? fromMaster
      : MCD_POSITION_ELEMENT_NAMES.slice();
  }

  function zIndexFor(name, fallbackIndex) {
    if (name === "$BG") {
      return 1;
    }
    const index = effectiveLayerOrder().indexOf(name);
    return index >= 0 ? index + 2 : fallbackIndex + 1;
  }

  // UXP 不支援 z-index，疊放只看 DOM 先後：依層級由下往上把圖片重新排進預覽區，
  // 並插在選取框之前，讓選取框與控制點永遠在最上面
  function applyLayerOrder() {
    const names = Object.keys(state.images).sort(
      (a, b) => zIndexFor(a, 0) - zIndexFor(b, 0),
    );
    const anchor = state.selection ? state.selection.box : null;
    names.forEach((name) => {
      const img = state.images[name];
      img.style.zIndex = String(zIndexFor(name, 0));
      if (anchor) {
        stage.insertBefore(img, anchor);
      } else {
        stage.appendChild(img);
      }
    });
  }

  const LAYER_MOVES = {
    front: (order, i) => [...order.slice(0, i), ...order.slice(i + 1), order[i]],
    back: (order, i) => [order[i], ...order.slice(0, i), ...order.slice(i + 1)],
    forward: (order, i) => swapAt(order, i, i + 1),
    backward: (order, i) => swapAt(order, i, i - 1),
  };

  function swapAt(order, i, j) {
    if (j < 0 || j >= order.length) {
      return order;
    }
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }

  function moveLayer(direction) {
    const variant = currentVariant();
    const name = state.elementName;
    if (!variant || name === "$BG") {
      setStatus("$BG 固定在最底層。");
      return;
    }
    const order = effectiveLayerOrder();
    const next = LAYER_MOVES[direction](order, order.indexOf(name));
    variant.order = next;
    applyLayerOrder();
    const position = next.length - next.indexOf(name);
    setStatus(`${name} 目前在第 ${position} 層（由上往下數），按「儲存設定值」保存。`);
  }

  /**
   * 同步圖層大小：以目前樣板各圖層的寬度%／高度% 為準，套到同模組的其他樣板。
   * 只改大小，各樣板原本的靠左%、靠上% 不變。
   * $BG 若目前是自動鋪滿，其他樣板也改回自動鋪滿。
   */
  async function syncLayerSizes() {
    const template = currentTemplate();
    const source = currentVariant();
    if (!template || !source) {
      return;
    }
    if (!(await showDialog(el("sync-dialog"), "同步圖層大小"))) {
      return;
    }
    commitFields();
    for (const variant of template.values.variants) {
      if (variant === source) {
        continue;
      }
      for (const name of MCD_POSITION_ELEMENT_NAMES) {
        copyFrameSize(source.elements[name], variant.elements[name]);
      }
      if (!source.elements.$BG) {
        delete variant.elements.$BG;
      } else if (!variant.elements.$BG) {
        variant.elements.$BG = deepClone(source.elements.$BG);
      } else {
        copyFrameSize(source.elements.$BG, variant.elements.$BG);
      }
    }
    await persist(
      `已將「${variantLabel(source)}」的圖層大小同步到其他樣板`,
      "已同步圖層大小",
    );
  }

  function copyFrameSize(from, to) {
    to.widthPercent = from.widthPercent;
    if (hasFrameHeight(from)) {
      to.heightPercent = from.heightPercent;
    } else {
      delete to.heightPercent;
    }
  }

  function updateLayerButtons() {
    root.querySelectorAll("[data-layer-move]").forEach((button) => {
      button.disabled = state.elementName === "$BG";
    });
  }

  function renderPreview() {
    stage.innerHTML = "";
    state.images = {};
    state.selection = null;
    const cache = state.previewCache;
    if (!cache) {
      return;
    }

    cache.order.forEach((name, index) => {
      const img = document.createElement("img");
      img.className = "preview-layer";
      img.src = cache.images[name].dataUrl;
      img.style.zIndex = String(zIndexFor(name, index));
      stage.appendChild(img);
      state.images[name] = img;
      img.classList.add("is-draggable");
      img.addEventListener("mousedown", (event) => {
        startMove(name, event);
      });
      applyElementStyle(name, specForPreview(name));
    });

    state.selection = createSelection(cache.order.length + 1);
    applyLayerOrder();

    resizeStage();
    updateHighlight();
  }

  function updatePreviewFromFields() {
    applyElementStyle(state.elementName, readFieldsAsSpec());
    updateSelectionBox();
  }

  async function refreshPreview(force) {
    const master = state.master;
    if (!isDocumentOpen(master)) {
      state.previewCache = null;
      renderPreview();
      setStatus("請按「上傳.psd」或開啟母版後再按「開始執行」。");
      return;
    }
    if (!force && state.previewCache && state.previewCache.masterId === master.id) {
      renderPreview();
      return;
    }

    setStatus("擷取圖層中，請稍候…");
    try {
      const cache = await getPreviewCache(master, force);
      if (state.master !== master) {
        return; // 擷取期間已切換母版
      }
      state.previewCache = cache;
      renderPreview();
      setStatus(`預覽來源：${master.name}`);
    } catch (error) {
      state.previewCache = null;
      renderPreview();
      setStatus(`預覽擷取失敗：${describeModalError(error)}`);
    }
  }

  // ----- 預覽拖拉：點圖層切換下拉並移動；拉四個角等比縮放 -----

  function selectElement(name) {
    if (name === state.elementName) {
      return;
    }
    commitFields();
    state.elementName = name;
    setPickerIndex(elementPicker, EDITABLE_ELEMENT_NAMES.indexOf(name));
    loadFields();
    updateHighlight();
  }

  function beginDrag(mode, corner, event) {
    event.preventDefault();
    const spec = readFieldsAsSpec();
    state.drag = {
      mode,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      start: spec,
      startHeight: frameHeightPercent(state.elementName, spec),
      stageW: Math.max(stage.clientWidth, 1),
      stageH: Math.max(stage.clientHeight, 1),
    };
    stage.classList.add("is-dragging");
  }

  function startMove(name, event) {
    selectElement(name);
    beginDrag("move", null, event);
  }

  function startResize(corner, event) {
    event.stopPropagation();
    beginDrag("resize", corner, event);
  }

  /**
   * 框的縮放（對邊／對角固定不動）：
   *   四個角：框等比縮放；不限高度時高度維持「不限」，圖層照舊以寬度等比放大縮小
   *   上下邊：只改框高（會設定高度%）
   *   左右邊：只改框寬
   * 角落以水平或垂直拖曳量中變化較大者為準，拖斜線時比較順手。
   */
  function resizeSpecFromDrag(drag, dxPercent, dyPercent) {
    const { start, startHeight, corner } = drag;
    const sx = corner.includes("e") ? 1 : corner.includes("w") ? -1 : 0;
    const sy = corner.includes("s") ? 1 : corner.includes("n") ? -1 : 0;
    let width = start.widthPercent;
    let height = startHeight;

    if (sx && sy) {
      const ratio = startHeight / Math.max(start.widthPercent, 0.01);
      const widthFromX = start.widthPercent + sx * dxPercent;
      const widthFromY = ratio ? (startHeight + sy * dyPercent) / ratio : widthFromX;
      const useX =
        Math.abs(widthFromX - start.widthPercent) >=
        Math.abs(widthFromY - start.widthPercent);
      width = Math.max(MIN_WIDTH_PERCENT, useX ? widthFromX : widthFromY);
      height = width * ratio;
    } else if (sx) {
      width = Math.max(MIN_WIDTH_PERCENT, start.widthPercent + sx * dxPercent);
    } else {
      height = Math.max(MIN_WIDTH_PERCENT, startHeight + sy * dyPercent);
    }

    const next = {
      ...start,
      leftPercent: sx < 0 ? start.leftPercent + (start.widthPercent - width) : start.leftPercent,
      topPercent: sy < 0 ? start.topPercent + (startHeight - height) : start.topPercent,
      widthPercent: width,
    };
    if (hasFrameHeight(start) || (sy && !sx)) {
      next.heightPercent = height;
    }
    return next;
  }

  function onMouseMove(event) {
    const drag = state.drag;
    if (!drag) {
      return;
    }
    const dxPercent = ((event.clientX - drag.startX) / drag.stageW) * 100;
    const dyPercent = ((event.clientY - drag.startY) / drag.stageH) * 100;

    if (state.elementName === "$BG") {
      // 背景拖拉／縮放時即時夾在滿版範圍內（可為負值，但不會露出白邊）
      const next =
        drag.mode === "move"
          ? {
              ...drag.start,
              leftPercent: drag.start.leftPercent + dxPercent,
              topPercent: drag.start.topPercent + dyPercent,
            }
          : resizeSpecFromDrag(drag, dxPercent, dyPercent);
      writeFields(coveredBackgroundSpec(next));
    } else if (drag.mode === "move") {
      fields.leftPercent.value = roundPercent(drag.start.leftPercent + dxPercent);
      fields.topPercent.value = roundPercent(drag.start.topPercent + dyPercent);
    } else {
      writeFields(resizeSpecFromDrag(drag, dxPercent, dyPercent));
    }
    updatePreviewFromFields();
  }

  function onMouseUp() {
    if (!state.drag) {
      return;
    }
    state.drag = null;
    stage.classList.remove("is-dragging");
    commitFields();
  }

  // 預覽區不吃滑鼠滾輪：避免誤滑讓圖片左右位移，滾輪改為捲動整個面板
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const scroller = document.scrollingElement || document.body;
    scroller.scrollTop += event.deltaY;
  });
  stage.addEventListener("scroll", () => {
    if (stage.scrollLeft || stage.scrollTop) {
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    }
  });

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);

  // ----- 儲存 -----

  async function persist(message, toast) {
    try {
      await saveModuleStore();
      notifyModuleStoreChanged(workspace);
      setStatus(message);
      if (toast) {
        await showToast(toast);
      }
      return true;
    } catch (error) {
      await app.showAlert(`module.json 寫入失敗：${error.message || error}`);
      return false;
    }
  }

  // 把目前版型各圖層的框高鎖定成目前母版圖層的實際高度（之後換 PSD 也不會超出）
  async function lockFrameHeights() {
    const variant = currentVariant();
    if (!variant || !state.previewCache) {
      setStatus("請先擷取預覽圖層。");
      return;
    }
    commitFields();
    let count = 0;
    for (const name of MCD_POSITION_ELEMENT_NAMES) {
      const spec = variant.elements[name];
      if (!hasFrameHeight(spec)) {
        spec.heightPercent = roundTo(naturalHeightPercent(name, spec), 2);
        count += 1;
      }
    }
    loadFields();
    renderPreview();
    await persist(
      `已鎖定「${variantLabel(variant)}」${count} 個圖層的框高`,
      "已鎖定框高",
    );
  }

  // ----- 模組（template）-----

  function selectTemplate(index) {
    commitFields();
    state.templateIndex = index;
    state.variantIndex = 0;
    clampSelection();

    // 模組記錄的來源 PSD 若已開啟，就改用它當預覽母版
    // 模組的來源 PSD 若已開啟，預覽改用它（只換面板的預覽來源，不切換 Photoshop 文件）
    const template = currentTemplate();
    const sourceDoc = findOpenDocumentForTemplate(template);
    if (sourceDoc && validMasterOrNull(sourceDoc)) {
      state.master = sourceDoc;
    }

    renderVariantPicker();
    loadFields();
    refreshPreview(false);
  }

  async function uploadPsd() {
    if (masterNeedsTemplate()) {
      await app.showAlert("請點選新增模組");
      return;
    }
    let file;
    try {
      file = await localFileSystem.getFileForOpening({ types: ["psd", "psb"] });
    } catch (error) {
      await app.showAlert(`無法選擇檔案：${error.message || error}`);
      return;
    }
    if (!file) {
      return;
    }

    try {
      const doc = await openPsdAsMaster(file);
      requireMcdSmartLayers(getMcdSourceContainer(doc));
      state.master = doc;
      await captureReferenceIfNeeded(doc);
      const existing = findTemplateIndexForDocument(doc);
      if (existing >= 0) {
        templateNameInput.value = "";
        templateNameInput.classList.remove("is-suggested");
        state.draft = null;
        state.templateIndex = existing;
        state.variantIndex = 0;
        renderAll();
        setStatus(`${doc.name} 已有模組「${moduleStore.templates[existing].name}」。`);
      } else {
        suggestTemplate(doc);
      }
      templateNameInput.classList.remove("is-invalid");
      await refreshPreview(false);
    } catch (error) {
      await app.showAlert(error.message || String(error));
    }
  }

  async function addTemplate() {
    const name = templateNameInput.value.trim();
    if (!name) {
      templateNameInput.classList.add("is-invalid");
      setStatus("請輸入模組名稱。");
      return;
    }
    if (moduleStore.templates.some((template) => template.name === name)) {
      templateNameInput.classList.add("is-invalid");
      setStatus(`模組「${name}」已存在。`);
      return;
    }
    if (!isDocumentOpen(state.master)) {
      setStatus("請先按「上傳.psd」選擇母版。");
      return;
    }

    commitFields();
    // 有這份 PSD 的草稿就照畫面上的草稿存；否則用內建樣板、寬度依基準換算
    const draft = state.draft && state.draft.draftFor === state.master.id ? state.draft : null;
    const values = draft ? draft.values : initialValuesForDocument(state.master);
    const variantIndex = draft && isDraftSelected() ? state.variantIndex : 0;
    state.draft = null;
    moduleStore.templates.push({
      name,
      source: {
        fileName: state.master.name,
        path: readDocumentPath(state.master),
      },
      values,
    });
    state.templateIndex = moduleStore.templates.length - 1;
    state.variantIndex = variantIndex;
    templateNameInput.value = "";
    templateNameInput.classList.remove("is-invalid", "is-suggested");

    renderAll();
    await persist(`已新增模組「${name}」`, "成功新增模組");
  }

  // ----- 版型（variant / outputDocument）-----

  async function addVariant() {
    const template = currentTemplate();
    if (!template) {
      setStatus("請先選擇或新增模組。");
      return;
    }
    const name = variantNameInput.value.trim();
    if (!name) {
      variantNameInput.classList.add("is-invalid");
      setStatus("請輸入版型名稱。");
      return;
    }
    const variants = template.values.variants;
    if (variants.some((variant) => isSameVariantName(variant.outputDocument || "", name))) {
      variantNameInput.classList.add("is-invalid");
      setStatus(`版型「${name}」已存在。`);
      return;
    }

    commitFields();
    // 有未命名的草稿（剛新增模組時的第 0 筆）就直接替它命名，保留使用者拖拉過的位置
    const draft = variants.find((variant) => !variant.outputDocument);
    if (draft) {
      draft.outputDocument = name;
      state.variantIndex = variants.indexOf(draft);
    } else {
      variants.push({
        outputDocument: name,
        elements: deepClone(DEFAULT_VARIANT_ELEMENTS),
      });
      state.variantIndex = variants.length - 1;
    }
    variantNameInput.value = "";

    renderVariantPicker();
    loadFields();
    renderPreview();
    await persist(`已新增樣板「${name}」`, "成功新增樣板");
  }

  function defaultElementsFor(template, variant) {
    // 與內建樣板同名就還原成內建數值（寬度依基準換算成這份 PSD 的比例），其餘還原成置中預設值
    const match = BUILTIN_RESIZE_VALUES.variants.find((item) =>
      isSameVariantName(item.outputDocument, variant.outputDocument || ""),
    );
    if (!match) {
      return deepClone(DEFAULT_VARIANT_ELEMENTS);
    }
    const elements = deepClone(match.elements);
    delete elements.$BG;
    const doc = template === state.draft ? state.master : findOpenDocumentForTemplate(template);
    return template.builtin ? elements : scaleElementsForDocument(elements, doc);
  }

  async function resetVariant() {
    const template = currentTemplate();
    const variant = currentVariant();
    if (!template || !variant) {
      return;
    }
    el("reset-dialog-text").textContent =
      `確認要將「${variantLabel(variant)}」還原預設值嗎？`;
    if (!(await showDialog(el("reset-dialog"), "還原預設值"))) {
      return;
    }
    // $BG 不在預設值內，還原後回到自動 cover
    variant.elements = defaultElementsFor(template, variant);
    delete variant.order;
    loadFields();
    renderPreview();
    await persist(`已將「${variantLabel(variant)}」還原為預設值。`);
  }


  const variantManager = createListManager({
    prefix: "variant-manager",
    title: "編輯 Resize 樣板",
    emptyLabel: "（未命名版型）",
    listItems: () => (currentTemplate() ? currentTemplate().values.variants : []),
    getName: (variant) => variant.outputDocument,
    setName: (variant, name) => {
      variant.outputDocument = name;
    },
    isSameName: isSameVariantName,
    remove: (variant) => {
      const variants = currentTemplate().values.variants;
      const index = variants.indexOf(variant);
      if (index < 0) {
        return;
      }
      variants.splice(index, 1);
      if (state.variantIndex > index || state.variantIndex >= variants.length) {
        state.variantIndex = Math.max(state.variantIndex - 1, 0);
      }
    },
    afterChange: () => {
      clampSelection();
      renderVariantPicker();
      loadFields();
      renderPreview();
    },
    deletedMessage: (variant) => `已刪除樣板「${variantLabel(variant)}」`,
  }, { el, beforeOpen: commitFields, persist });

  const templateManager = createListManager({
    prefix: "template-manager",
    title: "編輯模組",
    emptyLabel: "（未命名模組）",
    listItems: () => moduleStore.templates,
    getName: (template) => template.name,
    setName: (template, name) => {
      template.name = name;
    },
    isSameName: (a, b) => a === b,
    // 「預設」模組是新模組複製的來源，不開放刪除（可改名）
    canDelete: (template) => !template.builtin,
    remove: (template) => {
      const index = moduleStore.templates.indexOf(template);
      if (index < 0) {
        return;
      }
      moduleStore.templates.splice(index, 1);
      if (state.templateIndex > index || state.templateIndex >= moduleStore.templates.length) {
        state.templateIndex = Math.max(state.templateIndex - 1, 0);
        state.variantIndex = 0;
      }
    },
    afterChange: renderAll,
    deletedMessage: (template) => `已刪除模組「${template.name}」`,
  }, { el, beforeOpen: commitFields, persist });

  // ----- 事件 -----

  root.querySelectorAll("[data-step-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const direction = button.getAttribute("data-step-dir") === "up" ? 1 : -1;
      stepField(button.getAttribute("data-step-target"), direction);
      updatePreviewFromFields();
    });
  });

  for (const key of FIELD_KEYS) {
    fields[key].addEventListener("input", updatePreviewFromFields);
  }

  templatePicker.addEventListener("change", (event) => {
    selectTemplate(readPickerIndex(event) - pickerOffset());
  });

  variantPicker.addEventListener("change", (event) => {
    commitFields();
    state.variantIndex = readPickerIndex(event);
    updateVariantNameValidity();
    loadFields();
    renderPreview();
  });

  elementPicker.addEventListener("change", (event) => {
    commitFields();
    state.elementName = EDITABLE_ELEMENT_NAMES[readPickerIndex(event)];
    loadFields();
    updateHighlight();
  });

  templateNameInput.addEventListener("input", () => {
    templateNameInput.classList.remove("is-invalid", "is-suggested");
  });
  variantNameInput.addEventListener("input", updateVariantNameValidity);

  el("btn-upload-psd").addEventListener("click", uploadPsd);
  el("btn-add-template").addEventListener("click", addTemplate);
  el("btn-add-variant").addEventListener("click", addVariant);
  el("btn-refresh-preview").addEventListener("click", () => refreshPreview(true));
  el("btn-reset-defaults").addEventListener("click", resetVariant);
  el("btn-lock-heights").addEventListener("click", lockFrameHeights);
  el("btn-sync-sizes").addEventListener("click", syncLayerSizes);
  el("btn-sync-confirm").addEventListener("click", () => {
    el("sync-dialog").close("confirm");
  });
  el("btn-sync-cancel").addEventListener("click", () => {
    el("sync-dialog").close("cancel");
  });
  root.querySelectorAll("[data-layer-move]").forEach((button) => {
    button.addEventListener("click", () => moveLayer(button.getAttribute("data-layer-move")));
  });

  el("btn-manage-variants").addEventListener("click", () => {
    if (!currentTemplate()) {
      setStatus("請先選擇或新增模組。");
      return;
    }
    variantManager.open();
  });
  el("btn-manage-templates").addEventListener("click", () => templateManager.open());

  el("btn-reset-confirm").addEventListener("click", () => {
    el("reset-dialog").close("confirm");
  });
  el("btn-reset-cancel").addEventListener("click", () => {
    el("reset-dialog").close("cancel");
  });

  el("btn-save-setting").addEventListener("click", async () => {
    commitFields();
    if (isDraftSelected()) {
      await app.showAlert("請點選新增模組");
      return;
    }
    await persist(
      `已儲存 ${variantLabel(currentVariant())} 的設定值`,
      "成功儲存設定值",
    );
  });

  el("btn-start-generate").addEventListener("click", async () => {
    commitFields();
    const template = currentTemplate();
    if (!template) {
      return;
    }
    if (!(await persist("設定已儲存"))) {
      return;
    }
    try {
      await whilePhotoshopBusy(() =>
        generateResizeDocuments(state.master, template.values),
      );
      closeResizeSettingsPanel();
    } catch (error) {
      await app.showAlert(`Resize 產製失敗：${error.message || error}`);
    }
  });

  el("btn-cancel-settings").addEventListener("click", () => {
    closeResizeSettingsPanel();
  });

  window.addEventListener("resize", () => {
    if (state.previewCache) {
      resizeStage();
      updateSelectionBox();
    }
  });

  onModuleStoreChanged((source) => {
    if (source === workspace) {
      return;
    }
    // 另一個分頁已替這份 PSD 新增模組：草稿換成該模組
    const registered = state.draft ? findTemplateIndexForDocument(state.master) : -1;
    if (registered >= 0) {
      state.draft = null;
      state.templateIndex = registered;
      templateNameInput.value = "";
      templateNameInput.classList.remove("is-suggested");
    }
    renderAll();
  });

  // ----- 對外 -----

  function suggestTemplate(doc) {
    // 尚未建立模組的 PSD：帶入「檔名-時間」，並建立草稿讓預覽立刻套用這份 PSD 的大小
    const name = suggestTemplateName(doc);
    state.draft = {
      name,
      label: `${stripExtension(doc.name)}（未新增）`,
      draftFor: doc.id,
      values: initialValuesForDocument(doc),
    };
    state.templateIndex = -1;
    state.variantIndex = 0;
    renderAll();
    templateNameInput.value = name;
    templateNameInput.classList.add("is-suggested");
    setStatus(`${doc.name} 尚未建立模組，可先調整，確認名稱後按「新增」。`);
  }

  // 目前母版還沒建立模組（還沒按「新增」）
  function masterNeedsTemplate() {
    return (
      isDocumentOpen(state.master) &&
      Boolean(validMasterOrNull(state.master)) &&
      findTemplateIndexForDocument(state.master) < 0
    );
  }

  function updateTemplateHint() {
    el("template-hint").style.display = masterNeedsTemplate() ? "block" : "none";
  }

  function open(master, note) {
    if (!master || !state.master || master.id !== state.master.id) {
      state.previewCache = null;
    }
    state.master = master;
    const existing = master ? findTemplateIndexForDocument(master) : -1;
    state.draft = null;
    state.templateIndex = Math.max(existing, 0);
    state.variantIndex = 0;
    state.elementName = MCD_POSITION_ELEMENT_NAMES[0];
    templateNameInput.value = "";
    templateNameInput.classList.remove("is-invalid", "is-suggested");
    variantNameInput.value = "";
    renderAll();
    setStatus(note || "");
    if (master && existing < 0) {
      suggestTemplate(master);
    }
  }

  function show() {
    if (!isDocumentOpen(state.master)) {
      // 另一個分頁上傳過母版時，沿用目前作用中的文件
      state.master = validMasterOrNull(app.activeDocument);
    }
    if (!state.master) {
      return;
    }
    // 分頁隱藏時量不到寬度，切回來再重新擷取或排版
    refreshPreview(false);
  }

  return workspace;
}


// ---------- 套圖：依 PSD 原稿位置，把勾選的圖層換成資料夾裡的圖 ----------
//
// 套圖模組（module.json 的 applyTemplates，與 Resize 分開）：
//   { name, source: { fileName, path }, layers: ["$PROD", "$CTA"], srcPath: "…/MCD" }
// 圖檔資料夾結構：srcPath/PROD/01.jpg、02.jpg…；srcPath/CTA/01.jpg…（資料夾名稱＝圖層名去掉 $）
// 第 n 組＝各圖層資料夾排序後的第 n 張，產出「套圖0n.psd」；某圖層沒有第 n 張時保留原圖。

const APPLY_LAYER_NAMES = ["$LOGO", "$PROD", "$HEAD", "$CTA", "$SM", "$BG"];
const APPLY_IMAGE_PATTERN = /\.(jpe?g|png|psd|psb|tiff?|webp|gif|bmp)$/i;
const SRC_FOLDER_TOKENS_KEY = "bannerResizer.srcFolderTokens";

// 未設定（舊的 module.json）時六個都必須；設定過就照清單（可以是空的）
function normalizeRequiredLayers(raw) {
  if (!Array.isArray(raw)) {
    return MCD_SMART_LAYER_NAMES.slice();
  }
  return APPLY_LAYER_NAMES.filter((name) => raw.includes(name));
}

function applyRequiredLayers() {
  return moduleStore.applyRequiredLayers || MCD_SMART_LAYER_NAMES;
}

// 套圖用的母版檢查：只要求「必選」勾選的圖層存在
function validApplyMasterOrNull(doc) {
  if (!doc) {
    return null;
  }
  const required = applyRequiredLayers();
  try {
    requireMcdSmartLayers(getMcdSourceContainer(doc, required), required);
    return doc;
  } catch (_error) {
    return null;
  }
}

function applyMasterProblem(doc) {
  const required = applyRequiredLayers();
  try {
    requireMcdSmartLayers(getMcdSourceContainer(doc, required), required);
    return "";
  } catch (error) {
    return `${error.message || error}（可按「必選」調整必須有的圖層）`;
  }
}

function normalizeApplyTemplate(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const layers = Array.isArray(raw.layers)
    ? APPLY_LAYER_NAMES.filter((name) => raw.layers.includes(name))
    : [];
  return {
    name: String(raw.name || "").trim(),
    source: raw.source && typeof raw.source === "object" ? { ...raw.source } : null,
    layers,
    srcPath: String(raw.srcPath || "").trim(),
  };
}

function readSrcFolderTokens() {
  try {
    return JSON.parse(localStorage.getItem(SRC_FOLDER_TOKENS_KEY)) || {};
  } catch (_error) {
    return {};
  }
}

function rememberSrcFolder(path, token) {
  const tokens = readSrcFolderTokens();
  tokens[path] = token;
  try {
    localStorage.setItem(SRC_FOLDER_TOKENS_KEY, JSON.stringify(tokens));
  } catch (_error) {
    // 記不住就下次再選
  }
}

/**
 * 找到圖檔資料夾：先用「選擇資料夾」記住的授權，
 * 再試直接用路徑開啟（需要 manifest 給 localFileSystem 完整權限，否則會被拒絕）。
 */
async function resolveSrcFolder(path) {
  const trimmed = String(path || "").trim();
  if (!trimmed) {
    return null;
  }
  const token = readSrcFolderTokens()[trimmed];
  if (token) {
    try {
      return await localFileSystem.getEntryForPersistentToken(token);
    } catch (_error) {
      // 授權失效，改試路徑
    }
  }
  if (typeof localFileSystem.getEntryWithUrl === "function") {
    const normalized = trimmed.replace(/\\/g, "/");
    try {
      return await localFileSystem.getEntryWithUrl(
        `file:${normalized.startsWith("/") ? "" : "/"}${normalized}`,
      );
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// 讀圖檔資料夾，依勾選圖層組出每一組要替換的圖
async function collectApplySets(folder, layerNames) {
  const entries = await folder.getEntries();
  const perLayer = {};
  for (const name of layerNames) {
    const key = name.replace("$", "").toLowerCase();
    const sub = entries.find((entry) => entry.isFolder && entry.name.toLowerCase() === key);
    const files = sub
      ? (await sub.getEntries())
          .filter((entry) => entry.isFile && APPLY_IMAGE_PATTERN.test(entry.name))
          .sort((a, b) => naturalCompare(a.name, b.name))
      : [];
    perLayer[name] = files;
  }
  const count = Math.max(0, ...layerNames.map((name) => perLayer[name].length));
  const sets = [];
  for (let i = 0; i < count; i++) {
    const files = {};
    layerNames.forEach((name) => {
      if (perLayer[name][i]) {
        files[name] = perLayer[name][i];
      }
    });
    sets.push({ name: `套圖${String(i + 1).padStart(2, "0")}.psd`, files });
  }
  return { sets, perLayer };
}

// 各圖層在原稿畫布上的位置（百分比），畫布＝含齊圖層的工作區域或整份文件
function measureLayerFrames(master, required = MCD_SMART_LAYER_NAMES) {
  const container = getMcdSourceContainer(master, required);
  const layers = requireMcdSmartLayers(container, required);
  const frame =
    container === master
      ? { left: 0, top: 0, right: unitNumber(master.width), bottom: unitNumber(master.height) }
      : readLayerBounds(container);
  const width = Math.max(frame.right - frame.left, 1);
  const height = Math.max(frame.bottom - frame.top, 1);
  const frames = {};
  for (const name of Object.keys(layers)) {
    const b = readLayerBounds(layers[name]);
    frames[name] = {
      left: ((b.left - frame.left) / width) * 100,
      top: ((b.top - frame.top) / height) * 100,
      width: ((b.right - b.left) / width) * 100,
      height: ((b.bottom - b.top) / height) * 100,
    };
  }
  return { frames, width, height };
}

function imageMimeType(fileName) {
  const ext = String(fileName).split(".").pop().toLowerCase();
  if (ext === "png") {
    return "image/png";
  }
  if (ext === "gif") {
    return "image/gif";
  }
  if (ext === "webp") {
    return "image/webp";
  }
  return "image/jpeg";
}

/**
 * 直接從圖檔檔頭讀寬高（JPEG / PNG / GIF / WebP / BMP）。
 * UXP 面板裡的 <img> 不一定會觸發 load、也不一定有 naturalWidth，
 * 所以預覽定位不依賴瀏覽器載入圖片。讀不到時回傳 null。
 */
function readImageSize(bytes) {
  const u16be = (i) => (bytes[i] << 8) | bytes[i + 1];
  const u16le = (i) => bytes[i] | (bytes[i + 1] << 8);
  const u24le = (i) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
  const u32be = (i) => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
  const ascii = (i, n) => String.fromCharCode(...bytes.slice(i, i + n));
  if (bytes.length < 26) {
    return null;
  }
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
    return { width: u32be(16), height: u32be(20) };
  }
  if (ascii(0, 3) === "GIF") {
    return { width: u16le(6), height: u16le(8) };
  }
  if (ascii(0, 2) === "BM") {
    const height = bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24);
    return { width: u16le(18) + (bytes[20] << 16), height: Math.abs(height) };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 " && bytes.length >= 30) {
      return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes.length >= 25) {
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | bytes[21]),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (chunk === "VP8X" && bytes.length >= 30) {
      return { width: 1 + u24le(24), height: 1 + u24le(27) };
    }
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      // SOF0–SOF15（排除 DHT C4、JPG C8、DAC CC）記錄影像寬高
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(i + 7), height: u16be(i + 5) };
      }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

async function readImageInfo(file) {
  const buffer = await file.read({ format: formats.binary });
  const bytes = new Uint8Array(buffer);
  const size = readImageSize(bytes);
  return {
    url: `data:${imageMimeType(file.name)};base64,${arrayBufferToBase64(buffer)}`,
    width: size ? size.width : 0,
    height: size ? size.height : 0,
  };
}

/**
 * 替換智慧型物件內容，並把新圖等比縮放塞回原本圖層的框內、置中，
 * 所以位置與大小都和原稿一致。
 */
async function replaceLayerImage(layer, imageFile) {
  if (!isSmartObject(layer)) {
    throw new Error(`${layer.name} 不是智慧型物件，無法替換圖片`);
  }
  const before = boundsBox(layer);
  await selectOnlyLayer(layer);
  const token = localFileSystem.createSessionToken(imageFile);
  await action.batchPlay(
    [{ _obj: "placedLayerReplaceContents", null: { _path: token, _kind: "local" } }],
    { synchronousExecution: true },
  );
  const after = boundsBox(layer);
  const scale = Math.min(before.width / after.width, before.height / after.height);
  await scaleLayerUniform(layer, Math.max(scale, 0.01));
  const fitted = boundsBox(layer);
  await translateLayer(
    layer,
    before.centerX - fitted.centerX,
    before.centerY - fitted.centerY,
  );
}

// 每一組：複製原始 PSD → 換圖 → 另存 → 關閉副本（不修改原稿）
async function generateApplyDocuments(master, sets) {
  if (!isDocumentOpen(master)) {
    throw new Error("母版已關閉，請重新開啟或上傳母版。");
  }
  const folder = await localFileSystem.getFolder();
  if (!folder) {
    return 0;
  }
  const errors = [];
  let done = 0;
  for (const set of sets) {
    try {
      const file = await folder.createFile(set.name, { overwrite: true });
      await runModal(async () => {
        app.activeDocument = master;
        const copy = await master.duplicate(stripExtension(set.name));
        app.activeDocument = copy;
        try {
          const container = getMcdSourceContainer(copy, applyRequiredLayers());
          for (const name of Object.keys(set.files)) {
            const layer = findNamedLayer(container, name);
            if (!layer) {
              throw new Error(`找不到圖層 ${name}`);
            }
            await replaceLayerImage(layer, set.files[name]);
          }
          await saveDocumentAsPsd(copy, file);
        } finally {
          await closeDocumentQuietly(copy);
        }
      }, `產製 ${set.name}`);
      done += 1;
    } catch (error) {
      errors.push(`${set.name}：${error.message || error}`);
    }
  }
  try {
    await activateDocument(master);
  } catch (_error) {
    // 母版可能已被關閉
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  return done;
}

function createApplyWorkspace(root) {
  const el = (role) => root.querySelector(`[data-role="${role}"]`);
  const stage = el("preview-stage");
  const templatePicker = el("template-picker");
  const templateNameInput = el("template-name");
  const outputPicker = el("output-picker");
  const layerToggle = el("layer-toggle");
  const layerPanel = el("layer-panel");
  const srcInput = el("src-path");
  const requiredDialog = el("required-dialog");

  // UXP 不支援 z-index，後出現的元素會蓋在前面：把下拉清單移到分頁最後，
  // 打開時再依按鈕位置定位，才不會被下方的 src 輸入框等元素蓋住
  root.appendChild(layerPanel);

  const state = {
    master: null,
    templateIndex: 0,
    draft: null,
    previewCache: null,
    frames: null,
    sets: [],
    outputIndex: 0,
    imageUrls: {},
    loading: false,
    previewError: "",
  };

  const workspace = { root, open, show, commit: commitSettings };

  // ----- 目前選取 -----

  function templates() {
    return moduleStore.applyTemplates;
  }

  function currentTemplate() {
    return state.templateIndex < 0 ? state.draft : templates()[state.templateIndex] || null;
  }

  function isDraftSelected() {
    return state.templateIndex < 0 && Boolean(state.draft);
  }

  function pickerOffset() {
    return state.draft ? 1 : 0;
  }

  function clampSelection() {
    if (state.templateIndex < 0 && state.draft) {
      return;
    }
    const count = templates().length;
    state.templateIndex = count ? Math.min(Math.max(state.templateIndex, 0), count - 1) : 0;
  }

  function setStatus(text) {
    el("preview-status").textContent = text;
  }

  function masterNeedsTemplate() {
    return (
      isDocumentOpen(state.master) &&
      Boolean(validApplyMasterOrNull(state.master)) &&
      findTemplateIndexIn(templates(), state.master) < 0
    );
  }

  // 目前母版有的圖層（預覽量測後才知道）
  function presentLayers() {
    return state.frames ? Object.keys(state.frames.frames) : APPLY_LAYER_NAMES;
  }

  function updateTemplateHint() {
    el("template-hint").style.display = masterNeedsTemplate() ? "block" : "none";
  }

  // ----- 設定（勾選圖層、圖檔 src）-----

  function checkedLayers() {
    return APPLY_LAYER_NAMES.filter((name) => {
      const box = layerPanel.querySelector(`[data-layer-name="${name}"]`);
      return box && box.checked;
    });
  }

  function updateLayerToggleLabel() {
    const layers = checkedLayers();
    layerToggle.textContent = layers.length ? layers.join("、") : "（尚未勾選圖層）";
  }

  function loadSettings() {
    const template = currentTemplate();
    const layers = template ? template.layers : [];
    const present = presentLayers();
    layerPanel.querySelectorAll("[data-layer-name]").forEach((box) => {
      const name = box.getAttribute("data-layer-name");
      box.checked = layers.includes(name);
      // PSD 沒有的圖層不能套圖
      box.disabled = !present.includes(name);
      box.parentElement.classList.toggle("is-missing", box.disabled);
    });
    srcInput.value = template ? template.srcPath : "";
    updateLayerToggleLabel();
  }

  function commitSettings() {
    const template = currentTemplate();
    if (!template) {
      return;
    }
    template.layers = checkedLayers();
    template.srcPath = srcInput.value.trim();
  }

  function resetOutputs() {
    state.sets = [];
    state.outputIndex = 0;
    renderOutputPicker();
  }

  // ----- 下拉選單 -----

  function renderTemplatePicker() {
    const names = templates().map((template) => template.name || "（未命名模組）");
    const labels = state.draft ? [state.draft.label, ...names] : names;
    fillPicker(templatePicker, labels);
    if (labels.length) {
      setPickerIndex(templatePicker, state.templateIndex + pickerOffset());
    }
    updateTemplateHint();
  }

  // 「預設」＝原稿；按「預覽套圖」後列出 套圖01.psd、套圖02.psd…
  function renderOutputPicker() {
    fillPicker(outputPicker, ["預設", ...state.sets.map((set) => set.name)]);
    setPickerIndex(outputPicker, state.outputIndex);
  }

  function renderAll() {
    clampSelection();
    renderTemplatePicker();
    renderOutputPicker();
    loadSettings();
    renderPreview();
  }

  // ----- 預覽：圖層照原稿位置擺放，勾選圖層換成目前這一組的圖 -----

  function stageAspect() {
    return state.frames ? state.frames.height / state.frames.width : 1;
  }

  function resizeStage() {
    stage.style.height = `${stage.clientWidth * stageAspect()}px`;
  }

  function currentSet() {
    return state.outputIndex > 0 ? state.sets[state.outputIndex - 1] || null : null;
  }

  /**
   * 換上的圖等比塞進原圖層的框並置中（與產出時的處理相同），全部用畫布百分比計算：
   *   框寬高(px) = 框% × 原稿畫布寬高
   *   縮放 = min(框寬 ÷ 圖寬, 框高 ÷ 圖高)
   * 讀不到圖的寬高時，直接用框的位置與寬度。
   */
  function containedRect(frame, info) {
    const canvasW = state.frames.width;
    const canvasH = state.frames.height;
    const boxW = (frame.width / 100) * canvasW;
    const boxH = (frame.height / 100) * canvasH;
    if (!(info.width > 0 && info.height > 0 && boxW > 0 && boxH > 0)) {
      return { left: frame.left, top: frame.top, width: frame.width };
    }
    const scale = Math.min(boxW / info.width, boxH / info.height);
    const w = info.width * scale;
    const h = info.height * scale;
    return {
      left: frame.left + (((boxW - w) / 2) / canvasW) * 100,
      top: frame.top + (((boxH - h) / 2) / canvasH) * 100,
      width: (w / canvasW) * 100,
    };
  }

  function imageKey(file) {
    return file.nativePath || file.name;
  }

  // 先把這一組要換的圖全部讀好，再一次畫出來（避免逐張閃爍）
  async function preloadSet(set) {
    if (!set) {
      return;
    }
    for (const file of Object.values(set.files)) {
      const key = imageKey(file);
      if (state.imageUrls[key]) {
        continue;
      }
      try {
        state.imageUrls[key] = await readImageInfo(file);
      } catch (error) {
        setStatus(`無法讀取 ${file.name}：${error.message || error}`);
      }
    }
  }

  async function showOutput(index) {
    state.outputIndex = index;
    await preloadSet(currentSet());
    if (state.outputIndex === index) {
      renderPreview();
    }
  }

  function showStageMessage(text) {
    const message = document.createElement("div");
    message.className = "stage-message";
    message.textContent = text;
    stage.appendChild(message);
  }

  function renderPreview() {
    stage.innerHTML = "";
    // 只用目前母版的擷取結果，避免換 PSD 時閃出上一份的圖
    const cache =
      state.previewCache && state.master && state.previewCache.masterId === state.master.id
        ? state.previewCache
        : null;
    if (state.frames) {
      resizeStage();
    }
    if (!cache || !state.frames) {
      if (state.loading) {
        showStageMessage("預覽擷取中，請稍候…");
      } else if (state.previewError) {
        showStageMessage(state.previewError);
      }
      return;
    }
    const set = currentSet();
    cache.order.forEach((name) => {
      const frame = state.frames.frames[name];
      if (!frame) {
        return;
      }
      const img = document.createElement("img");
      img.className = "preview-layer";
      img.style.left = `${frame.left}%`;
      img.style.top = `${frame.top}%`;
      img.style.width = `${frame.width}%`;
      const replacement = set && set.files[name];
      const info = replacement && state.imageUrls[imageKey(replacement)];
      if (info) {
        // 圖已預先讀好，寬高也已知：直接定位顯示
        const rect = containedRect(frame, info);
        img.classList.add("is-replaced");
        img.style.left = `${rect.left}%`;
        img.style.top = `${rect.top}%`;
        img.style.width = `${rect.width}%`;
        img.src = info.url;
      } else {
        img.src = cache.images[name].dataUrl;
      }
      stage.appendChild(img);
    });
  }

  async function refreshPreview(force) {
    const master = state.master;
    if (!isDocumentOpen(master)) {
      state.previewCache = null;
      renderPreview();
      setStatus("請按「上傳.psd」或開啟母版後再按「開始執行」。");
      return;
    }
    try {
      state.frames = measureLayerFrames(master, applyRequiredLayers());
    } catch (error) {
      state.frames = null;
      state.previewError = `${error.message || error}（可按「必選」調整必須有的圖層）`;
      renderPreview();
      setStatus(state.previewError);
      return;
    }
    loadSettings();
    if (!force && state.previewCache && state.previewCache.masterId === master.id) {
      renderPreview();
      return;
    }
    setStatus("擷取圖層中，請稍候…");
    state.loading = true;
    renderPreview();
    try {
      const cache = await getPreviewCache(master, force, applyRequiredLayers());
      if (state.master !== master) {
        return;
      }
      state.previewCache = cache;
      state.loading = false;
      state.previewError = "";
      renderPreview();
      if (cache.failed && cache.failed.length) {
        setStatus(`部分圖層無法預覽（${cache.failed.join("；")}）`);
      } else if (!state.sets.length) {
        setStatus(`預覽來源：${master.name}`);
      }
    } catch (error) {
      state.previewCache = null;
      state.loading = false;
      state.previewError = `預覽擷取失敗：${describeModalError(error)}`;
      renderPreview();
      setStatus(state.previewError);
    }
  }

  // ----- 儲存 -----

  async function persist(message, toast) {
    try {
      await saveModuleStore();
      notifyModuleStoreChanged(workspace);
      setStatus(message);
      if (toast) {
        await showToast(toast);
      }
      return true;
    } catch (error) {
      await app.showAlert(`module.json 寫入失敗：${error.message || error}`);
      return false;
    }
  }

  // ----- 模組 -----

  function suggestTemplate(doc) {
    const name = suggestTemplateName(doc);
    state.draft = {
      name,
      label: `${stripExtension(doc.name)}（未新增）`,
      draftFor: doc.id,
      layers: [],
      srcPath: "",
    };
    state.templateIndex = -1;
    resetOutputs();
    renderAll();
    templateNameInput.value = name;
    templateNameInput.classList.add("is-suggested");
    setStatus(`${doc.name} 尚未建立套圖模組，確認名稱後按「新增」。`);
  }

  function selectTemplate(index) {
    commitSettings();
    state.templateIndex = index;
    clampSelection();
    const sourceDoc = findOpenDocumentForTemplate(currentTemplate());
    if (sourceDoc && validApplyMasterOrNull(sourceDoc)) {
      state.master = sourceDoc;
    }
    resetOutputs();
    loadSettings();
    refreshPreview(false);
  }

  async function uploadPsd() {
    if (masterNeedsTemplate()) {
      await app.showAlert("請點選新增模組");
      return;
    }
    let file;
    try {
      file = await localFileSystem.getFileForOpening({ types: ["psd", "psb"] });
    } catch (error) {
      await app.showAlert(`無法選擇檔案：${error.message || error}`);
      return;
    }
    if (!file) {
      return;
    }
    try {
      const doc = await openPsdAsMaster(file);
      const problem = applyMasterProblem(doc);
      if (problem) {
        throw new Error(problem);
      }
      state.master = doc;
      const existing = findTemplateIndexIn(templates(), doc);
      if (existing >= 0) {
        state.draft = null;
        state.templateIndex = existing;
        templateNameInput.value = "";
        templateNameInput.classList.remove("is-suggested");
        resetOutputs();
        renderAll();
        setStatus(`${doc.name} 已有套圖模組「${templates()[existing].name}」。`);
      } else {
        suggestTemplate(doc);
      }
      await refreshPreview(false);
    } catch (error) {
      await app.showAlert(error.message || String(error));
    }
  }

  async function addTemplate() {
    const name = templateNameInput.value.trim();
    if (!name) {
      templateNameInput.classList.add("is-invalid");
      setStatus("請輸入模組名稱。");
      return;
    }
    if (templates().some((template) => template.name === name)) {
      templateNameInput.classList.add("is-invalid");
      setStatus(`模組「${name}」已存在。`);
      return;
    }
    if (!isDocumentOpen(state.master)) {
      setStatus("請先按「上傳.psd」選擇母版。");
      return;
    }
    commitSettings();
    const draft = state.draft && state.draft.draftFor === state.master.id ? state.draft : null;
    templates().push({
      name,
      source: { fileName: state.master.name, path: readDocumentPath(state.master) },
      layers: draft ? draft.layers : [],
      srcPath: draft ? draft.srcPath : "",
    });
    state.draft = null;
    state.templateIndex = templates().length - 1;
    templateNameInput.value = "";
    templateNameInput.classList.remove("is-invalid", "is-suggested");
    renderAll();
    await persist(`已新增套圖模組「${name}」`, "成功新增模組");
  }

  const templateManager = createListManager(
    {
      prefix: "template-manager",
      title: "編輯套圖模組",
      emptyLabel: "（未命名模組）",
      listItems: () => templates(),
      getName: (template) => template.name,
      setName: (template, name) => {
        template.name = name;
      },
      isSameName: (a, b) => a === b,
      remove: (template) => {
        const index = templates().indexOf(template);
        if (index < 0) {
          return;
        }
        templates().splice(index, 1);
        if (state.templateIndex > index || state.templateIndex >= templates().length) {
          state.templateIndex = Math.max(state.templateIndex - 1, 0);
        }
      },
      afterChange: renderAll,
      deletedMessage: (template) => `已刪除套圖模組「${template.name}」`,
    },
    { el, beforeOpen: commitSettings, persist },
  );

  // ----- 圖檔資料夾與預覽套圖 -----

  async function pickSrcFolder() {
    let folder;
    try {
      folder = await localFileSystem.getFolder();
    } catch (error) {
      await app.showAlert(`無法選擇資料夾：${error.message || error}`);
      return;
    }
    if (!folder) {
      return;
    }
    const path = folder.nativePath;
    try {
      rememberSrcFolder(path, await localFileSystem.createPersistentToken(folder));
    } catch (_error) {
      // 無法記住授權，下次需要再選一次
    }
    srcInput.value = path;
    commitSettings();
    resetOutputs();
    renderPreview();
  }

  async function buildSets() {
    const template = currentTemplate();
    const present = presentLayers();
    const layers = template ? template.layers.filter((name) => present.includes(name)) : [];
    if (!layers.length) {
      await app.showAlert("請先在「圖層」勾選要套圖的圖層（PSD 裡要有這個圖層）。");
      return null;
    }
    if (!template.srcPath) {
      await app.showAlert("請輸入圖檔 src 或按「選擇資料夾」。");
      return null;
    }
    const folder = await resolveSrcFolder(template.srcPath);
    if (!folder) {
      await app.showAlert("找不到圖檔資料夾（或 Photoshop 不允許直接讀取這個路徑），請按「選擇資料夾」選一次。");
      return null;
    }
    const { sets, perLayer } = await collectApplySets(folder, layers);
    const summary = layers
      .map((name) => `${name} ${perLayer[name].length} 張`)
      .join("、");
    if (!sets.length) {
      await app.showAlert(`資料夾裡找不到圖檔（${summary}）。子資料夾名稱需為圖層名去掉 $，例如 PROD、CTA。`);
      return null;
    }
    return { sets, summary };
  }

  async function previewApply() {
    commitSettings();
    const result = await buildSets();
    if (!result) {
      return;
    }
    state.sets = result.sets;
    state.outputIndex = 1;
    renderOutputPicker();
    await showOutput(1);
    setStatus(
      `找到 ${result.sets.length} 組（${result.summary}）${state.loading ? "，預覽擷取中…" : ""}`,
    );
  }

  // ----- 必選：PSD 必須有哪些圖層（沒勾的可以不存在）-----

  async function openRequiredDialog() {
    const required = applyRequiredLayers();
    requiredDialog.querySelectorAll("[data-required-name]").forEach((box) => {
      box.checked = required.includes(box.getAttribute("data-required-name"));
    });
    if (!(await showDialog(requiredDialog, "必選圖層"))) {
      return;
    }
    moduleStore.applyRequiredLayers = APPLY_LAYER_NAMES.filter((name) => {
      const box = requiredDialog.querySelector(`[data-required-name="${name}"]`);
      return box && box.checked;
    });
    await persist("已儲存必選圖層", "已儲存必選圖層");
    // 用新的必選條件重新檢查：目前的母版、或 Photoshop 作用中的文件
    const candidate = isDocumentOpen(state.master) ? state.master : app.activeDocument;
    const doc = validApplyMasterOrNull(candidate);
    if (doc) {
      open(doc, "");
      refreshPreview(true);
    } else if (candidate) {
      setStatus(applyMasterProblem(candidate));
    }
  }

  // ----- 事件 -----

  templatePicker.addEventListener("change", (event) => {
    selectTemplate(readPickerIndex(event) - pickerOffset());
  });
  el("btn-required").addEventListener("click", openRequiredDialog);
  el("btn-required-save").addEventListener("click", () => requiredDialog.close("confirm"));
  el("btn-required-cancel").addEventListener("click", () => requiredDialog.close("cancel"));
  outputPicker.addEventListener("change", (event) => {
    showOutput(readPickerIndex(event));
  });
  templateNameInput.addEventListener("input", () => {
    templateNameInput.classList.remove("is-invalid", "is-suggested");
  });

  // 圖層下拉：點按鈕展開勾選清單，點外面收起
  layerToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (layerPanel.style.display === "block") {
      layerPanel.style.display = "none";
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const rect = layerToggle.getBoundingClientRect();
    layerPanel.style.left = `${rect.left - rootRect.left}px`;
    layerPanel.style.top = `${rect.bottom - rootRect.top + 2}px`;
    layerPanel.style.width = `${rect.width}px`;
    layerPanel.style.display = "block";
  });
  layerPanel.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => {
    layerPanel.style.display = "none";
  });
  layerPanel.querySelectorAll("[data-layer-name]").forEach((box) => {
    box.addEventListener("change", () => {
      updateLayerToggleLabel();
      commitSettings();
      resetOutputs();
      renderPreview();
    });
  });
  srcInput.addEventListener("change", () => {
    commitSettings();
    resetOutputs();
    renderPreview();
  });

  el("btn-upload-psd").addEventListener("click", uploadPsd);
  el("btn-add-template").addEventListener("click", addTemplate);
  el("btn-manage-templates").addEventListener("click", () => templateManager.open());
  el("btn-refresh-preview").addEventListener("click", () => refreshPreview(true));
  el("btn-pick-src").addEventListener("click", pickSrcFolder);
  el("btn-preview-apply").addEventListener("click", previewApply);

  el("btn-save-setting").addEventListener("click", async () => {
    commitSettings();
    if (isDraftSelected()) {
      await app.showAlert("請點選新增模組");
      return;
    }
    await persist("已儲存套圖設定", "成功儲存設定值");
  });

  el("btn-start-generate").addEventListener("click", async () => {
    commitSettings();
    if (isDraftSelected()) {
      await app.showAlert("請點選新增模組");
      return;
    }
    if (!state.sets.length) {
      const result = await buildSets();
      if (!result) {
        return;
      }
      state.sets = result.sets;
      state.outputIndex = 1;
      renderOutputPicker();
      await showOutput(1);
    }
    if (!(await persist("設定已儲存"))) {
      return;
    }
    try {
      const done = await whilePhotoshopBusy(() => generateApplyDocuments(state.master, state.sets));
      if (done) {
        setStatus(`已產出 ${done} 個套圖檔案`);
        await showToast(`已產出 ${done} 個套圖檔案`);
      }
    } catch (error) {
      await app.showAlert(`套圖產製失敗：${error.message || error}`);
    }
  });

  el("btn-cancel-settings").addEventListener("click", () => {
    closeResizeSettingsPanel();
  });

  window.addEventListener("resize", () => {
    if (root.style.display !== "none") {
      renderPreview();
    }
  });

  onModuleStoreChanged((source) => {
    if (source === workspace) {
      return;
    }
    renderAll();
  });

  // ----- 對外 -----

  function open(master, note) {
    if (!master || !state.master || master.id !== state.master.id) {
      state.previewCache = null;
      state.frames = null;
    }
    state.master = master;
    state.draft = null;
    const existing = master ? findTemplateIndexIn(templates(), master) : -1;
    state.templateIndex = Math.max(existing, 0);
    templateNameInput.value = "";
    templateNameInput.classList.remove("is-invalid", "is-suggested");
    resetOutputs();
    renderAll();
    setStatus(note || "");
    if (master && existing < 0) {
      suggestTemplate(master);
    }
  }

  function show() {
    if (!isDocumentOpen(state.master)) {
      state.master = validApplyMasterOrNull(app.activeDocument);
    }
    if (!state.master) {
      return;
    }
    refreshPreview(false);
  }

  return workspace;
}

// ---------- 分頁與面板 ----------

const workspaces = {
  resize: createResizeWorkspace(document.querySelector('[data-workspace="resize"]')),
  apply: createApplyWorkspace(document.querySelector('[data-workspace="apply"]')),
};
let activeTab = "resize";

function selectTab(name) {
  activeTab = name;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.getAttribute("data-tab") === name);
  });
  Object.keys(workspaces).forEach((key) => {
    workspaces[key].root.style.display = key === name ? "block" : "none";
  });
  workspaces[name].show();
}

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    selectTab(button.getAttribute("data-tab"));
  });
});

function updateModuleFolderLabel() {
  const label = document.getElementById("module-folder-label");
  label.textContent = moduleStore.folder
    ? `module.json：${moduleStore.folder.nativePath}`
    : "module.json：尚未選擇資料夾（儲存時會詢問）";
}

onModuleStoreChanged(updateModuleFolderLabel);

// ---------- module.json 編輯視窗 ----------

/**
 * 驗證使用者改寫的 JSON：需為 { "templates": [...] }，每個模組要有不重複的名稱。
 * 數值欄位經 normalizeTemplate 補齊，錯誤時丟出可讀的訊息。
 */
function parseModuleJsonText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 格式錯誤：${error.message}`);
  }
  if (!data || !Array.isArray(data.templates)) {
    throw new Error("最外層需為 { \"templates\": [ ... ] }");
  }
  const names = new Set();
  const templates = data.templates.map((raw, index) => {
    const template = normalizeTemplate(raw);
    if (!template || !template.name) {
      throw new Error(`第 ${index + 1} 個模組缺少 name`);
    }
    if (names.has(template.name)) {
      throw new Error(`模組名稱重複：${template.name}`);
    }
    names.add(template.name);
    return template;
  });
  const applyNames = new Set();
  const applyTemplates = (Array.isArray(data.applyTemplates) ? data.applyTemplates : []).map(
    (raw, index) => {
      const template = normalizeApplyTemplate(raw);
      if (!template || !template.name) {
        throw new Error(`applyTemplates 第 ${index + 1} 個模組缺少 name`);
      }
      if (applyNames.has(template.name)) {
        throw new Error(`套圖模組名稱重複：${template.name}`);
      }
      applyNames.add(template.name);
      return template;
    },
  );
  return {
    templates,
    applyTemplates,
    applyRequiredLayers: normalizeRequiredLayers(data.applyRequiredLayers),
    reference: normalizeReference(data.reference),
  };
}

const jsonEditor = {
  dialog: document.getElementById("json-editor-dialog"),
  text: document.getElementById("json-editor-text"),
  error: document.getElementById("json-editor-error"),
  editView: document.getElementById("json-editor-edit-view"),
  confirmView: document.getElementById("json-editor-confirm-view"),
  pending: null,
};

function showJsonEditorView(confirm) {
  jsonEditor.editView.style.display = confirm ? "none" : "block";
  jsonEditor.confirmView.style.display = confirm ? "block" : "none";
}

async function openJsonEditor() {
  await ensureModuleStore();
  // 面板上尚未寫回的欄位先寫進資料，編輯視窗才會看到最新數值
  Object.keys(workspaces).forEach((key) => workspaces[key].commit());
  jsonEditor.text.value = JSON.stringify(moduleFileContent(), null, 2);
  jsonEditor.error.textContent = "";
  jsonEditor.pending = null;
  showJsonEditorView(false);
  showDialog(jsonEditor.dialog, "編輯 module.json", {
    resize: "both",
    size: { width: 640, height: 540 },
  });
}

document.getElementById("btn-edit-module-json").addEventListener("click", openJsonEditor);

document.getElementById("btn-json-cancel").addEventListener("click", () => {
  jsonEditor.dialog.close("cancel");
});

document.getElementById("btn-json-save").addEventListener("click", () => {
  try {
    jsonEditor.pending = parseModuleJsonText(jsonEditor.text.value);
  } catch (error) {
    jsonEditor.error.textContent = error.message || String(error);
    return;
  }
  jsonEditor.error.textContent = "";
  showJsonEditorView(true);
});

document.getElementById("btn-json-confirm-cancel").addEventListener("click", () => {
  jsonEditor.pending = null;
  showJsonEditorView(false);
});

document.getElementById("btn-json-confirm-ok").addEventListener("click", async () => {
  const pending = jsonEditor.pending;
  if (!pending) {
    return;
  }
  const previous = {
    templates: moduleStore.templates,
    applyTemplates: moduleStore.applyTemplates,
    applyRequiredLayers: moduleStore.applyRequiredLayers,
    reference: moduleStore.reference,
  };
  moduleStore.templates = pending.templates;
  moduleStore.applyTemplates = pending.applyTemplates;
  moduleStore.applyRequiredLayers = pending.applyRequiredLayers;
  moduleStore.reference = pending.reference;
  try {
    await saveModuleStore();
  } catch (error) {
    moduleStore.templates = previous.templates;
    moduleStore.applyTemplates = previous.applyTemplates;
    moduleStore.applyRequiredLayers = previous.applyRequiredLayers;
    moduleStore.reference = previous.reference;
    jsonEditor.error.textContent = `寫入失敗：${error.message || error}`;
    showJsonEditorView(false);
    return;
  }
  jsonEditor.pending = null;
  jsonEditor.dialog.close("save");
  notifyModuleStoreChanged(null);
  await showToast("已儲存 module.json");
});

async function openResizeSettingsPanel() {
  await ensureModuleStore();

  const active = app.activeDocument;
  const master = validMasterOrNull(active);
  let note = "";
  if (active && !master) {
    try {
      requireMcdSmartLayers(getMcdSourceContainer(active));
    } catch (error) {
      note = `${error.message || error}；請按「上傳.psd」選擇母版。`;
    }
  }

  if (master) {
    await captureReferenceIfNeeded(master);
  }
  workspaces.resize.open(master, note);
  const applyMaster = validApplyMasterOrNull(active);
  workspaces.apply.open(applyMaster, active && !applyMaster ? applyMasterProblem(active) : "");
  updateModuleFolderLabel();
  document.getElementById("btn-resize-1200x629").style.display = "none";
  document.getElementById("resize-settings-panel").style.display = "block";
  selectTab(activeTab);
}

function closeResizeSettingsPanel() {
  document.getElementById("resize-settings-panel").style.display = "none";
  document.getElementById("btn-resize-1200x629").style.display = "";
}

document.getElementById("btn-resize-1200x629").addEventListener("click", () => {
  openResizeSettingsPanel();
});

document
  .getElementById("btn-change-module-folder")
  .addEventListener("click", async () => {
    await changeModuleFolder();
    updateModuleFolderLabel();
  });

const btnOpenCsv = document.getElementById("btn-open-csv");
const btnGenBanner1 = document.getElementById("btn-gen-banner1");

btnOpenCsv && btnOpenCsv.addEventListener("click", async () => {
  try {
    const text = await readCsvText();
    if (text === null) {
      return;
    }

    const jobs = parseCsvJobs(text);
    if (!jobs.length) {
      await app.showAlert(
        "CSV 中找不到有效資料。第一欄需為尺寸（例如 300x300）。",
      );
      return;
    }

    await createArtboardDocumentFromCsvJobs(jobs);
  } catch (error) {
    await app.showAlert(`開檔失敗：${error.message || error}`);
  }
});

btnGenBanner1 &&
  btnGenBanner1.addEventListener("click", async () => {
    const master = app.activeDocument;
    if (!master) {
      await app.showAlert("請先開啟帶有標準圖層命名的 PSD 母版。");
      return;
    }

    let sourceLayers;
    try {
      sourceLayers = requireBannerLayers(master);
    } catch (error) {
      await app.showAlert(error.message || String(error));
      return;
    }

    try {
      const text = await readCsvText("input-banner-csv");
      if (text === null) {
        return;
      }

      const jobs = parseCsvSizes(text);
      if (!jobs.length) {
        await app.showAlert("CSV 中找不到尺寸（例如 300x300）。");
        return;
      }

      const masterSize = {
        width: unitNumber(master.width),
        height: unitNumber(master.height),
      };

      const errors = [];
      for (const job of jobs) {
        try {
          // 同一 modal 內完成「開檔 + 排版」，避免巢狀 executeAsModal 讓後續尺寸中斷
          await core.executeAsModal(
            async () => {
              const newDoc = await createBannerCanvasFromMaster(
                master,
                sourceLayers,
                job.width,
                job.height,
              );
              await applyBannerLayout(
                newDoc,
                job.width,
                job.height,
                masterSize,
              );
            },
            { commandName: `產製 ${job.width}x${job.height}` },
          );
        } catch (error) {
          errors.push(`${job.width}x${job.height}：${error.message || error}`);
        }
      }

      if (errors.length) {
        await app.showAlert(`部分尺寸失敗：\n${errors.join("\n")}`);
      }
    } catch (error) {
      await app.showAlert(`Banner 產製失敗：${error.message || error}`);
    }
  });

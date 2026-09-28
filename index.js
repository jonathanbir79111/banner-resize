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
// 可於面板中調整,故用 let 而非 const；使用者按「儲存」後會直接覆寫這裡的數值。
let RESIZE_1200x629 = {
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

// 程式碼內的預設值快照；「還原預設值」以此為準
const RESIZE_1200x629_DEFAULTS = JSON.parse(JSON.stringify(RESIZE_1200x629));
const RESIZE_SETTINGS_FILE = "resize-1200x629-settings.json";

function serializeResizeSettings() {
  const out = {};
  for (const variant of RESIZE_1200x629.variants) {
    out[variant.outputDocument] = {};
    for (const name of MCD_POSITION_ELEMENT_NAMES) {
      const spec = variant.elements[name];
      out[variant.outputDocument][name] = {
        leftPercent: spec.leftPercent,
        topPercent: spec.topPercent,
        widthPercent: spec.widthPercent,
      };
    }
  }
  return out;
}

function applySavedResizeSettings(saved) {
  if (!saved || typeof saved !== "object") {
    return;
  }
  for (const variant of RESIZE_1200x629.variants) {
    const savedVariant = saved[variant.outputDocument];
    if (!savedVariant) {
      continue;
    }
    for (const name of MCD_POSITION_ELEMENT_NAMES) {
      const savedSpec = savedVariant[name];
      if (!savedSpec) {
        continue;
      }
      for (const key of ["leftPercent", "topPercent", "widthPercent"]) {
        if (Number.isFinite(savedSpec[key])) {
          variant.elements[name][key] = savedSpec[key];
        }
      }
    }
  }
}

async function saveResizeSettingsToFile() {
  const folder = await localFileSystem.getDataFolder();
  const file = await folder.createFile(RESIZE_SETTINGS_FILE, {
    overwrite: true,
  });
  await file.write(JSON.stringify(serializeResizeSettings(), null, 2));
}

async function loadResizeSettingsFromFile() {
  try {
    const folder = await localFileSystem.getDataFolder();
    const file = await folder.getEntry(RESIZE_SETTINGS_FILE);
    applySavedResizeSettings(JSON.parse(await file.read()));
  } catch (_error) {
    // 尚未儲存過或檔案損毀，沿用程式碼預設值
  }
}

async function resetResizeSettingsToDefaults() {
  RESIZE_1200x629 = JSON.parse(JSON.stringify(RESIZE_1200x629_DEFAULTS));
  await saveResizeSettingsToFile();
}

function findNamedLayer(container, name) {
  return (
    findLayerByName(container, name) ||
    findLayerByName(container, `${name} copy`) ||
    findLayerByName(container, `${name} 拷貝`)
  );
}

function requireMcdSmartLayers(container) {
  const layers = {};
  const missing = [];
  for (const name of MCD_SMART_LAYER_NAMES) {
    const layer = findNamedLayer(container, name);
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

function getMcdSourceContainer(doc) {
  const boards = listArtboards(doc);
  for (const board of boards) {
    try {
      requireMcdSmartLayers(board);
      return board;
    } catch (_error) {
      // 不完整的工作區域略過，改找下一層或整份文件
    }
  }
  return doc;
}

function listMcdLayersBottomToTop(container, sourceLayers) {
  const wantedIds = new Set(
    MCD_SMART_LAYER_NAMES.map((name) => sourceLayers[name].id),
  );
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
  for (const name of MCD_SMART_LAYER_NAMES) {
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
) {
  const newDoc = await app.createDocument({
    width,
    height,
    resolution: 72,
    mode: constants.NewDocumentMode.RGB,
    fill: constants.DocumentFill.WHITE,
    name,
  });

  const bottomToTop = listMcdLayersBottomToTop(
    getMcdSourceContainer(master),
    sourceLayers,
  );
  for (const layer of bottomToTop) {
    await master.duplicateLayers([layer], newDoc);
  }

  app.activeDocument = newDoc;
  return newDoc;
}

async function layoutSmartByPercents(layer, canvasW, canvasH, spec) {
  const targetW = (canvasW * spec.widthPercent) / 100;
  const targetLeft = (canvasW * spec.leftPercent) / 100;
  const targetTop = (canvasH * spec.topPercent) / 100;

  // 只以寬度決定縮放，高度隨原始比例等比跟著變
  const src = boundsBox(layer);
  const scale = targetW / src.width;
  await scaleLayerUniform(layer, Math.max(scale, 0.01));

  const fitted = boundsBox(layer);
  await translateLayer(layer, targetLeft - fitted.left, targetTop - fitted.top);
}

async function applyResize1200x629Layout(doc, variant) {
  const canvasW = RESIZE_1200x629.width;
  const canvasH = RESIZE_1200x629.height;
  const layers = requireMcdSmartLayers(doc);

  await layoutObjectFitCover(layers.$BG, canvasW, canvasH);

  for (const name of ["$LOGO", "$HEAD", "$PROD", "$SM", "$CTA"]) {
    await layoutSmartByPercents(
      layers[name],
      canvasW,
      canvasH,
      variant.elements[name],
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

/**
 * 依 左字右圖~03 規格，從母版複製六個智慧物件，另存 3 份 1200x629 PSD。
 * 母版須含 $BG $PROD $HEAD $LOGO $SM $CTA；不修改母版、不使用工作區域。
 */
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

async function resizeTo1200x629(master) {
  if (!isDocumentOpen(master)) {
    throw new Error("母版已關閉，請重新開啟母版後再按「開始執行」。");
  }
  app.activeDocument = master;

  const sourceContainer = getMcdSourceContainer(master);
  const sourceLayers = requireMcdSmartLayers(sourceContainer);

  const folder = await localFileSystem.getFolder();
  if (!folder) {
    return;
  }

  const jobs = [];
  for (const variant of RESIZE_1200x629.variants) {
    const file = await folder.createFile(variant.outputDocument, {
      overwrite: true,
    });
    jobs.push({ variant, file });
  }

  const errors = [];
  const canvasW = RESIZE_1200x629.width;
  const canvasH = RESIZE_1200x629.height;

  for (const job of jobs) {
    const docName = job.variant.outputDocument.replace(/\.psd$/i, "");
    try {
      await core.executeAsModal(
        async () => {
          app.activeDocument = master;
          const newDoc = await createMcdDocumentFromMaster(
            master,
            sourceLayers,
            docName,
            canvasW,
            canvasH,
          );
          await applyResize1200x629Layout(newDoc, job.variant);
          await saveDocumentAsPsd(newDoc, job.file);
        },
        { commandName: `產製 ${docName}` },
      );
    } catch (error) {
      errors.push(`${job.variant.outputDocument}：${error.message || error}`);
    }
  }

  try {
    app.activeDocument = master;
  } catch (_error) {
    // 母版可能已被關閉
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
}

let resizeSettingsVariantIndex = 0;
let resizeSettingsElementName = MCD_POSITION_ELEMENT_NAMES[0];

function getResizeSettingSpec() {
  return RESIZE_1200x629.variants[resizeSettingsVariantIndex].elements[
    resizeSettingsElementName
  ];
}

function fillPicker(pickerId, labels) {
  const picker = document.getElementById(pickerId);
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
  picker.selectedIndex = 0;
}

function setPickerIndex(pickerId, index) {
  const picker = document.getElementById(pickerId);
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

function populateResizeSettingsSelectors() {
  fillPicker(
    "setting-variant",
    RESIZE_1200x629.variants.map((variant) => variant.outputDocument),
  );
  fillPicker("setting-element", MCD_POSITION_ELEMENT_NAMES);
}

function loadResizeSettingFields() {
  const spec = getResizeSettingSpec();
  document.getElementById("setting-leftPercent").value = spec.leftPercent;
  document.getElementById("setting-topPercent").value = spec.topPercent;
  document.getElementById("setting-widthPercent").value = spec.widthPercent;
}

function saveResizeSettingFields() {
  const spec = getResizeSettingSpec();
  const left = parseFloat(document.getElementById("setting-leftPercent").value);
  const top = parseFloat(document.getElementById("setting-topPercent").value);
  const width = parseFloat(
    document.getElementById("setting-widthPercent").value,
  );
  spec.leftPercent = Number.isFinite(left) ? left : spec.leftPercent;
  spec.topPercent = Number.isFinite(top) ? top : spec.topPercent;
  spec.widthPercent = Number.isFinite(width) ? width : spec.widthPercent;
}

const SETTING_STEP = 0.1;

function stepSettingInput(inputId, direction) {
  const input = document.getElementById(inputId);
  const current = parseFloat(input.value);
  const base = Number.isFinite(current) ? current : 0;
  const next = Math.min(100, Math.max(0, base + direction * SETTING_STEP));
  input.value = Math.round(next * 100) / 100;
}

document.querySelectorAll("[data-step-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const direction = button.getAttribute("data-step-dir") === "up" ? 1 : -1;
    stepSettingInput(button.getAttribute("data-step-target"), direction);
    updatePreviewFromFields();
  });
});

["setting-leftPercent", "setting-topPercent", "setting-widthPercent"].forEach(
  (id) => {
    document.getElementById(id).addEventListener("input", () => {
      updatePreviewFromFields();
    });
  },
);

// ---------- 預覽：把母版六個圖層各自匯出成 PNG，在面板內用 CSS 定位模擬排版 ----------

const PREVIEW_MAX_LAYER_WIDTH = 800;
const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

let previewCache = null;

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

async function exportLayerPreviewPng(master, layer, file) {
  const temp = await app.createDocument({
    width: unitNumber(master.width),
    height: unitNumber(master.height),
    resolution: 72,
    mode: constants.NewDocumentMode.RGB,
    fill: constants.DocumentFill.TRANSPARENT,
    name: "preview-temp",
  });

  try {
    const copies = await master.duplicateLayers([layer], temp);
    app.activeDocument = temp;
    const copy = (copies && copies[0]) || temp.layers[0];
    try {
      copy.visible = true;
    } catch (_error) {
      // 唯讀屬性略過
    }

    // 與排版邏輯同用 boundsNoEffects：把圖層拉到 (0,0) 再把畫布縮成圖層大小
    const b = readLayerBounds(copy);
    const width = Math.max(Math.round(b.right - b.left), 1);
    const height = Math.max(Math.round(b.bottom - b.top), 1);
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

async function buildPreviewCache(master) {
  const sourceContainer = getMcdSourceContainer(master);
  const sourceLayers = requireMcdSmartLayers(sourceContainer);
  const order = listMcdLayersBottomToTop(sourceContainer, sourceLayers).map(
    (layer) =>
      MCD_SMART_LAYER_NAMES.find((name) => sourceLayers[name].id === layer.id),
  );

  const tempFolder = await localFileSystem.getTemporaryFolder();
  const images = {};

  await core.executeAsModal(
    async () => {
      for (const name of MCD_SMART_LAYER_NAMES) {
        const file = await tempFolder.createFile(
          `preview-${name.replace("$", "")}.png`,
          { overwrite: true },
        );
        const size = await exportLayerPreviewPng(
          master,
          sourceLayers[name],
          file,
        );
        const buffer = await file.read({ format: formats.binary });
        images[name] = {
          ...size,
          dataUrl: `data:image/png;base64,${arrayBufferToBase64(buffer)}`,
        };
      }
      app.activeDocument = master;
    },
    { commandName: "擷取預覽圖層" },
  );

  return { masterId: master.id, order, images };
}

function setPreviewStatus(text) {
  document.getElementById("preview-status").textContent = text;
}

function readSettingFieldsAsSpec() {
  const spec = getResizeSettingSpec();
  const left = parseFloat(document.getElementById("setting-leftPercent").value);
  const top = parseFloat(document.getElementById("setting-topPercent").value);
  const width = parseFloat(
    document.getElementById("setting-widthPercent").value,
  );
  return {
    leftPercent: Number.isFinite(left) ? left : spec.leftPercent,
    topPercent: Number.isFinite(top) ? top : spec.topPercent,
    widthPercent: Number.isFinite(width) ? width : spec.widthPercent,
  };
}

function applyPreviewElementStyle(name, spec) {
  const img = document.getElementById(`preview-img-${name.replace("$", "")}`);
  if (!img) {
    return;
  }
  img.style.left = `${spec.leftPercent}%`;
  img.style.top = `${spec.topPercent}%`;
  img.style.width = `${spec.widthPercent}%`;
}

function applyPreviewBackgroundStyle() {
  const stage = document.getElementById("preview-stage");
  const img = document.getElementById("preview-img-BG");
  if (!img || !previewCache) {
    return;
  }
  const info = previewCache.images.$BG;
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  const scale = Math.max(stageW / info.width, stageH / info.height);
  const w = info.width * scale;
  const h = info.height * scale;
  img.style.left = `${(stageW - w) / 2}px`;
  img.style.top = `${(stageH - h) / 2}px`;
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
}

function updatePreviewHighlight() {
  for (const name of MCD_POSITION_ELEMENT_NAMES) {
    const img = document.getElementById(
      `preview-img-${name.replace("$", "")}`,
    );
    if (img) {
      img.classList.toggle("is-active", name === resizeSettingsElementName);
    }
  }
}

function resizePreviewStage() {
  const stage = document.getElementById("preview-stage");
  stage.style.height = `${
    (stage.clientWidth * RESIZE_1200x629.height) / RESIZE_1200x629.width
  }px`;
  applyPreviewBackgroundStyle();
}

function renderPreview() {
  const stage = document.getElementById("preview-stage");
  stage.innerHTML = "";
  if (!previewCache) {
    return;
  }

  const variant = RESIZE_1200x629.variants[resizeSettingsVariantIndex];
  previewCache.order.forEach((name, index) => {
    const img = document.createElement("img");
    img.id = `preview-img-${name.replace("$", "")}`;
    img.className = "preview-layer";
    img.src = previewCache.images[name].dataUrl;
    img.style.zIndex = String(index + 1);
    stage.appendChild(img);
    if (name !== "$BG") {
      img.classList.add("is-draggable");
      img.addEventListener("mousedown", (event) => {
        startPreviewDrag(name, event);
      });
      applyPreviewElementStyle(name, variant.elements[name]);
    }
  });

  resizePreviewStage();
  updatePreviewHighlight();
}

function updatePreviewFromFields() {
  applyPreviewElementStyle(resizeSettingsElementName, readSettingFieldsAsSpec());
}

// ---------- 預覽拖拉：點選圖層即切換下拉，拖曳直接改靠左%/靠上% ----------

let previewDrag = null;

function selectPreviewElement(name) {
  if (name === resizeSettingsElementName) {
    return;
  }
  saveResizeSettingFields();
  resizeSettingsElementName = name;
  setPickerIndex("setting-element", MCD_POSITION_ELEMENT_NAMES.indexOf(name));
  loadResizeSettingFields();
  updatePreviewHighlight();
}

function roundPercent(value) {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function startPreviewDrag(name, event) {
  event.preventDefault();
  selectPreviewElement(name);

  const stage = document.getElementById("preview-stage");
  const spec = readSettingFieldsAsSpec();
  previewDrag = {
    startX: event.clientX,
    startY: event.clientY,
    startLeft: spec.leftPercent,
    startTop: spec.topPercent,
    stageW: Math.max(stage.clientWidth, 1),
    stageH: Math.max(stage.clientHeight, 1),
  };
  stage.classList.add("is-dragging");
}

function movePreviewDrag(event) {
  if (!previewDrag) {
    return;
  }
  const dxPercent = ((event.clientX - previewDrag.startX) / previewDrag.stageW) * 100;
  const dyPercent = ((event.clientY - previewDrag.startY) / previewDrag.stageH) * 100;
  document.getElementById("setting-leftPercent").value = roundPercent(
    previewDrag.startLeft + dxPercent,
  );
  document.getElementById("setting-topPercent").value = roundPercent(
    previewDrag.startTop + dyPercent,
  );
  updatePreviewFromFields();
}

function endPreviewDrag() {
  if (!previewDrag) {
    return;
  }
  previewDrag = null;
  document.getElementById("preview-stage").classList.remove("is-dragging");
  saveResizeSettingFields();
}

document.addEventListener("mousemove", movePreviewDrag);
document.addEventListener("mouseup", endPreviewDrag);

let resizeMasterDoc = null;

async function refreshPreview(force) {
  const master = resizeMasterDoc;
  if (!isDocumentOpen(master)) {
    setPreviewStatus("母版已關閉，請重新開啟母版後再按「開始執行」。");
    return;
  }
  if (!force && previewCache && previewCache.masterId === master.id) {
    renderPreview();
    return;
  }

  setPreviewStatus("擷取圖層中，請稍候…");
  try {
    previewCache = await buildPreviewCache(master);
    renderPreview();
    setPreviewStatus(`預覽來源：${master.name}`);
  } catch (error) {
    previewCache = null;
    renderPreview();
    setPreviewStatus(`預覽擷取失敗：${error.message || error}`);
  }
}

async function openResizeSettingsPanel() {
  const master = app.activeDocument;
  if (!master) {
    await app.showAlert("請先開啟帶有標準圖層命名的 PSD 母版。");
    return;
  }
  try {
    requireMcdSmartLayers(getMcdSourceContainer(master));
  } catch (error) {
    await app.showAlert(error.message || String(error));
    return;
  }
  resizeMasterDoc = master;

  populateResizeSettingsSelectors();
  resizeSettingsVariantIndex = 0;
  resizeSettingsElementName = MCD_POSITION_ELEMENT_NAMES[0];
  setPickerIndex("setting-variant", 0);
  setPickerIndex("setting-element", 0);
  loadResizeSettingFields();
  document.getElementById("btn-resize-1200x629").style.display = "none";
  document.getElementById("resize-settings-panel").style.display = "block";
  refreshPreview(false);
}

function closeResizeSettingsPanel() {
  document.getElementById("resize-settings-panel").style.display = "none";
  document.getElementById("btn-resize-1200x629").style.display = "";
}

document.getElementById("btn-resize-1200x629").addEventListener("click", () => {
  openResizeSettingsPanel();
});

loadResizeSettingsFromFile();

document
  .getElementById("setting-variant")
  .addEventListener("change", (event) => {
    saveResizeSettingFields();
    resizeSettingsVariantIndex = readPickerIndex(event);
    loadResizeSettingFields();
    renderPreview();
  });

document
  .getElementById("setting-element")
  .addEventListener("change", (event) => {
    saveResizeSettingFields();
    resizeSettingsElementName = MCD_POSITION_ELEMENT_NAMES[readPickerIndex(event)];
    loadResizeSettingFields();
    updatePreviewHighlight();
  });

document
  .getElementById("btn-refresh-preview")
  .addEventListener("click", () => {
    refreshPreview(true);
  });

window.addEventListener("resize", () => {
  if (previewCache) {
    resizePreviewStage();
  }
});

document
  .getElementById("btn-save-setting")
  .addEventListener("click", async () => {
    saveResizeSettingFields();
    const variantName =
      RESIZE_1200x629.variants[resizeSettingsVariantIndex].outputDocument;
    try {
      await saveResizeSettingsToFile();
      setPreviewStatus(
        `已儲存 ${variantName} 的 ${resizeSettingsElementName} 設定`,
      );
    } catch (error) {
      await app.showAlert(`設定寫入失敗：${error.message || error}`);
    }
  });

function confirmResetDefaults() {
  const dialog = document.getElementById("reset-dialog");
  const show = dialog.uxpShowModal
    ? dialog.uxpShowModal({ title: "還原預設值", resize: "none" })
    : dialog.showModal();
  return Promise.resolve(show).then((result) => result === "confirm");
}

document.getElementById("btn-reset-confirm").addEventListener("click", () => {
  document.getElementById("reset-dialog").close("confirm");
});

document.getElementById("btn-reset-cancel").addEventListener("click", () => {
  document.getElementById("reset-dialog").close("cancel");
});

document
  .getElementById("btn-reset-defaults")
  .addEventListener("click", async () => {
    if (!(await confirmResetDefaults())) {
      return;
    }
    try {
      await resetResizeSettingsToDefaults();
      loadResizeSettingFields();
      renderPreview();
      await app.showAlert("已將全部樣板還原為預設值。");
    } catch (error) {
      await app.showAlert(`還原失敗：${error.message || error}`);
    }
  });

document.getElementById("btn-cancel-settings").addEventListener("click", () => {
  closeResizeSettingsPanel();
});

document
  .getElementById("btn-start-generate")
  .addEventListener("click", async () => {
    saveResizeSettingFields();
    try {
      await saveResizeSettingsToFile();
      await resizeTo1200x629(resizeMasterDoc);
      closeResizeSettingsPanel();
    } catch (error) {
      await app.showAlert(`1200x629 產製失敗：${error.message || error}`);
    }
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

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
  // 套圖：換上的圖在框內置中
  if (src.centered === true) {
    out.centered = true;
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
  // 套圖自訂的圖層（圖層「編輯」新增的名稱）
  for (const name of Object.keys(raw || {})) {
    const src = raw[name];
    if (out[name] || name === "$BG" || !src || typeof src !== "object") {
      continue;
    }
    if (SPEC_KEYS.every((key) => Number.isFinite(Number(src[key])))) {
      out[name] = {};
      for (const key of SPEC_KEYS) {
        out[name][key] = Number(src[key]);
      }
      normalizeFrameOptions(src, out[name]);
    }
  }
  return out;
}

// 沒有設定值的圖層（例如新增的套圖圖層）用的預設框
function defaultSpecFor(name) {
  return deepClone(
    DEFAULT_VARIANT_ELEMENTS[name] || { leftPercent: 10, topPercent: 10, widthPercent: 30 },
  );
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
  if (spec.centered) {
    return { alignX: "center", alignY: "middle" };
  }
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
  if (!Array.isArray(raw) || !raw.every((name) => typeof name === "string")) {
    return null;
  }
  // 五個元件各一次，另外可以有「新增文字」加的 $TEXT1…
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
        if (variant && variant.independent === true) {
          out.independent = true;
        }
        const overrides = normalizeTextOverrides(variant && variant.textOverrides);
        if (overrides) {
          out.textOverrides = overrides;
        }
        // 「調整版面尺寸」設定的這個樣板自己的尺寸（沒有就用模組的寬高）
        const width = parsePositiveInt(variant && variant.width);
        const height = parsePositiveInt(variant && variant.height);
        if (width && height) {
          out.width = width;
          out.height = height;
        }
        return out;
      }),
    },
  };
}

/**
 * 獨立樣板自己的文字（不改 PSD、不影響其他樣板）：
 *   textOverrides: { "$SM": { texts: ["第一個文字圖層", …], style: { font, size, color, align } } }
 * texts 依圖層裡文字圖層由上往下的順序；style 套到該圖層所有文字圖層。
 */
function normalizeTextOverrides(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const out = {};
  Object.keys(raw).forEach((name) => {
    const item = raw[name];
    if (!item || typeof item !== "object") {
      return;
    }
    const entry = {};
    if (Array.isArray(item.texts)) {
      entry.texts = item.texts.map((text) => String(text == null ? "" : text));
    }
    if (item.style && typeof item.style === "object") {
      const style = {};
      if (item.style.font) {
        style.font = String(item.style.font);
      }
      const size = Number(item.style.size);
      if (size > 0) {
        style.size = size;
      }
      const color = String(item.style.color || "");
      if (/^#?[0-9a-f]{6}$/i.test(color)) {
        style.color = `#${color.replace("#", "").toUpperCase()}`;
      }
      if (["left", "center", "right"].includes(item.style.align)) {
        style.align = item.style.align;
      }
      if (["horizontal", "vertical"].includes(item.style.orientation)) {
        style.orientation = item.style.orientation;
      }
      if (Object.keys(style).length) {
        entry.style = style;
      }
    }
    if (entry.texts || entry.style) {
      out[name] = entry;
    }
  });
  return Object.keys(out).length ? out : null;
}

// 勾選「獨立」的 Resize 樣板：文字與圖層大小自己設定，不和其他樣板共用／同步
function isIndependentVariant(variant) {
  return Boolean(variant && variant.independent);
}

// 樣板自己的版面尺寸，沒設定就用模組的寬高
function variantCanvasSize(values, variant) {
  if (variant && variant.width > 0 && variant.height > 0) {
    return { width: variant.width, height: variant.height };
  }
  return { width: values.width, height: values.height };
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
  // 套圖可用的圖層名稱（圖層「編輯」視窗可新增／改名／刪除）
  applyLayers: null,
  // 套圖時 PSD 必須有的圖層（圖層「編輯」視窗勾選）；未設定時六個都必須
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
  const data = unpackModuleData(JSON.parse(await file.read()));
  return {
    templates: Array.isArray(data.templates) ? data.templates : [],
    applyTemplates: Array.isArray(data.applyTemplates) ? data.applyTemplates : [],
    applyLayers: normalizeApplyLayers(data.applyLayers),
    applyRequiredLayers: normalizeRequiredLayers(
      data.applyRequiredLayers,
      normalizeApplyLayers(data.applyLayers),
    ),
    reference: normalizeReference(data.reference),
  };
}

/**
 * module.json 的格式：
 *   {
 *     "resize":    { "templates": [Resize 模組…], "reference": {比例基準} },
 *     "image-set": [套圖模組…],
 *     "image-set-layers": { "layers": [套圖圖層清單], "required": [必選圖層] }
 *   }
 * 舊版（templates / applyTemplates / applyLayers / applyRequiredLayers / reference 放在最外層）
 * 一樣讀得進來，下次存檔時改寫成新格式。
 */
function unpackModuleData(data) {
  const source = data && typeof data === "object" ? data : {};
  const resize = source.resize;
  const resizeObject = resize && typeof resize === "object" && !Array.isArray(resize) ? resize : null;
  const layerSettings =
    source["image-set-layers"] && typeof source["image-set-layers"] === "object"
      ? source["image-set-layers"]
      : {};
  let templates = source.templates;
  if (resizeObject) {
    templates = resizeObject.templates;
  } else if (Array.isArray(resize)) {
    templates = resize;
  }
  return {
    templates,
    reference: resizeObject && resizeObject.reference ? resizeObject.reference : source.reference,
    applyTemplates: Array.isArray(source["image-set"]) ? source["image-set"] : source.applyTemplates,
    applyLayers: layerSettings.layers !== undefined ? layerSettings.layers : source.applyLayers,
    applyRequiredLayers:
      layerSettings.required !== undefined ? layerSettings.required : source.applyRequiredLayers,
  };
}

function moduleFileContent() {
  const resize = { templates: moduleStore.templates };
  if (moduleStore.reference) {
    resize.reference = moduleStore.reference;
  }
  return {
    resize,
    "image-set": moduleStore.applyTemplates,
    "image-set-layers": {
      layers: applyLayerNames(),
      required: moduleStore.applyRequiredLayers,
    },
  };
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
  moduleStore.applyLayers = raw ? raw.applyLayers : APPLY_LAYER_NAMES.slice();
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
function requireMcdSmartLayers(container, required = MCD_SMART_LAYER_NAMES, names = MCD_SMART_LAYER_NAMES) {
  const layers = {};
  const missing = [];
  for (const name of names) {
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

function getMcdSourceContainer(doc, required = MCD_SMART_LAYER_NAMES, names = MCD_SMART_LAYER_NAMES) {
  const boards = listArtboards(doc);
  for (const board of boards) {
    try {
      const found = requireMcdSmartLayers(board, required, names);
      // 沒有必要圖層時：第一個含有任一 $ 圖層的工作區域
      if (required.length || Object.keys(found).length) {
        return board;
      }
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
  // （層級裡沒有的圖層，例如之後才新增的文字，放在最上面）
  const others = Object.keys(sourceLayers).filter(
    (layerName) => layerName !== "$BG" && !(layerOrder || []).includes(layerName),
  );
  const bottomToTop = layerOrder
    ? ["$BG", ...layerOrder, ...others]
        .map((layerName) => sourceLayers[layerName])
        .filter(Boolean)
    : listMcdLayersBottomToTop(
        getMcdSourceContainer(master, [], Object.keys(sourceLayers)),
        sourceLayers,
      );
  for (const layer of bottomToTop) {
    await master.duplicateLayers([layer], newDoc);
  }

  app.activeDocument = newDoc;
  return newDoc;
}

async function layoutSmartByPercents(layer, canvasW, canvasH, spec, name) {
  await layoutInFrame(layer, { left: 0, top: 0, right: canvasW, bottom: canvasH }, spec, name);
}

// 等比放進框內（見 fitInFrame），框外不會超出；frame 為畫布（工作區域或整份文件）的像素範圍
async function layoutInFrame(layer, frame, spec, name) {
  const canvasW = frame.right - frame.left;
  const canvasH = frame.bottom - frame.top;
  const src = boundsBox(layer);
  const aspectPercent = (src.height / src.width) * (canvasW / canvasH);
  const rect = fitInFrame(name, spec, aspectPercent);
  const scale = (canvasW * rect.width) / 100 / src.width;
  await scaleLayerUniform(layer, Math.max(scale, 0.01));

  const fitted = boundsBox(layer);
  await translateLayer(
    layer,
    frame.left + (canvasW * rect.left) / 100 - fitted.left,
    frame.top + (canvasH * rect.top) / 100 - fitted.top,
  );
}

async function applyResizeVariantLayout(doc, variant, canvasW, canvasH) {
  const names = withExtraNames(MCD_SMART_LAYER_NAMES, dollarLayerNames(doc));
  // PSD 有哪些 $ 圖層就排哪些（不要求六個都有）
  const layers = requireMcdSmartLayers(doc, [], names);

  if (layers.$BG && variant.elements.$BG) {
    await layoutSmartByPercents(
      layers.$BG,
      canvasW,
      canvasH,
      variant.elements.$BG,
      "$BG",
    );
  } else if (layers.$BG) {
    await layoutObjectFitCover(layers.$BG, canvasW, canvasH);
  }

  for (const name of names.filter((item) => item !== "$BG")) {
    if (!layers[name] || !variant.elements[name]) {
      continue; // PSD 沒有這個圖層，或還沒設定位置的新增文字維持原位
    }
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

function findOpenDocumentById(id) {
  for (let i = 0; i < app.documents.length; i++) {
    if (app.documents[i].id === id) {
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
  const container = getMcdSourceContainer(master, [], MCD_SMART_LAYER_NAMES);
  const layers = requireMcdSmartLayers(container, [], MCD_SMART_LAYER_NAMES);
  const frame =
    container === master
      ? { left: 0, right: unitNumber(master.width) }
      : readLayerBounds(container);
  const frameW = Math.max(frame.right - frame.left, 1);
  const out = {};
  for (const name of MCD_POSITION_ELEMENT_NAMES) {
    if (!layers[name]) {
      continue; // PSD 沒有這個圖層
    }
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
    if (elements[name] && base > 0 && widths[name] > 0) {
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

// 只要 PSD 裡有 $ 開頭的圖層就能用（不再要求固定的六個圖層）
function validMasterOrNull(doc) {
  return doc && !dollarMasterProblem(doc) ? doc : null;
}

function dollarMasterProblem(doc) {
  try {
    return dollarLayerNames(doc).length ? "" : "PSD 裡沒有名稱以 $ 開頭的圖層";
  } catch (error) {
    return error.message || String(error);
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
// 六個元件 + 「新增文字」加的 $TEXT1…
function resizeSourceLayers(master) {
  const names = withExtraNames(MCD_SMART_LAYER_NAMES, dollarLayerNames(master));
  const sourceContainer = getMcdSourceContainer(master, [], names);
  return requireMcdSmartLayers(sourceContainer, [], names);
}

/**
 * 產出一個 Resize 樣板的文件（需在 modal 內）：新文件 → 複製圖層 → 獨立樣板的文字 → 排版。
 * 產出每個樣板的 PSD 都用這一份。
 */
async function buildResizeVariantDocument(master, sourceLayers, docName, canvasW, canvasH, variant) {
  app.activeDocument = master;
  const newDoc = await createMcdDocumentFromMaster(
    master,
    sourceLayers,
    docName,
    canvasW,
    canvasH,
    variant.order,
  );
  if (isIndependentVariant(variant) && variant.textOverrides) {
    // 獨立樣板自己的文字只改在這份文件
    for (const layerName of Object.keys(variant.textOverrides)) {
      const layer = findNamedLayer(newDoc, layerName);
      if (layer) {
        await applyTextOverride(newDoc, layer, variant.textOverrides[layerName]);
      }
    }
    app.activeDocument = newDoc;
  }
  await applyResizeVariantLayout(newDoc, variant, canvasW, canvasH);
  return newDoc;
}

async function generateResizeDocuments(master, values) {
  if (!isDocumentOpen(master)) {
    throw new Error("母版已關閉，請重新開啟或上傳母版。");
  }
  const variants = values.variants.filter((variant) => variant.outputDocument);
  if (!variants.length) {
    throw new Error("此模組還沒有已命名的版型，請先輸入版型名稱並按「新增」。");
  }

  const sourceLayers = resizeSourceLayers(master);

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

  for (const job of jobs) {
    const docName = stripExtension(job.fileName);
    const { width: canvasW, height: canvasH } = variantCanvasSize(values, job.variant);
    try {
      await runModal(
        async () => {
          const newDoc = await buildResizeVariantDocument(
            master,
            sourceLayers,
            docName,
            canvasW,
            canvasH,
            job.variant,
          );
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

async function exportLayerPreviewPng(master, layer, file, name, prepare) {
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
    if (prepare) {
      // 例如獨立樣板：先套上自己的文字再匯出
      await prepare(temp, copy);
      app.activeDocument = temp;
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

async function buildPreviewCache(master, required = MCD_SMART_LAYER_NAMES, names = MCD_SMART_LAYER_NAMES) {
  const sourceContainer = getMcdSourceContainer(master, required, names);
  const sourceLayers = requireMcdSmartLayers(sourceContainer, required, names);
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
            `preview-${master.id}-${presentNames.indexOf(name)}.png`,
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

function getPreviewCache(master, force, required, names = MCD_SMART_LAYER_NAMES) {
  // 套圖的圖層清單可自訂，依圖層清單分開快取
  const key = `${master.id}|${names.slice().sort().join("|")}`;
  if (!force && previewCacheByMaster.has(key)) {
    return previewCacheByMaster.get(key);
  }
  const pending = whilePhotoshopBusy(() => buildPreviewCache(master, required, names)).catch((error) => {
    previewCacheByMaster.delete(key);
    throw error;
  });
  previewCacheByMaster.set(key, pending);
  return pending;
}

// ---------- 下拉選單 ----------

// 下拉的 label 屬性＝目前選項的文字：UXP 重建選單後有時選項有打勾、框裡卻是空白，
// 有 label 時至少會顯示這段文字（沒有選項時還原成原本的提示文字）
function syncPickerLabel(picker, index) {
  if (picker._placeholder === undefined) {
    picker._placeholder = picker.getAttribute("label");
  }
  const item = picker.querySelectorAll("sp-menu-item")[index];
  if (item) {
    picker.setAttribute("label", item.textContent);
  } else if (picker._placeholder) {
    picker.setAttribute("label", picker._placeholder);
  } else {
    picker.removeAttribute("label");
  }
}

function fillPicker(picker, labels) {
  if (!picker._labelSync) {
    picker._labelSync = true;
    picker.addEventListener("change", () => {
      picker._wantedIndex = null; // 使用者自己選了，不要再被延後的設定蓋掉
      syncPickerLabel(picker, picker.selectedIndex);
    });
  }
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
  syncPickerLabel(picker, labels.length ? 0 : -1);
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
  syncPickerLabel(picker, index);
  // 選單剛重建時 UXP 可能還沒畫好選項：等這一輪結束再設一次，框裡才會顯示文字
  picker._wantedIndex = index;
  setTimeout(() => {
    if (picker._wantedIndex === index) {
      picker.selectedIndex = index;
    }
  }, 0);
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

const LOADING_DELAY_MS = 250;
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

// 讀取中視窗（轉圈＋百分比）：很快就做完的不顯示，免得閃一下
function startLoading(message) {
  const dialog = document.getElementById("loading-dialog");
  const state = { shown: false, closed: false, frame: 0, percent: 0, message };
  const render = () => {
    document.getElementById("loading-spinner").textContent = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length];
    document.getElementById("loading-text").textContent = state.message;
    document.getElementById("loading-percent").textContent = `${Math.round(state.percent)}%`;
    document.getElementById("loading-bar").style.width = `${state.percent}%`;
  };
  const showTimer = setTimeout(() => {
    if (state.closed) {
      return;
    }
    state.shown = true;
    render();
    const shown = dialog.uxpShowModal
      ? dialog.uxpShowModal({ title: "讀取中", resize: "none" })
      : dialog.showModal();
    Promise.resolve(shown).catch(() => {});
  }, LOADING_DELAY_MS);
  const spinTimer = setInterval(() => {
    state.frame += 1;
    if (state.shown) {
      render();
    }
  }, 120);
  return {
    update(percent, text) {
      state.percent = clampNumber(percent, state.percent, 100); // 只往前不倒退
      if (text) {
        state.message = text;
      }
      if (state.shown) {
        render();
      }
    },
    async done() {
      state.closed = true;
      clearTimeout(showTimer);
      clearInterval(spinTimer);
      if (state.shown) {
        try {
          dialog.close();
        } catch (_error) {
          // 已關閉
        }
        // 等這個視窗收掉再開下一個
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
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
const EMPTY_TEMPLATE_LABEL = "（請按「上傳.psd」）";
const EMPTY_STATUS = "請按「上傳.psd」選擇 PSD。";
const DOUBLE_CLICK_MS = 400;
const TEXT_EDITOR_Z_INDEX = 1000;
const DELETE_BUTTON_SIZE = 18;
const MAX_CANVAS_SIZE = 30000;

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

/**
 * Resize 與套圖共用同一個工作區（同一套預覽、拖拉、靠左／靠上／寬度／高度、層級）。
 * mode 決定兩者不同的地方：模組清單、母版需要哪些圖層、新模組的預設版面、產出方式。
 */
function createResizeWorkspace(root, mode = RESIZE_MODE) {
  const el = (role) => root.querySelector(`[data-role="${role}"]`);
  const isApply = mode.kind === "apply";
  const templates = () => mode.templates();
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
    elementName: mode.editableNames()[0],
    previewCache: null,
    // 獨立樣板自己的文字預覽圖（key：母版 id + 圖層 + 設定）
    overrideImages: {},
    drag: null,
    images: {},
    selection: null,
    // 套圖：按「預覽套圖」後的各組換圖（選擇套圖樣板＝預設 + 套圖01.psd…）
    sets: [],
    outputIndex: 0,
    imageInfos: {},
  };
  let applyExtras = null;

  const workspace = { root, open, show, commit: commitFields };

  // ----- 圖層名稱：上傳的 PSD 裡所有 $ 開頭的圖層（沒有 PSD 時用模式的預設清單） -----

  function refreshExtraNames() {
    try {
      state.extraNames = isDocumentOpen(state.master) ? dollarLayerNames(state.master) : [];
    } catch (_error) {
      state.extraNames = [];
    }
  }

  // 要找的圖層：模式的清單 + PSD 裡其他 $ 圖層
  function layerNames() {
    return withExtraNames(mode.layerNames(), state.extraNames || []);
  }

  function positionNames() {
    return withExtraNames(
      mode.positionNames(),
      (state.extraNames || []).filter((name) => name !== "$BG"),
    );
  }

  // 「圖層」下拉：有 PSD 時只列 PSD 裡有的 $ 圖層（預設清單的順序在前，其餘照 PSD 順序）
  function editableNames() {
    const present = state.extraNames || [];
    const base = mode.editableNames();
    if (!present.length) {
      return base;
    }
    // $BG 固定放最後
    const names = [
      ...base.filter((name) => present.includes(name) && name !== "$BG"),
      ...present.filter((name) => !base.includes(name) && name !== "$BG"),
    ];
    if (present.includes("$BG")) {
      names.push("$BG");
    }
    return names;
  }

  // ----- 目前選取 -----

  // templateIndex = -1 代表「尚未新增」的草稿模組（還沒按「新增」的 PSD）
  function currentTemplate() {
    if (state.templateIndex < 0) {
      return state.draft;
    }
    const template = templates()[state.templateIndex] || null;
    if (template && !template.values && isDocumentOpen(state.master)) {
      try {
        template.values = mode.initialValues(state.master);
      } catch (_error) {
        // 母版圖層不齊，等換母版再量
      }
    }
    // 舊的套圖模組沒有版面、也還沒有母版可量：先當作沒有選取，開啟 PSD 後再補上
    return template && template.values ? template : null;
  }

  // 預覽用的圖層圖片：套圖選了某一組時，勾選圖層改用那一組的圖（含寬高）
  function layerImage(name) {
    const cache = state.previewCache;
    if (isApply && applyExtras) {
      const replaced = applyExtras.replacementFor(name);
      if (replaced) {
        return replaced;
      }
    }
    const own = overrideImage(name);
    if (own) {
      return own;
    }
    return (cache && cache.images[name]) || null;
  }

  // ----- 獨立樣板自己的文字 -----

  // 目前選的是獨立樣板（Resize）才回傳它
  function verticalVariant() {
    const variant = isApply ? null : currentVariant();
    return isIndependentVariant(variant) ? variant : null;
  }

  function textOverrideOf(variant, name, create) {
    if (!variant) {
      return null;
    }
    if (!variant.textOverrides && create) {
      variant.textOverrides = {};
    }
    const overrides = variant.textOverrides;
    if (overrides && !overrides[name] && create) {
      overrides[name] = {};
    }
    return overrides ? overrides[name] || null : null;
  }

  // 獨立樣板有自己的文字時，預覽改用套上那些文字後匯出的圖（第一次需要時在背景產生）
  function overrideImage(name) {
    const variant = verticalVariant();
    const override = textOverrideOf(variant, name, false);
    if (!override || !isDocumentOpen(state.master)) {
      return null;
    }
    const key = `${state.master.id}|${name}|${JSON.stringify(override)}`;
    const hit = state.overrideImages[key];
    if (hit) {
      return hit.image || null;
    }
    state.overrideImages[key] = { pending: true };
    const master = state.master;
    whilePhotoshopBusy(() =>
      buildTextOverridePreview(master, name, mode.required(), layerNames(), override),
    )
      .then((image) => {
        state.overrideImages[key] = { image };
        if (state.master && state.master.id === master.id) {
          renderPreview();
        }
      })
      .catch((error) => {
        state.overrideImages[key] = { image: null };
        setStatus(`獨立樣板的文字預覽失敗：${describeModalError(error)}`);
      });
    return null;
  }

  function isDraftSelected() {
    return state.templateIndex < 0 && Boolean(state.draft);
  }

  // 一開始（還沒按「上傳.psd」、也沒選模組）什麼都不帶入
  function isNothingSelected() {
    return state.templateIndex < 0 && !state.draft;
  }

  function currentVariant() {
    const template = currentTemplate();
    return template ? template.values.variants[state.variantIndex] || null : null;
  }

  function coverSpec() {
    // 與 layoutObjectFitCover 相同：等比放大到鋪滿畫布並置中，換算成百分比
    const info = layerImage("$BG");
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
    return variant.elements[name] || defaultSpecFor(name);
  }

  // 套圖新增的圖層在舊的版面裡沒有設定值：有母版就用 PSD 原稿位置，否則用預設框
  // Resize：只補「新增文字」的 $TEXTn（依母版上的位置）
  function ensureVariantElements(template) {
    if (!template || !template.values) {
      return;
    }
    let measured = null;
    for (const variant of template.values.variants) {
      for (const name of positionNames()) {
        if (variant.elements[name]) {
          continue;
        }
        if (!measured) {
          measured = measuredSpecs();
        }
        variant.elements[name] = measured[name] ? deepClone(measured[name]) : defaultSpecFor(name);
      }
    }
  }

  function measuredSpecs() {
    if (!isDocumentOpen(state.master)) {
      return {};
    }
    try {
      if (isApply) {
        return mode.initialValues(state.master).variants[0].elements;
      }
      const { frames } = measureLayerFrames(state.master, mode.required(), layerNames());
      const out = {};
      Object.keys(frames).forEach((name) => {
        out[name] = {
          leftPercent: roundTo(frames[name].left, 2),
          topPercent: roundTo(frames[name].top, 2),
          widthPercent: roundTo(frames[name].width, 2),
        };
      });
      return out;
    } catch (_error) {
      return {}; // 量不到就用預設框
    }
  }

  function currentSpec() {
    const variant = currentVariant();
    return variant ? elementSpec(variant, state.elementName) : null;
  }

  function canvasSize() {
    const template = currentTemplate();
    if (!template) {
      return BUILTIN_RESIZE_VALUES;
    }
    // 預設是模組的寬高（套圖＝PSD 原稿）；「調整版面尺寸」可以讓每個樣板／每組套圖各自設定
    return variantCanvasSize(template.values, currentVariant());
  }

  function variantLabel(variant) {
    return variant && variant.outputDocument
      ? variant.outputDocument
      : "（未命名版型）";
  }

  function clampSelection() {
    const count = templates().length;
    if (state.templateIndex >= 0) {
      state.templateIndex = count ? Math.min(state.templateIndex, count - 1) : -1;
    }
    const template = currentTemplate();
    const editable = editableNames();
    if (!editable.includes(state.elementName)) {
      state.elementName = editable[0];
    }
    if (template && !template.values.variants.length) {
      // 沒有任何版型時先放一個未命名草稿，讓使用者可以直接拖拉再命名
      template.values.variants.push(newDraftVariant());
    }
    ensureVariantElements(template);
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
    if (spec.centered) {
      out.centered = true;
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

  // 「獨立」勾選框跟著目前的 Resize 樣板
  function updateIndependentCheck() {
    const check = el("independent-check");
    if (!check) {
      return;
    }
    const variant = currentVariant();
    check.checked = isIndependentVariant(variant);
    check.disabled = !variant;
  }

  function loadFields() {
    updateIndependentCheck();
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
    if (applyExtras) {
      applyExtras.commit();
    }
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

  // 有草稿時下拉第 0 項是「（未新增）」草稿；什麼都沒選時第 0 項是提示；其後才是各模組。
  // 畫下拉時記住每一項對應的模組（templateIndex，草稿／提示為 -1），
  // 選擇時直接查表，不必在選完之後重畫下拉，位置也不會差一格
  function renderTemplatePicker() {
    const entries = templates().map((template, index) => ({
      label: template.name || "（未命名模組）",
      index,
    }));
    if (state.draft) {
      entries.unshift({ label: state.draft.label, index: -1 });
    } else if (isNothingSelected()) {
      entries.unshift({ label: EMPTY_TEMPLATE_LABEL, index: -1 });
    }
    state.templateEntries = entries;
    fillPicker(templatePicker, entries.map((entry) => entry.label));
    if (entries.length) {
      setPickerIndex(
        templatePicker,
        Math.max(entries.findIndex((entry) => entry.index === state.templateIndex), 0),
      );
    }
    updateTemplateHint();
  }

  function renderVariantPicker() {
    const template = currentTemplate();
    const variants = template ? template.values.variants : [];
    // 套圖：預設 + 各組（每組有自己的版面，存在同名的 variant）
    const labels = isApply
      ? variants.length
        ? [variantLabel(variants[0]), ...state.sets.map((set) => set.name)]
        : []
      : variants.map(variantLabel);
    fillPicker(variantPicker, labels);
    if (labels.length) {
      setPickerIndex(variantPicker, isApply ? state.outputIndex : state.variantIndex);
    }
    updateVariantNameValidity();
  }

  function renderElementPicker() {
    fillPicker(elementPicker, editableNames());
    setPickerIndex(elementPicker, editableNames().indexOf(state.elementName));
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
    refreshExtraNames();
    clampSelection();
    renderTemplatePicker();
    renderVariantPicker();
    renderElementPicker();
    loadFields();
    if (applyExtras) {
      applyExtras.load();
    }
    renderPreview();
  }

  // ----- 預覽 -----

  function heightRatio(name) {
    // 高度% ÷ 寬度%：圖層長寬比 × 畫布寬高比
    const info = layerImage(name);
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
    const deletable = !hidden && EXTRA_TEXT_PATTERN.test(state.elementName);
    if (sel.remove) {
      sel.remove.style.display = deletable ? "block" : "none";
    }
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
    if (deletable && sel.remove) {
      // 放在右上角控制點的右上方，不擋到縮放
      const size = DELETE_BUTTON_SIZE;
      const right = ((spec.leftPercent + spec.widthPercent) / 100) * stageW;
      const top = (spec.topPercent / 100) * stageH;
      sel.remove.style.left = `${clampNumber(right + 4, 0, stageW - size)}px`;
      sel.remove.style.top = `${clampNumber(top - size - 4, 0, stageH - size)}px`;
    }
  }

  function updateHighlight() {
    updateSelectionBox();
    updateLayerButtons();
  }

  // 預覽區依版面比例：橫式／正方形撐滿面板寬；直式（高 > 寬）高度最多等於面板寬，
  // 寬度跟著等比縮小並置中，不會變成一整條超長的預覽
  function resizeStage() {
    const canvas = canvasSize();
    const available =
      (stage.parentElement && stage.parentElement.clientWidth) || stage.clientWidth;
    let width = available;
    let height = (available * canvas.height) / canvas.width;
    if (height > available) {
      height = available;
      width = (available * canvas.width) / canvas.height;
    }
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.marginLeft = "auto";
    stage.style.marginRight = "auto";
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
    // 「新增文字」的文字區塊右上角有 ×，可以刪除
    const remove = document.createElement("div");
    remove.className = "preview-delete";
    remove.textContent = "×";
    remove.style.zIndex = String(zIndex + 2);
    remove.style.display = "none";
    remove.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      event.preventDefault();
    });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteTextBlock();
    });
    stage.appendChild(remove);
    return { box, handles, remove };
  }

  // ----- 圖層前後順序 -----

  function effectiveLayerOrder() {
    const variant = currentVariant();
    const names = positionNames();
    if (variant && variant.order) {
      // 套圖的圖層清單可能改過：去掉已刪除的、新增的放最上面
      const kept = variant.order.filter((name) => names.includes(name));
      return [...kept, ...names.filter((name) => !kept.includes(name))];
    }
    // 未設定時沿用母版的堆疊順序
    const fromMaster = state.previewCache
      ? state.previewCache.order.filter((name) => names.includes(name))
      : [];
    return fromMaster.length === names.length ? fromMaster : names.slice();
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
    // 格線要在圖片上面：圖片重新排過後再畫一次
    renderGrid();
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
    if (isApply) {
      await syncApplyLayers(template, source);
      return;
    }
    // 勾選「獨立」的樣板自己設定，不跟其他樣板同步
    if (isIndependentVariant(source)) {
      setStatus(`「${variantLabel(source)}」是獨立樣板，不與其他樣板同步圖層大小。`);
      await app.showAlert(`「${variantLabel(source)}」勾選了「獨立」，大小自己設定，不會同步到其他樣板。`);
      return;
    }
    const targets = template.values.variants.filter(
      (variant) => variant !== source && !isIndependentVariant(variant),
    );
    const skipped = template.values.variants.filter(
      (variant) => variant !== source && isIndependentVariant(variant),
    );
    el("sync-dialog-text").textContent = skipped.length
      ? `請問要同步全部的圖層大小嗎?（獨立樣板 ${skipped.map(variantLabel).join("、")} 不會同步）`
      : "請問要同步全部的圖層大小嗎?";
    if (!(await showDialog(el("sync-dialog"), "同步圖層大小"))) {
      return;
    }
    commitFields();
    for (const variant of targets) {
      for (const name of positionNames()) {
        if (source.elements[name] && variant.elements[name]) {
          copyFrameSize(source.elements[name], variant.elements[name]);
        }
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
      skipped.length
        ? `已將「${variantLabel(source)}」的圖層大小同步到其他樣板（獨立樣板不同步）`
        : `已將「${variantLabel(source)}」的圖層大小同步到其他樣板`,
      "已同步圖層大小",
    );
  }

  /**
   * 套圖的同步圖層：目前這組的各圖層大小與位置（含 $BG），
   * 套到預設與其他所有套圖。
   */
  async function syncApplyLayers(template, source) {
    commitFields();
    for (const set of state.sets) {
      applyExtras.variantForSet(set);
    }
    if (!template.values.variants.some((variant) => variant !== source)) {
      await app.showAlert("目前沒有其他套圖可以同步。請先在「圖檔 src」選擇放有套圖圖檔的資料夾。");
      return;
    }
    if (!(await showDialog(el("sync-dialog"), "同步圖層"))) {
      return;
    }
    for (const variant of template.values.variants) {
      if (variant === source) {
        continue;
      }
      for (const name of positionNames()) {
        if (source.elements[name]) {
          variant.elements[name] = deepClone(source.elements[name]);
        }
      }
      if (source.elements.$BG) {
        variant.elements.$BG = deepClone(source.elements.$BG);
      } else {
        delete variant.elements.$BG;
      }
    }
    await persist(
      `已將「${variantLabel(source)}」的圖層大小與位置同步到全部套圖`,
      "已同步圖層",
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
      img.setAttribute("data-layer", name);
      img.src = layerImage(name).dataUrl;
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
    if (state.textEditor && state.textEditor.box) {
      positionTextEditor(state.textEditor.box, state.textEditor.name);
    }

    resizeStage();
    updateHighlight();
  }

  // ----- 預覽上雙擊圖層改文字（改完直接存 PSD） -----

  async function openTextEditor(name) {
    if (state.textEditor || !isDocumentOpen(state.master)) {
      return;
    }
    const master = state.master;
    state.textEditor = { name, master };
    setStatus(`讀取 ${name} 的文字中…`);
    let texts;
    try {
      texts = await whilePhotoshopBusy(() =>
        readEditableTexts(master, name, mode.required(), layerNames()),
      );
    } catch (error) {
      state.textEditor = null;
      setStatus(`無法讀取 ${name} 的文字：${describeModalError(error)}`);
      return;
    }
    if (!texts.length) {
      state.textEditor = null;
      setStatus(`${name} 沒有可編輯的文字`);
      return;
    }
    // 獨立樣板有自己的文字就顯示它的（文字圖層數量要一致）
    const variant = verticalVariant();
    const own = textOverrideOf(variant, name, false);
    if (own && own.texts && own.texts.length === texts.length) {
      texts = texts.map((item, i) => ({ name: item.name, text: own.texts[i] }));
    }
    if (state.textEditor && state.master && state.master.id === master.id) {
      showTextEditor(name, texts, variant);
    } else {
      state.textEditor = null;
    }
  }

  function textEditorPosition(name) {
    const ratio = heightRatio(name);
    const rect = ratio
      ? fitInFrame(name, specForPreview(name), ratio)
      : { left: 10, top: 10, width: 40, height: 10 };
    const below = rect.top + rect.height;
    return {
      left: clampNumber(rect.left, 0, 55),
      top: below < 70 ? Math.max(below, 0) : clampNumber(rect.top - 30, 0, 70),
    };
  }

  function showTextEditor(name, texts, variant) {
    const box = document.createElement("div");
    box.className = "text-editor";
    // 預覽圖片各有 z-index（層級），編輯框要比全部都高才不會被蓋住、點得到按鈕
    box.style.zIndex = String(TEXT_EDITOR_Z_INDEX);
    box.addEventListener("mousedown", (event) => event.stopPropagation());

    const inputs = texts.map((item) => {
      if (texts.length > 1) {
        const label = document.createElement("div");
        label.className = "text-editor-label";
        label.textContent = item.name;
        box.appendChild(label);
      }
      // Photoshop 的換行是 \r；一律用 textarea，Enter 確認、Shift／Alt＋Enter 換行
      const value = item.text.replace(/\r\n?|\n/g, "\n");
      const input = document.createElement("textarea");
      input.className = "text-input text-editor-input";
      input.value = value;
      input.rows = Math.max(value.split("\n").length, 1) + 1;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          closeTextEditor();
        } else if (event.key === "Enter" && (event.shiftKey || event.altKey)) {
          event.preventDefault();
          insertLineBreak(input);
        } else if (event.key === "Enter") {
          event.preventDefault();
          confirmTextEditor();
        }
      });
      box.appendChild(input);
      return input;
    });

    const hint = document.createElement("div");
    hint.className = "text-editor-hint";
    hint.textContent = "Enter 確認；Shift＋Enter 或 Alt＋Enter 換行";
    box.appendChild(hint);

    const actions = document.createElement("div");
    actions.className = "text-editor-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "small-btn";
    cancel.textContent = "取消";
    cancel.addEventListener("click", closeTextEditor);
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "small-btn";
    confirm.textContent = "確認";
    confirm.addEventListener("click", confirmTextEditor);
    // 左下角「編輯」：開文字樣式（字型／大小／對齊／顏色）
    const style = document.createElement("button");
    style.type = "button";
    style.className = "small-btn text-editor-style";
    style.textContent = "編輯";
    style.addEventListener("click", openStyleFromEditor);
    // 「轉向」：橫排 ↔ 直排
    const turn = document.createElement("button");
    turn.type = "button";
    turn.className = "small-btn";
    turn.textContent = "轉向";
    turn.addEventListener("click", toggleOrientationFromEditor);
    actions.appendChild(turn);
    actions.appendChild(style);
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    box.appendChild(actions);

    state.textEditor = { name, master: state.master, texts, inputs, box, variant: variant || null };
    // 放在預覽區裡會被圖層圖片蓋住（UXP 的 z-index 不可靠）：
    // 跟「套圖圖層」下拉一樣移到分頁最後，再依預覽區位置擺到圖層旁邊
    root.appendChild(box);
    positionTextEditor(box, name);
    setStatus(
      variant
        ? `修改「${variantLabel(variant)}」自己的 ${name} 文字（獨立樣板，不改 PSD 與其他樣板）`
        : `修改 ${name} 的文字，按「確認」寫回 PSD 並存檔`,
    );
    try {
      inputs[0].focus();
    } catch (_error) {
      // 無法聚焦就略過
    }
  }

  function insertLineBreak(input) {
    const value = input.value;
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : value.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : start;
    input.value = `${value.slice(0, start)}\n${value.slice(end)}`;
    try {
      input.selectionStart = input.selectionEnd = start + 1;
    } catch (_error) {
      // 無法移動游標就停在最後
    }
    input.rows = input.value.split("\n").length + 1;
  }

  function positionTextEditor(box, name) {
    const position = textEditorPosition(name);
    const rootRect = root.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const stageW = stageRect.width || stage.clientWidth;
    const stageH = stageRect.height || stage.clientHeight;
    // 寬度依面板（不是預覽區）：直式版面的預覽很窄，按鈕才不會擠出框外
    const rootW = rootRect.width || root.clientWidth || stageW;
    const width = Math.min(Math.max(rootW * 0.5, 280), rootW);
    const left = stageRect.left - rootRect.left + (stageW * position.left) / 100;
    box.style.left = `${clampNumber(left, 0, Math.max(rootW - width, 0))}px`;
    box.style.top = `${stageRect.top - rootRect.top + (stageH * position.top) / 100}px`;
    box.style.width = `${width}px`;
  }

  // 已經改了文字就先寫回存檔，再切換橫排／直排
  async function toggleOrientationFromEditor() {
    const editor = state.textEditor;
    if (!editor || !editor.inputs || editor.saving) {
      return;
    }
    const changed = editor.inputs.some(
      (input, i) =>
        input.value.replace(/\r\n?|\n/g, "\r") !== editor.texts[i].text.replace(/\r\n?|\n/g, "\r"),
    );
    if (changed) {
      await confirmTextEditor();
    } else {
      closeTextEditor();
    }
    await toggleOrientation(editor.name);
  }

  async function toggleOrientation(name) {
    if (!isDocumentOpen(state.master)) {
      return;
    }
    const master = state.master;
    let style;
    try {
      style = await whilePhotoshopBusy(() =>
        readTextStyle(master, name, mode.required(), layerNames()),
      );
    } catch (error) {
      setStatus(`無法讀取文字方向：${describeModalError(error)}`);
      return;
    }
    if (!style) {
      setStatus(`${name} 沒有文字`);
      return;
    }
    let psdTexts;
    try {
      psdTexts = (
        await whilePhotoshopBusy(() => readEditableTexts(master, name, mode.required(), layerNames()))
      ).map((item) => item.text);
    } catch (error) {
      setStatus(`無法讀取 ${name} 的文字：${describeModalError(error)}`);
      return;
    }
    const variant = verticalVariant();
    const own = textOverrideOf(variant, name, false);
    const current = (own && own.style && own.style.orientation) || style.orientation || "horizontal";
    const next = current === "vertical" ? "horizontal" : "vertical";
    const label = next === "vertical" ? "直排" : "橫排";
    // 直排：半形數字／英文轉全形才會直立；橫排：換回半形
    const convert = next === "vertical" ? toFullWidth : toHalfWidth;
    if (variant) {
      // 獨立樣板：方向與文字存在這個樣板，不改 PSD
      const override = textOverrideOf(variant, name, true);
      const base =
        override.texts && override.texts.length === psdTexts.length ? override.texts : psdTexts;
      override.texts = base.map(convert);
      override.style = { ...(override.style || {}), orientation: next };
      renderPreview();
      await saveOverride(`已將「${variantLabel(variant)}」的 ${name} 改為${label}`);
      return;
    }
    // 共用樣板要改 PSD：獨立樣板先記下原本的樣式與文字
    const frozen =
      freezeIndependent(name, "style", style) + freezeIndependent(name, "texts", psdTexts);
    setStatus(`將 ${name} 改為${label}並存檔中…`);
    try {
      await whilePhotoshopBusy(() =>
        writeTextsAndStyle(master, name, mode.required(), layerNames(), psdTexts.map(convert), {
          orientation: next,
        }),
      );
    } catch (error) {
      setStatus(`轉向失敗：${describeModalError(error)}`);
      await app.showAlert(`轉向失敗：${describeModalError(error)}`);
      return;
    }
    if (frozen) {
      await persist(`獨立樣板保留原本的 ${name} 方向`);
    }
    if (state.master && state.master.id === master.id) {
      await refreshPreview(true);
    }
    setStatus(`已將 ${name} 改為${label}並存檔`);
    await showToast(`已改為${label}`);
  }

  // 已經改了文字就先寫回存檔，再開文字樣式
  async function openStyleFromEditor() {
    const editor = state.textEditor;
    if (!editor || !editor.inputs || editor.saving) {
      return;
    }
    const changed = editor.inputs.some(
      (input, i) =>
        input.value.replace(/\r\n?|\n/g, "\r") !== editor.texts[i].text.replace(/\r\n?|\n/g, "\r"),
    );
    if (changed) {
      await confirmTextEditor();
    } else {
      closeTextEditor();
    }
    await openTextStyle(editor.name);
  }

  function closeTextEditor() {
    const editor = state.textEditor;
    state.textEditor = null;
    if (editor && editor.box && editor.box.parentNode) {
      editor.box.parentNode.removeChild(editor.box);
    }
    setStatus("");
  }

  async function confirmTextEditor() {
    const editor = state.textEditor;
    if (!editor || !editor.inputs || editor.saving) {
      return;
    }
    const values = editor.inputs.map((input) => input.value.replace(/\r\n?|\n/g, "\r"));
    if (editor.variant) {
      // 獨立樣板：文字存在這個樣板（module.json），不改 PSD
      textOverrideOf(editor.variant, editor.name, true).texts = values;
      if (editor.box && editor.box.parentNode) {
        editor.box.parentNode.removeChild(editor.box);
      }
      state.textEditor = null;
      renderPreview();
      await saveOverride(`已更新「${variantLabel(editor.variant)}」自己的 ${editor.name} 文字`);
      return;
    }
    // 共用樣板要改 PSD 了：還沒有自己文字的獨立樣板先記下「改之前」的文字，不被這次修改影響
    const frozen = freezeIndependent(
      editor.name,
      "texts",
      editor.texts.map((item) => item.text.replace(/\r\n?|\n/g, "\r")),
    );
    // 文字沒改也照樣寫回存檔：順便把之前被裁掉的智慧型物件畫布放大
    editor.saving = true;
    if (editor.box.parentNode) {
      editor.box.parentNode.removeChild(editor.box);
    }
    editor.box = null;
    setStatus(`更新 ${editor.name} 的文字並存檔中…`);
    try {
      await whilePhotoshopBusy(() =>
        writeEditableTexts(editor.master, editor.name, mode.required(), layerNames(), values),
      );
    } catch (error) {
      state.textEditor = null;
      setStatus(`更新文字失敗：${describeModalError(error)}`);
      await app.showAlert(`更新文字失敗：${describeModalError(error)}`);
      return;
    }
    state.textEditor = null;
    if (frozen) {
      await persist(`獨立樣板保留原本的 ${editor.name} 文字`);
    }
    if (state.master && state.master.id === editor.master.id) {
      await refreshPreview(true);
    }
    setStatus(`已更新 ${editor.name} 的文字並存檔`);
    await showToast("已更新文字並存檔");
  }

  // 同一份 PSD 的模組裡，勾了「獨立」但這個圖層還沒有自己 key（texts／style）的樣板：
  // 存一份目前（改之前）的值，之後共用樣板改 PSD 就不會影響它。回傳記了幾個樣板
  function freezeIndependent(name, key, value) {
    const path = readDocumentPath(state.master);
    const owners = templates().filter(
      (template) =>
        template === currentTemplate() ||
        (template.source && path && template.source.path === path),
    );
    if (state.draft && state.draft.values) {
      owners.push(state.draft);
    }
    let count = 0;
    owners.forEach((template) => {
      (template.values ? template.values.variants : []).forEach((variant) => {
        if (!isIndependentVariant(variant)) {
          return;
        }
        const existing = textOverrideOf(variant, name, false);
        if (existing && existing[key] !== undefined) {
          return;
        }
        textOverrideOf(variant, name, true)[key] = deepClone(value);
        count += 1;
      });
    });
    return count;
  }

  async function saveOverride(message) {
    if (isDraftSelected()) {
      setStatus(`${message}（按「新增」後存進 module.json）`);
      await showToast("已更新獨立樣板文字");
      return;
    }
    await persist(message, "已更新獨立樣板文字");
  }

  // ----- 格線：直 N 條、橫 N 條等分參考線（畫在圖層上面、選取框下面，不擋拖拉） -----

  function renderGrid() {
    stage.querySelectorAll(".preview-grid-line").forEach((line) => {
      line.parentNode.removeChild(line);
    });
    const grid = readGridSettings();
    if (el("grid-check")) {
      el("grid-check").checked = grid.visible;
    }
    if (!grid.visible || !state.previewCache) {
      return;
    }
    const anchor = state.selection ? state.selection.box : null;
    const addLine = (vertical, percent) => {
      const line = document.createElement("div");
      line.className = `preview-grid-line ${vertical ? "is-vertical" : "is-horizontal"}`;
      line.style[vertical ? "left" : "top"] = `${percent}%`;
      // 在所有圖層之上（與選取框同層、排在它前面，選取框和控制點仍在最上面）
      line.style.zIndex = anchor ? anchor.style.zIndex : String(state.previewCache.order.length + 1);
      if (anchor) {
        stage.insertBefore(line, anchor);
      } else {
        stage.appendChild(line);
      }
    };
    for (let i = 1; i <= grid.vertical; i++) {
      addLine(true, (i * 100) / (grid.vertical + 1));
    }
    for (let i = 1; i <= grid.horizontal; i++) {
      addLine(false, (i * 100) / (grid.horizontal + 1));
    }
  }

  function showGridView(confirm) {
    el("grid-edit-view").style.display = confirm ? "none" : "block";
    el("grid-confirm-view").style.display = confirm ? "block" : "none";
  }

  function readGridFields() {
    const vertical = Number(el("grid-vertical").value.trim());
    const horizontal = Number(el("grid-horizontal").value.trim());
    const valid = (n) => Number.isInteger(n) && n >= 0 && n <= GRID_MAX_LINES;
    if (!valid(vertical) || !valid(horizontal)) {
      el("grid-error").textContent = `請輸入 0～${GRID_MAX_LINES} 的整數`;
      return null;
    }
    el("grid-error").textContent = "";
    return { vertical, horizontal };
  }

  let gridDraft = null;

  async function openGridSettings() {
    const grid = readGridSettings();
    el("grid-vertical").value = String(grid.vertical);
    el("grid-horizontal").value = String(grid.horizontal);
    el("grid-error").textContent = "";
    gridDraft = null;
    showGridView(false);
    if (!(await showDialog(el("grid-dialog"), "格線"))) {
      return;
    }
    if (!gridDraft) {
      return;
    }
    writeGridSettings({ ...readGridSettings(), ...gridDraft });
    renderGrid();
    setStatus(`格線：直 ${gridDraft.vertical} 條、橫 ${gridDraft.horizontal} 條`);
    await showToast("已儲存格線設定");
  }

  function updatePreviewFromFields() {
    applyElementStyle(state.elementName, readFieldsAsSpec());
    updateSelectionBox();
  }

  async function refreshPreview(force) {
    refreshExtraNames();
    if (force) {
      state.overrideImages = {};
    }
    const master = state.master;
    if (!isDocumentOpen(master)) {
      state.previewCache = null;
      renderPreview();
      setStatus(EMPTY_STATUS);
      return;
    }
    if (!force && state.previewCache && state.previewCache.masterId === master.id) {
      renderPreview();
      return;
    }

    setStatus("擷取圖層中，請稍候…");
    try {
      const cache = await getPreviewCache(master, force, mode.required(), layerNames());
      // UXP 每次取得的文件物件不一定是同一個，用 id 判斷是否已切換母版
      if (!state.master || state.master.id !== master.id) {
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
    setPickerIndex(elementPicker, editableNames().indexOf(name));
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
    state.drag.name = name;
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
    if (Math.abs(event.clientX - drag.startX) > 2 || Math.abs(event.clientY - drag.startY) > 2) {
      drag.moved = true;
    }

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
    const drag = state.drag;
    if (!drag) {
      return;
    }
    state.drag = null;
    stage.classList.remove("is-dragging");
    commitFields();
    noteClick(drag);
  }

  // 雙擊圖層改文字：同一圖層、兩次都沒拖動、間隔夠短才算（UXP 不一定有 dblclick 事件）
  function noteClick(drag) {
    if (drag.mode !== "move" || drag.moved) {
      state.lastClick = null;
      return;
    }
    const now = Date.now();
    const last = state.lastClick;
    if (last && last.name === drag.name && now - last.time < DOUBLE_CLICK_MS) {
      state.lastClick = null;
      openTextEditor(drag.name);
      return;
    }
    state.lastClick = { name: drag.name, time: now };
  }

  // 預覽區不吃滑鼠滾輪：避免誤滑讓圖片左右位移，滾輪改為捲動整個面板
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

  // ----- 文字樣式（圖層旁的「編輯」） -----

  const textStyle = { fonts: null, families: [], familiesKey: "", styles: [], pickedFamily: "", align: "left", missing: "" };
  let canvasSizeDraft = null;

  // 樣式列出 100～900 全部粗細：字型有的可以選，沒有的變灰（Photoshop 做不出字型沒有的粗細）
  // 同一個粗細有好幾種樣式（例如 Bold、Bold Italic）就各列一項
  function fillFontStyles(family, preferred) {
    const available = (textStyle.fonts || [])
      .filter((font) => font.family === family)
      .map((font) => font.style)
      .sort((a, b) => fontWeightOf(a) - fontWeightOf(b) || a.localeCompare(b));
    const styles = [];
    const weights = [];
    const labels = [];
    if (available.length) {
      FONT_WEIGHTS.forEach(([weight, name]) => {
        const matches = available.filter((style) => fontWeightOf(style) === weight);
        if (matches.length) {
          matches.forEach((style) => {
            styles.push(style);
            weights.push(weight);
            labels.push(`${weight}　${style}`);
          });
        } else {
          styles.push(null);
          weights.push(weight);
          labels.push(`${weight}　${name}（此字型沒有）`);
        }
      });
    }
    textStyle.styles = styles;
    textStyle.styleWeights = weights;
    textStyle.availableStyles = available;
    const picker = el("text-font-style");
    fillPicker(picker, labels.length ? labels : ["—"]);
    picker.querySelectorAll("sp-menu-item").forEach((item, i) => {
      if (styles[i] === null) {
        item.setAttribute("disabled", "");
      }
    });
    let index = styles.indexOf(preferred);
    if (index < 0) {
      index = styles.indexOf("Regular");
    }
    if (index < 0) {
      index = Math.max(styles.findIndex((style) => style !== null), 0);
    }
    setPickerIndex(picker, index);
    return available;
  }

  // 選到沒有的粗細（變灰的項目）時，改用字型裡最接近的粗細
  function pickedFontStyle() {
    const index = el("text-font-style").selectedIndex;
    const style = textStyle.styles[index];
    if (style || !textStyle.availableStyles || !textStyle.availableStyles.length) {
      return style || "";
    }
    const target = textStyle.styleWeights[index] || 400;
    return textStyle.availableStyles.reduce((best, s) =>
      Math.abs(fontWeightOf(s) - target) < Math.abs(fontWeightOf(best) - target) ? s : best,
    );
  }

  function renderAlignButtons() {
    root.querySelectorAll("[data-text-align]").forEach((button) => {
      const value = button.getAttribute("data-text-align");
      const label = { left: "靠左", center: "置中", right: "靠右" }[value];
      button.textContent = value === textStyle.align ? `✓ ${label}` : label;
    });
  }

  function updateColorSwatch() {
    const value = el("text-color").value.trim();
    const parsed = parseColor(value);
    el("text-color-swatch").style.background = parsed ? parsed.hex : "transparent";
    let hint = "";
    if (!parsed) {
      hint = value ? "看不懂這個顏色，可輸入 #RGB、#RRGGBB、rgb()、rgba()、hsl()、hsla()、hsb()" : "";
    } else if (parsed.alpha < 1) {
      hint = `會套用 ${parsed.hex}（Photoshop 文字顏色沒有透明度，透明度會忽略）`;
    } else if (parsed.hex.toLowerCase() !== value.toLowerCase()) {
      hint = `會套用 ${parsed.hex}`;
    }
    el("text-color-hint").textContent = hint;
  }

  // 色塊點兩下開 Photoshop 檢色器
  async function onSwatchClick() {
    const now = Date.now();
    const last = textStyle.swatchClick || 0;
    textStyle.swatchClick = now;
    if (now - last >= DOUBLE_CLICK_MS || textStyle.picking) {
      return;
    }
    textStyle.swatchClick = 0;
    textStyle.picking = true;
    try {
      const picked = await whilePhotoshopBusy(() => pickColorInPhotoshop(el("text-color").value.trim()));
      if (picked) {
        el("text-color").value = picked;
        updateColorSwatch();
      }
    } catch (error) {
      await app.showAlert(`無法開啟檢色器：${describeModalError(error)}`);
    } finally {
      textStyle.picking = false;
    }
  }

  // ----- 調整版面尺寸（目前選的 Resize 樣板的輸出寬高） -----

  function showCanvasSizeView(confirm) {
    el("canvas-size-edit-view").style.display = confirm ? "none" : "block";
    el("canvas-size-confirm-view").style.display = confirm ? "block" : "none";
  }

  async function openCanvasSize() {
    const variant = currentVariant();
    if (!variant) {
      await app.showAlert(EMPTY_STATUS);
      return;
    }
    commitFields();
    const size = canvasSize();
    el("canvas-width").value = String(size.width);
    el("canvas-height").value = String(size.height);
    el("canvas-size-error").textContent = "";
    showCanvasSizeView(false);
    canvasSizeDraft = null;
    if (!(await showDialog(el("canvas-size-dialog"), `調整版面尺寸：${variantLabel(variant)}`))) {
      return;
    }
    if (!canvasSizeDraft || currentVariant() !== variant) {
      return;
    }
    variant.width = canvasSizeDraft.width;
    variant.height = canvasSizeDraft.height;
    renderPreview();
    const message = `已將「${variantLabel(variant)}」版面尺寸改為 ${variant.width} × ${variant.height} 像素`;
    if (isDraftSelected()) {
      setStatus(`${message}（按「新增」後存進 module.json）`);
      await showToast("已更改版面尺寸");
    } else {
      await persist(message, "已更改版面尺寸");
    }
  }

  function readCanvasSizeFields() {
    const width = Number(el("canvas-width").value.trim());
    const height = Number(el("canvas-height").value.trim());
    const valid = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_CANVAS_SIZE;
    if (!valid(width) || !valid(height)) {
      el("canvas-size-error").textContent = `寬度與高度請輸入 1～${MAX_CANVAS_SIZE} 的整數（像素）`;
      return null;
    }
    return { width, height };
  }

  async function openTextStyle(layerName) {
    const name = layerName || state.elementName;
    if (!isDocumentOpen(state.master)) {
      await app.showAlert(EMPTY_STATUS);
      return;
    }
    commitFields();
    const master = state.master;
    setStatus(`讀取 ${name} 的文字樣式中…`);
    const loading = startLoading("讀取文字樣式…");
    let style;
    try {
      style = await whilePhotoshopBusy(() =>
        readTextStyle(master, name, mode.required(), layerNames()),
      );
      loading.update(10, "載入字型清單…");
      // 字型清單只讀一次（兩個分頁共用），第一次讀會比較久
      textStyle.fonts = textStyle.fonts || (await loadFonts((ratio) => loading.update(10 + ratio * 80)));
      loading.update(90, "建立選單…");
    } catch (error) {
      await loading.done();
      setStatus(`無法讀取文字樣式：${describeModalError(error)}`);
      await app.showAlert(`無法讀取文字樣式：${describeModalError(error)}`);
      return;
    }
    if (!style) {
      await loading.done();
      setStatus(`${name} 沒有文字`);
      await app.showAlert(`${name} 不是文字，請在「圖層」選擇文字圖層（例如 $SM、$TEXT1）。`);
      return;
    }
    const psdStyle = { ...style };
    // 獨立樣板：顯示它自己的樣式（沒有就從 PSD 的開始改）
    const variant = verticalVariant();
    const own = textOverrideOf(variant, name, false);
    if (own && own.style) {
      style = { ...style, ...own.style };
    }

    // 字型清單：目前字型找不到時（缺字型）放在第一項，代表維持不變
    if (!textStyle.sortedFamilies) {
      textStyle.sortedFamilies = [...new Set(textStyle.fonts.map((font) => font.family))].sort((a, b) =>
        a.localeCompare(b),
      );
    }
    const families = textStyle.sortedFamilies;
    const current = textStyle.fonts.find((font) => font.postScriptName === style.font) || null;
    textStyle.missing = current ? "" : style.font;
    textStyle.families = textStyle.missing ? [`（目前字型）${style.font || "未知"}`, ...families] : families;
    // 字型很多時重建選單很慢：清單沒變就沿用
    const familiesKey = textStyle.missing ? `missing:${textStyle.missing}` : "all";
    if (textStyle.familiesKey !== familiesKey) {
      fillPicker(el("text-font-family"), textStyle.families);
      textStyle.familiesKey = familiesKey;
    }
    const familyIndex = current ? textStyle.families.indexOf(current.family) : 0;
    setPickerIndex(el("text-font-family"), Math.max(familyIndex, 0));
    textStyle.pickedFamily = current ? current.family : "";
    fillFontStyles(textStyle.pickedFamily, current ? current.style : "");
    el("text-font-size").value = style.size > 0 ? String(style.size) : "";
    el("text-color").value = style.color;
    textStyle.align = style.align;
    renderAlignButtons();
    updateColorSwatch();
    loading.update(100);
    await loading.done();
    setStatus(`編輯 ${name} 的文字樣式`);

    if (!(await showDialog(el("text-style-dialog"), `文字樣式：${name}`))) {
      setStatus("");
      return;
    }
    const size = parseFloat(el("text-font-size").value);
    const color = parseColor(el("text-color").value);
    if (!(size > 0)) {
      await app.showAlert("請輸入大於 0 的文字大小（pt）。");
      return;
    }
    if (!color) {
      await app.showAlert("看不懂這個顏色，例如 #000000、#000、rgb(0, 0, 0)、rgba(0, 0, 0, 1)、hsl(0, 0%, 0%)。");
      return;
    }
    const familyIndex2 = el("text-font-family").selectedIndex;
    const styleName = pickedFontStyle();
    const family = textStyle.families[familyIndex2];
    const picked = textStyle.fonts.find((font) => font.family === family && font.style === styleName);
    const next = {
      font: picked ? picked.postScriptName : "",
      size,
      color: color.hex,
      align: textStyle.align,
    };
    if (variant) {
      // 獨立樣板：樣式存在這個樣板，不改 PSD
      const override = textOverrideOf(variant, name, true);
      override.style = {
        ...(override.style || {}),
        ...next,
        font: next.font || (override.style && override.style.font) || "",
      };
      if (!override.style.font) {
        delete override.style.font;
      }
      renderPreview();
      await saveOverride(`已更新「${variantLabel(variant)}」自己的 ${name} 文字樣式`);
      return;
    }
    // 共用樣板要改 PSD：還沒有自己樣式的獨立樣板先記下改之前的樣式
    const frozen = freezeIndependent(name, "style", psdStyle);
    setStatus(`更新 ${name} 的文字樣式並存檔中…`);
    try {
      await whilePhotoshopBusy(() =>
        writeTextStyle(master, name, mode.required(), layerNames(), next),
      );
    } catch (error) {
      setStatus(`更新文字樣式失敗：${describeModalError(error)}`);
      await app.showAlert(`更新文字樣式失敗：${describeModalError(error)}`);
      return;
    }
    if (frozen) {
      await persist(`獨立樣板保留原本的 ${name} 文字樣式`);
    }
    if (state.master && state.master.id === master.id) {
      await refreshPreview(true);
    }
    setStatus(`已更新 ${name} 的文字樣式並存檔`);
    await showToast("已更新文字樣式");
  }

  // ----- 刪除文字區塊（$TEXTn 右上角的 ×） -----

  async function deleteTextBlock() {
    const name = state.elementName;
    if (!EXTRA_TEXT_PATTERN.test(name) || !isDocumentOpen(state.master)) {
      return;
    }
    el("delete-text-message").textContent = `請問要刪除文字區塊「${name}」嗎？`;
    if (!(await showDialog(el("delete-text-dialog"), "刪除文字區塊"))) {
      return;
    }
    commitFields();
    const master = state.master;
    try {
      await whilePhotoshopBusy(() =>
        deleteLayerFromMaster(master, name, mode.required(), layerNames()),
      );
    } catch (error) {
      setStatus(`刪除失敗：${describeModalError(error)}`);
      await app.showAlert(`刪除失敗：${describeModalError(error)}`);
      return;
    }
    // 同一份 PSD 的模組一併拿掉這個圖層的位置
    const path = readDocumentPath(master);
    const owners = templates().filter(
      (template) => template === currentTemplate() || (template.source && path && template.source.path === path),
    );
    if (state.draft) {
      owners.push(state.draft);
    }
    owners.forEach((template) => {
      (template.values ? template.values.variants : []).forEach((variant) => {
        delete variant.elements[name];
        if (variant.textOverrides) {
          delete variant.textOverrides[name];
        }
        if (Array.isArray(variant.order)) {
          variant.order = variant.order.filter((item) => item !== name);
        }
      });
    });
    refreshExtraNames();
    state.elementName = editableNames()[0];
    renderAll();
    if (state.master && state.master.id === master.id) {
      await refreshPreview(true);
    }
    const message = `已刪除文字區塊 ${name}`;
    if (currentTemplate() && !isDraftSelected()) {
      await persist(message, "已刪除文字區塊");
    } else {
      setStatus(message);
      await showToast("已刪除文字區塊");
    }
  }

  // ----- 新增文字 -----

  async function addText() {
    if (!isDocumentOpen(state.master)) {
      await app.showAlert(EMPTY_STATUS);
      return;
    }
    commitFields();
    const master = state.master;
    setStatus("新增文字中…");
    let name;
    try {
      name = await whilePhotoshopBusy(() =>
        addTextLayerToMaster(master, mode.required(), layerNames(), DEFAULT_NEW_TEXT),
      );
    } catch (error) {
      setStatus(`新增文字失敗：${describeModalError(error)}`);
      await app.showAlert(`新增文字失敗：${describeModalError(error)}`);
      return;
    }
    if (!state.master || state.master.id !== master.id) {
      return;
    }
    refreshExtraNames();
    state.elementName = name;
    renderAll();
    await refreshPreview(true);
    const message = `已新增 ${name}（雙擊預覽上的文字可修改）`;
    if (currentTemplate() && !isDraftSelected()) {
      await persist(message, "已新增文字");
    } else {
      setStatus(message);
      await showToast("已新增文字");
    }
  }

  // ----- 模組（template）-----

  function selectTemplate(index) {
    commitFields();
    state.templateIndex = index;
    state.variantIndex = 0;
    if (applyExtras) {
      applyExtras.resetOutputs();
      applyExtras.load();
    }
    clampSelection();
    // 不在下拉自己的 change 事件裡重畫它（UXP 會讓下拉卡住點不了）
    renderVariantPicker();
    loadFields();
    loadTemplateSource(currentTemplate());
  }

  /**
   * 每個模組記得自己的 PSD：選模組時預覽改用該模組的來源 PSD。
   * 已在 Photoshop 開啟就直接用（不切換 Photoshop 文件）；沒開就依記錄的路徑開啟，
   * 開不了（沒有權限或檔案已移動）時清空預覽並提示重新「上傳.psd」。
   * 沒有來源的模組（內建「預設」）沿用目前的預覽 PSD。
   */
  async function loadTemplateSource(template) {
    const request = (state.sourceRequest = (state.sourceRequest || 0) + 1);
    if (template && template === state.draft) {
      const doc = findOpenDocumentById(state.draft.draftFor);
      if (doc) {
        state.master = doc;
      }
      refreshPreview(false);
      return;
    }
    if (!template || !template.source) {
      refreshPreview(false);
      return;
    }
    const opened = findOpenDocumentForTemplate(template);
    if (opened) {
      useTemplateMaster(opened, template);
      return;
    }
    state.master = null;
    state.previewCache = null;
    renderPreview();
    const fileName = template.source.fileName || "PSD";
    setStatus(`開啟 ${fileName} 中…`);
    const file = await resolveSrcFolder(template.source.path);
    if (request !== state.sourceRequest) {
      return; // 期間又選了別的模組
    }
    if (!file) {
      setStatus(`找不到 ${fileName}，請按「上傳.psd」重新選擇這份 PSD。`);
      return;
    }
    try {
      const doc = await openPsdAsMaster(file);
      if (request === state.sourceRequest) {
        useTemplateMaster(doc, template);
      }
    } catch (error) {
      if (request === state.sourceRequest) {
        setStatus(`無法開啟 ${fileName}：${error.message || error}`);
      }
    }
  }

  async function useTemplateMaster(doc, template) {
    const problem = mode.masterProblem(doc);
    if (problem) {
      state.master = null;
      state.previewCache = null;
      renderPreview();
      setStatus(`${template.source.fileName}：${problem}`);
      return;
    }
    if (!state.master || state.master.id !== doc.id) {
      state.previewCache = null;
    }
    state.master = doc;
    await mode.onMaster(doc);
    if (applyExtras) {
      applyExtras.load();
    }
    refreshPreview(false);
  }

  async function uploadPsd() {
    // 已帶入 PSD、模組名稱也填好但還沒按「新增」才提醒；其餘直接開啟選擇檔案
    const pendingDraft =
      isDraftSelected() &&
      templateNameInput.value.trim() &&
      isDocumentOpen(state.master) &&
      state.draft.draftFor === state.master.id;
    if (pendingDraft) {
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
      // 記住這份 PSD 的授權，之後選它的模組時可以直接重新開啟
      rememberSrcFolder(file.nativePath, await localFileSystem.createPersistentToken(file));
    } catch (_error) {
      // 記不住就等下次再上傳
    }

    try {
      state.sourceRequest = (state.sourceRequest || 0) + 1;
      const doc = await openPsdAsMaster(file);
      const problem = mode.masterProblem(doc);
      if (problem) {
        throw new Error(problem);
      }
      state.master = doc;
      await mode.onMaster(doc);
      const existing = findTemplateIndexIn(templates(), doc);
      if (existing >= 0) {
        templateNameInput.value = "";
        templateNameInput.classList.remove("is-suggested");
        state.draft = null;
        state.templateIndex = existing;
        state.variantIndex = 0;
        renderAll();
        setStatus(`${doc.name} 已有模組「${templates()[existing].name}」。`);
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
    if (templates().some((template) => template.name === name)) {
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
    const values = draft ? draft.values : mode.initialValues(state.master);
    const variantIndex = draft && isDraftSelected() ? state.variantIndex : 0;
    state.draft = null;
    templates().push({
      name,
      source: {
        fileName: state.master.name,
        path: readDocumentPath(state.master),
      },
      values,
      ...(isApply
        ? { layers: draft ? draft.layers : [], srcPath: draft ? draft.srcPath : "" }
        : {}),
    });
    state.templateIndex = templates().length - 1;
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
    if (isApply) {
      const doc = isDocumentOpen(state.master) ? state.master : null;
      if (doc) {
        try {
          return mode.initialValues(doc).variants[0].elements;
        } catch (_error) {
          // 量不到就沿用目前的數值
        }
      }
      return deepClone(variant.elements);
    }
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
    listItems: () => templates(),
    getName: (template) => template.name,
    setName: (template, name) => {
      template.name = name;
    },
    isSameName: (a, b) => a === b,
    // 「預設」模組是新模組複製的來源，不開放刪除（可改名）
    canDelete: (template) => !template.builtin,
    remove: (template) => {
      const index = templates().indexOf(template);
      if (index < 0) {
        return;
      }
      templates().splice(index, 1);
      if (state.templateIndex > index || state.templateIndex >= templates().length) {
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
    const entry = (state.templateEntries || [])[readPickerIndex(event)];
    if (entry) {
      selectTemplate(entry.index);
    }
  });

  variantPicker.addEventListener("change", async (event) => {
    commitFields();
    if (isApply) {
      // 第 0 項是預設版面，其餘是各組換圖（各自的版面）
      await applyExtras.showOutput(readPickerIndex(event));
      loadFields();
      return;
    }
    state.variantIndex = readPickerIndex(event);
    updateVariantNameValidity();
    loadFields();
    renderPreview();
  });

  elementPicker.addEventListener("change", (event) => {
    commitFields();
    state.elementName = editableNames()[readPickerIndex(event)];
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
  el("btn-add-text").addEventListener("click", addText);
  el("text-font-family").addEventListener("change", (event) => {
    const family = textStyle.families[readPickerIndex(event)];
    textStyle.pickedFamily = family;
    fillFontStyles(family, "");
  });
  root.querySelectorAll("[data-text-align]").forEach((button) => {
    button.addEventListener("click", () => {
      textStyle.align = button.getAttribute("data-text-align");
      renderAlignButtons();
    });
  });
  el("text-color").addEventListener("input", updateColorSwatch);
  el("text-color-swatch").addEventListener("click", onSwatchClick);
  el("grid-check").addEventListener("change", () => {
    writeGridSettings({ ...readGridSettings(), visible: el("grid-check").checked });
    renderGrid();
  });
  el("btn-grid").addEventListener("click", openGridSettings);
  root.querySelectorAll("[data-grid-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = el(`grid-${button.getAttribute("data-grid-step")}`);
      const current = parseInt(input.value, 10);
      const step = button.getAttribute("data-grid-dir") === "up" ? 1 : -1;
      const next = (Number.isFinite(current) ? current : 0) + step;
      input.value = String(clampNumber(next, 0, GRID_MAX_LINES));
    });
  });
  ["grid-vertical", "grid-horizontal"].forEach((role) => {
    // 只能輸入數字
    el(role).addEventListener("input", () => {
      const digits = el(role).value.replace(/[^0-9]/g, "");
      if (digits !== el(role).value) {
        el(role).value = digits;
      }
    });
  });
  el("btn-grid-cancel").addEventListener("click", () => el("grid-dialog").close("cancel"));
  el("btn-grid-save").addEventListener("click", () => {
    const grid = readGridFields();
    if (!grid) {
      return;
    }
    gridDraft = grid;
    showGridView(true);
  });
  el("btn-grid-confirm-cancel").addEventListener("click", () => {
    gridDraft = null;
    showGridView(false);
  });
  el("btn-grid-confirm-ok").addEventListener("click", () => el("grid-dialog").close("confirm"));
  if (el("independent-check")) {
    el("independent-check").addEventListener("change", () => {
      const variant = currentVariant();
      if (!variant) {
        updateIndependentCheck();
        return;
      }
      if (el("independent-check").checked) {
        variant.independent = true;
      } else {
        delete variant.independent;
      }
      renderPreview();
      setStatus(
        variant.independent
          ? `「${variantLabel(variant)}」設為獨立：文字與圖層大小只改這個樣板，按「儲存設定值」保存`
          : `「${variantLabel(variant)}」改回共用：按「儲存設定值」保存`,
      );
    });
  }
  if (el("btn-canvas-size")) {
    el("btn-canvas-size").addEventListener("click", openCanvasSize);
    el("btn-canvas-size-cancel").addEventListener("click", () => el("canvas-size-dialog").close("cancel"));
    el("btn-canvas-size-save").addEventListener("click", () => {
      const size = readCanvasSizeFields();
      if (!size) {
        return;
      }
      canvasSizeDraft = size;
      el("canvas-size-confirm-text").textContent =
        `確認要更改此版面尺寸？（${size.width} × ${size.height} 像素）`;
      showCanvasSizeView(true);
    });
    el("btn-canvas-size-confirm-cancel").addEventListener("click", () => {
      canvasSizeDraft = null;
      showCanvasSizeView(false);
    });
    el("btn-canvas-size-confirm-ok").addEventListener("click", () => {
      el("canvas-size-dialog").close("confirm");
    });
  }
  el("btn-text-style-save").addEventListener("click", () => el("text-style-dialog").close("confirm"));
  el("btn-text-style-cancel").addEventListener("click", () => el("text-style-dialog").close("cancel"));
  el("btn-delete-text-confirm").addEventListener("click", () => el("delete-text-dialog").close("confirm"));
  el("btn-delete-text-cancel").addEventListener("click", () => el("delete-text-dialog").close("cancel"));
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
    if (!currentTemplate()) {
      await app.showAlert(EMPTY_STATUS);
      return;
    }
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
      await app.showAlert(EMPTY_STATUS);
      return;
    }
    if (isApply && isDraftSelected()) {
      await app.showAlert("請點選新增模組");
      return;
    }
    if (!(await persist("設定已儲存"))) {
      return;
    }
    if (isApply) {
      await applyExtras.generate(template);
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
    const registered = state.draft ? findTemplateIndexIn(templates(), state.master) : -1;
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
      values: mode.initialValues(doc),
      ...(isApply ? { layers: [], srcPath: "" } : {}),
    };
    if (applyExtras) {
      applyExtras.resetOutputs();
    }
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
      Boolean(mode.validMaster(state.master)) &&
      findTemplateIndexIn(templates(), state.master) < 0
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
    const existing = master ? findTemplateIndexIn(templates(), master) : -1;
    state.draft = null;
    // 沒有母版（剛按「開始執行」）時什麼都不選，等「上傳.psd」
    state.templateIndex = master ? Math.max(existing, 0) : -1;
    state.variantIndex = 0;
    state.elementName = editableNames()[0];
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
    // 每個分頁的 PSD 都只由自己的「上傳.psd」帶入，不沿用 Photoshop 作用中的文件
    if (!isDocumentOpen(state.master)) {
      return;
    }
    // 分頁隱藏時量不到寬度，切回來再重新擷取或排版
    refreshPreview(false);
  }

  // ----- 套圖專用：勾選換圖圖層、必選、圖檔 src、預覽套圖、產出套圖 -----

  function setupApplyExtras() {
    const layerToggle = el("layer-toggle");
    const layerPanel = el("layer-panel");
    const srcInput = el("src-path");
    // 套圖圖層下拉的勾選框依圖層清單產生：name -> checkbox
    let layerBoxes = new Map();

    // UXP 不支援 z-index：把下拉清單移到分頁最後，打開時依按鈕位置定位
    root.appendChild(layerPanel);

    function presentLayers() {
      const names = layerNames();
      if (!isDocumentOpen(state.master)) {
        return names;
      }
      try {
        const required = applyRequiredLayers();
        return Object.keys(
          requireMcdSmartLayers(getMcdSourceContainer(state.master, required, names), required, names),
        );
      } catch (_error) {
        return names;
      }
    }

    function checkedLayers() {
      return [...layerBoxes.keys()].filter((name) => {
        const box = layerBoxes.get(name);
        return box && box.checked;
      });
    }

    function onLayerChecked() {
      updateToggleLabel();
      commit();
      resetOutputs();
      renderVariantPicker();
      renderPreview();
    }

    // 套圖圖層的勾選清單：有 PSD 時＝PSD 裡的 $ 圖層，沒有 PSD 時＝圖層清單
    function panelLayerNames() {
      if (!isDocumentOpen(state.master)) {
        return applyLayerNames();
      }
      const present = presentLayers();
      return editableNames().filter((name) => present.includes(name));
    }

    function renderLayerPanel() {
      layerPanel.innerHTML = "";
      layerBoxes = new Map();
      for (const name of panelLayerNames()) {
        const label = document.createElement("label");
        label.className = "layer-check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.setAttribute("data-layer-name", name);
        box.addEventListener("change", onLayerChecked);
        label.appendChild(box);
        label.appendChild(document.createTextNode(name));
        layerPanel.appendChild(label);
        layerBoxes.set(name, box);
      }
    }

    function updateToggleLabel() {
      const layers = checkedLayers();
      layerToggle.textContent = layers.length ? layers.join("、") : "（尚未勾選圖層）";
    }

    function load() {
      const template = currentTemplate();
      const layers = (template && template.layers) || [];
      const present = presentLayers();
      renderLayerPanel();
      layerBoxes.forEach((box, name) => {
        box.checked = layers.includes(name);
        box.disabled = !present.includes(name);
        box.parentElement.classList.toggle("is-missing", box.disabled);
      });
      srcInput.value = (template && template.srcPath) || "";
      updateToggleLabel();
    }

    function commit() {
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
      state.variantIndex = 0;
    }

    // 每組套圖有自己的版面（同名 variant）；第一次選到時從預設複製一份
    function variantForSet(set) {
      const template = currentTemplate();
      if (!template) {
        return null;
      }
      const variants = template.values.variants;
      let variant = variants.find((item) => item.outputDocument === set.name);
      if (!variant) {
        variant = deepClone(variants[0]);
        variant.outputDocument = set.name;
        variants.push(variant);
      }
      return variant;
    }

    function currentSet() {
      return state.outputIndex > 0 ? state.sets[state.outputIndex - 1] || null : null;
    }

    function imageKey(file) {
      return file.nativePath || file.name;
    }

    function replacementFor(name) {
      const set = currentSet();
      const file = set && set.files[name];
      const info = file && state.imageInfos[imageKey(file)];
      return info && info.width > 0
        ? { dataUrl: info.url, width: info.width, height: info.height }
        : null;
    }

    async function preloadSet(set) {
      if (!set) {
        return;
      }
      for (const file of Object.values(set.files)) {
        const key = imageKey(file);
        if (!state.imageInfos[key]) {
          try {
            state.imageInfos[key] = await readTrimmedImageInfo(file, state.master);
          } catch (error) {
            setStatus(`無法讀取 ${file.name}：${error.message || error}`);
          }
        }
      }
    }

    async function showOutput(index) {
      state.outputIndex = index;
      const set = currentSet();
      const variant = set ? variantForSet(set) : null;
      const variants = currentTemplate() ? currentTemplate().values.variants : [];
      state.variantIndex = variant ? variants.indexOf(variant) : 0;
      await preloadSet(set);
      if (state.outputIndex === index) {
        renderPreview();
      }
    }

    async function buildSets() {
      const template = currentTemplate();
      const present = presentLayers();
      const layers = template && template.layers
        ? template.layers.filter((name) => present.includes(name))
        : [];
      if (!layers.length) {
        await app.showAlert("請先在「套圖圖層」勾選要換圖的圖層（PSD 裡要有這個圖層）。");
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
      const summary = layers.map((name) => `${name} ${perLayer[name].length} 張`).join("、");
      if (!sets.length) {
        await app.showAlert(`資料夾裡找不到圖檔（${summary}）。子資料夾名稱需為圖層名去掉 $，例如 PROD、CTA。`);
        return null;
      }
      return { sets, summary };
    }

    async function previewApply() {
      commitFields();
      const result = await buildSets();
      if (!result) {
        return;
      }
      state.sets = result.sets;
      // 每一組的版面都記錄到 module.json（尚未新增的模組等按「新增」時一起存）
      state.sets.forEach(variantForSet);
      await showOutput(1);
      renderVariantPicker();
      loadFields();
      const message = `找到 ${result.sets.length} 組（${result.summary}）`;
      if (isDraftSelected()) {
        setStatus(`${message}；請按「新增」把這個模組存進 module.json`);
      } else {
        await persist(message);
      }
    }

    async function generate(template) {
      if (!state.sets.length) {
        const result = await buildSets();
        if (!result) {
          return;
        }
        state.sets = result.sets;
        await showOutput(1);
        renderVariantPicker();
      }
      if (!(await persist("設定已儲存"))) {
        return;
      }
      try {
        const done = await whilePhotoshopBusy(() =>
          generateApplyDocuments(state.master, state.sets, (set) => {
            const variants = template.values.variants;
            return variants.find((item) => item.outputDocument === set.name) || variants[0];
          }),
        );
        if (done) {
          setStatus(`已產出 ${done} 個套圖檔案`);
          await showToast(`已產出 ${done} 個套圖檔案`);
        }
      } catch (error) {
        await app.showAlert(`套圖產製失敗：${error.message || error}`);
      }
      refreshPreview(false);
    }

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
      try {
        rememberSrcFolder(folder.nativePath, await localFileSystem.createPersistentToken(folder));
      } catch (_error) {
        // 無法記住授權，下次需要再選一次
      }
      srcInput.value = folder.nativePath;
      commit();
      resetOutputs();
      renderVariantPicker();
      renderPreview();
    }

    // ----- 圖層「編輯」：套圖可用的圖層清單；勾選＝PSD 必須有（必選） -----

    const layerList = {
      dialog: el("layer-list-dialog"),
      list: el("layer-list"),
      listView: el("layer-list-view"),
      deleteView: el("layer-delete-view"),
      deleteText: el("layer-delete-text"),
      rows: [],
      pendingDelete: null,
    };

    function showLayerListView(confirmDelete) {
      layerList.listView.style.display = confirmDelete ? "none" : "block";
      layerList.deleteView.style.display = confirmDelete ? "block" : "none";
    }

    function layerRowButton(label, disabled, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small-btn";
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener("click", onClick);
      return button;
    }

    function renderLayerList() {
      layerList.list.innerHTML = "";
      const { rows } = layerList;
      rows.forEach((row) => {
        const line = document.createElement("div");
        line.className = "manager-row";

        if (row.editing) {
          const input = document.createElement("input");
          input.type = "text";
          input.className = "text-input manager-name";
          input.placeholder = "輸入圖層名稱";
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
          label.textContent = row.name;
          // 點名稱也可以直接改名
          label.addEventListener("click", () => {
            row.editing = true;
            renderLayerList();
          });
          line.appendChild(label);
        }

        line.appendChild(
          layerRowButton("編輯", row.editing, () => {
            row.editing = true;
            renderLayerList();
          }),
        );
        line.appendChild(
          layerRowButton("刪除", rows.length <= 1, () => {
            if (!row.original) {
              // 還沒儲存的新圖層直接拿掉
              layerList.rows = rows.filter((item) => item !== row);
              renderLayerList();
              return;
            }
            layerList.pendingDelete = row;
            layerList.deleteText.textContent = `請問確認刪除圖層「${row.original}」嗎？`;
            showLayerListView(true);
          }),
        );
        layerList.list.appendChild(line);
      });
    }

    function openLayerList() {
      commitFields();
      const required = applyRequiredLayers();
      layerList.rows = applyLayerNames().map((name) => ({
        original: name,
        name,
        required: required.includes(name),
        editing: false,
        invalid: false,
      }));
      layerList.pendingDelete = null;
      renderLayerList();
      showLayerListView(false);
      showDialog(layerList.dialog, "編輯圖層", {
        resize: "both",
        size: { width: 460, height: 380 },
      });
    }

    function addLayerRow() {
      layerList.rows.push({
        original: null,
        name: "",
        required: false,
        editing: true,
        invalid: false,
      });
      renderLayerList();
    }

    // 模組資料（含尚未新增的草稿）裡的圖層名稱一起改／刪
    function eachApplyTemplate(callback) {
      const list = templates().slice();
      if (state.draft && !list.includes(state.draft)) {
        list.push(state.draft);
      }
      list.forEach(callback);
    }

    function renameLayerData(renames) {
      const mapName = (name) => (renames.has(name) ? renames.get(name) : name);
      eachApplyTemplate((template) => {
        if (Array.isArray(template.layers)) {
          template.layers = template.layers.map(mapName);
        }
        const variants = template.values ? template.values.variants : [];
        variants.forEach((variant) => {
          const elements = {};
          Object.keys(variant.elements).forEach((name) => {
            elements[mapName(name)] = variant.elements[name];
          });
          variant.elements = elements;
          if (Array.isArray(variant.order)) {
            variant.order = variant.order.map(mapName);
          }
        });
      });
      state.elementName = mapName(state.elementName);
    }

    function removeLayerData(name) {
      eachApplyTemplate((template) => {
        if (Array.isArray(template.layers)) {
          template.layers = template.layers.filter((item) => item !== name);
        }
        const variants = template.values ? template.values.variants : [];
        variants.forEach((variant) => {
          delete variant.elements[name];
          if (Array.isArray(variant.order)) {
            variant.order = variant.order.filter((item) => item !== name);
          }
        });
      });
    }

    async function confirmDeleteLayer() {
      const row = layerList.pendingDelete;
      layerList.pendingDelete = null;
      showLayerListView(false);
      if (!row) {
        return;
      }
      layerList.rows = layerList.rows.filter((item) => item !== row);
      moduleStore.applyLayers = applyLayerNames().filter((name) => name !== row.original);
      moduleStore.applyRequiredLayers = (moduleStore.applyRequiredLayers || []).filter(
        (name) => name !== row.original,
      );
      removeLayerData(row.original);
      renderLayerList();
      await persist(`已刪除圖層「${row.original}」`);
      reopenAfterLayerChange();
    }

    async function saveLayerList() {
      const { rows } = layerList;
      let valid = true;
      rows.forEach((row, i) => {
        const name = row.name.trim();
        const duplicate = rows.some((other, j) => j !== i && other.name.trim() === name);
        row.invalid = !name || duplicate;
        if (row.invalid) {
          row.editing = true;
          valid = false;
        }
      });
      if (!valid || !rows.length) {
        renderLayerList();
        return;
      }
      const renames = new Map();
      rows.forEach((row) => {
        const name = row.name.trim();
        if (row.original && row.original !== name) {
          renames.set(row.original, name);
        }
      });
      const added = rows.filter((row) => !row.original).length;
      renameLayerData(renames);
      moduleStore.applyLayers = rows.map((row) => row.name.trim());
      moduleStore.applyRequiredLayers = rows
        .filter((row) => row.required)
        .map((row) => row.name.trim());
      layerList.dialog.close("save");
      await persist(
        added ? `已新增 ${added} 個圖層` : "已儲存圖層設定",
        added ? "新增成功" : "已儲存圖層設定",
      );
      reopenAfterLayerChange();
    }

    // 圖層清單或必選改了：重新檢查母版並重新擷取預覽
    function reopenAfterLayerChange() {
      const candidate = isDocumentOpen(state.master) ? state.master : null;
      const doc = mode.validMaster(candidate);
      if (doc) {
        open(doc, "");
        refreshPreview(true);
      } else {
        renderAll();
        if (candidate) {
          setStatus(mode.masterProblem(candidate));
        }
      }
    }

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
    srcInput.addEventListener("change", () => {
      commit();
      resetOutputs();
      renderVariantPicker();
      renderPreview();
    });
    el("btn-pick-src").addEventListener("click", pickSrcFolder);
    el("btn-preview-apply").addEventListener("click", previewApply);
    el("btn-edit-layers").addEventListener("click", openLayerList);
    el("btn-layer-add").addEventListener("click", addLayerRow);
    el("btn-layer-list-save").addEventListener("click", saveLayerList);
    el("btn-layer-list-cancel").addEventListener("click", () => layerList.dialog.close("cancel"));
    el("btn-layer-delete-confirm").addEventListener("click", confirmDeleteLayer);
    el("btn-layer-delete-cancel").addEventListener("click", () => {
      layerList.pendingDelete = null;
      showLayerListView(false);
    });

    return { load, commit, resetOutputs, replacementFor, showOutput, generate, variantForSet };
  }

  if (isApply) {
    applyExtras = setupApplyExtras();
  }

  return workspace;
}


// ---------- 套圖：依 PSD 原稿位置，把勾選的圖層換成資料夾裡的圖 ----------
//
// 套圖模組（module.json 的 image-set，與 Resize 分開）：
//   { name, source: { fileName, path }, layers: ["$PROD", "$CTA"], srcPath: "…/MCD" }
// 圖檔資料夾結構：srcPath/PROD/01.jpg、02.jpg…；srcPath/CTA/01.jpg…（資料夾名稱＝圖層名去掉 $）
// 第 n 組＝各圖層資料夾排序後的第 n 張，產出「套圖0n.psd」；某圖層沒有第 n 張時保留原圖。

const APPLY_LAYER_NAMES = ["$LOGO", "$PROD", "$HEAD", "$CTA", "$SM", "$BG"];
const APPLY_IMAGE_PATTERN = /\.(jpe?g|png|psd|psb|tiff?|webp|gif|bmp)$/i;
const SRC_FOLDER_TOKENS_KEY = "bannerResizer.srcFolderTokens";

// 套圖的圖層清單：不重複、非空白的名稱；未設定（舊的 module.json）時用預設六個
function normalizeApplyLayers(raw) {
  if (!Array.isArray(raw)) {
    return APPLY_LAYER_NAMES.slice();
  }
  const out = [];
  for (const item of raw) {
    const name = String(item == null ? "" : item).trim();
    if (name && !out.includes(name)) {
      out.push(name);
    }
  }
  return out.length ? out : APPLY_LAYER_NAMES.slice();
}

function applyLayerNames() {
  return moduleStore.applyLayers || APPLY_LAYER_NAMES;
}

// 套圖的可設定位置圖層（$BG 另外處理）
function applyPositionNames() {
  return applyLayerNames().filter((name) => name !== "$BG");
}

// 未設定（舊的 module.json）時六個都必須；設定過就照清單（可以是空的）
function normalizeRequiredLayers(raw, names = APPLY_LAYER_NAMES) {
  if (!Array.isArray(raw)) {
    return MCD_SMART_LAYER_NAMES.filter((name) => names.includes(name));
  }
  return names.filter((name) => raw.includes(name));
}

function applyRequiredLayers() {
  // 不再要求必選圖層：PSD 裡有哪些 $ 圖層就用哪些
  return [];
}

// 套圖用的母版檢查：PSD 裡要有 $ 開頭的圖層
function validApplyMasterOrNull(doc) {
  return validMasterOrNull(doc);
}

function applyMasterProblem(doc) {
  return dollarMasterProblem(doc);
}

function normalizeApplyTemplate(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const layers = Array.isArray(raw.layers)
    ? normalizeApplyLayers(raw.layers).filter((name) => raw.layers.includes(name))
    : [];
  const out = {
    name: String(raw.name || "").trim(),
    source: raw.source && typeof raw.source === "object" ? { ...raw.source } : null,
    layers,
    srcPath: String(raw.srcPath || "").trim(),
  };
  // 版面（與 Resize 相同格式）；舊的套圖模組沒有，開啟母版時依 PSD 原稿補上
  if (raw.values && typeof raw.values === "object") {
    const normalized = normalizeTemplate({ name: out.name, values: raw.values });
    out.values = normalized.values;
    if (!out.values.variants.length) {
      out.values.variants.push({ outputDocument: "預設", elements: deepClone(DEFAULT_VARIANT_ELEMENTS) });
    }
    // 層級順序可含自訂圖層，不套用 Resize 的五個圖層限制
    const rawVariants = Array.isArray(raw.values.variants) ? raw.values.variants : [];
    out.values.variants.forEach((variant, index) => {
      const order = rawVariants[index] && rawVariants[index].order;
      if (Array.isArray(order) && order.every((name) => typeof name === "string")) {
        variant.order = order.filter((name, i) => order.indexOf(name) === i);
      }
    });
  }
  return out;
}

/**
 * 套圖的預設版面：PSD 原稿各圖層的位置與大小（畫布百分比），畫布＝原稿尺寸。
 * 各組換圖第一次選到時從「預設」複製一份自己的版面，可再用「同步圖層」統一。
 */
function applyInitialValues(doc) {
  const measured = measureLayerFrames(doc, applyRequiredLayers(), applyLayerNames());
  const elements = {};
  for (const name of applyPositionNames()) {
    const frame = measured.frames[name];
    // 框＝原圖層的位置與大小：換上的圖等比塞進這個框並置中
    elements[name] = frame
      ? {
          leftPercent: roundTo(frame.left, 2),
          topPercent: roundTo(frame.top, 2),
          widthPercent: roundTo(frame.width, 2),
          heightPercent: roundTo(frame.height, 2),
          centered: true,
        }
      : defaultSpecFor(name);
  }
  if (measured.frames.$BG) {
    elements.$BG = {
      leftPercent: roundTo(measured.frames.$BG.left, 2),
      topPercent: roundTo(measured.frames.$BG.top, 2),
      widthPercent: roundTo(measured.frames.$BG.width, 2),
    };
  }
  return {
    width: Math.round(measured.width),
    height: Math.round(measured.height),
    variants: [{ outputDocument: "預設", elements }],
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
 * 找到圖檔資料夾（或上傳過的 PSD 檔）：先用「選擇資料夾」／「上傳.psd」記住的授權，
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
function measureLayerFrames(master, required = MCD_SMART_LAYER_NAMES, names = MCD_SMART_LAYER_NAMES) {
  const container = getMcdSourceContainer(master, required, names);
  const layers = requireMcdSmartLayers(container, required, names);
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
 * 套圖預覽用的換圖資訊，去掉透明邊。
 * Photoshop 換圖後量到的圖層範圍不含透明像素，產出時是「看得到的部分」塞進框；
 * 預覽若用整張檔案（含透明邊）的寬高，圖會顯得比產出小很多。
 * 有透明圖層的圖檔先在 Photoshop 開啟、裁掉透明邊再匯出預覽；
 * 不透明（背景圖層）或讀不到時直接讀檔頭寬高。
 */
async function readTrimmedImageInfo(imageFile, master) {
  let trimmed = null;
  try {
    const tempFolder = await localFileSystem.getTemporaryFolder();
    const out = await tempFolder.createFile(`apply-preview-${Date.now()}.png`, { overwrite: true });
    await whilePhotoshopBusy(() =>
      runModal(async () => {
        try {
          trimmed = await exportTrimmedImagePng(imageFile, out);
        } finally {
          if (isDocumentOpen(master)) {
            app.activeDocument = master;
          }
        }
      }, "擷取套圖預覽"),
    );
    if (trimmed) {
      const buffer = await out.read({ format: formats.binary });
      return {
        url: `data:image/png;base64,${arrayBufferToBase64(buffer)}`,
        width: trimmed.width,
        height: trimmed.height,
      };
    }
  } catch (_error) {
    // 改讀檔頭
  }
  return readImageInfo(imageFile);
}

// 回傳裁掉透明邊後的寬高；不需要裁（不透明、多圖層）時回傳 null
async function exportTrimmedImagePng(imageFile, outFile) {
  const doc = await app.open(imageFile);
  try {
    const layers = doc.layers || [];
    if (layers.length !== 1 || layers[0].isBackgroundLayer) {
      return null;
    }
    const layer = layers[0];
    const b = readLayerBounds(layer);
    const width = Math.round(b.right - b.left);
    const height = Math.round(b.bottom - b.top);
    const fullWidth = Math.round(unitNumber(doc.width));
    const fullHeight = Math.round(unitNumber(doc.height));
    if (!(width >= 1 && height >= 1) || (width >= fullWidth && height >= fullHeight)) {
      return null;
    }
    await translateLayer(layer, -b.left, -b.top);
    await doc.resizeCanvas(width, height, constants.AnchorPosition.TOPLEFT);
    if (width > PREVIEW_MAX_LAYER_WIDTH) {
      await doc.resizeImage(
        PREVIEW_MAX_LAYER_WIDTH,
        Math.max(Math.round((height * PREVIEW_MAX_LAYER_WIDTH) / width), 1),
      );
    }
    await doc.saveAs.png(outFile, { compression: 6 }, true);
    return { width, height };
  } finally {
    await closeDocumentQuietly(doc);
  }
}

/**
 * 替換智慧型物件內容，並把新圖等比縮放塞回原本圖層的框內、置中，
 * 所以位置與大小都和原稿一致。
 */
async function replaceLayerImage(layer, imageFile) {
  if (!isSmartObject(layer)) {
    throw new Error(`${layer.name} 不是智慧型物件，無法替換圖片`);
  }
  const originalName = layer.name;
  const before = boundsBox(layer);
  await selectOnlyLayer(layer);
  const token = localFileSystem.createSessionToken(imageFile);
  await action.batchPlay(
    [{ _obj: "placedLayerReplaceContents", null: { _path: token, _kind: "local" } }],
    { synchronousExecution: true },
  );
  // 「取代內容」會把圖層改名成新圖檔的檔名（$CTA → 01），改回原名，後續才找得到
  await action.batchPlay(
    [{ _obj: "set", _target: [{ _ref: "layer", _id: layer.id }], to: { _obj: "layer", name: originalName } }],
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
// variantFor(set)：這一組要用的版面
async function generateApplyDocuments(master, sets, variantFor) {
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
          const required = applyRequiredLayers();
          const names = withExtraNames(applyLayerNames(), dollarLayerNames(copy));
          const container = getMcdSourceContainer(copy, required, names);
          for (const name of Object.keys(set.files)) {
            const layer = findNamedLayer(container, name);
            if (!layer) {
              throw new Error(`找不到圖層 ${name}`);
            }
            await replaceLayerImage(layer, set.files[name]);
          }
          // 再依面板上這一組的版面（靠左／靠上／寬度／高度）擺放每個圖層
          const variant = variantFor(set);
          if (variant && variant.width > 0 && variant.height > 0) {
            // 「調整版面尺寸」：先把畫布改成這一組的尺寸（置中），再照百分比排版
            if (container !== copy) {
              throw new Error("PSD 使用工作區域，暫不支援調整版面尺寸");
            }
            await copy.resizeCanvas(variant.width, variant.height, constants.AnchorPosition.MIDDLECENTER);
          }
          if (variant) {
            const frame =
              container === copy
                ? { left: 0, top: 0, right: unitNumber(copy.width), bottom: unitNumber(copy.height) }
                : readLayerBounds(container);
            const layers = requireMcdSmartLayers(container, required, names);
            for (const name of Object.keys(layers)) {
              const spec = variant.elements[name];
              if (spec) {
                await layoutInFrame(layers[name], frame, spec, name);
              }
            }
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

// ---------- 預覽上雙擊改文字 ----------
//
// 圖層本身是文字圖層就直接改；群組找裡面的文字圖層；
// 智慧型物件（例如 $SM 內含 TEXT 123.psb）先「編輯內容」打開，改完存檔關閉，
// 外層的智慧型物件就會跟著更新。改完把 PSD 存檔。

function isTextLayer(layer) {
  return Boolean(layer && layer.kind === constants.LayerKind.TEXT);
}

// 由上往下找出容器內所有文字圖層
function collectTextLayers(container) {
  const out = [];
  (function walk(node) {
    for (const layer of listLayers(node)) {
      if (isTextLayer(layer)) {
        out.push(layer);
      } else if (canSearchChildren(layer)) {
        walk(layer);
      }
    }
  })(container);
  return out;
}

async function readLayerText(doc, layer) {
  try {
    if (layer.textItem && typeof layer.textItem.contents === "string") {
      return layer.textItem.contents;
    }
  } catch (_error) {
    // 舊版 Photoshop 沒有 textItem，改用 batchPlay
  }
  const result = await action.batchPlay(
    [
      {
        _obj: "get",
        _target: [
          { _property: "textKey" },
          { _ref: "layer", _id: layer.id },
          { _ref: "document", _id: doc.id },
        ],
      },
    ],
    { synchronousExecution: true },
  );
  const key = result && result[0] && result[0].textKey;
  return key && typeof key.textKey === "string" ? key.textKey : "";
}

async function writeLayerText(layer, text) {
  try {
    // 文字一樣就不要重寫：重寫會讓整段變成第一個字的樣式（混合的字型／粗細會不見）
    if (layer.textItem && sameText(layer.textItem.contents, text)) {
      return;
    }
  } catch (_error) {
    // 讀不到就照寫
  }
  try {
    if (layer.textItem) {
      // 用 DOM 改內容會保留原本的字型與樣式
      layer.textItem.contents = text;
      return;
    }
  } catch (_error) {
    // 改用 batchPlay
  }
  await action.batchPlay(
    [
      {
        _obj: "set",
        _target: [{ _ref: "textLayer", _id: layer.id }],
        to: { _obj: "textLayer", textKey: text },
      },
    ],
    { synchronousExecution: true },
  );
}

// 影像 > 全部顯現：畫布放大到容得下所有圖層（作用中文件）
async function revealAllCanvas() {
  try {
    await action.batchPlay([{ _obj: "revealAll", _options: { dialogOptions: "dontDisplay" } }], {
      synchronousExecution: true,
    });
  } catch (_error) {
    // 已經都在畫布內時 Photoshop 可能不給執行，略過
  }
}

// 打開智慧型物件的內容（.psb），回傳打開的文件
async function openSmartObjectContents(master, layer) {
  await selectOnlyLayer(layer);
  await action.batchPlay(
    [{ _obj: "placedLayerEditContents", _options: { dialogOptions: "dontDisplay" } }],
    { synchronousExecution: true },
  );
  const inner = app.activeDocument;
  if (!inner || inner.id === master.id) {
    throw new Error(`${layer.name} 的內容無法開啟`);
  }
  return inner;
}

/**
 * 對母版的某個 $ 圖層裡的文字做事：
 *   task(doc, textLayers) 拿到文字所在的文件與文字圖層（由上往下）。
 *   save = true 時，改完存檔（智慧型物件內容與 PSD 本身）。
 */
async function withLayerTexts(master, layerName, required, names, task, save) {
  app.activeDocument = master;
  const container = getMcdSourceContainer(master, required, names);
  const layer = findNamedLayer(container, layerName);
  if (!layer) {
    throw new Error(`找不到圖層 ${layerName}`);
  }
  if (isTextLayer(layer) || (!isSmartObject(layer) && canSearchChildren(layer))) {
    const texts = isTextLayer(layer) ? [layer] : collectTextLayers(layer);
    const result = await task(master, texts);
    if (save && texts.length) {
      await master.save();
    }
    return result;
  }
  if (!isSmartObject(layer)) {
    return task(master, []);
  }
  const inner = await openSmartObjectContents(master, layer);
  let result;
  try {
    result = await task(inner, collectTextLayers(inner));
    if (save) {
      // 智慧型物件的畫布只有原本文字那麼大，字變長會被裁掉：先「全部顯現」把畫布放大到容得下
      await revealAllCanvas();
      await inner.save();
    }
  } finally {
    await closeDocumentQuietly(inner);
    if (isDocumentOpen(master)) {
      app.activeDocument = master;
    }
  }
  if (save) {
    await master.save();
  }
  return result;
}

// 把獨立樣板自己的文字／樣式套到某文件裡的圖層（預覽暫存文件或產出的文件，不碰母版）
async function applyTextOverride(doc, layer, override) {
  if (!override || (!override.texts && !override.style)) {
    return;
  }
  app.activeDocument = doc;
  const apply = async (layers) => {
    for (let i = 0; i < layers.length; i++) {
      if (override.texts && i < override.texts.length) {
        await writeLayerText(layers[i], override.texts[i]);
      }
      if (override.style) {
        await applyTextStyle(layers[i], override.style);
      }
    }
  };
  if (isTextLayer(layer) || (!isSmartObject(layer) && canSearchChildren(layer))) {
    await apply(isTextLayer(layer) ? [layer] : collectTextLayers(layer));
    return;
  }
  if (!isSmartObject(layer)) {
    return;
  }
  const inner = await openSmartObjectContents(doc, layer);
  try {
    await apply(collectTextLayers(inner));
    await revealAllCanvas();
    await inner.save();
  } finally {
    await closeDocumentQuietly(inner);
    app.activeDocument = doc;
  }
}

// 獨立樣板的文字預覽：在暫存文件複製圖層、套上自己的文字後匯出
async function buildTextOverridePreview(master, layerName, required, names, override) {
  const tempFolder = await localFileSystem.getTemporaryFolder();
  const file = await tempFolder.createFile(`preview-override-${master.id}-${Date.now()}.png`, {
    overwrite: true,
  });
  let size = null;
  await runModal(async () => {
    await closeLeftoverPreviewDocuments();
    const container = getMcdSourceContainer(master, required, names);
    const layer = findNamedLayer(container, layerName);
    if (!layer) {
      throw new Error(`找不到圖層 ${layerName}`);
    }
    try {
      size = await exportLayerPreviewPng(master, layer, file, layerName, (temp, copy) =>
        applyTextOverride(temp, copy, override),
      );
    } finally {
      // 不管成功或失敗，暫存文件（以及打開的智慧型物件內容）都要關掉，不留在 Photoshop
      await closeLeftoverPreviewDocuments();
      if (isDocumentOpen(master)) {
        app.activeDocument = master;
      }
    }
  }, "擷取獨立樣板的文字");
  const buffer = await file.read({ format: formats.binary });
  return { ...size, dataUrl: `data:image/png;base64,${arrayBufferToBase64(buffer)}` };
}

// 讀出圖層裡的文字：[{ name, text }]，沒有文字回傳空陣列
async function readEditableTexts(master, layerName, required, names) {
  let texts = [];
  await runModal(async () => {
    texts = await withLayerTexts(master, layerName, required, names, async (doc, layers) => {
      const out = [];
      for (const layer of layers) {
        out.push({ name: layer.name, text: await readLayerText(doc, layer) });
      }
      return out;
    }, false);
  }, "讀取文字");
  return texts;
}

// 依讀取時的順序寫回文字並存檔
async function writeEditableTexts(master, layerName, required, names, values) {
  await runModal(async () => {
    await withLayerTexts(master, layerName, required, names, async (_doc, layers) => {
      if (layers.length !== values.length) {
        throw new Error(`${layerName} 的文字圖層數量已改變，請重新雙擊編輯`);
      }
      for (let i = 0; i < layers.length; i++) {
        await writeLayerText(layers[i], values[i]);
      }
    }, true);
  }, "更新文字");
}

// ---------- 新增文字：在 PSD 加一個文字智慧型物件 $TEXT1、$TEXT2… ----------

const EXTRA_TEXT_PATTERN = /^\$TEXT\d+$/;
const DEFAULT_NEW_TEXT = "新增文字";

// PSD 裡所有名稱開頭是 $ 的圖層（含群組／工作區域裡的，不看智慧型物件內部），依圖層面板由上往下
function dollarLayerNames(doc) {
  const found = [];
  (function walk(node) {
    for (const layer of listLayers(node)) {
      const name = String(layer.name || "").trim();
      if (name.startsWith("$") && name.length > 1 && !found.includes(name)) {
        found.push(name);
      }
      if (canSearchChildren(layer)) {
        walk(layer);
      }
    }
  })(doc);
  return found;
}

function withExtraNames(names, extras) {
  return [...names, ...extras.filter((name) => !names.includes(name))];
}

function allLayerNamesIn(doc) {
  const out = new Set();
  (function walk(node) {
    for (const layer of listLayers(node)) {
      out.add(String(layer.name));
      if (canSearchChildren(layer)) {
        walk(layer);
      }
    }
  })(doc);
  return out;
}

/**
 * 在母版加一段文字：建立文字圖層（預設「新增文字」）→ 轉成智慧型物件（跟 $SM 一樣是一個 .psb）
 * → 命名為下一個 $TEXTn → 放在畫布上方置中 → 存檔。回傳新圖層名稱。
 */
async function addTextLayerToMaster(master, required, names, text) {
  let newName = "";
  await runModal(async () => {
    app.activeDocument = master;
    const container = getMcdSourceContainer(master, required, names);
    const existing = allLayerNamesIn(master);
    let n = 1;
    while (existing.has(`$TEXT${n}`)) {
      n += 1;
    }
    newName = `$TEXT${n}`;

    const frame =
      container === master
        ? { left: 0, top: 0, right: unitNumber(master.width), bottom: unitNumber(master.height) }
        : readLayerBounds(container);
    const frameW = Math.max(frame.right - frame.left, 1);
    const frameH = Math.max(frame.bottom - frame.top, 1);
    const resolution = unitNumber(master.resolution) || 72;
    const sizePx = Math.max(Math.round(frameH * 0.08), 12);

    // 先選容器裡最上面的 $ 圖層：新圖層會建在它上面（同一個工作區域裡）
    const found = requireMcdSmartLayers(container, [], names);
    const top = listMcdLayersBottomToTop(container, found).slice(-1)[0] || null;
    if (top) {
      await selectOnlyLayer(top);
    }
    let textLayer = null;
    if (typeof master.createTextLayer === "function") {
      textLayer = await master.createTextLayer({
        contents: text,
        fontSize: (sizePx * 72) / resolution,
        position: { x: frame.left + frameW * 0.1, y: frame.top + frameH * 0.2 },
      });
    } else {
      await action.batchPlay(
        [
          {
            _obj: "make",
            _target: [{ _ref: "textLayer" }],
            using: {
              _obj: "textLayer",
              textKey: text,
              textClickPoint: {
                _obj: "paint",
                horizontal: { _unit: "percentUnit", _value: ((frame.left + frameW * 0.1) / unitNumber(master.width)) * 100 },
                vertical: { _unit: "percentUnit", _value: ((frame.top + frameH * 0.2) / unitNumber(master.height)) * 100 },
              },
              textStyleRange: [
                {
                  _obj: "textStyleRange",
                  from: 0,
                  to: text.length,
                  textStyle: {
                    _obj: "textStyle",
                    size: { _unit: "pointsUnit", _value: (sizePx * 72) / resolution },
                    color: { _obj: "RGBColor", red: 0, grain: 0, blue: 0 },
                  },
                },
              ],
            },
          },
        ],
        { synchronousExecution: true },
      );
      textLayer = master.activeLayers && master.activeLayers[0];
    }
    if (!textLayer) {
      throw new Error("無法建立文字圖層");
    }
    if (top && container !== master) {
      try {
        // 確保在同一個工作區域裡
        textLayer.move(top, constants.ElementPlacement.PLACEBEFORE);
      } catch (_error) {
        // 已在正確位置
      }
    }

    // 轉成智慧型物件
    await selectOnlyLayer(textLayer);
    await action.batchPlay([{ _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }], {
      synchronousExecution: true,
    });
    const placed = (master.activeLayers && master.activeLayers[0]) || textLayer;
    await action.batchPlay(
      [{ _obj: "set", _target: [{ _ref: "layer", _id: placed.id }], to: { _obj: "layer", name: newName } }],
      { synchronousExecution: true },
    );
    try {
      placed.name = newName;
    } catch (_error) {
      // 已由 batchPlay 改名
    }

    // 水平置中、放在上方
    const b = boundsBox(placed);
    await translateLayer(
      placed,
      frame.left + (frameW - b.width) / 2 - b.left,
      frame.top + frameH * 0.15 - b.top,
    );
    await master.save();
  }, "新增文字");
  return newName;
}

// ---------- 文字樣式（字型／樣式／大小／對齊／顏色，像 Photoshop 上方的文字列） ----------

const TEXT_ALIGNS = ["left", "center", "right"];

function textStyleOf(layer) {
  const item = layer.textItem;
  if (!item || !item.characterStyle) {
    throw new Error("這個版本的 Photoshop 讀不到文字樣式");
  }
  const cs = item.characterStyle;
  let color = "#000000";
  try {
    color = `#${String(cs.color.rgb.hexValue).toUpperCase()}`;
  } catch (_error) {
    // 讀不到顏色就當黑色
  }
  let align = "left";
  try {
    const value = String(item.paragraphStyle.justification).toLowerCase();
    align = value.includes("center") ? "center" : value.includes("right") ? "right" : "left";
  } catch (_error) {
    // 讀不到對齊就當靠左
  }
  let orientation = "horizontal";
  try {
    orientation = String(item.orientation).toLowerCase().includes("vertical") ? "vertical" : "horizontal";
  } catch (_error) {
    // 讀不到就當橫排
  }
  return { font: String(cs.font || ""), size: roundTo(unitNumber(cs.size), 2), color, align, orientation };
}

// 直排時半形字（數字、英文、$ + 等）會被 Photoshop 橫躺：轉成全形才會直立；轉回橫排時換回半形
function toFullWidth(text) {
  return String(text)
    .replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))
    .replace(/ /g, "\u3000");
}

function toHalfWidth(text) {
  return String(text)
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

function sameText(a, b) {
  const norm = (value) => String(value == null ? "" : value).replace(/\r\n?|\n/g, "\r");
  return norm(a) === norm(b);
}

// 只改跟目前不同的樣式：設定一次就會套到整段文字，原本混合的樣式會被統一
async function applyTextStyle(layer, style) {
  const item = layer.textItem;
  if (!item || !item.characterStyle) {
    throw new Error("這個版本的 Photoshop 無法修改文字樣式");
  }
  const cs = item.characterStyle;
  let current = {};
  try {
    current = textStyleOf(layer);
  } catch (_error) {
    // 讀不到就全部照設
  }
  if (style.font && style.font !== current.font) {
    cs.font = style.font;
  }
  if (style.size > 0 && !(Math.abs(style.size - current.size) < 0.01)) {
    cs.size = style.size;
  }
  if (style.color && String(style.color).toUpperCase() !== String(current.color).toUpperCase()) {
    const color = new app.SolidColor();
    color.rgb.hexValue = style.color.replace("#", "");
    cs.color = color;
  }
  if (style.align && style.align !== current.align && constants.Justification) {
    item.paragraphStyle.justification = constants.Justification[style.align.toUpperCase()];
  }
  if (style.orientation && style.orientation === current.orientation) {
    return; // 方向沒變
  }
  if (style.orientation === "vertical") {
    // 段落文字（固定大小的文字框）轉直排會照舊框的大小折行，每行只剩幾個字：先轉成點文字，只在換行處分行
    try {
      if (item.isParagraphText && typeof item.convertToPointText === "function") {
        await item.convertToPointText();
      }
    } catch (_error) {
      // 不支援就維持原樣
    }
  }
  if (style.orientation) {
    // 橫排／直排
    let done = false;
    const value = constants.Orientation && constants.Orientation[style.orientation.toUpperCase()];
    if (value !== undefined) {
      try {
        item.orientation = value;
        done = true;
      } catch (_error) {
        // 改用 batchPlay
      }
    }
    if (!done) {
      await action.batchPlay(
        [
          {
            _obj: "set",
            _target: [{ _ref: "textLayer", _id: layer.id }],
            to: { _obj: "textLayer", orientation: { _enum: "orientation", _value: style.orientation } },
          },
        ],
        { synchronousExecution: true },
      );
    }
  }
}

// 讀第一個文字圖層的樣式；圖層沒有文字回傳 null
async function readTextStyle(master, layerName, required, names) {
  let style = null;
  await runModal(async () => {
    style = await withLayerTexts(master, layerName, required, names, async (_doc, layers) =>
      layers.length ? textStyleOf(layers[0]) : null, false);
  }, "讀取文字樣式");
  return style;
}

// 套用到圖層裡所有文字圖層並存檔
async function writeTextStyle(master, layerName, required, names, style) {
  await runModal(async () => {
    await withLayerTexts(master, layerName, required, names, async (_doc, layers) => {
      if (!layers.length) {
        throw new Error(`${layerName} 沒有文字`);
      }
      for (const layer of layers) {
        await applyTextStyle(layer, style);
      }
    }, true);
  }, "更新文字樣式");
}

function hexToRgb(hex) {
  const parsed = parseColor(hex);
  if (!parsed) {
    return null;
  }
  const value = parsed.hex.slice(1);
  return {
    red: parseInt(value.slice(0, 2), 16),
    green: parseInt(value.slice(2, 4), 16),
    blue: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue]
    .map((n) => Math.round(clampNumber(Number(n) || 0, 0, 255)).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

// 打開 Photoshop 內建的檢色器；按取消回傳 null
async function pickColorInPhotoshop(hex) {
  const rgb = hexToRgb(hex) || { red: 0, green: 0, blue: 0 };
  let picked = null;
  await runModal(async () => {
    const result = await action.batchPlay(
      [
        {
          _obj: "showColorPicker",
          _target: [{ _ref: "application" }],
          context: "文字顏色",
          color: { _obj: "RGBColor", red: rgb.red, grain: rgb.green, blue: rgb.blue },
        },
      ],
      {},
    );
    const first = result && result[0];
    picked = pickerColorToHex(first && (first.RGBFloatColor || first.color));
  }, "選擇顏色");
  return picked;
}

// 檢色器回傳的顏色依使用者選的模式不同（RGB／HSB／Lab／CMYK／灰階），統一轉成 #RRGGBB
function pickerColorToHex(color) {
  if (!color) {
    return null;
  }
  const n = (value) => Number(value && typeof value === "object" ? value._value : value);
  const kind = String(color._obj || "").toLowerCase();
  if (Number.isFinite(n(color.red))) {
    return rgbToHex(n(color.red), n(color.grain !== undefined ? color.grain : color.green), n(color.blue));
  }
  if (kind.startsWith("hsb") || Number.isFinite(n(color.brightness))) {
    const rgb = hsbToRgb((((n(color.hue) % 360) + 360) % 360) / 360, n(color.saturation) / 100, n(color.brightness) / 100);
    return rgbToHex(rgb[0], rgb[1], rgb[2]);
  }
  try {
    const solid = new app.SolidColor();
    if (Number.isFinite(n(color.luminance))) {
      solid.lab.l = n(color.luminance);
      solid.lab.a = n(color.a);
      solid.lab.b = n(color.b);
    } else if (Number.isFinite(n(color.cyan))) {
      solid.cmyk.cyan = n(color.cyan);
      solid.cmyk.magenta = n(color.magenta);
      solid.cmyk.yellow = n(color.yellowColor);
      solid.cmyk.black = n(color.black);
    } else if (Number.isFinite(n(color.gray))) {
      solid.gray.gray = n(color.gray);
    } else {
      return null;
    }
    return `#${String(solid.rgb.hexValue).toUpperCase()}`;
  } catch (_error) {
    return null;
  }
}

// 文字與樣式一起改、只存一次（轉向用）
async function writeTextsAndStyle(master, layerName, required, names, values, style) {
  await runModal(async () => {
    await withLayerTexts(master, layerName, required, names, async (_doc, layers) => {
      if (layers.length !== values.length) {
        throw new Error(`${layerName} 的文字圖層數量已改變，請重新雙擊編輯`);
      }
      for (let i = 0; i < layers.length; i++) {
        await writeLayerText(layers[i], values[i]);
        await applyTextStyle(layers[i], style);
      }
    }, true);
  }, "轉向");
}

// 字型清單：一次用 batchPlay 讀完（很快）；不行才逐一讀 app.fonts（每個屬性都要跟 Photoshop 來回，幾千個字型會很久）
let fontListPromise = null;

function loadFonts(onProgress) {
  if (!fontListPromise) {
    fontListPromise = readFontList(onProgress).catch((error) => {
      fontListPromise = null;
      throw error;
    });
  } else if (onProgress) {
    fontListPromise.then(() => onProgress(1));
  }
  return fontListPromise;
}

async function readFontList(onProgress) {
  const report = (ratio) => {
    if (onProgress) {
      onProgress(ratio);
    }
  };
  try {
    const fonts = await readFontListByBatchPlay();
    if (fonts.length) {
      report(1);
      return fonts;
    }
  } catch (_error) {
    // 改逐一讀
  }
  return readFontListByDom(report);
}

async function readFontListByBatchPlay() {
  const result = await action.batchPlay(
    [
      {
        _obj: "get",
        _target: [{ _property: "fontList" }, { _ref: "application", _enum: "ordinal", _value: "targetEnum" }],
      },
    ],
    {},
  );
  const list = result && result[0] && result[0].fontList;
  if (!list || !Array.isArray(list.fontPostScriptName)) {
    return [];
  }
  const names = list.fontName || [];
  const styles = list.fontStyleName || [];
  const families = list.fontFamilyName || [];
  return list.fontPostScriptName.map((postScriptName, i) => {
    const style = String(styles[i] || "Regular");
    let family = String(families[i] || "");
    if (!family) {
      // 沒有字族名稱：從完整名稱去掉樣式（例如「Arial Bold」→「Arial」）
      const name = String(names[i] || postScriptName || "");
      family = name.endsWith(` ${style}`) ? name.slice(0, -style.length - 1) : name;
    }
    return { family, style, postScriptName: String(postScriptName || "") };
  });
}

const FONT_READ_CHUNK = 100;

async function readFontListByDom(report) {
  const out = [];
  try {
    const fonts = app.fonts || [];
    const total = fonts.length;
    for (let i = 0; i < total; i++) {
      const font = fonts[i];
      out.push({
        family: String(font.family || font.name || ""),
        style: String(font.style || "Regular"),
        postScriptName: String(font.postScriptName || font.name || ""),
      });
      if ((i + 1) % FONT_READ_CHUNK === 0) {
        report((i + 1) / total);
        await new Promise((resolve) => setTimeout(resolve, 0)); // 讓畫面更新進度
      }
    }
  } catch (_error) {
    // 讀不到字型清單：只能沿用目前字型
  }
  report(1);
  return out;
}

const FONT_WEIGHTS = [
  [100, "Thin"],
  [200, "ExtraLight"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "SemiBold"],
  [700, "Bold"],
  [800, "ExtraBold"],
  [900, "Black"],
];

// 樣式名稱 → 粗細數字（100～900，跟 CSS font-weight 一樣）
function fontWeightOf(style) {
  const value = String(style || "").toLowerCase().replace(/[\s_-]/g, "");
  const w = value.match(/(?:^|[^a-z])w([1-9])(?![0-9])/);
  if (w) {
    return Number(w[1]) * 100; // 日文字型的 W3、W6…
  }
  const rules = [
    [/extralight|ultralight/, 200],
    [/extrabold|ultrabold/, 800],
    [/semibold|demibold|demi/, 600],
    [/thin|hairline/, 100],
    [/light/, 300],
    [/medium/, 500],
    [/black|heavy/, 900],
    [/bold/, 700],
  ];
  const hit = rules.find(([pattern]) => pattern.test(value));
  return hit ? hit[1] : 400;
}

// ---------- 顏色字串（#hex、rgb()、rgba()、hsl()、hsla()、hsb()、顏色名稱） ----------

const NAMED_COLORS = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", lime: "00FF00", blue: "0000FF",
  yellow: "FFFF00", cyan: "00FFFF", aqua: "00FFFF", magenta: "FF00FF", fuchsia: "FF00FF",
  gray: "808080", grey: "808080", silver: "C0C0C0", maroon: "800000", olive: "808000",
  navy: "000080", purple: "800080", teal: "008080", orange: "FFA500", pink: "FFC0CB",
  brown: "A52A2A", gold: "FFD700",
};

// 回傳 { hex: "#RRGGBB", alpha: 0～1 }；看不懂回傳 null
function parseColor(input) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) {
    return null;
  }
  if (NAMED_COLORS[text]) {
    return { hex: `#${NAMED_COLORS[text]}`, alpha: 1 };
  }
  const hexMatch = text.match(/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hexMatch) {
    let digits = hexMatch[1];
    if (digits.length <= 4) {
      digits = digits.split("").map((ch) => ch + ch).join("");
    }
    const alpha = digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1;
    return { hex: `#${digits.slice(0, 6).toUpperCase()}`, alpha };
  }
  const fn = text.match(/^(rgba?|hsla?|hsb|hsv)\s*\(([^)]*)\)$/);
  if (!fn) {
    return null;
  }
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) {
    return null;
  }
  const num = (part) => parseFloat(part);
  if (parts.some((part) => !Number.isFinite(num(part)))) {
    return null;
  }
  const alphaOf = (part) => {
    if (part === undefined) {
      return 1;
    }
    const n = part.endsWith("%") ? num(part) / 100 : num(part);
    return clampNumber(n, 0, 1);
  };
  const percent = (part, scale) => (part.endsWith("%") ? (num(part) / 100) * scale : num(part));
  const alpha = alphaOf(parts[3]);
  if (fn[1].startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((part) => percent(part, 255));
    return { hex: rgbToHex(r, g, b), alpha };
  }
  const hue = (((num(parts[0]) % 360) + 360) % 360) / 360;
  const sat = clampNumber(parts[1].endsWith("%") ? num(parts[1]) / 100 : num(parts[1]) > 1 ? num(parts[1]) / 100 : num(parts[1]), 0, 1);
  const third = clampNumber(parts[2].endsWith("%") ? num(parts[2]) / 100 : num(parts[2]) > 1 ? num(parts[2]) / 100 : num(parts[2]), 0, 1);
  const rgb = fn[1].startsWith("hsl") ? hslToRgb(hue, sat, third) : hsbToRgb(hue, sat, third);
  return { hex: rgbToHex(rgb[0], rgb[1], rgb[2]), alpha };
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    return [l * 255, l * 255, l * 255];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    const x = (t + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

function hsbToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [r * 255, g * 255, b * 255];
}

// 刪除「新增文字」加的文字區塊並存檔
async function deleteLayerFromMaster(master, layerName, required, names) {
  await runModal(async () => {
    app.activeDocument = master;
    const container = getMcdSourceContainer(master, required, names);
    const layer = findNamedLayer(container, layerName);
    if (!layer) {
      throw new Error(`找不到圖層 ${layerName}`);
    }
    await selectOnlyLayer(layer);
    await action.batchPlay(
      [{ _obj: "delete", _target: [{ _ref: "layer", _id: layer.id }] }],
      { synchronousExecution: true },
    );
    await master.save();
  }, "刪除文字區塊");
}

// ---------- 預覽格線（等分參考線；存在這台電腦，兩個分頁共用） ----------

const GRID_SETTINGS_KEY = "bannerResizer.grid";
const GRID_MAX_LINES = 50;
const DEFAULT_GRID = { vertical: 9, horizontal: 9, visible: false };

function readGridSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(GRID_SETTINGS_KEY)) || {};
    const clampLines = (n, fallback) =>
      Number.isInteger(n) && n >= 0 && n <= GRID_MAX_LINES ? n : fallback;
    return {
      vertical: clampLines(raw.vertical, DEFAULT_GRID.vertical),
      horizontal: clampLines(raw.horizontal, DEFAULT_GRID.horizontal),
      visible: raw.visible === true,
    };
  } catch (_error) {
    return { ...DEFAULT_GRID };
  }
}

function writeGridSettings(settings) {
  try {
    localStorage.setItem(GRID_SETTINGS_KEY, JSON.stringify(settings));
  } catch (_error) {
    // 存不了就只在這次使用
  }
}

// ---------- 分頁與面板 ----------

const RESIZE_MODE = {
  kind: "resize",
  templates: () => moduleStore.templates,
  // 不檢查必要圖層：PSD 裡有哪些 $ 圖層就用哪些
  required: () => [],
  layerNames: () => MCD_SMART_LAYER_NAMES,
  positionNames: () => MCD_POSITION_ELEMENT_NAMES,
  editableNames: () => EDITABLE_ELEMENT_NAMES,
  validMaster: validMasterOrNull,
  masterProblem: dollarMasterProblem,
  // 內建樣板，寬度依 MCD-SMART 比例基準換算
  initialValues: initialValuesForDocument,
  onMaster: captureReferenceIfNeeded,
};

const APPLY_MODE = {
  kind: "apply",
  templates: () => moduleStore.applyTemplates,
  required: applyRequiredLayers,
  layerNames: applyLayerNames,
  positionNames: applyPositionNames,
  // 面板「圖層」下拉＝圖層清單的順序
  editableNames: applyLayerNames,
  validMaster: validApplyMasterOrNull,
  masterProblem: applyMasterProblem,
  // 套圖的預設版面＝PSD 原稿的位置與大小
  initialValues: applyInitialValues,
  onMaster: async () => {},
};

const workspaces = {
  resize: createResizeWorkspace(document.querySelector('[data-workspace="resize"]'), RESIZE_MODE),
  apply: createResizeWorkspace(document.querySelector('[data-workspace="apply"]'), APPLY_MODE),
};
const START_TAB_KEY = "bannerResizer.startTab";

function readStartTab() {
  try {
    const saved = localStorage.getItem(START_TAB_KEY);
    return saved === "apply" ? "apply" : "resize";
  } catch (_error) {
    return "resize";
  }
}

// 啟動畫面的「Resize／套圖」選擇：決定按「開始執行」後預選哪個分頁，並記住上次的選擇
let activeTab = readStartTab();
const startModePicker = document.getElementById("start-mode-picker");
fillPicker(startModePicker, ["Resize", "套圖"]);
setPickerIndex(startModePicker, activeTab === "apply" ? 1 : 0);
startModePicker.addEventListener("change", (event) => {
  activeTab = readPickerIndex(event) === 1 ? "apply" : "resize";
  try {
    localStorage.setItem(START_TAB_KEY, activeTab);
  } catch (_error) {
    // 記不住就每次預設 Resize
  }
});

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
    data = unpackModuleData(JSON.parse(text));
  } catch (error) {
    throw new Error(`JSON 格式錯誤：${error.message}`);
  }
  if (!Array.isArray(data.templates)) {
    throw new Error("最外層需為 { \"resize\": { \"templates\": [ ... ] }, \"image-set\": [ ... ] }");
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
        throw new Error(`image-set 第 ${index + 1} 個模組缺少 name`);
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
    applyLayers: normalizeApplyLayers(data.applyLayers),
    applyRequiredLayers: normalizeRequiredLayers(
      data.applyRequiredLayers,
      normalizeApplyLayers(data.applyLayers),
    ),
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
    applyLayers: moduleStore.applyLayers,
    applyRequiredLayers: moduleStore.applyRequiredLayers,
    reference: moduleStore.reference,
  };
  moduleStore.templates = pending.templates;
  moduleStore.applyTemplates = pending.applyTemplates;
  moduleStore.applyLayers = pending.applyLayers;
  moduleStore.applyRequiredLayers = pending.applyRequiredLayers;
  moduleStore.reference = pending.reference;
  try {
    await saveModuleStore();
  } catch (error) {
    moduleStore.templates = previous.templates;
    moduleStore.applyTemplates = previous.applyTemplates;
    moduleStore.applyLayers = previous.applyLayers;
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

  // 一開始兩個分頁都是空的，不帶入 Photoshop 裡已開啟的檔案；PSD 一律由「上傳.psd」帶入
  workspaces.resize.open(null, EMPTY_STATUS);
  workspaces.apply.open(null, EMPTY_STATUS);
  updateModuleFolderLabel();
  document.getElementById("btn-resize-1200x629").style.display = "none";
  document.getElementById("start-screen").style.display = "none";
  document.getElementById("resize-settings-panel").style.display = "block";
  selectTab(activeTab);
}

function closeResizeSettingsPanel() {
  document.getElementById("resize-settings-panel").style.display = "none";
  document.getElementById("btn-resize-1200x629").style.display = "";
  document.getElementById("start-screen").style.display = "";
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

// 面板開好後先在背景讀字型清單，第一次按「編輯」就不用等
setTimeout(() => {
  loadFonts().catch(() => {});
}, 2000);

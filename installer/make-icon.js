'use strict';

/**
 * Minos Work Dashboard - icon generator
 * 외부 의존성(외부 npm, 외부 바이너리, 외부 다운로드) 없이 순수 Node.js 내장 모듈(fs, zlib)로
 * 멀티 사이즈(16, 24, 32, 48, 64, 128, 256) 고해상도 RGBA PNG를 렌더링하고
 * 단일 Windows 아이콘(.ico) 포맷으로 패킹합니다.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 테이블 및 계산기
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// 순수 RGBA 버퍼 -> PNG 버퍼 생성기
function encodePng(width, height, rgbaBuffer) {
  // 스캔라인 구성: 각 행마다 [filterType=0 (1바이트)] + [RGBA 4바이트 * width]
  const rowBytes = 1 + width * 4;
  const rawData = Buffer.alloc(rowBytes * height);

  for (let y = 0; y < height; y++) {
    const rawOffset = y * rowBytes;
    rawData[rawOffset] = 0; // Filter None
    rgbaBuffer.copy(rawData, rawOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressedIdat = zlib.deflateSync(rawData, { level: 9 });

  // PNG 청크 빌더
  function makeChunk(typeStr, dataBuf) {
    const len = dataBuf.length;
    const chunk = Buffer.alloc(12 + len);
    chunk.writeUInt32BE(len, 0);
    chunk.write(typeStr, 4, 4, 'ascii');
    dataBuf.copy(chunk, 8);
    const crcVal = crc32(chunk, 4, 8 + len);
    chunk.writeUInt32BE(crcVal, 8 + len);
    return chunk;
  }

  // 1. IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // 2. IDAT
  const idatChunk = makeChunk('IDAT', compressedIdat);

  // 3. IEND
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// 둥근 모서리 사각형 거리 함수 (SDF: Signed Distance Field)
function sdRoundedBox(x, y, halfW, halfH, radius) {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  const outerDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const innerDist = Math.min(Math.max(qx, qy), 0);
  return outerDist + innerDist - radius;
}

// 세련된 작업현황 대시보드 아이콘 렌더링
function renderDashboardIcon(size) {
  const buf = Buffer.alloc(size * size * 4);

  const cx = size / 2;
  const cy = size / 2;
  const margin = Math.max(1, Math.round(size * 0.04));
  const halfW = cx - margin;
  const halfH = cy - margin;
  const cornerRadius = Math.max(2, Math.round(size * 0.22));

  // 색상 팔레트
  // 배경: Deep Slate Navy (#0a0f1d ~ #1e293b)
  // 헤더: Dark Indigo Glass (#1e1b4b ~ #312e81)
  // 진행 막대 1 (작업): Vivid Cyan (#06b6d4)
  // 진행 막대 2 (장비/인원): Sky Blue (#38bdf8)
  // 진행 막대 3 (자재/특이사항): Amber Gold (#f59e0b)
  // 외곽 보더: Subtle Slate Blue Glow (#38bdf8, 25% opacity)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = (py * size + px) * 4;

      // 안티앨리어싱을 위한 2x2 서브픽셀 샘플링
      let accumR = 0, accumG = 0, accumB = 0, accumA = 0;

      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const subX = px + (sx + 0.5) / 2;
          const subY = py + (sy + 0.5) / 2;
          const relX = subX - cx;
          const relY = subY - cy;

          const dist = sdRoundedBox(relX, relY, halfW, halfH, cornerRadius);

          if (dist > 0.5) {
            // 박스 바깥 완전 투명
            continue;
          }

          // 외곽 안티앨리어싱 알파 계수
          let alphaCov = 1.0;
          if (dist > -0.5) {
            alphaCov = 0.5 - dist;
            if (alphaCov < 0) alphaCov = 0;
            if (alphaCov > 1) alphaCov = 1;
          }

          // 기본 윈도우 배경 그라데이션 (위 -> 아래, #0f172a -> #1e3a8a)
          const normY = (subY - (cy - halfH)) / (halfH * 2);
          const normX = (subX - (cx - halfW)) / (halfW * 2);

          let r = 15 + normY * 15;
          let g = 23 + normY * 35;
          let b = 42 + normY * 85;

          // 미세한 대각선 빛 반사
          const diagGlow = Math.max(0, 1 - Math.abs(normX - normY * 0.7));
          r += diagGlow * 8;
          g += diagGlow * 12;
          b += diagGlow * 20;

          // 1. 상단 헤더 바 (높이 약 24%)
          const headerH = 0.24;
          if (normY < headerH) {
            // 헤더 배경: 어둡고 정갈한 블루 인디고
            r = 18; g = 30; b = 60;

            // 헤더 하단 구분선
            if (normY > headerH - 0.03) {
              r = 45; g = 70; b = 120;
            }

            // 헤더 좌측: 신호등 점 3개 (빨강, 노랑, 녹색)
            // 16px 같은 극소 아이콘에서는 1개의 액티브 점 또는 단정화
            const dotY = headerH * 0.5;
            const dotR = Math.max(0.7, (size * 0.035) / size);
            const dotYDist = Math.abs(normY - dotY);

            // 점 1 (Red #ef4444)
            const dot1X = 0.16;
            if (Math.hypot(normX - dot1X, dotYDist * 1.5) < dotR) {
              r = 239; g = 68; b = 68;
            }
            // 점 2 (Amber #f59e0b)
            const dot2X = 0.28;
            if (Math.hypot(normX - dot2X, dotYDist * 1.5) < dotR) {
              r = 245; g = 158; b = 11;
            }
            // 점 3 (Emerald #10b981)
            const dot3X = 0.40;
            if (Math.hypot(normX - dot3X, dotYDist * 1.5) < dotR) {
              r = 16; g = 185; b = 129;
            }

            // 헤더 우측: 대시보드 상태 배지 (Cyan Pulse #06b6d4)
            const pulseX = 0.82;
            if (Math.hypot(normX - pulseX, dotYDist * 1.5) < dotR * 1.2) {
              r = 6; g = 182; b = 212;
            }
          } else {
            // 2. 대시보드 본문 영역 (normY 0.25 ~ 0.92)
            // 가로 진행 막대 3줄 + 좌측 라벨 블록
            const bars = [
              { top: 0.32, h: 0.13, fillRatio: 0.76, color: [6, 182, 212] },  // Cyan (작업)
              { top: 0.51, h: 0.13, fillRatio: 0.58, color: [56, 189, 248] }, // Sky Blue (장비/인원)
              { top: 0.70, h: 0.13, fillRatio: 0.88, color: [245, 158, 11] }  // Amber (자재/특이사항)
            ];

            for (const bar of bars) {
              if (normY >= bar.top && normY <= bar.top + bar.h) {
                // 좌측 라벨 아이콘 블록 (normX 0.14 ~ 0.24)
                if (normX >= 0.14 && normX <= 0.24) {
                  r = bar.color[0] * 0.9;
                  g = bar.color[1] * 0.9;
                  b = bar.color[2] * 0.9;
                } else if (normX >= 0.28 && normX <= 0.86) {
                  // 게이지 트랙 배경
                  const trackX = (normX - 0.28) / (0.86 - 0.28);
                  if (trackX <= bar.fillRatio) {
                    // 활성 게이지 (화사한 그라데이션)
                    r = bar.color[0];
                    g = bar.color[1];
                    b = bar.color[2];
                    // 상단 하이라이트
                    if (normY < bar.top + bar.h * 0.35) {
                      r = Math.min(255, r + 40);
                      g = Math.min(255, g + 40);
                      b = Math.min(255, b + 40);
                    }
                  } else {
                    // 비활성 게이지 트랙 (어두운 배경 슬롯)
                    r = 25; g = 38; b = 64;
                  }
                }
              }
            }
          }

          // 3. 외곽 테두리 (Border Glow, 1px)
          if (dist > -1.2 && dist <= 0.5) {
            r = Math.min(255, r * 0.5 + 56 * 0.5);
            g = Math.min(255, g * 0.5 + 189 * 0.5);
            b = Math.min(255, b * 0.5 + 248 * 0.5);
          }

          accumR += r * alphaCov;
          accumG += g * alphaCov;
          accumB += b * alphaCov;
          accumA += 255 * alphaCov;
        }
      }

      buf[idx] = Math.round(accumR / 4);
      buf[idx + 1] = Math.round(accumG / 4);
      buf[idx + 2] = Math.round(accumB / 4);
      buf[idx + 3] = Math.round(accumA / 4);
    }
  }

  return buf;
}

// 메인 빌드 함수
function buildIcons() {
  const installerDir = __dirname;
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  console.log(`[아이콘 빌드] ${sizes.join(', ')}px 멀티 사이즈 렌더링 시작...`);

  const pngBuffers = [];

  for (const s of sizes) {
    const rawRgba = renderDashboardIcon(s);
    const pngBuf = encodePng(s, s, rawRgba);
    pngBuffers.push({ size: s, png: pngBuf });

    // 256px은 미리보기 확인용 단독 PNG로도 저장
    if (s === 256) {
      fs.writeFileSync(path.join(installerDir, 'icon-preview.png'), pngBuf);
      console.log(`  -> 256px 미리보기 저장: ${path.join(installerDir, 'icon-preview.png')}`);
    }
  }

  // ICO 파일 헤더 (ICONDIR: 6 바이트)
  // 0-1: 0 (Reserved)
  // 2-3: 1 (Type 1 = Icon)
  // 4-5: Count
  const count = pngBuffers.length;
  const headerBuf = Buffer.alloc(6);
  headerBuf.writeUInt16LE(0, 0);
  headerBuf.writeUInt16LE(1, 2);
  headerBuf.writeUInt16LE(count, 4);

  // 엔트리 테이블 (ICONDIRENTRY: 개당 16바이트)
  const entriesBuf = Buffer.alloc(count * 16);
  let currentOffset = 6 + count * 16;

  for (let i = 0; i < count; i++) {
    const item = pngBuffers[i];
    const s = item.size;
    const len = item.png.length;
    const offset = i * 16;

    entriesBuf[offset + 0] = s === 256 ? 0 : s; // Width (256은 0으로 기록)
    entriesBuf[offset + 1] = s === 256 ? 0 : s; // Height
    entriesBuf[offset + 2] = 0; // Color count
    entriesBuf[offset + 3] = 0; // Reserved
    entriesBuf.writeUInt16LE(1, offset + 4); // Color planes
    entriesBuf.writeUInt16LE(32, offset + 6); // Bits per pixel
    entriesBuf.writeUInt32LE(len, offset + 8); // Size of image data
    entriesBuf.writeUInt32LE(currentOffset, offset + 12); // File offset

    currentOffset += len;
  }

  // 전체 ICO 버퍼 조립
  const icoParts = [headerBuf, entriesBuf];
  for (const item of pngBuffers) {
    icoParts.push(item.png);
  }
  const icoBuf = Buffer.concat(icoParts);

  const outIcoPath = path.join(installerDir, 'icon.ico');
  fs.writeFileSync(outIcoPath, icoBuf);
  console.log(`[아이콘 빌드 완료] ${outIcoPath} (${icoBuf.length} 바이트, ${count}개 해상도 패킹)`);

  return outIcoPath;
}

if (require.main === module) {
  try {
    buildIcons();
  } catch (err) {
    console.error('[아이콘 빌드 에러]', err);
    process.exit(1);
  }
}

module.exports = { buildIcons, renderDashboardIcon, encodePng };

/**
 * public/pdfzones.js
 * WD-72: 작업일보 PDF 글자 좌표 추출 및 구역/표 읽기 모듈
 * 외부 의존성: window.pdfjsLib (PDF.js)
 */
(function (global) {
  'use strict';

  const PdfZones = {
    /**
     * PDF ArrayBuffer 로드 및 텍스트/좌표 추출
     * @param {ArrayBuffer} arrayBuffer
     * @param {Object} [options]
     * @param {string} [options.baseUrl] - PDF worker 경로 접두사 (기본 '/')
     * @returns {Promise<{ pageCount: number, pages: Array }>}
     */
    async load(arrayBuffer, options = {}) {
      const pdfjs = (typeof window !== 'undefined' && window.pdfjsLib) ? window.pdfjsLib : (typeof require === 'function' ? require('./vendor/pdfjs/pdf.min.js') : null);
      if (!pdfjs) throw new Error('pdfjsLib is not available');

      const baseUrl = options.baseUrl || '/';
      if (pdfjs.GlobalWorkerOptions) {
        if (typeof window === 'undefined') {
          try {
            const path = require('path');
            pdfjs.GlobalWorkerOptions.workerSrc = path.join(__dirname, 'vendor', 'pdfjs', 'pdf.worker.min.js');
          } catch {}
        } else {
          pdfjs.GlobalWorkerOptions.workerSrc = baseUrl + 'vendor/pdfjs/pdf.worker.min.js';
        }
      }

      let uint8;
      // ArrayBuffer detach 방어: slice 복사본 사용
      const rawBuf = (arrayBuffer && arrayBuffer.buffer instanceof ArrayBuffer) ? arrayBuffer.buffer : arrayBuffer;
      const safeBuf = (rawBuf && typeof rawBuf.slice === 'function') ? rawBuf.slice(0) : rawBuf;

      if (arrayBuffer instanceof Uint8Array && arrayBuffer.constructor.name === 'Uint8Array') {
        uint8 = new Uint8Array(safeBuf);
      } else if (arrayBuffer && arrayBuffer.buffer instanceof ArrayBuffer) {
        uint8 = new Uint8Array(safeBuf, arrayBuffer.byteOffset || 0, arrayBuffer.byteLength || safeBuf.byteLength);
      } else {
        uint8 = new Uint8Array(safeBuf);
      }
      const loadingTask = pdfjs.getDocument({
        data: uint8,
        isEvalSupported: false,
        useSystemFonts: true,
      });

      const pdf = await loadingTask.promise;
      const pageCount = pdf.numPages;
      const pages = [];

      for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const W = viewport.width;
        const H = viewport.height;

        const textContent = await page.getTextContent();
        const rawItems = [];

        for (const it of textContent.items) {
          const str = (it.str || '').trim();
          if (!str) continue;

          // PDF 좌표(좌하단) -> 뷰포트 좌표(좌상단) 변환
          const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
          const w = it.width / W;
          const h = it.height / H;
          const x = vx / W;
          const y = (vy - it.height) / H;

          rawItems.push({
            str: it.str,
            x,
            y,
            w,
            h,
            cx: x + w / 2,
            cy: y + h / 2,
          });
        }

        // y 정렬 후 x 정렬 (위->아래, 좌->우)
        rawItems.sort((a, b) => Math.abs(a.y - b.y) > 0.003 ? a.y - b.y : a.x - b.x);

        // 인접 글자 병합 (같은 줄 & 글자 간격이 가까운 경우)
        const merged = [];
        let cur = null;
        for (const it of rawItems) {
          if (!cur) {
            cur = { ...it };
            continue;
          }
          const sameLine = Math.abs(it.y - cur.y) < Math.max(cur.h, it.h) * 0.6;
          const adjacent = it.x >= (cur.x + cur.w - 0.005) && it.x <= (cur.x + cur.w + Math.max(cur.h * 1.2, 0.02));
          if (sameLine && adjacent) {
            cur.str += it.str;
            const newRight = Math.max(cur.x + cur.w, it.x + it.w);
            cur.w = newRight - cur.x;
            cur.h = Math.max(cur.h, it.h);
            cur.cx = cur.x + cur.w / 2;
            cur.cy = cur.y + cur.h / 2;
          } else {
            merged.push(cur);
            cur = { ...it };
          }
        }
        if (cur) merged.push(cur);

        pages.push({
          n: pageNum,
          width: W,
          height: H,
          items: merged,
        });
      }

      return { pageCount, pages };
    },

    /**
     * 지정 구역(rect: {x,y,w,h} 비율 0~1) 안의 텍스트 추출
     * @param {Object} page - page 객체
     * @param {Object} rect - {x, y, w, h} 비율
     * @returns {string} 추출 텍스트 (공백 정규화)
     */
    readText(page, rect) {
      if (!page || !page.items || !rect) return '';
      const rx1 = rect.x;
      const ry1 = rect.y;
      const rx2 = rect.x + rect.w;
      const ry2 = rect.y + rect.h;

      // 중심점이 rect 안에 들어가는 item 필터링
      const inside = page.items.filter((it) => (
        it.cx >= rx1 && it.cx <= rx2 && it.cy >= ry1 && it.cy <= ry2
      ));

      if (inside.length === 0) return '';

      // y 정렬 후 x 정렬 (위->아래, 좌->우)
      inside.sort((a, b) => Math.abs(a.y - b.y) > 0.004 ? a.y - b.y : a.x - b.x);

      // 줄 묶기
      const lines = [];
      let curLine = [];
      let lastY = null;

      for (const it of inside) {
        if (lastY === null || Math.abs(it.y - lastY) <= 0.005) {
          curLine.push(it);
          lastY = it.y;
        } else {
          curLine.sort((a, b) => a.x - b.x);
          lines.push(curLine.map((i) => i.str.trim()).filter(Boolean).join(' '));
          curLine = [it];
          lastY = it.y;
        }
      }
      if (curLine.length > 0) {
        curLine.sort((a, b) => a.x - b.x);
        lines.push(curLine.map((i) => i.str.trim()).filter(Boolean).join(' '));
      }

      return lines.join(' ').replace(/\s+/g, ' ').trim();
    },

    /**
     * 지정 구역(rect: {x,y,w,h} 비율 0~1) 안의 텍스트를 줄 단위 배열로 추출 (WD-77)
     * @param {Object} page - page 객체
     * @param {Object} rect - {x, y, w, h} 비율
     * @param {Object} [opt]
     * @param {number} [opt.rowTol] - 줄 묶기 허용 오차 (기본 0.006)
     * @returns {Array<string>} 줄 문자열 배열
     */
    readLines(page, rect, opt = {}) {
      if (!page || !page.items || !rect) return [];
      const rx1 = rect.x;
      const ry1 = rect.y;
      const rx2 = rect.x + rect.w;
      const ry2 = rect.y + rect.h;
      const rowTol = typeof opt.rowTol === 'number' ? opt.rowTol : 0.006;

      const inside = page.items.filter((it) => (
        it.cx >= rx1 && it.cx <= rx2 && it.cy >= ry1 && it.cy <= ry2
      ));
      if (inside.length === 0) return [];

      inside.sort((a, b) => a.cy - b.cy);

      const rawRows = [];
      let curRowItems = [];
      let curRowCy = null;

      for (const it of inside) {
        if (curRowCy === null || Math.abs(it.cy - curRowCy) <= rowTol) {
          curRowItems.push(it);
          curRowCy = (curRowCy === null) ? it.cy : (curRowCy * 0.7 + it.cy * 0.3);
        } else {
          rawRows.push(curRowItems);
          curRowItems = [it];
          curRowCy = it.cy;
        }
      }
      if (curRowItems.length > 0) rawRows.push(curRowItems);

      const lines = [];
      for (const row of rawRows) {
        row.sort((a, b) => a.x - b.x);
        const lineStr = row.map((i) => (i.str || '').trim()).filter(Boolean).join(' ');
        const cleaned = PdfZones.cleanLabel(lineStr.replace(/\s+/g, ' ').trim());
        if (cleaned) {
          lines.push(cleaned);
        }
      }
      return lines;
    },

    /**
     * 줄 배열을 불릿 단위 항목 배열로 분할/결합 (WD-77)
     * - 불릿 기호(-, –, ·, •, ※, 1), ① 등)로 시작하면 새 항목 시작
     * - 불릿 없이 이어지는 줄은 직전 항목에 공백으로 이어 붙임
     * - 불릿이 하나도 없는 구역은 각 줄을 개별 항목으로 취급
     * - 시작 불릿 기호는 제거
     * @param {Array<string>} lines - 줄 문자열 배열
     * @returns {Array<string>} 항목 배열
     */
    splitBullets(lines) {
      if (!Array.isArray(lines) || lines.length === 0) return [];

      // 불릿 정규식: -, –, —, ·, •, ※, 숫자+괄호(1), 2) 등), 원숫자(①~⑳)
      const bulletRegex = /^[\s]*([-–—·•※]|\d+\)|[①-⑳])\s*/;

      // 구역 전체에서 불릿이 하나라도 있는지 확인
      const hasAnyBullet = lines.some((l) => bulletRegex.test(l));

      if (!hasAnyBullet) {
        // 불릿이 하나도 없으면 줄마다 개별 항목
        return lines.map((l) => l.trim()).filter(Boolean);
      }

      const items = [];
      let currentItem = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (bulletRegex.test(trimmed)) {
          if (currentItem) {
            items.push(currentItem);
          }
          // 불릿 기호 제거
          currentItem = trimmed.replace(bulletRegex, '').trim();
        } else {
          if (currentItem) {
            currentItem += ' ' + trimmed;
          } else {
            currentItem = trimmed;
          }
        }
      }
      if (currentItem) {
        items.push(currentItem);
      }

      return items.filter(Boolean);
    },

    /**
     * 지정 구역(rect)에서 표 구조(columns 경계)로 행 데이터 추출
     * @param {Object} page - page 객체
     * @param {Object} rect - {x, y, w, h} 비율
     * @param {Array<number>} columns - 열 경계 x 목록 (오름차순 비율). N개 경계 -> N+1개 열.
     *                                  열 0: rect.x ~ columns[0]
     *                                  열 i: columns[i-1] ~ columns[i]
     *                                  열 N: columns[N-1] ~ rect.x + rect.w
     * @param {Object} [opt]
     * @param {number} [opt.rowTol] - 행 클러스터링 오차 (기본 0.007)
     * @param {number} [opt.skipRows] - 건너뛸 헤더 행 수 (기본 0)
     * @param {string} [opt.stopAt] - 'sum' (합계 행 등장 시 중단)
     * @param {Object} [opt.columnMap] - 열 인덱스 -> 필드명 매핑 객체 { 0: 'job', 1: 'count' }
     * @returns {Array<Array<string>|Object>} 행 배열
     */
    readTable(page, rect, columns = [], opt = {}) {
      if (!page || !page.items || !rect) return [];
      const rx1 = rect.x;
      const ry1 = rect.y;
      const rx2 = rect.x + rect.w;
      const ry2 = rect.y + rect.h;
      const numCols = columns.length + 1;
      const rowTol = typeof opt.rowTol === 'number' ? opt.rowTol : 0.007;

      // rect 내부 아이템 추출
      const inside = page.items.filter((it) => (
        it.cx >= rx1 && it.cx <= rx2 && it.cy >= ry1 && it.cy <= ry2
      ));
      if (inside.length === 0) return [];

      // 각 아이템에 열 인덱스 부여
      for (const it of inside) {
        let colIdx = numCols - 1;
        for (let i = 0; i < columns.length; i++) {
          if (it.cx < columns[i]) {
            colIdx = i;
            break;
          }
        }
        it._col = colIdx;
      }

      // cy 기준으로 정렬하여 행 클러스터링
      inside.sort((a, b) => a.cy - b.cy);

      const rawRows = [];
      let curRowItems = [];
      let curRowCy = null;

      for (const it of inside) {
        if (curRowCy === null || Math.abs(it.cy - curRowCy) <= rowTol) {
          curRowItems.push(it);
          curRowCy = (curRowCy === null) ? it.cy : (curRowCy * 0.7 + it.cy * 0.3);
        } else {
          rawRows.push(curRowItems);
          curRowItems = [it];
          curRowCy = it.cy;
        }
      }
      if (curRowItems.length > 0) rawRows.push(curRowItems);

      // 각 행을 열 배열 [col0, col1, ...] 로 변환
      const tableRows = [];
      for (const rowItems of rawRows) {
        const rowCells = Array(numCols).fill('');
        // 열별로 모아서 정렬 후 결합
        const colBuckets = Array.from({ length: numCols }, () => []);
        for (const item of rowItems) {
          if (item._col >= 0 && item._col < numCols) {
            colBuckets[item._col].push(item);
          }
        }
        for (let c = 0; c < numCols; c++) {
          const b = colBuckets[c];
          if (b.length > 0) {
            b.sort((a, b) => Math.abs(a.y - b.y) > 0.003 ? a.y - b.y : a.x - b.x);
            rowCells[c] = b.map((i) => i.str.trim()).filter(Boolean).join(' ').trim();
          }
        }
        tableRows.push(rowCells);
      }

      // skipRows 적용
      const skip = Math.max(0, parseInt(opt.skipRows, 10) || 0);
      let rows = tableRows.slice(skip);

      // stopAt 적용
      const resultRows = [];
      let totalRow = null;

      for (const r of rows) {
        const isSumRow = r.some((c) => /^(계|합계|총계|누계)$/i.test(c.replace(/\s+/g, '')));
        if (isSumRow) {
          totalRow = r;
          if (opt.stopAt === 'sum') {
            break;
          }
        }
        resultRows.push(r);
      }

      // columnMap 이 주어지면 객체 형태로 변환
      if (opt.columnMap && typeof opt.columnMap === 'object') {
        const mapped = resultRows.map((r) => {
          const obj = {};
          for (const [colIdxStr, field] of Object.entries(opt.columnMap)) {
            const cIdx = parseInt(colIdxStr, 10);
            if (cIdx >= 0 && cIdx < r.length && field) {
              obj[field] = r[cIdx];
            }
          }
          return obj;
        });
        if (totalRow) mapped.totalRow = totalRow;
        return mapped;
      }

      if (totalRow) resultRows.totalRow = totalRow;
      return resultRows;
    },

    /**
     * 한글 자간 공백 제거 및 라벨 정리 유틸
     * - 한글 낱글자(1글자) 토큰이 2개 이상 연속된 구간만 공백 제거 ("협 력 사 직 원" -> "협력사직원", "직 원" -> "직원")
     * - 2글자 이상 한글 단어 사이 공백 유지 ("도장 및 방청공사", "본관 3층 슬라브 타설", "슬라브 타설")
     * - 영숫자·단위 보존 ("B/H 0.2 ㎥", "25A~500A STS강관", "100A~300A PIPE")
     * @param {string} str
     * @returns {string}
     */
    cleanLabel(str) {
      if (str === null || str === undefined) return '';
      const s = String(str).trim();
      if (!s) return '';

      const tokens = s.split(/\s+/);
      const isSingleHangul = t => /^[가-힣ㄱ-ㅎㅏ-ㅣ]$/.test(t);

      const result = [];
      let i = 0;
      while (i < tokens.length) {
        if (isSingleHangul(tokens[i])) {
          let j = i;
          while (j < tokens.length && isSingleHangul(tokens[j])) {
            j++;
          }
          const count = j - i;
          if (count >= 2) {
            result.push(tokens.slice(i, j).join(''));
          } else {
            result.push(tokens[i]);
          }
          i = j;
        } else {
          result.push(tokens[i]);
          i++;
        }
      }
      return result.join(' ');
    },

    /**
     * 문자열 숫자 정리 유틸
     * @param {string|number} str
     * @param {number|null} [defaultVal=0]
     * @returns {number|null}
     */
    num(str, defaultVal = 0) {
      if (typeof str === 'number') return Number.isFinite(str) ? str : defaultVal;
      if (str === null || str === undefined) return defaultVal;
      const s = String(str).replace(/,/g, '').replace(/%/g, '').trim();
      if (!s || s === '-' || s === '·' || s === '/') return defaultVal;
      const parsed = parseFloat(s);
      return Number.isFinite(parsed) ? parsed : defaultVal;
    },

    /**
     * 표 데이터 행들의 특정 열 합계와 합계 행 일치 여부 검증
     * @param {Array} rows - readTable 결과 행 목록
     * @param {number|string} colIndexOrKey - 숫자 인덱스 또는 columnMap 키
     * @param {Array|Object} totalRow - 합계 행
     * @returns {{ match: boolean, sum: number, expected: number }}
     */
    sumCheck(rows, colIndexOrKey, totalRow) {
      let sum = 0;
      for (const r of rows) {
        const val = Array.isArray(r) ? r[colIndexOrKey] : r[colIndexOrKey];
        sum += PdfZones.num(val, 0);
      }
      let expected = 0;
      if (totalRow) {
        const expVal = Array.isArray(totalRow) ? totalRow[colIndexOrKey] : totalRow[colIndexOrKey];
        expected = PdfZones.num(expVal, 0);
      }
      // 소수점 3자리 반올림 비교
      const diff = Math.abs(sum - expected);
      const match = diff < 0.001;
      return { match, sum: Math.round(sum * 1000) / 1000, expected: Math.round(expected * 1000) / 1000 };
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PdfZones;
  }
  if (typeof global !== 'undefined') {
    global.PdfZones = PdfZones;
  }
})(typeof window !== 'undefined' ? window : globalThis);

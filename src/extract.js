import englishData from '@tesseract.js-data/eng';
import arabicData from '@tesseract.js-data/ara';
import simplifiedChineseData from '@tesseract.js-data/chi_sim';
import traditionalChineseData from '@tesseract.js-data/chi_tra';
import japaneseData from '@tesseract.js-data/jpn';
import koreanData from '@tesseract.js-data/kor';
import frenchData from '@tesseract.js-data/fra';
import portugueseData from '@tesseract.js-data/por';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { imageSize } from 'image-size';
import sharp from 'sharp';
import { mergeEnglishReadings, mergeLanguageReadings, ocrLines, parseInstagramLines, selectTitleReading } from './instagram.js';

const UI_TEXT = /^(?:original audio|use audio|saved audio|audio|music|save|saved|message sent|delivered|instagram reels|reels?|follow|following|share|send|cancel|play|pause|view profile|see more)$/i;
const METADATA = /(?:https?:\/\/|www\.|@\w+|\b\d+(?:[.,]\d+)?\s*[kmb]?\s*(?:reels?|plays?|views?|likes?)\b|^\d{1,2}:\d{2}$)/i;

function cleanName(value, stripSentenceEnd = false) {
  let name = value.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  if (stripSentenceEnd) name = name.replace(/[.;]+$/, '').trim();
  return name;
}

function plausibleName(value) {
  return value.length >= 2
    && value.length <= 90
    && /\p{L}/u.test(value)
    && value.split(/\s+/).length <= 14
    && !UI_TEXT.test(value)
    && !METADATA.test(value)
    && !/^(?:song|track|title|artist)\s*[:：]/i.test(value);
}

/** Find review candidates only when the text supplies both a title and an artist. */
export function extractCandidates(text) {
  if (typeof text !== 'string') throw new TypeError('OCR text must be a string');

  const lines = text.split(/\r?\n/).map(line => line.trim());
  const found = [];
  const add = (titleText, artistText, confidence, sourceText, lineIndex) => {
    const title = cleanName(titleText);
    const artist = cleanName(artistText, true);
    if (plausibleName(title) && plausibleName(artist)) {
      found.push({ title, artist, confidence, sourceText, lineIndex });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const next = lines[i + 1] ?? '';

    // A typed song recommendation from a text conversation.
    const recommendation = line.match(/\b(?:listen\s+to|check\s+out|play|add)\s+(.+?)\s+by\s+(.+?)(?=$|[.!?](?:\s|$))/i);
    if (recommendation) add(recommendation[1], recommendation[2], 0.89, line, i);

    // A pair of explicit labels.
    const titleLabel = line.match(/^(?:song|track|title)\s*[:：]\s*(.+)$/i);
    const artistLabel = next.match(/^artist\s*[:：]\s*(.+)$/i);
    if (titleLabel && artistLabel) add(titleLabel[1], artistLabel[1], 0.96, `${line}\n${next}`, i);

    const reverseArtistLabel = line.match(/^artist\s*[:：]\s*(.+)$/i);
    const reverseTitleLabel = next.match(/^(?:song|track|title)\s*[:：]\s*(.+)$/i);
    const previousIsTitle = /^(?:song|track|title)\s*[:：]/i.test(lines[i - 1] ?? '');
    const followingIsArtist = /^artist\s*[:：]/i.test(lines[i + 2] ?? '');
    if (reverseArtistLabel && reverseTitleLabel && !previousIsTitle && !followingIsArtist) {
      add(reverseTitleLabel[1], reverseArtistLabel[1], 0.96, `${line}\n${next}`, i);
    }

    // The music note identifies an audio overlay; the separator divides title and artist.
    const overlay = line.match(/^[♫♪♬🎵]\s*(.+?)\s+[·•–—-]\s+(.+)$/u);
    if (overlay) add(overlay[1], overlay[2], 0.87, line, i);

    // Instagram audio cards normally end with a "Use audio" button.
    if (/^use audio$/i.test(line) && i >= 2) {
      add(lines[i - 2], lines[i - 1], 0.82, `${lines[i - 2]}\n${lines[i - 1]}\n${line}`, i - 2);
    }

    // A cropped card may show its heading without the button below it.
    if (/^saved audio$/i.test(line) && i + 2 < lines.length && !/^use audio$/i.test(lines[i + 3] ?? '')) {
      add(lines[i + 1], lines[i + 2], 0.76, `${line}\n${lines[i + 1]}\n${lines[i + 2]}`, i + 1);
    }
  }

  found.sort((a, b) => a.lineIndex - b.lineIndex || b.confidence - a.confidence);
  const seen = new Set();
  return found.flatMap(({ lineIndex: _lineIndex, ...candidate }) => {
    const key = `${candidate.title}::${candidate.artist}`.normalize('NFKC').toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [candidate];
  });
}

let workerPromise;
let englishFocusWorkerPromise;
let multilingualWorkerPromise;
let languageDirPromise;
let recognitionQueue = Promise.resolve();
const packs = [englishData, arabicData, simplifiedChineseData, traditionalChineseData, japaneseData, koreanData, frenchData, portugueseData];

async function getWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js')
      .then(({ createWorker }) => createWorker(englishData.code, 1, {
        langPath: englishData.langPath,
        gzip: englishData.gzip,
        cacheMethod: 'none',
      }))
      .catch(error => {
        workerPromise = undefined;
        throw error;
      });
  }
  return workerPromise;
}

async function getEnglishFocusWorker() {
  if (!englishFocusWorkerPromise) {
    englishFocusWorkerPromise = import('tesseract.js')
      .then(({ createWorker }) => createWorker(englishData.code, 1, {
        langPath: englishData.langPath, gzip: englishData.gzip, cacheMethod: 'none',
      }))
      .then(async worker => { await worker.setParameters({ tessedit_pageseg_mode: '7' }); return worker; })
      .catch(error => { englishFocusWorkerPromise = undefined; throw error; });
  }
  return englishFocusWorkerPromise;
}

async function getMultilingualWorker() {
  if (!multilingualWorkerPromise) {
    multilingualWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      languageDirPromise ||= mkdtemp(join(tmpdir(), 'music-inbox-ocr-'));
      const directory = await languageDirPromise;
      await Promise.all(packs.map(pack => copyFile(
        join(`${pack.langPath}_best_int`, `${pack.code}.traineddata.gz`),
        join(directory, `${pack.code}.traineddata.gz`),
      )));
      // Five language packs fit in one pass; Arabic is read by the focused row pass below.
      return createWorker(packs.slice(0, 6).filter(pack => pack.code !== 'ara').map(pack => pack.code), 1,
        { langPath: directory, gzip: true, cacheMethod: 'none' });
    })().catch(error => { multilingualWorkerPromise = undefined; throw error; });
  }
  return multilingualWorkerPromise;
}

function titleCrop(candidate, width, height) {
  const left = Math.round(width * .149);
  const top = Math.max(0, Math.round(candidate.region.y + height * .00625));
  return { left, top, width: Math.min(Math.floor(width * .72), width - left),
    height: Math.min(Math.round(height * .033), height - top) };
}

function scriptPacks(candidate) {
  const title = candidate.title;
  if (/\p{Script=Arabic}/u.test(title)) return ['ara'];
  if (/\p{Script=Hangul}/u.test(title)) return ['kor'];
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title)) return ['jpn'];
  if (/\p{Script=Han}/u.test(title)) return ['chi_sim', 'chi_tra'];
  if (candidate.confidence < .7 || /\p{Ll}.*\s[A-Z]{2,3}$/u.test(title)) {
    return ['ara', 'kor', 'jpn', 'chi_sim', 'chi_tra'];
  }
  return [];
}

async function refineInstagramTitles(buffer, candidates, width, height) {
  const crops = await Promise.all(candidates.map(async candidate => {
    const raw = await sharp(buffer).extract(titleCrop(candidate, width, height)).resize({ width: Math.round(width * 2.16) }).toBuffer();
    const highContrast = await sharp(raw).greyscale().normalize().sharpen().threshold(150).toBuffer();
    return { raw, highContrast };
  }));
  const englishWorker = await getEnglishFocusWorker();
  const refined = [];
  const englishReadings = [];
  for (const [index, candidate] of candidates.entries()) {
    const data = (await englishWorker.recognize(crops[index].highContrast)).data;
    englishReadings.push(data);
    const choice = selectTitleReading(candidate.title, data, 'english');
    const allCapsDisagreement = /^[A-Z]{5,}$/u.test(candidate.title) && /^[A-Z]{5,}$/u.test(data.text.trim())
      && candidate.title !== data.text.trim() && data.confidence >= 65;
    refined.push({ ...candidate, title: choice.title,
      needsReview: candidate.needsReview || choice.uncertain || allCapsDisagreement
        || (data.confidence < 20 && candidate.confidence < .85) });
  }

  const scriptTargets = candidates.map(scriptPacks);
  const accentTargets = candidates.map((candidate, index) =>
    /\p{M}/u.test(candidate.title.normalize('NFKD')) || englishReadings[index].confidence < 20 && /^[A-Z]{5,}$/u.test(candidate.title));
  if (!scriptTargets.some(target => target.length) && !accentTargets.includes(true)) return refined;

  const { createWorker } = await import('tesseract.js');
  const directory = await languageDirPromise;
  const alternatives = new Map();
  for (const code of ['ara', 'kor', 'jpn', 'chi_sim', 'chi_tra', 'fra', 'por']) {
    const targets = candidates.flatMap((candidate, index) =>
      (code === 'fra' || code === 'por' ? accentTargets[index] : scriptTargets[index].includes(code)) ? [index] : []);
    if (!targets.length) continue;
    const worker = await createWorker(code, 1, { langPath: directory, gzip: true, cacheMethod: 'none' });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '7' });
      for (const index of targets) {
        const image = code === 'chi_sim' || code === 'chi_tra' ? crops[index].highContrast : crops[index].raw;
        const data = (await worker.recognize(image)).data;
        const kind = code === 'fra' || code === 'por' ? 'accent' : code;
        const choice = selectTitleReading(candidates[index].title, data, kind);
        if (choice.changed && (!alternatives.has(index) || data.confidence > alternatives.get(index).confidence)) {
          alternatives.set(index, { ...choice, confidence: data.confidence });
        }
        if (kind === 'accent' && accentTargets[index] && data.confidence >= 85 && !choice.changed
            && englishReadings[index].confidence < 20) refined[index].needsReview = true;
      }
    } finally {
      await worker.terminate();
    }
  }
  for (const [index, choice] of alternatives) {
    refined[index].title = choice.title;
    refined[index].needsReview ||= choice.uncertain;
  }
  return refined;
}

/** OCR an uploaded image, reusing one worker for a batch of uploads. */
export async function analyzeImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('OCR needs a non-empty image buffer');
  }

  const job = recognitionQueue.then(async () => {
    const worker = await getWorker();
    const { width, height } = imageSize(buffer);
    if (!width || !height || width > 10000 || height > 20000) throw new Error('Unsupported screenshot dimensions.');
    const region = { left: Math.round(width * .155), top: Math.round(height * .245),
      width: Math.round(width * .73), height: height - Math.round(height * .245) };
    const result = await worker.recognize(buffer, { rectangle: region }, { blocks: true });
    const text = result?.data?.text;
    if (typeof text !== 'string') throw new Error('OCR returned no text result');
    let english = parseInstagramLines(ocrLines(result.data), width, height);
    if (english.anchors >= 2) {
      const enlargedImage = await sharp(buffer).resize({ width: width * 2 }).toBuffer();
      const enlargedResult = await worker.recognize(enlargedImage, { rectangle: Object.fromEntries(
        Object.entries(region).map(([key, value]) => [key, value * 2]),
      ) }, { blocks: true });
      english = mergeEnglishReadings(english, parseInstagramLines(ocrLines(enlargedResult.data), width * 2, height * 2), height);
      const multilingualWorker = await getMultilingualWorker();
      const multilingualResult = await multilingualWorker.recognize(buffer, { rectangle: region }, { blocks: true });
      const merged = mergeLanguageReadings(english,
        parseInstagramLines(ocrLines(multilingualResult.data), width, height), height);
      return { text: text.trim(), ...merged,
        candidates: await refineInstagramTitles(buffer, merged.candidates, width, height), format: 'instagram' };
    }
    const wholeImage = await worker.recognize(buffer);
    return { text: wholeImage.data.text.trim(), candidates: extractCandidates(wholeImage.data.text), skippedOriginalAudio: 0, format: 'message' };
  });
  recognitionQueue = job.then(() => undefined, () => undefined);

  try {
    return await job;
  } catch (error) {
    throw new Error(`Could not read text from image: ${error.message}`, { cause: error });
  }
}

/** Call at server shutdown to release the OCR worker. */
export async function closeOcrWorker() {
  await recognitionQueue;
  const pending = workerPromise;
  workerPromise = undefined;
  if (pending) await (await pending).terminate();
  const englishFocusedPending = englishFocusWorkerPromise;
  englishFocusWorkerPromise = undefined;
  if (englishFocusedPending) await (await englishFocusedPending).terminate();
  const multilingualPending = multilingualWorkerPromise;
  multilingualWorkerPromise = undefined;
  if (multilingualPending) await (await multilingualPending).terminate();
  const languageDirectory = languageDirPromise;
  languageDirPromise = undefined;
  if (languageDirectory) await rm(await languageDirectory, { recursive: true, force: true });
}

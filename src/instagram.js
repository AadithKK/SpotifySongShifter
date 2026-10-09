const META = /^(.*?)\s*[-·•]\s*\d+(?:[.,]\d+)?\s*[KMB]?\s*reels?\b/iu;
const UI = /^(?:search|saved|for you|trending|original audio|link spotify|how it works)$/iu;

function tidy(value, title = false) {
  let text = value.replace(/[\u200e\u200f\u202a-\u202e]/gu, '').replace(/\s+/gu, ' ').trim();
  if (title) text = text.replace(/\s+(?:[&8E3§2©®]|日|و)$/u, '').trim(); // OCR often reads the explicit badge as a letter.
  if (title) text = text.replace(/^(\d)(?=[A-Za-z])/u, '$1 ');
  if (title) text = text.replace(/\blt\b/giu, 'It');
  if (!title) text = text.replace(/^(?:2|[↗↖↘↙])\s+(?=[\p{L}])/u, ''); // The external-link arrow can read as "2".
  return text;
}

function scriptCharacters(value) {
  return (value.match(/[\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
}

const SCRIPT = {
  ara: /\p{Script=Arabic}/gu,
  chi_sim: /\p{Script=Han}/gu,
  chi_tra: /\p{Script=Han}/gu,
  jpn: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  kor: /\p{Script=Hangul}/gu,
};

function latinBase(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/** Accept only focused OCR changes with a clear reason; every uncertain script result stays reviewable. */
export function selectTitleReading(current, reading, kind) {
  const title = tidy(reading?.text || '', true);
  const confidence = reading?.confidence || 0;
  const unchanged = { title: current, changed: false, uncertain: false };
  if (!title || title === current) return unchanged;
  if (kind === 'english') {
    if (confidence < 75 || scriptCharacters(current) || scriptCharacters(title)) return unchanged;
    const oldBase = latinBase(current);
    const newBase = latinBase(title);
    const losesAccent = /\p{M}/u.test(current.normalize('NFKD')) && !/\p{M}/u.test(title.normalize('NFKD'));
    if (losesAccent) return unchanged;
    const compact = value => value.replace(/[^\p{L}\p{N}]/gu, '');
    const spacingFix = compact(oldBase) === compact(newBase) && (title.match(/\s/g) || []).length !== (current.match(/\s/g) || []).length;
    const romanFix = /\bIl$/u.test(current) && title === current.replace(/Il$/u, 'II');
    return spacingFix || (romanFix && confidence >= 85) ? { title, changed: true, uncertain: false } : unchanged;
  }
  if (kind === 'accent') {
    return confidence >= 90 && latinBase(current) === latinBase(title)
      ? { title, changed: true, uncertain: false } : unchanged;
  }
  const pattern = SCRIPT[kind];
  const found = (title.match(pattern) || []).length;
  const before = (current.match(pattern) || []).length;
  const requiredConfidence = kind === 'chi_sim' || kind === 'chi_tra' ? 80 : 85;
  if (confidence < requiredConfidence || found < 2 || found <= before) return unchanged;
  if ((kind === 'chi_sim' || kind === 'chi_tra') && current.includes('(') && title.includes('(')
      && !/\b(?:feat|remix|instrumental)\b/iu.test(current.slice(current.lastIndexOf('(')))) {
    return { title: `${current.slice(0, current.lastIndexOf('('))}${title.slice(title.lastIndexOf('('))}`, changed: true, uncertain: true };
  }
  return { title, changed: true, uncertain: true };
}

export function ocrLines(data) {
  return (data?.blocks || []).flatMap(block => (block.paragraphs || [])
    .flatMap(paragraph => (paragraph.lines || []).map(line => ({
      text: line.text?.trim() || '', bbox: line.bbox, confidence: line.confidence || 0,
    })))).filter(line => line.text && line.bbox);
}

/** Instagram's metadata line identifies a row; the title is directly above it. */
export function parseInstagramLines(lines, width, height) {
  const ordered = lines.filter(line => line?.bbox && line.text).sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const candidates = [];
  let skippedOriginalAudio = 0;
  let anchors = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const artistLine = ordered[i];
    const metadata = tidy(artistLine.text);
    const match = metadata.match(META);
    const clippedMetadata = !match && /(?:\.{2,}|…)$/u.test(metadata);
    if (!match && !clippedMetadata) continue;
    if (match) anchors += 1;
    const titleLine = ordered[i - 1];
    if (!titleLine) continue;
    const gap = artistLine.bbox.y0 - titleLine.bbox.y1;
    if (gap < -3 || gap > height * .025 || titleLine.bbox.y0 < height * .255) continue;
    const title = tidy(titleLine.text, true);
    const artist = tidy(match ? match[1] : metadata.replace(/\s*[-·•]\s*\d+(?:[.,]\d+)?\s*[KMB]?\s*(?:\.{2,}|…)$/iu, '').trim());
    if (/^original audio$/iu.test(title)) { skippedOriginalAudio += 1; continue; }
    if (!title || !artist || META.test(title) || UI.test(title) || UI.test(artist) || !/\p{L}/u.test(title) || !/\p{L}/u.test(artist)) continue;
    const partial = clippedMetadata || /(?:\.{2,}|…)/u.test(title) || /(?:\.{2,}|…)/u.test(artist);
    const time = artistLine.text.match(/\b\d{1,2}:\d{2}\b/u)?.[0];
    const duration = time ? time.split(':').reduce((minutes, seconds) => Number(minutes) * 60 + Number(seconds)) : undefined;
    const confidence = Math.min(titleLine.confidence, artistLine.confidence) / 100;
    const suspiciousSuffix = /\p{Ll}.*\s[A-Z]{2,3}$/u.test(title);
    const ambiguousArtistInitial = /^l[a-z]+\d/u.test(artist); // OCR often confuses a leading capital I with lowercase l.
    candidates.push({
      title, artist, durationSeconds: duration, partial, needsReview: partial || confidence < .78 || suspiciousSuffix || ambiguousArtistInitial,
      confidence: Math.round(confidence * 100) / 100,
      sourceText: `${titleLine.text.trim()}\n${artistLine.text.trim()}`,
      region: {
        x: Math.max(0, Math.round(width * .025)),
        y: Math.max(0, titleLine.bbox.y0 - Math.round(height * .015)),
        width: Math.round(width * .94),
        height: Math.min(height - titleLine.bbox.y0, Math.max(55, artistLine.bbox.y1 - titleLine.bbox.y0 + Math.round(height * .025))),
      },
      rowY: titleLine.bbox.y0,
    });
  }
  return { candidates, skippedOriginalAudio, anchors };
}

/** Prefer a multilingual reading where it reveals script that English OCR missed. */
export function mergeLanguageReadings(english, multilingual, height) {
  const merged = english.candidates.map(candidate => {
    const other = multilingual.candidates.find(row => Math.abs(row.rowY - candidate.rowY) < height * .025);
    if (!other) return candidate;
    const useMultilingualTitle = candidate.confidence < .8 || scriptCharacters(other.title) >= 3;
    const useMultilingualArtist = candidate.confidence < .8 || scriptCharacters(other.artist) >= 3;
    const title = useMultilingualTitle && scriptCharacters(other.title) >= Math.max(2, scriptCharacters(candidate.title) + 1) ? other.title : candidate.title;
    const artist = useMultilingualArtist && scriptCharacters(other.artist) >= Math.max(2, scriptCharacters(candidate.artist) + 1) ? other.artist : candidate.artist;
    return { ...candidate, title, artist, partial: candidate.partial || other.partial,
      needsReview: candidate.needsReview || other.needsReview || title !== candidate.title || artist !== candidate.artist };
  });
  for (const candidate of multilingual.candidates) {
    if (!merged.some(row => Math.abs(row.rowY - candidate.rowY) < height * .025)) merged.push(candidate);
  }
  return { candidates: merged.sort((a, b) => a.rowY - b.rowY).map(({ rowY, ...candidate }) => candidate),
    skippedOriginalAudio: Math.max(english.skippedOriginalAudio, multilingual.skippedOriginalAudio) };
}

export function mergeEnglishReadings(original, enlarged, height) {
  const scaled = enlarged.candidates.map(candidate => ({
    ...candidate, rowY: candidate.rowY / 2,
    region: Object.fromEntries(Object.entries(candidate.region).map(([key, value]) => [key, Math.round(value / 2)])),
  }));
  const candidates = original.candidates.map(candidate => {
    const other = scaled.find(row => Math.abs(row.rowY - candidate.rowY) < height * .025);
    return other && candidate.confidence < .78 && other.confidence > candidate.confidence + .06
      ? { ...other, needsReview: true } : candidate;
  });
  for (const candidate of scaled) {
    if (!candidates.some(row => Math.abs(row.rowY - candidate.rowY) < height * .025)) candidates.push(candidate);
  }
  return { candidates: candidates.sort((a, b) => a.rowY - b.rowY),
    skippedOriginalAudio: Math.max(original.skippedOriginalAudio, enlarged.skippedOriginalAudio),
    anchors: Math.max(original.anchors, enlarged.anchors) };
}

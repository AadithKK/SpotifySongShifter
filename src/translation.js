import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageForTranslation } from '../public/song-utils.js';

export { languageForTranslation } from '../public/song-utils.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const models = { ko: 'Xenova/opus-mt-ko-en', zh: 'Xenova/opus-mt-zh-en' };
const pipelines = new Map();
const translations = new Map();
let translationQueue = Promise.resolve();

async function getPipeline(language) {
  if (!models[language]) throw new Error('Unsupported translation language.');
  if (!pipelines.has(language)) {
    const loading = (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.cacheDir = join(process.env.DATA_DIR || join(root, 'data'), 'translation-models');
      return pipeline('translation', models[language], { dtype: 'q8' });
    })();
    pipelines.set(language, loading);
    loading.catch(() => pipelines.delete(language));
  }
  return pipelines.get(language);
}

async function localTranslate(text, language) {
  const key = `${language}\n${text}`;
  if (!translations.has(key)) {
    const task = translationQueue.then(async () => {
      const translator = await getPipeline(language);
      const result = await translator(text);
      return String(result?.[0]?.translation_text || '').trim();
    });
    translationQueue = task.catch(() => {});
    translations.set(key, task);
    task.catch(() => translations.delete(key));
  }
  return translations.get(key);
}

/** English is a review hint; the OCR title and artist are never replaced. */
export async function translateSongFields(song, translate = localTranslate) {
  const titleLanguage = languageForTranslation(song.title);
  const artistLanguage = languageForTranslation(song.artist);
  return {
    englishTitle: titleLanguage ? await translate(song.title, titleLanguage) : '',
    englishArtist: artistLanguage ? await translate(song.artist, artistLanguage) : '',
  };
}
